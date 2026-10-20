/**
 * llm_intelligence voice session — WebKit STT/TTS with Amazon Polly/Transcribe fallback.
 *
 * Vosk (offline) gates the wake phrase; Silero VAD detects speech end and triggers STT submit.
 * STT only runs during an utterance and transcribes once — never used for phrase detection.
 *
 * `stream` input mode (Config → Voice → Input mode) skips all of that: the mic
 * is piped straight to the bridge (audio-stream-pipe.ts), which segments and
 * transcribes it and feeds the agent as the user talks. Turns stay the default
 * and the recommendation.
 */

import { acquireMic, type MicLease } from './mic-service.js';
import { AgentAudioPlayer, type AgentAudioState } from './agent-audio.js';
import type { PcmContextLike } from './pcm-scheduler.js';
import {
  createMicProcessingChain,
  getSharedAudioContext,
  primeTtsPlaybackUnlock,
  connectSilentSink,
  type MicProcessingChain,
} from './audio.js';
import { getVoiceAudioMeter } from './voice-audio-meter.js';
import type { SessionCallbacks, VoiceAgentStatusEvent, VoiceLogLevel, VoiceLogSubcategory } from './voice-session-types.js';
import { type TurnSubmit, type WakeWords, resolveWakeConfidenceThreshold, textContainsWakePhrase } from './wake-words.js';
import {
  cancelTtsFallback,
  chunkForSpeech,
  openingForSpeech,
  stopAllTts,
  TtsPile,
  prepareSpeechSynthesisForPlayback,
  type TtsPlayContext,
} from './tts-fallback.js';
import {
  snapshotToPayload,
  summarizeTtsInterrupt,
  withLastHeardWords,
  type TtsInterruptSnapshot,
} from './tts-interrupt.js';
import { WebkitSttSession } from './webkit-stt.js';
import { AudioStreamPipeClient } from './audio-stream-pipe.js';
import { ServerSttSession } from './server-stt.js';
import { speakServerTts, stopServerTts } from './server-tts.js';
import { canUseWebkitTts } from './webkit-capabilities.js';
import {
  resolveAudioBackendsAsync,
  serverSttLabel,
  serverTtsLabel,
  EMPTY_AUDIO_CONFIG,
  type IntelligenceAudioConfig,
  type SttBackend,
  type TtsBackend,
} from './intelligence-audio.js';
import type { SttGate } from './stt-gate.js';
import { isCrossOriginIsolated, wakePhraseCoopError } from './cross-origin-isolation.js';
import {
  VoskGrammarSpotter,
  voskPhraseMatches,
  wakeSpotterOptions,
} from './vosk-wake-word.js';
import { DEFAULT_REDEMPTION_MS, SileroVadDetector } from './silero-vad.js';
import { prefetchVoiceModels } from './model-download.js';
import { TurnSubmitBuffer } from './turn-submit-buffer.js';
import { playVoiceCueNow } from './sound-effects.js';
import { errorSpeechText } from './error-feedback.js';
import {
  looksLikeSilentPlayback,
  resolveBrowserTtsOptions,
  type WebkitTtsDefaults,
} from './browser-tts-settings.js';

/** How much of the agent's work is read aloud beyond its actual replies. */

/** Uploaded media sent with a typed turn (docs/46). */
export interface TurnMediaRef {
  ids: string[];
  delivery: 'path' | 'inline';
}

export type ReadAloudMode = 'replies' | 'titles' | 'summary' | 'everything';

export interface VoiceTtsSettings {
  agentSpeechEnabled: boolean;
  errorSoundEnabled: boolean;
  errorSpeakEnabled: boolean;
  readAloud?: ReadAloudMode;
  webkit: WebkitTtsDefaults;
}

export type VoiceInputMode = 'turns' | 'stream';

export interface IntelligenceAuthOk {
  sessionKey: string;
  workflow: string;
  wakeWords: WakeWords;
  turnSubmit: TurnSubmit;
  inputMode?: VoiceInputMode;
  tts?: VoiceTtsSettings;
  wakeWordsEnabled?: boolean;
  model: string;
  audio?: IntelligenceAudioConfig;
}

type SttSession = WebkitSttSession | ServerSttSession;

export interface AudioBackendSummary {
  stt: SttBackend;
  tts: TtsBackend;
  /** Display name of the active STT engine (e.g. "Groq", "Browser STT"). */
  sttLabel: string;
  ttsLabel: string;
}

export class LlmIntelligenceSession {
  private ws: WebSocket | null = null;
  private stt: SttSession | null = null;
  private closed = false;
  /** Resolves when the bridge reports the wake-word model is prepared (or fails). */
  private serverModelReadyResolved = false;
  private resolveServerModelReady!: () => void;
  private readonly serverModelReady = new Promise<void>((resolve) => {
    this.resolveServerModelReady = resolve;
  });
  private wakeWords: WakeWords = { start: '', end: 'send' };
  private turnSubmit: TurnSubmit = { silenceMs: DEFAULT_REDEMPTION_MS, vadEnabled: true };
  private workflow = 'agent_native';
  /** `stream` pipes the mic to /ws/audio-stream instead of taking turns. */
  private inputMode: VoiceInputMode = 'turns';
  private streamPipe: AudioStreamPipeClient | null = null;
  private ttsSettings: VoiceTtsSettings = {
    agentSpeechEnabled: true,
    errorSoundEnabled: true,
    errorSpeakEnabled: true,
    webkit: { rate: 1.02, pitch: 1, volume: 1, lang: 'en-US' },
  };
  private resolvedWebkitTts = resolveBrowserTtsOptions({
    rate: 1.02,
    pitch: 1,
    volume: 1,
    lang: 'en-US',
  });
  private voiceActivated = false;
  /** True while STT is buffering audio between Vosk wake and VAD speech-end cut. */
  private capturingUtterance = false;
  private orchestratorBusy = false;
  private ttsSpeaking = false;
  private wsConnected = false;
  private audioConfig: IntelligenceAudioConfig = EMPTY_AUDIO_CONFIG;
  private sttBackend: SttBackend = 'text_only';
  private ttsBackend: TtsBackend = 'none';
  private readonly ttsPile = new TtsPile((text, ctx) => this.playSpeakUtterance(text, ctx));
  /** The agent's own audio streams (docs/47): queued ones ride the pile, async ones play at once. */
  private readonly agentAudio = new AgentAudioPlayer({
    context: () => getSharedAudioContext() as unknown as PcmContextLike,
    output: (volume) => {
      const ctx = getSharedAudioContext();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      gain.connect(ctx.destination);
      return { node: gain, release: () => gain.disconnect() };
    },
    enqueueLine: (line) => this.ttsPile.enqueueRaw(line),
    report: (streamId, state, message) => this.sendAgentAudioState(streamId, state, message),
    log: (summary, detail) => this.voiceLog('tts', 'info', summary, detail),
    onAsyncActiveChange: () => this.syncCapture(),
    enabled: () => this.ttsSettings.agentSpeechEnabled,
  });
  /** Server called done(); re-arm only after all queued speech finishes. */
  private turnCompletionPending = false;
  private pendingTtsInterrupt: TtsInterruptSnapshot | null = null;
  private meterMicChain: MicProcessingChain | null = null;
  /** True while the display is off — skip rebuilding the viz-only Web Audio graph. */
  private visualMeterPaused = false;
  private startSpotter: VoskGrammarSpotter | null = null;
  private vadDetector: SileroVadDetector | null = null;
  private endSpotter: VoskGrammarSpotter | null = null;
  private cancelSpotter: VoskGrammarSpotter | null = null;
  private turnBuffer: TurnSubmitBuffer | null = null;
  private vadSpeechEndPending = false;
  private endPhrasePending = false;
  private endSubmitTimer = 0;
  /**
   * Ignore speech-end for this long after wake (avoids bleed-through / partial
   * false hits). Safe only while the VAD cannot physically report speech-end
   * sooner: with the v5 model that floor is minSpeechMs(384) + redemption, i.e.
   * 864 ms at the lowest configurable silenceMs (500). Re-check this if either
   * the guard rises or the silenceMs minimum falls.
   */
  private readonly minSpeechEndMs = 800;
  private capturePhaseStartedAt = 0;
  /** True only between wake activation and turn submit — VAD must not run before this. */
  private vadListening = false;
  /** True only between wake activation and turn submit — end Vosk must not run before this. */
  private listeningForEndPhrase = false;
  private micMuted = false;
  private wakeWordsEnabled = true;
  private lastLoggedSttPartial = '';
  private sharedMicStream: MediaStream | null = null;
  /** Borrowed from MicService; released, not stopped, when the session ends. */
  private micLease: MicLease | null = null;
  private lastErrorFeedbackMessage = '';
  private lastErrorFeedbackAt = 0;
  private ownsSharedMic = false;
  private readonly micTracks = new Set<MediaStreamTrack>();

  private readonly sttGate: SttGate = {
    isCapturing: () =>
      this.capturingUtterance || this.vadSpeechEndPending || this.endPhrasePending,
    /** Pause STT only while muted or assistant TTS (not during a fresh user capture). */
    isPaused: () => this.micMuted || (this.ttsSpeaking && !this.capturingUtterance),
  };

  constructor(
    private readonly bridgeBase: string,
    private readonly appToken: string,
    private readonly cb: SessionCallbacks,
  ) {
    this.ttsPile.setOnDiscard((lines) => this.agentAudio.discardLines(lines));
    this.ttsPile.setOnActiveChange((active) => {
      this.ttsSpeaking = active;
      this.cb.onSpeaking(active);
      this.notifySpeakingState(active);
      if (!active) {
        if (this.turnCompletionPending && !this.ttsPile.isBargeInPaused()) {
          this.finishTurnComplete();
        } else {
          this.ensureWakeListening();
        }
      }
      this.syncCapture();
    });
  }

  getAudioBackends(): AudioBackendSummary {
    return {
      stt: this.sttBackend,
      tts: this.ttsBackend,
      // Labels come from here rather than a UI-side lookup table: the STT
      // engine is chosen on the bridge, so only the session knows its name.
      sttLabel: this.sttProviderLabel(),
      ttsLabel: this.ttsProviderLabel(),
    };
  }

  getAudioConfig(): IntelligenceAudioConfig {
    return this.audioConfig;
  }

  isVoiceActivated(): boolean {
    return this.voiceActivated;
  }

  /**
   * Discard the current capture or in-flight submit/transcribe.
   * Works after VAD/end-phrase when voiceActivated is already false.
   */
  cancelCurrentTurn(): boolean {
    if (this.closed) return false;
    const inFlight =
      this.voiceActivated ||
      this.capturingUtterance ||
      this.vadSpeechEndPending ||
      this.endPhrasePending;
    if (!inFlight) return false;

    if (this.ttsPile.isBargeInPaused()) {
      this.ttsPile.resumeAfterBargeInCancel();
      this.pendingTtsInterrupt = null;
      this.notifySpeakingState(this.ttsPile.isActive());
      this.voiceLog('tts', 'info', 'TTS resumed', 'cancel after barge-in');
    }

    playVoiceCueNow('cancel');
    this.clearEndSubmitTimer();
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    if (this.stt instanceof ServerSttSession) {
      this.stt.cancelPendingFlush();
    }
    console.debug('[cancel] turn cancelled by user');
    this.cb.onTurnCancelled?.(this.wakeWords.cancel?.trim() || 'cancel');
    this.exitCapturePhase();
    this.voiceActivated = false;
    this.cb.onDeactivated?.();
    void this.returnToWakeListen();
    return true;
  }

  /** On-screen Speak — same as wake phrase without requiring Vosk. */
  async activateFromTouch(): Promise<void> {
    if (this.closed) return;
    if (this.micMuted) {
      this.setMicMuted(false);
    }
    // Streaming is always listening — Speak only needs to unmute.
    if (this.streamPipe) return;
    await this.onVoskStartDetected('(touch)');
  }

  /** True while the mic is piped straight to the bridge rather than taking turns. */
  isStreamingInput(): boolean {
    return this.streamPipe !== null;
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    for (const t of this.micTracks) t.enabled = !muted;
    if (muted) {
      this.startSpotter?.pause();
      if (this.vadListening) this.vadDetector?.pause();
      if (this.listeningForEndPhrase) this.endSpotter?.pause();
    } else {
      this.startSpotter?.resume();
      if (this.vadListening) this.vadDetector?.resume();
      if (this.listeningForEndPhrase) this.endSpotter?.resume();
    }
    if (this.stt instanceof ServerSttSession) {
      this.stt.setMicEnabled(!muted);
    }
    this.syncCapture();
  }

  private registerMicStream(stream: MediaStream | null | undefined): void {
    stream?.getAudioTracks().forEach((t) => {
      this.micTracks.add(t);
      // The mute can be set before start() opens the device, and acquireMic()
      // re-enables every track it hands out.
      t.enabled = !this.micMuted;
    });
  }

  async start(): Promise<void> {
    this.cb.onState('connecting');
    await primeTtsPlaybackUnlock();

    const wsUrl = `${this.bridgeBase.replace(/^http/, 'ws')}/ws`;
    this.ws = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const ws = this.ws!;
      let settled = false;

      // A socket that opens to a half-ready bridge (e.g. one still restarting)
      // may never send auth_ok and never error — without this the connect would
      // hang forever and the caller's reconnect backoff could never retry.
      const timer = setTimeout(() => {
        finish(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(new Error('WebSocket connect timed out'));
        });
      }, 10_000);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: this.appToken }));
      });

      ws.addEventListener('message', (ev) => {
        this.handleMessage(ev.data as string, {
          onAuthOk: () => finish(resolve),
          onError: (message) => finish(() => reject(new Error(message))),
        });
      });

      ws.addEventListener('error', () =>
        finish(() => reject(new Error('WebSocket error'))),
      );

      ws.addEventListener('close', (ev) => {
        if (!this.closed && this.wsConnected) {
          this.cb.onClosed?.('WebSocket disconnected');
        }
        finish(() =>
          reject(new Error(ev.reason?.trim() || `WebSocket closed (${ev.code})`)),
        );
      });
    });

    // Resolve only after auth_ok: the bridge's STT/TTS chains arrive with it, and
    // resolving against the browser-only default would pick webkit STT even when
    // the bridge has a server provider ready (and webkit fails in e.g. Chromium).
    const resolved = await resolveAudioBackendsAsync(this.audioConfig);
    this.sttBackend = resolved.stt;
    this.ttsBackend = resolved.tts;
    console.info('[audio] STT:', this.sttBackend, 'TTS:', this.ttsBackend, resolved.sttNote ?? '');
    const ttsDetail = resolved.ttsNote ?? resolved.sttNote;
    this.voiceLog(
      'pipeline',
      'info',
      `Audio backends: ${this.sttProviderLabel()} · ${this.ttsProviderLabel()}`,
      ttsDetail,
    );
    this.wsConnected = true;

    if (this.inputMode === 'stream' && !this.audioConfig.sttAvailable) {
      // Browser STT cannot transcribe a raw stream — the bridge has to.
      this.inputMode = 'turns';
      this.voiceLog('pipeline', 'warn', 'Direct stream unavailable — using turns', 'no server speech-to-text provider');
      this.cb.onSttError?.(
        'Direct audio stream needs a server speech-to-text provider (Config → Speech). Using turns for this session.',
      );
    }

    if (this.inputMode === 'stream' && (await this.startStreamPhase())) {
      this.cb.onState('connected');
      return;
    }

    // Pull the offline models up front, with a progress bar, while the orb still
    // says "Preparing". Doing it lazily meant a silent ~50 MB download on the
    // first wake attempt and another one mid-turn when VAD first armed.
    await prefetchVoiceModels({
      vosk: this.wakeWordsEnabled && isCrossOriginIsolated(),
      silero: this.usesVad(),
    });

    // STT hardware is lazy-init in beginUtteranceCapture() — only one backend (WebKit OR Amazon).
    await this.startWakeWordPhase();

    this.cb.onState('connected');
  }

  close(): void {
    this.closed = true;
    this.wsConnected = false;
    this.streamPipe?.stop();
    this.streamPipe = null;
    this.endUtteranceCapture(true);
    this.stt?.stop();
    this.stt = null;
    this.startSpotter?.dispose();
    this.startSpotter = null;
    void this.stopVadDetector();
    this.endSpotter?.dispose();
    this.endSpotter = null;
    this.cancelSpotter?.dispose();
    this.cancelSpotter = null;
    this.turnBuffer?.dispose();
    this.turnBuffer = null;
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.capturingUtterance = false;
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    this.clearEndSubmitTimer();
    this.meterMicChain?.dispose();
    this.meterMicChain = null;
    this.micTracks.clear();
    this.micMuted = false;
    if (this.ownsSharedMic) {
      // Release the lease, not the device. MicService mutes immediately and
      // only stops the tracks after the keep-warm window, so the next session
      // does not trigger a fresh permission prompt.
      this.micLease?.release();
    }
    this.micLease = null;
    this.sharedMicStream = null;
    this.ownsSharedMic = false;
    stopAllTts();
    stopServerTts();
    this.agentAudio.stopAll();
    this.ttsPile.interrupt();
    this.ws?.close();
    this.ws = null;
  }

  injectNarration(text: string): void {
    this.enqueueSpeak(text);
    this.cb.onAssistantTranscript(text);
  }

  /**
   * Typed message — skips the wake gate; uses the same user_turn path as voice.
   * Always enqueues while the session is live (agent_native queues behind a running agent).
   * @returns false when the turn could not be sent (caller should keep the draft).
   */
  sendTextTurn(text: string, media?: TurnMediaRef): boolean {
    const trimmed = text.trim();
    const hasMedia = (media?.ids.length ?? 0) > 0;
    if ((!trimmed && !hasMedia) || this.closed) return false;
    if (!this.wsConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.cb.onSttError?.('Not connected — tap the orb to start a session.');
      return false;
    }
    if (!this.voiceActivated) {
      this.voiceActivated = true;
      this.cb.onActivated?.('(typed input)');
    }
    // Typed turns get the same send cue as spoken ones — submitting a message
    // should sound the same whichever way you wrote it.
    playVoiceCueNow('sent');
    const files = media?.ids.length ?? 0;
    const note = files > 0 ? `[${files} file${files === 1 ? '' : 's'} attached]` : '';
    this.cb.onUserTranscript([trimmed, note].filter(Boolean).join(' '));
    this.sendUserTurn(trimmed, media);
    return true;
  }

  private async ensureSharedMic(): Promise<MediaStream> {
    if (this.sharedMicStream) return this.sharedMicStream;
    // One owner for the whole app (docs/40 §4): the lease hands back the same
    // device every session instead of stopping its tracks and re-prompting.
    this.micLease = await acquireMic();
    this.sharedMicStream = this.micLease.stream;
    this.ownsSharedMic = true;
    this.registerMicStream(this.sharedMicStream);
    return this.sharedMicStream;
  }

  private async attachMicMeter(stream?: MediaStream): Promise<void> {
    if (this.visualMeterPaused) return;
    try {
      const mic = stream ?? (await this.ensureSharedMic());
      if (this.visualMeterPaused) return;
      const ctx = getSharedAudioContext();
      if (ctx.state === 'suspended') await ctx.resume();
      if (this.visualMeterPaused) return;
      this.meterMicChain?.dispose();
      this.meterMicChain = createMicProcessingChain(mic, { highPassHz: 120 });
      const tap = getVoiceAudioMeter().tapMic(ctx, this.meterMicChain.output);
      connectSilentSink(ctx, tap);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.cb.onSttError?.(`Microphone unavailable: ${message}`);
    }
  }

  /** Drop the viz-only filter graph while the display is off (wake-word Vosk stays up). */
  pauseVisualMeter(): void {
    this.visualMeterPaused = true;
    this.meterMicChain?.dispose();
    this.meterMicChain = null;
  }

  /** Re-attach the orb meter after the screen is on again. */
  resumeVisualMeter(): void {
    if (this.closed) return;
    this.visualMeterPaused = false;
    void this.ensureMicMeter();
  }

  /**
   * Direct stream — pipe the mic to the bridge for the whole session.
   * Returns false (after reporting why) if the bridge refused, so the caller
   * falls back to turns rather than leaving a session that cannot hear.
   */
  private async startStreamPhase(): Promise<boolean> {
    const mic = await this.ensureSharedMic();
    await this.attachMicMeter(mic);
    const pipe = new AudioStreamPipeClient(this.bridgeBase, this.appToken, {
      onReady: ({ stt }) => {
        this.voiceLog('pipeline', 'info', `Direct audio stream → ${stt}`, 'speech is cut at pauses and sent as you talk');
      },
      onSegment: (text, info) => {
        this.cb.onUserTranscript(text);
        this.voiceLog('stt', 'info', `Stream segment ${info.index}`, text.slice(0, 120));
      },
      onUndelivered: (message) => this.cb.onSttError?.(message),
      onError: (message) => {
        this.voiceLog('stt', 'error', 'Audio stream error', message);
        this.cb.onSttError?.(message);
      },
      onClosed: (reason) => {
        if (this.closed) return;
        this.voiceLog('pipeline', 'error', 'Audio stream closed', reason);
        this.cb.onClosed?.(`Audio stream closed — ${reason}`);
      },
    });
    try {
      await pipe.start(mic);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      pipe.stop();
      this.inputMode = 'turns';
      this.voiceLog('pipeline', 'error', 'Direct stream refused — using turns', message);
      this.cb.onSttError?.(`Direct audio stream unavailable: ${message}. Using turns for this session.`);
      return false;
    }
    this.streamPipe = pipe;
    this.voiceActivated = true;
    this.cb.onActivated?.('(direct stream)');
    this.syncCapture();
    return true;
  }

  /** Idle phase — Vosk only; no STT pipeline (no Transcribe cost). */
  private async startWakeWordPhase(): Promise<void> {
    await this.ensureSharedMic();

    if (!this.wakeWordsEnabled) {
      this.voiceLog('pipeline', 'info', 'Wake words off — use on-screen Speak');
      return;
    }

    if (!isCrossOriginIsolated()) {
      this.cb.onSttError?.(wakePhraseCoopError());
      return;
    }

    // The bridge prepares the wake-word model and reports readiness over the
    // socket. Wait for it so we never try to load a half-prepared archive; fall
    // through after a timeout so an older bridge that sends no status still works.
    await Promise.race([
      this.serverModelReady,
      new Promise<void>((resolve) => setTimeout(resolve, 25_000)),
    ]);

    await this.armStartSpotter();
  }

  private markServerModelReady(): void {
    if (this.serverModelReadyResolved) return;
    this.serverModelReadyResolved = true;
    this.resolveServerModelReady();
  }

  /** Re-arm wake Vosk when idle — safe to call after TTS or turn_complete. */
  private ensureWakeListening(): void {
    if (
      this.closed ||
      this.streamPipe ||
      !this.wakeWordsEnabled ||
      this.voiceActivated ||
      this.capturingUtterance ||
      this.vadListening ||
      this.listeningForEndPhrase ||
      this.ttsSpeaking
    ) {
      return;
    }
    if (!isCrossOriginIsolated()) return;
    if (!this.startSpotter) {
      void this.armStartSpotter();
    } else {
      this.startSpotter.resume();
    }
  }

  private async armStartSpotter(): Promise<void> {
    if (!this.wakeWordsEnabled) return;
    const start = this.wakeWords.start.trim();
    if (!start) {
      this.cb.onSttError?.('No wake phrase configured — set wakeWords.start on the Voice tab.');
      return;
    }
    if (!isCrossOriginIsolated() || this.closed) return;

    this.stopStartSpotter();
    try {
      this.startSpotter = new VoskGrammarSpotter({
        onMatch: (_phrase, heard) => void this.onVoskStartDetected(heard),
        onStatus: (status) => this.voiceLog('pipeline', 'info', status),
        onError: (message) => {
          console.warn('[vosk-start]', message);
          this.cb.onSttError?.(`Wake phrase spotter: ${message}`);
        },
      });
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      await this.startSpotter.start(start, {
        mediaStream: mic,
        ...wakeSpotterOptions(resolveWakeConfidenceThreshold(this.wakeWords)),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[vosk-start]', message);
      this.startSpotter?.dispose();
      this.startSpotter = null;
      this.cb.onSttError?.(`Wake phrase spotter failed: ${message}`);
    }
  }

  /** After VAD speech-end or turn complete — Vosk wake only, orb back to inactive/red. */
  private async returnToWakeListen(): Promise<void> {
    // A streaming session never goes back to waiting for a wake phrase.
    if (this.closed || this.streamPipe) return;
    this.voiceActivated = false;
    this.capturingUtterance = false;
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    void this.stopVadDetector();
    this.stopEndSpotter();
    this.stopCancelSpotter();
    if (this.stt instanceof WebkitSttSession) {
      this.stt.pause();
    }
    this.cb.onDeactivated?.();
    if (this.wakeWordsEnabled) {
      await this.armStartSpotter();
    }
  }

  /** Wake phrase heard while assistant TTS is playing — pause speech; agent keeps running. */
  private bargeInDuringTts(): void {
    if (!this.ttsPile.isActive() && !this.ttsPile.isBargeInPaused()) return;

    const snap = this.ttsPile.pauseForBargeIn();
    const payload = snapshotToPayload(snap);
    if (payload) {
      this.pendingTtsInterrupt = withLastHeardWords(payload);
      this.cb.onTtsBargeIn?.(summarizeTtsInterrupt(this.pendingTtsInterrupt));
    }
    this.voiceLog('tts', 'info', 'TTS paused', 'wake barge-in — cancel resumes, submit sends last-heard context');
    this.notifySpeakingState(false);
  }

  /**
   * During TTS, ignore wake detections that match the line being spoken — that is
   * acoustic echo from the assistant saying the wake phrase, not a user barge-in.
   */
  private isTtsWakeWordEcho(heard: string): boolean {
    const wake = this.wakeWords.start.trim();
    if (!wake || !voskPhraseMatches(heard, wake)) return false;

    const ttsLine = this.ttsPile.getCurrentLine();
    if (!ttsLine) return false;

    return textContainsWakePhrase(ttsLine, wake);
  }

  private async onVoskStartDetected(heard: string): Promise<void> {
    if (this.closed) return;

    if ((this.ttsSpeaking || this.ttsPile.isActive()) && !this.ttsPile.isBargeInPaused()) {
      if (this.isTtsWakeWordEcho(heard)) {
        this.startSpotter?.resetTrigger();
        this.voiceLog('pipeline', 'debug', 'Wake ignored — TTS echo', heard);
        return;
      }
      this.bargeInDuringTts();
    }

    if (
      this.voiceActivated &&
      (this.capturingUtterance ||
        this.vadListening ||
        this.listeningForEndPhrase ||
        this.vadSpeechEndPending ||
        this.endPhrasePending)
    ) {
      return;
    }
    if (this.voiceActivated) {
      this.exitCapturePhase();
      this.voiceActivated = false;
    }
    this.stopStartSpotter();
    this.voiceActivated = true;
    playVoiceCueNow('listening');
    this.cb.onActivated?.(this.wakeWords.start);
    await this.enterCapturePhase();
  }

  private stopStartSpotter(): void {
    this.startSpotter?.dispose();
    this.startSpotter = null;
  }

  private async stopVadDetector(): Promise<void> {
    await this.vadDetector?.dispose();
    this.vadDetector = null;
    this.vadListening = false;
  }

  private stopEndSpotter(): void {
    this.endSpotter?.dispose();
    this.endSpotter = null;
    this.listeningForEndPhrase = false;
  }

  private stopCancelSpotter(): void {
    this.cancelSpotter?.dispose();
    this.cancelSpotter = null;
  }

  /** Vosk cancel phrase heard during capture — abort turn; resume paused TTS if any. */
  private onCancelDetected(): void {
    if (this.closed || !this.voiceActivated) return;
    this.cancelCurrentTurn();
  }

  private async armCancelSpotter(): Promise<void> {
    if (!this.wakeWordsEnabled) return;
    const cancel = this.wakeWords.cancel?.trim();
    if (!cancel || !isCrossOriginIsolated()) return;

    this.stopCancelSpotter();
    try {
      this.cancelSpotter = new VoskGrammarSpotter({
        onMatch: () => this.onCancelDetected(),
        onError: (message) => console.warn('[vosk-cancel]', message),
      });
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      await this.cancelSpotter.start(cancel, { mediaStream: mic, matchPartial: false });
    } catch (err) {
      console.warn('[vosk-cancel]', err);
      this.cancelSpotter?.dispose();
      this.cancelSpotter = null;
    }
  }

  private exitCapturePhase(): void {
    this.vadListening = false;
    this.listeningForEndPhrase = false;
    void this.stopVadDetector();
    this.stopEndSpotter();
    this.stopCancelSpotter();
    this.clearEndSubmitTimer();
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.endUtteranceCapture(true);
  }

  /** Vosk wake heard — open STT stream, arm VAD or end-phrase spotter. */
  private async enterCapturePhase(): Promise<void> {
    this.capturePhaseStartedAt = Date.now();
    this.resetTurnBuffer();
    await this.beginUtteranceCapture();
    if (this.closed || !this.voiceActivated) return;
    if (this.usesVad()) {
      await this.armVadDetector();
    } else if (this.usesEndPhraseSubmit()) {
      await this.armEndPhraseSpotter();
    }
    if (this.closed || !this.voiceActivated) return;
    // Cancel spotter runs throughout the capture phase — lets user say "cancel"
    // to abort the turn silently without sending anything.
    await this.armCancelSpotter();
  }

  private resetTurnBuffer(): void {
    this.turnBuffer?.dispose();
    if (this.usesVad()) {
      this.turnBuffer = new TurnSubmitBuffer({
        silenceMs: 0,
        onSubmit: (text, reason) => this.flushTurn(text, reason),
      });
      return;
    }
    const endPhraseMode = this.usesEndPhraseSubmit();
    this.turnBuffer = new TurnSubmitBuffer({
      silenceMs: endPhraseMode ? 0 : this.turnSubmit.silenceMs,
      endPhrase: this.wakeWords.end,
      onSubmit: (text, reason) => this.flushTurn(text, reason),
    });
  }

  /** Silero VAD handles turn end when enabled. */
  private usesVad(): boolean {
    return this.turnSubmit.vadEnabled !== false;
  }

  /** End phrase via Vosk when VAD is off — silence timer and Amazon VAD must not auto-submit. */
  private usesEndPhraseSubmit(): boolean {
    return (
      !this.usesVad() &&
      Boolean(this.wakeWords.end.trim()) &&
      isCrossOriginIsolated()
    );
  }

  /**
   * Abandon the current capture after an STT failure. Must tell the UI: the
   * "Cancel" processing control keys off the submit-in-flight state that
   * onVadDetected / onEndPhraseDetected raised, and nothing else lowers it —
   * without this the button outlived the failed turn (#41).
   */
  private recoverCaptureError(reason = 'transcription failed'): void {
    const wasSubmitting = this.vadSpeechEndPending || this.endPhrasePending;
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.clearEndSubmitTimer();
    this.exitCapturePhase();
    this.turnBuffer?.dispose();
    this.turnBuffer = null;
    if (wasSubmitting || this.capturingUtterance || this.voiceActivated) {
      this.cb.onTurnDiscarded?.(reason);
    }
    void this.returnToWakeListen();
  }

  private async ensureMicMeter(): Promise<void> {
    if (this.meterMicChain) return;
    await this.attachMicMeter(this.sharedMicStream ?? undefined);
  }

  /** Create STT hardware once (mic tap); utterances use beginUtteranceCapture(). */
  private async ensureSttPipeline(): Promise<void> {
    await this.ensureMicMeter();
    if (this.stt) return;

    if (this.sttBackend === 'webkit') {
      this.stt = new WebkitSttSession('en-US', this.sttGate, {
        onInterim: (text) => this.onSttPartial(text),
        onFinal: (text) => this.onUserText(text),
        onError: (message) => {
          console.warn('[webkit-stt]', message);
          this.voiceLog('stt', 'error', 'Browser STT error', message);
          this.cb.onSttError?.(message);
          if (this.vadSpeechEndPending || this.endPhrasePending || this.capturingUtterance) {
            this.recoverCaptureError();
          }
        },
        onEnd: () => {
          if (this.closed || this.sttGate.isPaused() || !this.capturingUtterance) return;
          if (this.stt instanceof WebkitSttSession) {
            window.setTimeout(() => {
              if (this.capturingUtterance && !this.sttGate.isPaused()) {
                this.stt?.start();
              }
            }, 250);
          }
        },
      });
      return;
    }

    if (this.sttBackend === 'server') {
      const server = new ServerSttSession(this.bridgeBase, this.appToken, this.sttGate, {
        onInterim: (text) => this.onSttPartial(text),
        onFinal: (text) => this.onUserText(text),
        onError: (message) => {
          console.warn('[server-stt]', message);
          this.voiceLog('stt', 'error', `${this.sttProviderLabel()} error`, message);
          this.cb.onSttError?.(message);
          if (this.vadSpeechEndPending || this.endPhrasePending || this.capturingUtterance) {
            this.recoverCaptureError();
          }
        },
      });
      this.stt = server;
    }
  }

  /** Vosk cut-in: start buffering audio for one utterance. */
  private async beginUtteranceCapture(): Promise<void> {
    if (!this.voiceActivated || this.closed) return;
    await this.ensureSttPipeline();
    if (this.stt instanceof ServerSttSession) {
      await this.stt.start(this.sharedMicStream ?? undefined);
    }
    this.capturingUtterance = true;
    this.lastLoggedSttPartial = '';
    this.voiceLog('stt', 'info', `${this.sttProviderLabel()} listening`);
    const silenceFlush =
      !this.usesVad() && !this.usesEndPhraseSubmit() && this.turnSubmit.silenceMs > 0;
    if (this.stt instanceof ServerSttSession) {
      this.stt.beginCapture({ silenceFlush });
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.start();
    }
  }

  /** Vosk cut-out: stop buffering (optionally discard buffered audio). */
  private endUtteranceCapture(discard = false): void {
    this.capturingUtterance = false;
    if (this.stt instanceof ServerSttSession) {
      if (discard) this.stt.endCapture();
      else this.stt.freezeCapture();
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.pause();
    }
  }

  private async armVadDetector(): Promise<void> {
    if (!this.voiceActivated) return;

    await this.stopVadDetector();
    this.vadDetector = new SileroVadDetector();

    try {
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      await this.vadDetector.start(mic, {
        redemptionMs: this.turnSubmit.silenceMs,
        onSpeechEnd: () => this.onVadSpeechEnd(),
        onError: (message) => {
          console.warn('[silero-vad]', message);
          this.cb.onSttError?.(`Silero VAD: ${message}`);
        },
      });
      this.vadListening = true;
      this.cb.onVadArmed?.();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[silero-vad]', err);
      await this.stopVadDetector();
      this.cb.onSttError?.(`Silero VAD failed: ${message}`);
    }
  }

  /** Silero VAD speech-end — freeze mic, transcribe once, return to wake listen immediately. */
  private onVadSpeechEnd(): void {
    if (this.closed || !this.vadListening || !this.voiceActivated) {
      return;
    }
    if (Date.now() - this.capturePhaseStartedAt < this.minSpeechEndMs) {
      console.debug('[silero-vad] ignored — too soon after wake');
      return;
    }
    playVoiceCueNow('sent');
    this.vadSpeechEndPending = true;
    this.vadListening = false;
    void this.stopVadDetector();
    this.cb.onVadDetected?.();
    this.endUtteranceCapture(false);
    if (this.stt instanceof WebkitSttSession) {
      this.flushSttNow();
    }
    void this.returnToWakeListen();
    this.scheduleVadSubmit();
  }

  private async armEndPhraseSpotter(): Promise<void> {
    if (!this.wakeWordsEnabled) return;
    const end = this.wakeWords.end.trim();
    if (!end) {
      this.cb.onSttError?.(
        'No end phrase configured — set wakeWords.end on the Voice tab or enable VAD.',
      );
      return;
    }
    if (!isCrossOriginIsolated()) {
      this.cb.onSttError?.('End phrase Vosk needs COOP/COEP — enable VAD or use silence submit.');
      return;
    }
    if (!this.voiceActivated) return;

    this.stopEndSpotter();
    this.endSpotter = new VoskGrammarSpotter({
      onMatch: () => this.onEndPhraseHeard(),
      onError: (message) => {
        console.warn('[vosk-end]', message);
        this.cb.onSttError?.(`End phrase spotter: ${message}`);
      },
    });

    try {
      const mic = this.sharedMicStream ?? (await this.ensureSharedMic());
      const voskMic = cloneMicForVosk(mic);
      await this.endSpotter.start(end, {
        mediaStream: voskMic,
        matchPartial: false,
      });
      this.listeningForEndPhrase = true;
      this.cb.onEndPhraseArmed?.(end);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[vosk-end]', err);
      this.stopEndSpotter();
      this.cb.onSttError?.(`End phrase spotter failed: ${message}`);
    }
  }

  /** Vosk end phrase — freeze mic, transcribe once, return to wake listen immediately. */
  private onEndPhraseHeard(): void {
    if (this.closed || !this.listeningForEndPhrase || !this.voiceActivated) {
      return;
    }
    if (Date.now() - this.capturePhaseStartedAt < this.minSpeechEndMs) {
      console.debug('[end-phrase] ignored — too soon after wake');
      return;
    }
    playVoiceCueNow('sent');
    this.endPhrasePending = true;
    this.listeningForEndPhrase = false;
    this.stopEndSpotter();
    this.cb.onEndPhraseDetected?.(this.wakeWords.end);
    this.endUtteranceCapture(false);
    if (this.stt instanceof WebkitSttSession) {
      this.flushSttNow();
    }
    void this.returnToWakeListen();
    this.scheduleTurnSubmit('end_word');
  }

  private flushSttNow(): void {
    if (this.stt instanceof ServerSttSession) {
      this.stt.flushNow();
    } else if (this.stt instanceof WebkitSttSession) {
      this.stt.flushNow();
    }
  }

  private enqueueSpeech(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || !this.turnBuffer) return;
    this.cb.onUserTranscript(trimmed);
    this.turnBuffer.append(trimmed);
    if (this.vadSpeechEndPending && this.turnBuffer.submitNow('vad')) {
      this.vadSpeechEndPending = false;
      this.clearEndSubmitTimer();
    }
    if (this.endPhrasePending && this.turnBuffer.submitNow('end_word')) {
      this.endPhrasePending = false;
      this.clearEndSubmitTimer();
    }
  }

  private scheduleTurnSubmit(reason: 'vad' | 'end_word'): void {
    this.clearEndSubmitTimer();
    if (this.stt instanceof ServerSttSession) {
      void this.submitAmazonTurn(reason);
      return;
    }
    this.endSubmitTimer = window.setTimeout(() => this.pollTurnSubmit(reason, 0), 50);
  }

  /**
   * Await server STT — single flush path (WebKit uses pollTurnSubmit instead).
   * Uploads at once: capture was frozen before this runs, so waiting gains no
   * audio — it only delayed the transcript.
   */
  private async submitAmazonTurn(reason: 'vad' | 'end_word'): Promise<void> {
    if (this.closed || !(this.stt instanceof ServerSttSession)) return;

    try {
      await this.stt.flushNowAsync();
    } catch (err) {
      // Engine errors already went through onError → recoverCaptureError and
      // cleared the pending flag. The pre-flight rejections ("no speech
      // captured", "speech too short") never reach onError, so they left the
      // turn stuck in "submitting" with a Cancel button and no way out (#41).
      if (reason === 'vad' ? this.vadSpeechEndPending : this.endPhrasePending) {
        const message = err instanceof Error ? err.message : String(err);
        this.voiceLog('stt', 'error', 'Turn not sent', message);
        this.cb.onSttError?.(message);
        this.recoverCaptureError(message);
      }
      return;
    }

    if (reason === 'vad' ? !this.vadSpeechEndPending : !this.endPhrasePending) {
      return;
    }

    if (this.turnBuffer?.submitNow(reason)) {
      if (reason === 'vad') this.vadSpeechEndPending = false;
      if (reason === 'end_word') this.endPhrasePending = false;
      return;
    }

    this.failTurnSubmit(reason, this.turnBuffer?.text() ?? '');
  }

  private pollTurnSubmit(reason: 'vad' | 'end_word', attempt: number): void {
    if (this.closed) return;
    if (this.turnBuffer?.submitNow(reason)) {
      if (reason === 'vad') this.vadSpeechEndPending = false;
      if (reason === 'end_word') this.endPhrasePending = false;
      return;
    }
    const buffered = this.turnBuffer?.text() ?? '';
    const maxAttempts = 75;
    const retryMs = 400;
    if (attempt < maxAttempts) {
      this.endSubmitTimer = window.setTimeout(() => this.pollTurnSubmit(reason, attempt + 1), retryMs);
      return;
    }
    this.failTurnSubmit(reason, buffered);
  }

  private failTurnSubmit(reason: 'vad' | 'end_word', buffered: string): void {
    if (reason === 'vad') this.vadSpeechEndPending = false;
    if (reason === 'end_word') this.endPhrasePending = false;
    if (this.stt instanceof ServerSttSession) this.stt.endCapture();
    if (buffered) {
      const hint =
        reason === 'end_word'
          ? `Say your request after "${this.wakeWords.start}", then "${this.wakeWords.end}".`
          : `Say your request after "${this.wakeWords.start}".`;
      this.cb.onSttError?.(
        `Could not send — transcript was only "${buffered.slice(0, 40)}". ${hint}`,
      );
    } else {
      this.cb.onSttError?.(
        reason === 'end_word'
          ? 'End phrase heard but transcription failed — check Amazon Transcribe config and speak clearly after the wake phrase.'
          : 'Speech ended but transcription failed — check Amazon Transcribe config and speak clearly after the wake phrase.',
      );
    }
    this.recoverCaptureError(buffered ? 'transcript too short' : 'transcription failed');
  }

  private scheduleVadSubmit(): void {
    this.scheduleTurnSubmit('vad');
  }

  private clearEndSubmitTimer(): void {
    if (this.endSubmitTimer) {
      window.clearTimeout(this.endSubmitTimer);
      this.endSubmitTimer = 0;
    }
  }

  private flushTurn(text: string, reason: 'silence' | 'vad' | 'end_word'): void {
    if (this.closed) return;
    if (!this.capturingUtterance && !this.vadSpeechEndPending && !this.endPhrasePending) {
      return;
    }
    if (reason === 'silence') {
      playVoiceCueNow('sent');
    }
    this.exitCapturePhase();
    this.vadSpeechEndPending = false;
    this.endPhrasePending = false;
    this.clearEndSubmitTimer();
    if (this.stt instanceof ServerSttSession) this.stt.endCapture();
    this.sendUserTurn(text);
    this.cb.onTurnSubmitted?.(reason);
    console.debug('[turn-submit]', reason, text.slice(0, 80));
    void this.returnToWakeListen();
  }

  /** STT transcript for the current utterance only (Vosk wake + VAD/end phrase gate boundaries). */
  private onUserText(text: string): void {
    if (this.closed) return;
    if (!this.capturingUtterance && !this.vadSpeechEndPending && !this.endPhrasePending) {
      return;
    }
    const trimmed = text.trim();
    if (trimmed) {
      this.voiceLog('stt', 'info', `${this.sttProviderLabel()} final`, trimmed.slice(0, 120));
    }
    if (this.stt instanceof ServerSttSession && this.capturingUtterance) {
      this.endUtteranceCapture(false);
    }
    this.enqueueSpeech(text);
  }

  private onSttPartial(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || trimmed === this.lastLoggedSttPartial) return;
    this.lastLoggedSttPartial = trimmed;
    this.voiceLog('stt', 'info', `${this.sttProviderLabel()} partial`, trimmed.slice(0, 120));
  }

  private sendUserTurn(text: string, media?: TurnMediaRef): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    if (this.ttsPile.isBargeInPaused()) {
      const snap = this.ttsPile.finalizeBargeInOnSubmit();
      const payload = snapshotToPayload(snap);
      if (payload) {
        this.pendingTtsInterrupt = withLastHeardWords(payload);
      }
      this.notifySpeakingState(false);
    }

    const payload: Record<string, unknown> = { type: 'user_turn', text };
    // Uploads sent with this turn (docs/46) — already on the bridge, by id.
    if (media && media.ids.length > 0) {
      payload['media_ids'] = media.ids;
      payload['media_delivery'] = media.delivery;
    }
    if (this.pendingTtsInterrupt) {
      payload['tts_interrupt'] = this.pendingTtsInterrupt;
      this.pendingTtsInterrupt = null;
    } else if (isInterruptPhrase(text)) {
      payload['is_interrupt'] = true;
    }
    this.ws.send(JSON.stringify(payload));
  }

  private syncCapture(): void {
    // Never stream the agent's own voice back to it (or anything while muted).
    this.streamPipe?.setPaused(this.micMuted || this.ttsSpeaking || this.agentAudio.asyncActive);
    if (this.sttGate.isPaused()) {
      if (this.stt instanceof WebkitSttSession) this.stt.pause();
      if (this.vadListening) this.vadDetector?.pause();
      if (this.listeningForEndPhrase) this.endSpotter?.pause();
    } else {
      if (this.capturingUtterance && this.stt instanceof WebkitSttSession) {
        this.stt.resume();
      }
      if (this.vadListening) this.vadDetector?.resume();
      if (this.listeningForEndPhrase) this.endSpotter?.resume();
    }
  }

  private handleMessage(
    raw: string,
    hooks: { onAuthOk: () => void; onError: (message: string) => void },
  ): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg['type']) {
      case 'ping': {
        // Heartbeat from the bridge. The voice socket sends nothing while idle
        // (wake-word spotting is local), so without this pong the bridge closes
        // it as half-open after ~30s — dropping the session mid-listen.
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'pong' }));
        }
        break;
      }

      case 'vosk_status': {
        // The bridge prepares the wake-word model and reports progress here.
        const phase = msg['phase'];
        if (phase === 'downloading' || phase === 'unpacking' || phase === 'ready' || phase === 'error') {
          // 'ready' (or a terminal 'error') unblocks the wake-word load, which
          // waits for the bridge to finish preparing the model.
          if (phase === 'ready' || phase === 'error') this.markServerModelReady();
          const totalRaw = msg['totalBytes'];
          this.cb.onServerModelPrepare?.({
            phase,
            label: typeof msg['label'] === 'string' ? msg['label'] : 'Wake-word model',
            fraction: typeof msg['fraction'] === 'number' ? msg['fraction'] : null,
            loadedBytes: typeof msg['loadedBytes'] === 'number' ? msg['loadedBytes'] : undefined,
            totalBytes:
              typeof totalRaw === 'number' ? totalRaw : totalRaw === null ? null : undefined,
            message: typeof msg['message'] === 'string' ? msg['message'] : undefined,
          });
        }
        break;
      }

      case 'auth_ok': {
        this.workflow =
          typeof msg['workflow'] === 'string' ? msg['workflow'] : 'agent_native';
        const wake = msg['wakeWords'] as WakeWords | undefined;
        this.wakeWords = wake ?? { start: '', end: 'send' };
        const submit = msg['turnSubmit'] as TurnSubmit | undefined;
        this.turnSubmit = submit ?? { silenceMs: DEFAULT_REDEMPTION_MS, vadEnabled: true };
        this.wakeWordsEnabled = msg['wakeWordsEnabled'] !== false;
        this.inputMode = msg['inputMode'] === 'stream' ? 'stream' : 'turns';
        if (msg['tts'] && typeof msg['tts'] === 'object') {
          this.ttsSettings = msg['tts'] as VoiceTtsSettings;
          this.resolvedWebkitTts = resolveBrowserTtsOptions(this.ttsSettings.webkit);
          this.ttsPile.setBaseVolume(this.resolvedWebkitTts.volume);
        }
        if (msg['audio'] && typeof msg['audio'] === 'object') {
          this.audioConfig = msg['audio'] as IntelligenceAudioConfig;
        }
        hooks.onAuthOk();
        break;
      }

      case 'speak': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text && this.ttsSettings.agentSpeechEnabled) {
          cancelTtsFallback();
          if (!this.ttsPile.isActive()) {
            this.ttsPile.resetHeard();
          }
          this.enqueueSpeak(text);
        } else if (text) {
          this.cb.onAssistantTranscript(text);
        }
        break;
      }

      case 'agent_audio':
        this.agentAudio.handle(msg);
        break;

      case 'narration': {
        /**
         * Transcript only — never spoken here.
         *
         * The PWA holds both the control socket and this one. Narration is
         * routed control socket → BridgeService → AppComponent →
         * injectNarration, which is the single place that decides whether a
         * line is played. Speaking it here as well meant that the moment
         * narration was also delivered on this socket the user heard every
         * line twice, with no dedup between the two paths (docs/39 Part B).
         */
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text) this.cb.onAssistantTranscript(text);
        break;
      }

      case 'assistant_transcript': {
        const text = typeof msg['text'] === 'string' ? msg['text'] : '';
        if (text) this.cb.onAssistantTranscript(text);
        break;
      }

      case 'thinking':
        this.orchestratorBusy = Boolean(msg['value']);
        this.cb.onWorking(this.orchestratorBusy);
        this.syncCapture();
        break;

      case 'tool_activity': {
        const tool = String(msg['tool'] ?? '');
        const phase = msg['phase'] as 'start' | 'done' | 'error' | undefined;
        const label = String(msg['label'] ?? tool);
        const detail = typeof msg['detail'] === 'string' ? msg['detail'] : undefined;
        if (phase && tool) {
          this.cb.onToolActivity?.({ tool, phase, label, detail });
          this.readActivityAloud(label, detail, phase);
        }
        break;
      }

      case 'session_log': {
        const subcategory = msg['subcategory'] as VoiceLogSubcategory | undefined;
        const level = (msg['level'] as VoiceLogLevel | undefined) ?? 'info';
        const summary = typeof msg['summary'] === 'string' ? msg['summary'] : '';
        if (subcategory && summary) {
          this.cb.onVoiceLog?.({
            subcategory,
            level,
            summary,
            detail: typeof msg['detail'] === 'string' ? msg['detail'] : undefined,
          });
        }
        break;
      }

      case 'voice_agent_status': {
        const runId = typeof msg['run_id'] === 'string' ? msg['run_id'] : '';
        const pid = typeof msg['pid'] === 'number' ? msg['pid'] : 0;
        const sessionId =
          typeof msg['session_id'] === 'string' ? msg['session_id'] : null;
        const mcpSessionId =
          typeof msg['mcp_session_id'] === 'string' ? msg['mcp_session_id'] : null;
        const state = msg['state'] as VoiceAgentStatusEvent['state'] | undefined;
        const project = typeof msg['project'] === 'string' ? msg['project'] : '';
        const provider = typeof msg['provider'] === 'string' ? msg['provider'] : null;
        const providerName =
          typeof msg['provider_name'] === 'string' ? msg['provider_name'] : null;
        if (runId && state && project) {
          this.cb.onVoiceAgentStatus?.({
            runId,
            pid,
            sessionId,
            mcpSessionId,
            state,
            project,
            provider,
            providerName,
          });
        }
        break;
      }

      case 'turn_complete':
        this.orchestratorBusy = false;
        this.vadSpeechEndPending = false;
        this.endPhrasePending = false;
        this.turnBuffer?.dispose();
        this.turnBuffer = null;
        this.pendingTtsInterrupt = null;
        this.cb.onWorking(false);
        this.turnCompletionPending = true;
        if (!this.ttsPile.isActive() && !this.ttsPile.isBargeInPaused()) {
          this.finishTurnComplete();
        }
        break;

      case 'error': {
        const message = String(msg['message'] ?? 'Intelligence session error');
        if (this.wsConnected) {
          this.orchestratorBusy = false;
          this.cb.onWorking(false);
          this.syncCapture();
          this.cb.onTurnError?.(message);
          break;
        }
        hooks.onError(message);
        break;
      }

      default:
        break;
    }
  }

  private finishTurnComplete(): void {
    if (!this.turnCompletionPending || this.closed) return;
    this.turnCompletionPending = false;
    this.ttsPile.resetHeard();
    this.cb.onTurnComplete?.();
    void this.returnToWakeListen();
  }

  /** Queue speak lines from MCP — piles and plays sequentially. */
  /**
   * Read the agent's work aloud, as far as settings.voice.tts.readAloud asks.
   *
   * The bridge already sends every action as a headline plus whatever it
   * produced, so how much of that reaches your ears is purely a local choice:
   *   replies    — nothing here; only what the agent chose to say.
   *   titles     — the headline. "Reading main.py."
   *   summary    — the headline and the opening of the output.
   *   everything — the headline and all of it, split across several lines so
   *                the queue plays it in order instead of truncating it.
   *
   * Only start and error are spoken. Announcing 'done' as well doubles every
   * action, and by then you have already heard what it was.
   */
  private readActivityAloud(
    label: string,
    detail: string | undefined,
    phase: 'start' | 'done' | 'error',
  ): void {
    const mode = this.ttsSettings.readAloud ?? 'replies';
    if (mode === 'replies') return;
    if (!this.ttsSettings.agentSpeechEnabled) return;

    const body = detail?.trim() ?? '';

    // Announce work as it starts — that is the part you want to hear without
    // waiting, and in every mode above `replies`.
    if (phase === 'start') {
      const title = label.trim();
      if (title) this.enqueueSpeak(title);
      return;
    }

    if (phase === 'error') {
      this.enqueueSpeak(label.trim() || 'A tool call failed');
      return;
    }

    // `done` is the only event carrying what the tool actually produced, so it
    // is where summary and everything get their material. The headline was
    // already spoken at start; repeating it here would just stutter.
    if (mode === 'titles' || !body) return;
    if (mode === 'summary') {
      this.enqueueSpeak(openingForSpeech(body));
      return;
    }
    for (const chunk of chunkForSpeech(body)) this.enqueueSpeak(chunk);
  }

  private enqueueSpeak(text: string): void {
    if (!this.ttsSettings.agentSpeechEnabled) return;
    this.ttsPile.enqueue(text);
  }

  /** Refresh per-browser TTS options (call after Config tab saves local profile). */
  refreshBrowserTtsOptions(): void {
    this.resolvedWebkitTts = resolveBrowserTtsOptions(this.ttsSettings.webkit);
    this.ttsPile.setBaseVolume(this.resolvedWebkitTts.volume);
  }

  /** Error earcon + optional spoken alert (independent of agentSpeechEnabled). */
  notifyError(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;

    const now = Date.now();
    if (trimmed === this.lastErrorFeedbackMessage && now - this.lastErrorFeedbackAt < 2000) {
      return;
    }
    this.lastErrorFeedbackMessage = trimmed;
    this.lastErrorFeedbackAt = now;

    if (this.ttsSettings.errorSoundEnabled) {
      playVoiceCueNow('error', { force: true });
    }
    if (this.ttsSettings.errorSpeakEnabled) {
      this.ttsPile.enqueue(errorSpeechText(trimmed));
    }
  }

  private async playSpeakUtterance(text: string, ctx: TtsPlayContext): Promise<void> {
    if (this.agentAudio.isStreamLine(text)) return this.agentAudio.playQueued(text, ctx);
    const provider = this.ttsProviderLabel();
    this.voiceLog('tts', 'info', `${provider} start`, text.slice(0, 80));
    const webkitOpts = {
      rate: this.resolvedWebkitTts.rate,
      pitch: this.resolvedWebkitTts.pitch,
      lang: this.resolvedWebkitTts.lang,
      voiceURI: this.resolvedWebkitTts.voiceURI,
    };
    let playbackStarted = false;
    const wrappedCtx: TtsPlayContext = {
      signal: ctx.signal,
      baseVolume: ctx.baseVolume,
      onStart: () => {
        playbackStarted = true;
        this.voiceLog('tts', 'info', `${provider} playing`, text.slice(0, 80));
        ctx.onStart();
      },
    };

    try {
      if (this.ttsBackend === 'webkit') {
        await this.playWebkit(text, wrappedCtx, webkitOpts);
      } else if (this.ttsBackend === 'server') {
        await speakServerTts(text, this.bridgeBase, this.appToken, wrappedCtx);
      } else if (canUseWebkitTts()) {
        await this.playWebkit(text, wrappedCtx, webkitOpts);
      } else if (this.audioConfig.ttsAvailable) {
        await speakServerTts(text, this.bridgeBase, this.appToken, wrappedCtx);
      } else {
        console.warn('[tts] no TTS backend — text only:', text.slice(0, 80));
        wrappedCtx.onStart();
      }
      if (!ctx.signal.aborted) {
        this.voiceLog('tts', 'info', `${provider} done`, text.slice(0, 80));
      }
    } catch (err) {
      if (ctx.signal.aborted) {
        this.voiceLog('tts', 'info', `${provider} cancelled`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.voiceLog('tts', 'error', `${provider} error`, message.slice(0, 120));
      console.warn('[tts]', err);
      // Cross-side rescue: the bridge already walked its own provider chain, so
      // the only fallback left is the *other* kind of backend.
      if (this.ttsBackend === 'webkit' && this.audioConfig.ttsAvailable) {
        const serverLabel = serverTtsLabel(this.audioConfig);
        try {
          await speakServerTts(text, this.bridgeBase, this.appToken, wrappedCtx);
          if (!ctx.signal.aborted) {
            this.voiceLog('tts', 'info', `${serverLabel} done (fallback)`, text.slice(0, 80));
          }
        } catch (serverErr) {
          const serverMsg = serverErr instanceof Error ? serverErr.message : String(serverErr);
          this.voiceLog('tts', 'error', `${serverLabel} fallback error`, serverMsg.slice(0, 120));
          console.warn('[tts server fallback]', serverErr);
        }
      } else if (canUseWebkitTts()) {
        try {
          await this.playWebkit(text, wrappedCtx, webkitOpts);
          if (!ctx.signal.aborted) {
            this.voiceLog('tts', 'info', 'Browser TTS done (fallback)', text.slice(0, 80));
          }
        } catch (webkitErr) {
          const webkitMsg = webkitErr instanceof Error ? webkitErr.message : String(webkitErr);
          this.voiceLog('tts', 'error', 'Browser TTS fallback error', webkitMsg.slice(0, 120));
          console.warn('[tts webkit fallback]', webkitErr);
        }
      }
    }

    const hadTtsBackend =
      this.ttsBackend !== 'none' || canUseWebkitTts() || this.audioConfig.ttsAvailable;
    if (!playbackStarted && hadTtsBackend && !ctx.signal.aborted) {
      this.notifyError('Speech playback failed.');
    }
  }

  private playWebkit(
    text: string,
    ctx: TtsPlayContext,
    opts?: { rate?: number; pitch?: number; lang?: string; voiceURI?: string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        resolve();
        return;
      }
      if (ctx.signal.aborted) {
        resolve();
        return;
      }
      const startedAt = Date.now();

      window.speechSynthesis.getVoices();
      prepareSpeechSynthesisForPlayback();
      const utter = new SpeechSynthesisUtterance(text);
      utter.rate = opts?.rate ?? 1.02;
      utter.pitch = opts?.pitch ?? 1;
      utter.lang = opts?.lang ?? 'en-US';
      if (opts?.voiceURI) {
        const voice = window.speechSynthesis
          .getVoices()
          .find((v) => v.voiceURI === opts.voiceURI);
        if (voice) utter.voice = voice;
      }
      utter.volume = ctx.baseVolume;

      const finish = () => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve();
      };

      const onAbort = () => {
        window.speechSynthesis.cancel();
        finish();
      };

      ctx.signal.addEventListener('abort', onAbort, { once: true });

      utter.onstart = () => ctx.onStart();
      utter.onend = () => {
        // Cancel after onend to prevent Chrome's ghost-restart loop.
        window.speechSynthesis.cancel();
        // An engine with no usable voice completes instantly and silently.
        // Surface that as a failure so the caller can reach a server voice.
        if (
          !ctx.signal.aborted &&
          looksLikeSilentPlayback(text, Date.now() - startedAt, utter.rate)
        ) {
          ctx.signal.removeEventListener('abort', onAbort);
          reject(new Error('Browser speech finished instantly — nothing was audible'));
          return;
        }
        finish();
      };
      utter.onerror = (ev) => {
        const reason = ev.error ?? 'error';
        console.warn('[tts webkit]', reason);
        ctx.signal.removeEventListener('abort', onAbort);
        // 'interrupted' / 'canceled' are our own barge-in and cancel() calls,
        // not an engine that cannot speak — those must not trigger a re-read.
        if (reason === 'interrupted' || reason === 'canceled') {
          resolve();
          return;
        }
        reject(new Error(`Browser speech failed: ${reason}`));
      };
      // Cancel any lingering synthesis before queuing the next utterance.
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    });
  }

  /** What an agent audio stream is doing here, for the agent's stream log. */
  private sendAgentAudioState(streamId: string, state: AgentAudioState, message?: string): void {
    if (state === 'error') this.voiceLog('tts', 'warn', 'Agent audio failed', message);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'agent_audio_state', stream_id: streamId, state, ...(message ? { message } : {}) }));
  }

  private notifySpeakingState(speaking: boolean): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'speaking', value: speaking }));
  }

  private voiceLog(
    subcategory: VoiceLogSubcategory,
    level: VoiceLogLevel,
    summary: string,
    detail?: string,
  ): void {
    this.cb.onVoiceLog?.({ subcategory, level, summary, detail });
  }

  private sttProviderLabel(): string {
    if (this.sttBackend === 'webkit') return 'Browser STT';
    if (this.sttBackend === 'server') return serverSttLabel(this.audioConfig);
    return 'STT';
  }

  private ttsProviderLabel(): string {
    if (this.ttsBackend === 'webkit') return 'Browser TTS';
    if (this.ttsBackend === 'server') return serverTtsLabel(this.audioConfig);
    if (canUseWebkitTts()) return 'Browser TTS';
    if (this.audioConfig.ttsAvailable) return serverTtsLabel(this.audioConfig);
    return 'TTS';
  }
}

/** Separate mic tap for Vosk so STT ScriptProcessors do not starve the spotter. */
function cloneMicForVosk(mic: MediaStream): MediaStream {
  const track = mic.getAudioTracks()[0];
  if (track && typeof track.clone === 'function') {
    return new MediaStream([track.clone()]);
  }
  return mic;
}

const INTERRUPT_PHRASES = [/\bstop\b/i, /\bcancel\b/i, /\babort\b/i, /\bquit\b/i];

function isInterruptPhrase(text: string): boolean {
  return INTERRUPT_PHRASES.some((re) => re.test(text));
}
