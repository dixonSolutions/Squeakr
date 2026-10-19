import { Injectable, inject, signal } from '@angular/core';
import { LlmIntelligenceSession } from '../../llm-intelligence-session.js';
import type { SessionCallbacks } from '../../voice-session-types.js';
import {
  disposeVoiceAudioMeter,
  getVoiceAudioMeter,
  type AudioSpectrum,
} from '../../voice-audio-meter.js';
import { AppStateService } from './app-state.service';
import { BridgeService, type ChannelCallEvent } from './bridge.service';
import { LogService } from './log.service';
import { ToastService } from './toast.service';
import { VoiceProvidersService } from './voice-providers.service';
import { PushService } from './push.service';
import { AgentProviderService } from './agent-provider.service';
import { cancelTtsFallback, clearTranscriptTts, configureTranscriptTts, scheduleTtsFallback, stopAllTts } from '../../tts-fallback.js';
import { primeTtsPlaybackUnlock } from '../../audio.js';
import { CallSession, isNativeShell } from '../../native/call-session.js';
import { SessionKeepAlive } from '../../session-keepalive.js';
import {
  preloadVoiceCues,
  playVoiceCueNow,
  playStartBeep,
  playConnectDing,
} from '../../sound-effects.js';
import { loadVoskModel } from '../../vosk-model-cache.js';
import type { AudioBackendSummary, TurnMediaRef } from '../../llm-intelligence-session.js';
import {
  onModelDownload,
  prefetchVoiceModels,
  type ModelDownloadState,
} from '../../model-download.js';
import {
  promptSpeechLines,
  markPromptSpoken,
  hasSpokenPrompt,
  forgetSpokenPrompts,
  type ReadPromptsMode,
} from '../../prompt-speech.js';
import type { ApprovalRequest } from '@squeakr/client';

export interface TranscriptEntry {
  id: number;
  text: string;
  role: 'user' | 'assistant';
}

export interface ToolActivityState {
  tool: string;
  phase: 'start' | 'done' | 'error';
  label: string;
  detail?: string;
  at: number;
}

export interface VoiceAgentStatusState {
  runId: string;
  pid: number;
  sessionId: string | null;
  mcpSessionId: string | null;
  state: 'starting' | 'running' | 'done' | 'error' | 'stopped';
  project: string;
  at: number;
}

const MAX_ENTRIES = 50;
let _nextId = 0;

type ActiveSession = LlmIntelligenceSession;

@Injectable({ providedIn: 'root' })
export class VoiceSessionService {
  private readonly bridge = inject(BridgeService);
  private readonly appState = inject(AppStateService);
  private readonly toast = inject(ToastService);
  private readonly voiceProviders = inject(VoiceProvidersService);
  private readonly push = inject(PushService);
  private readonly logs = inject(LogService);
  private readonly agentProviders = inject(AgentProviderService);

  private _session: ActiveSession | null = null;
  private prepareAbort: AbortController | null = null;
  /** In-flight startSession(), so concurrent callers join it instead of racing. */
  private startPromise: Promise<void> | null = null;
  /** Set when a start bailed with its own explanation, to suppress a vaguer one. */
  private startAttemptFailed = false;
  private readonly keepalive = new SessionKeepAlive();
  private keepaliveWired = false;
  /** Reconnect intelligence session after OS background suspend (not user hang-up). */
  private resumeOnVisible = false;
  /** Silent reconnect after an unexpected foreground drop (network blip, etc.). */
  private reconnecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly MAX_SILENT_RECONNECTS = 4;
  /** Native CallKit / foreground-call started for this session — screen may lock. */
  private nativeCallStarted = false;
  private readonly _voiceActivated = signal(false);
  private readonly _speaking = signal(false);
  private readonly _jobRunning = signal(false);
  private readonly _micMuted = signal(false);

  readonly transcript = signal<TranscriptEntry[]>([]);
  readonly toolActivity = signal<ToolActivityState | null>(null);
  readonly agentStatus = signal<VoiceAgentStatusState | null>(null);
  readonly conversationActive = signal(false);
  readonly sessionConnecting = signal(false);
  /** True while MCP install / version check runs before mic opens. */
  readonly sessionPrepActive = signal(false);
  /** Offline model download in flight — null when nothing is being fetched. */
  readonly modelDownload = signal<ModelDownloadState | null>(null);
  readonly speaking = this._speaking.asReadonly();
  readonly voiceActivated = this._voiceActivated.asReadonly();
  readonly micMuted = this._micMuted.asReadonly();
  /** True when this session is backed by the native call shell (CallKit / Android FGS). */
  readonly nativeCallActive = signal(false);
  /** Silero VAD active — listening for speech end to submit. */
  readonly vadListening = signal(false);
  /** Vosk end-phrase spotter active (say end word to submit). */
  readonly endPhraseArmed = signal(false);
  /** Speech-end detected — flushing STT and submitting. */
  readonly submittingTurn = signal(false);

  private readonly _audioSpectrum = signal<AudioSpectrum>({
    bins: new Array(32).fill(0),
    mic: 0,
    out: 0,
    active: 0,
  });
  readonly audioSpectrum = this._audioSpectrum.asReadonly();

  private readonly _audioBackends = signal<AudioBackendSummary | null>(null);
  readonly audioBackends = this._audioBackends.asReadonly();

  /** @deprecated use audioSpectrum */
  readonly audioLevels = this.audioSpectrum;

  private meterRaf = 0;

  private static readonly MIC_MUTE_PREF_KEY = 'cv_mic_muted_pref';

  constructor() {
    // Model download progress drives the orb's Preparing state. The service lives
    // for the app's lifetime, so this subscription is never torn down.
    onModelDownload((state) => this.modelDownload.set(state));

    // Warm the wake-word model in the background (idle time), so the first orb
    // press connects in well under a second instead of waiting on a ~40 MB
    // download + WASM unpack. loadVoskModel() memoises, so startWakeWordPhase
    // reuses this exact promise. Best-effort — failures just fall back to the
    // lazy load at connect time.
    if (typeof window !== 'undefined') {
      const warm = () => {
        // Cache every offline model archive (Vosk + Silero VAD + ORT runtime) so
        // start() never downloads at connect time, and warm the Vosk WASM model.
        void prefetchVoiceModels({ vosk: true, silero: true }).catch(() => {});
        void loadVoskModel().catch(() => {});
      };
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void })
        .requestIdleCallback;
      if (ric) ric(warm);
      else setTimeout(warm, 1500);
    }
  }

  private readMicMutePref(): boolean | null {
    try {
      const raw = localStorage.getItem(VoiceSessionService.MIC_MUTE_PREF_KEY);
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch {
      // ignore
    }
    return null;
  }

  private writeMicMutePref(muted: boolean): void {
    try {
      localStorage.setItem(VoiceSessionService.MIC_MUTE_PREF_KEY, muted ? '1' : '0');
    } catch {
      // ignore
    }
  }

  isVoiceActivated(): boolean {
    return this._voiceActivated();
  }

  toggleMicMute(): void {
    const next = !this._micMuted();
    this._micMuted.set(next);
    this.writeMicMutePref(next);
    if (this._session instanceof LlmIntelligenceSession) {
      this._session.setMicMuted(next);
    }
  }

  /**
   * Pause voice capture while the user records a memo to send as a file
   * (docs/46) — otherwise the session would also hear it as a spoken turn.
   * Temporary: the user's own mute preference is left alone and restored.
   */
  holdMicForRecording(hold: boolean): void {
    if (!(this._session instanceof LlmIntelligenceSession)) return;
    this._session.setMicMuted(hold || this._micMuted());
  }

  /** Discard capture or in-flight transcription without hanging up the session. */
  cancelCurrentTurn(): boolean {
    if (!(this._session instanceof LlmIntelligenceSession)) return false;
    return this._session.cancelCurrentTurn();
  }

  /** On-screen Speak — unmute if needed and start capture. */
  async touchSpeak(): Promise<void> {
    if (!(this._session instanceof LlmIntelligenceSession)) return;
    if (this._micMuted()) {
      this._micMuted.set(false);
      this.writeMicMutePref(false);
    }
    await this._session.activateFromTouch();
  }

  /** Apply updated per-browser TTS profile to an active session. */
  refreshBrowserTtsOptions(): void {
    if (this._session instanceof LlmIntelligenceSession) {
      this._session.refreshBrowserTtsOptions();
    }
  }

  notifyJobRunning(running: boolean): void {
    this._jobRunning.set(running);
    this.syncAppState();
  }

  /**
   * Start the session, or join a start that is already running.
   *
   * Callers that need a live session before doing their own work (the typed
   * composer, most importantly) used to get an immediate return here while a
   * start was still in flight, see a null session, and drop the message.
   */
  startSession(): Promise<void> {
    if (this._session) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.runStartSession().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async runStartSession(): Promise<void> {
    if (this._session || this.sessionConnecting()) return;

    this.ensureKeepAliveWiring();
    this.resumeOnVisible = false;
    this.nativeCallStarted = false;
    this.nativeCallActive.set(false);

    if (isNativeShell()) {
      try {
        await CallSession.startCall();
        this.nativeCallStarted = true;
        this.nativeCallActive.set(true);
      } catch {
        this.toast.warn('Call session', 'Could not start native call — voice may drop when screen locks.');
      }
    }

    const project = this.bridge.activeProject();
    if (!project) {
      this.toast.error('Select a project', 'Choose a project in the dropdown before tapping the orb.');
      this.startAttemptFailed = true;
      return;
    }

    this.sessionConnecting.set(true);
    this.sessionPrepActive.set(true);
    this._voiceActivated.set(false);
    this._jobRunning.set(false);
    const storedMute = this.readMicMutePref();
    const defaultMuted =
      storedMute ?? this.voiceProviders.data()?.defaultMicMuted === true;
    this._micMuted.set(defaultMuted);

    // iOS Safari: unlock TTS in the user-gesture stack before any long await.
    await primeTtsPlaybackUnlock();
    void preloadVoiceCues();
    // Soft blip acknowledging the orb press; the connect ding comes at the end.
    playStartBeep();

    try {
      await this.bridge.setActiveProject(project);
      this.prepareAbort = new AbortController();
      const prepareSignal = this.prepareAbort.signal;
      await this.bridge.prepareVoiceSession(
        project,
        (event) => {
          this.logs.append(
            event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'info',
            'voice',
            event.message,
          );
        },
        prepareSignal,
      );
      await this.bridge.ensureAgentSessionReady(project);
      if (!this.bridge.settings()) {
        await this.bridge.loadSettings();
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      this.toast.error('Could not prepare voice session', detail);
      this.notifyVoiceError(detail);
      this.startAttemptFailed = true;
      this.sessionConnecting.set(false);
      this.sessionPrepActive.set(false);
      return;
    } finally {
      this.prepareAbort = null;
      this.sessionPrepActive.set(false);
    }

    const callbacks = this.buildCallbacks();
    const workflow = this.bridge.settings()?.workflow.default ?? 'agent_native';

    const intelSession = new LlmIntelligenceSession(
      this.bridge.bridgeBase,
      this.bridge.appToken,
      callbacks,
    );
    this._session = intelSession;
    // Before start(), not after: stream input mode pipes the mic to the bridge
    // as soon as its socket is ready, so a mute applied afterwards is too late.
    if (defaultMuted) {
      intelSession.setMicMuted(true);
    }

    try {
      await intelSession.start();
      // Fully connected and ready — everything up (WebSocket, models, wake word).
      playConnectDing();
      // Connected — clear any silent-reconnect backoff.
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this._audioBackends.set(intelSession.getAudioBackends());
      configureTranscriptTts({
        bridgeBase: this.bridge.bridgeBase,
        appToken: this.bridge.appToken,
        audio: intelSession.getAudioConfig(),
      });
      const wakeOff = this.voiceProviders.data()?.wakeWordsEnabled === false;
      const agent = this.agentProviders.activeProviderName();
      const startMsg =
        workflow === 'agent_native'
          ? wakeOff
            ? `Squeakr session started on ${agent} — tap Speak (wake words off)`
            : `Squeakr session started on ${agent} — say the wake phrase to talk to it`
          : wakeOff
            ? 'Intelligence session started — tap Speak (wake words off)'
            : 'Intelligence session started — say wake phrase to activate';
      this.logs.append('info', 'voice', startMsg);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.logs.append('error', 'voice', 'Could not start intelligence session', detail);
      this.startAttemptFailed = true;
      this.stopSession();
      if (this.reconnecting) {
        // A silent reconnect attempt failed — back off and try again (or give
        // up quietly once the budget is spent, inside scheduleSilentReconnect).
        this.scheduleSilentReconnect(detail);
      } else {
        this.toast.error('Could not start voice', detail);
        this.notifyVoiceError(detail);
      }
    } finally {
      this.sessionConnecting.set(false);
    }
  }

  stopSession(options?: { userInitiated?: boolean; keepKeepalive?: boolean }): void {
    const userInitiated = options?.userInitiated !== false;
    this.prepareAbort?.abort();
    this.prepareAbort = null;
    if (userInitiated) {
      this.resumeOnVisible = false;
      // A real hang-up cancels any pending silent reconnect.
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnecting = false;
      this.reconnectAttempts = 0;
    }
    if (userInitiated || !options?.keepKeepalive) {
      this.keepalive.stop();
    }
    if (userInitiated && isNativeShell()) {
      void CallSession.endCall().catch(() => {});
    }

    this._session?.close();
    this._session = null;
    this.sessionConnecting.set(false);
    this.sessionPrepActive.set(false);
    this._voiceActivated.set(false);
    this._speaking.set(false);
    this._jobRunning.set(false);
    this._micMuted.set(false);
    this.bridge.sendSpeakingState(false);
    this.stopMeterPoll();
    this.conversationActive.set(false);
    this.transcript.set([]);
    this.toolActivity.set(null);
    this.agentStatus.set(null);
    this.vadListening.set(false);
    this.endPhraseArmed.set(false);
    this.submittingTurn.set(false);
    this._audioBackends.set(null);
    this.nativeCallStarted = false;
    this.nativeCallActive.set(false);
    clearTranscriptTts();
    cancelTtsFallback();
    stopAllTts();
    // A new session must be able to hear a card that is still open.
    forgetSpokenPrompts();
    this.appState.transitionTo('idle');
  }

  /**
   * A channel voice call (Discord), mirrored here as it happens: what each
   * person said, the agent's lines, its activity, and the same sound effects
   * the call plays. Replies already reach an open session over its own socket
   * (and are spoken there), so they are only added when none is open.
   */
  mirrorChannelCall(e: ChannelCallEvent): void {
    const where = e.source.charAt(0).toUpperCase() + e.source.slice(1);
    switch (e.event) {
      case 'started':
        this.logs.append('info', 'voice', `${e.call} started${e.wake ? ' — wake words on' : ''}`);
        this.toast.info(`${where} call started`, e.call);
        break;
      case 'ended':
        this.logs.append('info', 'voice', `${e.call} ended`);
        this.toast.info(`${where} call ended`, e.call);
        break;
      case 'heard': {
        const mark = e.state === 'armed' ? ' 👂' : e.state === 'cancel' ? ' ✋' : e.state === 'held' ? ' …' : '';
        if (e.state === 'ignored') {
          this.logs.append('info', 'voice', `${where} · ${e.speaker} (not addressed): ${e.text}`, undefined, 'stt');
        } else {
          this.addEntry(`🎙️ ${e.speaker} (${where}): ${e.text}${mark}`, 'user');
        }
        break;
      }
      case 'reply':
        if (e.own || !this.conversationActive()) this.addEntry(e.text, 'assistant');
        break;
      case 'cue':
        playVoiceCueNow(e.cue, { force: true });
        break;
      case 'activity':
        this.logs.append('info', 'voice', `${where} call · ${e.line}`, undefined, 'tool');
        break;
      case 'notice':
        this.toast.warn(`${where} call`, e.text);
        break;
    }
  }

  injectNarration(text: string): void {
    if (!this.conversationActive()) return;
    this._session?.injectNarration(text);
  }

  /**
   * Read a question / plan / permission card aloud (docs/40 §1, #63).
   *
   * Spoken here, on the phone, from the card itself, so it is identical for
   * every workflow and every CLI — and so the bridge's hardcoded permission
   * and askpass narration lines can go away. It goes through the normal TTS
   * queue, so barge-in and tts_interrupt work and a spoken answer resolves
   * the card the way it already did.
   */
  speakPromptCard(request: ApprovalRequest): void {
    if (!this.conversationActive()) return;
    if (hasSpokenPrompt(request.request_id)) return;
    const mode = (this.voiceProviders.data()?.tts.readPrompts ?? 'question') as ReadPromptsMode;
    const lines = promptSpeechLines(request, mode);
    if (lines.length === 0) return;
    markPromptSpoken(request.request_id);
    for (const line of lines) this._session?.injectNarration(line);
  }

  /** Typed message for cascade workflows — same turn path as voice (queued while agent runs). */
  async sendTextMessage(text: string, media?: TurnMediaRef): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed && !(media && media.ids.length > 0)) return false;

    if (!this._session) {
      // Joins an in-flight start rather than racing past it.
      await this.startSession();
    }
    const session = this._session;
    if (session instanceof LlmIntelligenceSession) {
      return session.sendTextTurn(trimmed, media);
    }
    // startSession() already said why it could not connect (no project, prepare
    // failed). Telling the user to tap the orb on top of that is just noise.
    if (this.startAttemptFailed) {
      this.startAttemptFailed = false;
      return false;
    }
    this.toast.warn('Not connected', 'Tap the orb to start a voice session first.');
    return false;
  }

  addEntry(text: string, role: TranscriptEntry['role']): void {
    this.logs.transcript(role, text);
    this.transcript.update((entries) => {
      const next = [...entries, { id: _nextId++, text, role }];
      return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    });
  }

  private ensureKeepAliveWiring(): void {
    if (this.keepaliveWired) return;
    this.keepaliveWired = true;
    this.keepalive.onHidden(() => {
      this.pauseForegroundVisuals();
    });
    this.keepalive.onVisible(() => {
      this.resumeForegroundVisuals();
      void this.tryResumeAfterBackground();
    });
    if (isNativeShell()) {
      void CallSession.addListener('callEnded', () => {
        if (this.conversationActive()) {
          this.stopSession();
        }
      });
      void CallSession.addListener('incomingCallAnswered', () => {
        void this.push.syncPendingApprovals();
      });
    }
  }

  private async tryResumeAfterBackground(): Promise<void> {
    if (!this.resumeOnVisible) return;
    if (this._session || this.sessionConnecting()) return;
    this.resumeOnVisible = false;
    await this.startSession();
  }

  /**
   * Reconnect the voice session silently after an unexpected foreground drop
   * (network blip, bridge restart). Keeps the keepalive/wake-lock alive across
   * the gap and retries with exponential backoff; only surfaces an error once
   * the retry budget is spent, so a transient blip never alarms the user.
   */
  /** Show the bridge's one-time wake-word-model setup only once per session. */
  private serverPrepareNoted = false;

  /**
   * The bridge is preparing the wake-word model — a one-time launch step, not a
   * connection fault. Surface it clearly and point at the setup/doctor script,
   * which prepares the model ahead of time and avoids this entirely.
   */
  private handleServerModelPrepare(status: {
    phase: 'downloading' | 'unpacking' | 'ready' | 'error';
    label: string;
    fraction: number | null;
    loadedBytes?: number;
    totalBytes?: number | null;
    message?: string;
  }): void {
    if (status.phase === 'ready') {
      if (this.serverPrepareNoted) {
        this.logs.append('info', 'voice', 'Wake-word model ready.');
      }
      this.serverPrepareNoted = false;
      const cur = this.modelDownload();
      if (cur && cur.label.startsWith('One-time setup')) this.modelDownload.set(null);
      return;
    }
    if (status.phase === 'error') {
      this.serverPrepareNoted = false;
      this.modelDownload.set(null);
      this.toast.warn(
        'Wake-word setup failed',
        `${status.message ?? 'preparation failed'} — run the setup or doctor script to prepare the model, then reconnect.`,
      );
      return;
    }
    // downloading / unpacking — one-time launch setup, not a disconnect.
    if (!this.serverPrepareNoted) {
      this.serverPrepareNoted = true;
      this.toast.info(
        'One-time setup',
        'Preparing the wake-word model on the server. Tip: run the setup or doctor script to prepare it ahead of launch and skip this.',
      );
    }
    this.modelDownload.set({
      phase: status.phase,
      label: 'One-time setup — wake-word model',
      loadedBytes: status.loadedBytes ?? 0,
      totalBytes: status.totalBytes ?? null,
      fraction: status.fraction,
      step: 1,
      stepCount: 1,
    });
  }

  private scheduleSilentReconnect(reason: string): void {
    // Tear down the dead session but keep audio/keepalive (and the wake lock).
    this.stopSession({ userInitiated: false, keepKeepalive: true });
    if (this.reconnectAttempts >= VoiceSessionService.MAX_SILENT_RECONNECTS) {
      this.reconnecting = false;
      this.reconnectAttempts = 0;
      this.toast.warn('Voice disconnected', reason);
      this.notifyVoiceError(reason);
      return;
    }
    this.reconnecting = true;
    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(4000, 400 * 2 ** (attempt - 1));
    this.logs.append('info', 'voice', `Reconnecting… (attempt ${attempt})`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Watchdog: if an attempt stalls (bridge still down, prepare HTTP hanging),
      // abort it so the catch schedules the next backoff — or gives up quietly
      // once the budget is spent — rather than hanging silently forever.
      const watchdog = setTimeout(() => this.prepareAbort?.abort(), 12_000);
      void this.startSession().finally(() => clearTimeout(watchdog));
    }, delay);
  }

  private syncAppState(): void {
    if (this._jobRunning()) {
      this.appState.transitionTo('working');
      return;
    }
    if (this._voiceActivated()) {
      this.appState.transitionTo('listening');
    } else if (this.conversationActive()) {
      this.appState.transitionTo('inactive');
    } else {
      this.appState.transitionTo('idle');
    }
  }

  private buildCallbacks(): SessionCallbacks {
    return {
      onState: (s) => {
        if (s === 'connected') {
          this.conversationActive.set(true);
          this._voiceActivated.set(false);
          this.startMeterPoll();
          this.syncAppState();
          void this.keepalive.start({
            title: 'Squeakr',
            artist: 'Voice session active',
            // CallKit / Android FGS keep audio alive with the screen off.
            // Holding a screen wake lock is the largest iPhone battery cost.
            holdScreen: !this.nativeCallStarted,
            silentAudio: !this.nativeCallStarted,
          });
        }
        if (s === 'error') {
          const message = 'Voice connection failed — check bridge connection and AWS keys.';
          this.toast.error('Voice connection failed', message);
          this.notifyVoiceError(message);
          this.stopSession();
        }
      },
      onUserTranscript: (text) => this.addEntry(text, 'user'),
      onAssistantTranscript: (text) => {
        this.addEntry(text, 'assistant');
        // MCP speak() already drives TTS via the `speak` WS event. Scheduling fallback
        // here replays the same line after playback when assistant_transcript follows speak().
        const cursorVoiceTts =
          this.voiceProviders.data()?.tts.agentSpeechEnabled ?? true;
        if (!cursorVoiceTts) {
          scheduleTtsFallback(text, () => this._speaking());
        }
      },
      onSpeaking: (speaking) => {
        if (speaking) cancelTtsFallback();
        this._speaking.set(speaking);
        this.bridge.sendSpeakingState(speaking);
      },
      onWorking: (working) => {
        this._jobRunning.set(working);
        if (working) {
          this.appState.transitionTo('working');
        } else {
          this.syncAppState();
        }
      },
      onToolActivity: (event) => {
        this.toolActivity.set({ ...event, at: Date.now() });
        const workflow = this.bridge.settings()?.workflow.default ?? 'agent_native';
        if (workflow === 'llm_intelligence') {
          this.logs.voiceLog(
            'tool',
            event.phase === 'error' ? 'error' : 'info',
            event.label,
            event.detail,
          );
        }
        if (event.phase === 'start') {
          this._jobRunning.set(true);
          this.appState.transitionTo('working');
        } else if (event.phase === 'done' || event.phase === 'error') {
          this._jobRunning.set(false);
          this.syncAppState();
        }
      },
      onVoiceAgentStatus: (event) => {
        this.agentStatus.set({ ...event, at: Date.now() });
        const sid = event.sessionId ? `${event.sessionId.slice(0, 8)}…` : 'pending';
        // Name the CLI that is actually running. "Voice agent starting" read as
        // if Squeakr were narrating its own internals, and the old hardcoded
        // "Cursor agent" was outright wrong under Codex / Claude Code.
        const agent = event.providerName ?? this.agentProviders.activeProviderName();
        const label =
          event.state === 'starting'
            ? `${agent} starting — pid ${event.pid}, run ${event.runId.slice(0, 8)}…`
            : event.state === 'running'
              ? `${agent} running — pid ${event.pid}, session ${sid}`
              : event.state === 'done'
                ? `${agent} finished — session ${sid}`
                : `${agent} ${event.state} — pid ${event.pid}`;
        this.logs.append('info', 'voice', label);
      },
      onClosed: (reason) => {
        const backgrounded =
          typeof document !== 'undefined' && document.hidden;
        if (backgrounded) {
          this.resumeOnVisible = true;
          this.stopSession({ userInitiated: false, keepKeepalive: true });
          return;
        }
        // Foreground drop (network blip, bridge restart): reconnect silently
        // with backoff, keeping the keepalive/wake-lock alive across the gap.
        this.scheduleSilentReconnect(reason ?? 'connection lost');
      },
      onServerModelPrepare: (status) => this.handleServerModelPrepare(status),
      onActivated: (phrase) => {
        this.logs.append(
          'info',
          'voice',
          phrase === '(direct stream)' ? 'Direct audio stream open' : `Wake phrase heard — "${phrase}"`,
        );
        this._voiceActivated.set(true);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.syncAppState();
        if (phrase === '(direct stream)') {
          this.toast.success('Streaming', 'Direct audio stream — just talk; the agent hears you as you go.', false);
        } else if (phrase !== '(typed input)') {
          this.toast.success('Listening', 'Activation phrase heard — speak your request.', false);
        }
      },
      onDeactivated: () => {
        this._voiceActivated.set(false);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.syncAppState();
      },
      onWakeRejected: (heard, expectedWake) => {
        this.logs.append('info', 'voice', `Wake rejected — heard "${heard}"`);
        this.toast.warn(
          `Say "${expectedWake}" first`,
          `Heard: "${heard.slice(0, 80)}". Other speech is ignored until you activate.`,
        );
      },
      onSttError: (message) => {
        this.logs.append('error', 'voice', 'STT error', message);
        this.toast.error('Speech input error', message);
        this.notifyVoiceError(message);
      },
      onTurnError: (message) => {
        this.logs.append('error', 'voice', 'Request failed', message);
        this.toast.error('Request failed', message);
        this.notifyVoiceError(message);
      },
      onTurnComplete: () => {
        this.toolActivity.set(null);
        this.submittingTurn.set(false);
      },
      onTtsBargeIn: (summary) => {
        this.logs.append('info', 'voice', 'Speech interrupted — listening', summary);
      },
      onVadArmed: () => {
        this.vadListening.set(true);
        this.endPhraseArmed.set(false);
        this.submittingTurn.set(false);
        this.logs.append('info', 'voice', 'Silero VAD armed — pause when finished speaking');
      },
      onVadDetected: () => {
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.submittingTurn.set(true);
        this.logs.append('info', 'voice', 'Speech ended (VAD) — stopping mic, submitting');
      },
      onEndPhraseArmed: (phrase) => {
        this.endPhraseArmed.set(true);
        this.vadListening.set(false);
        this.submittingTurn.set(false);
        this.logs.append('info', 'voice', `End phrase armed — say "${phrase}" when finished`);
      },
      onEndPhraseDetected: (phrase) => {
        this.endPhraseArmed.set(false);
        this.vadListening.set(false);
        this.submittingTurn.set(true);
        this.logs.append('info', 'voice', `End phrase heard — "${phrase}" (stopping mic, submitting)`);
      },
      onTurnSubmitted: (reason) => {
        this.submittingTurn.set(false);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this.logs.append(
          'info',
          'voice',
          reason === 'vad'
            ? 'Turn sent (Silero VAD)'
            : reason === 'end_word'
              ? 'Turn sent (end phrase)'
              : 'Turn sent (silence)',
          undefined,
          'pipeline',
        );
      },
      onTurnDiscarded: (reason) => {
        // The error itself was already toasted via onSttError; this only
        // clears the in-flight state so the Cancel control goes away (#41).
        this.submittingTurn.set(false);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this._voiceActivated.set(false);
        this.toolActivity.set(null);
        this.syncAppState();
        this.logs.append('info', 'voice', `Turn discarded — ${reason}`, undefined, 'pipeline');
      },
      onTurnCancelled: (phrase) => {
        this.submittingTurn.set(false);
        this.vadListening.set(false);
        this.endPhraseArmed.set(false);
        this._voiceActivated.set(false);
        this.syncAppState();
        this.logs.append('info', 'voice', `Turn cancelled — "${phrase}"`);
        this.toast.info('Cancelled', 'Turn discarded — back to wake listen.');
      },
      onVoiceLog: (event) => {
        this.logs.voiceLog(event.subcategory, event.level, event.summary, event.detail);
      },
      relayToolCall: async (callId, name, args) => {
        this.onToolActivityLocal(name, 'start', args);
        try {
          const result = await this.bridge.relayToolCall(callId, name, args);
          this.onToolActivityLocal(name, 'done', result);
          return result;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          this.onToolActivityLocal(name, 'error', { error: detail });
          throw err;
        }
      },
    };
  }

  private onToolActivityLocal(
    tool: string,
    phase: 'start' | 'done' | 'error',
    payload: unknown,
  ): void {
    const label = this.formatToolLabel(tool, phase, payload);
    const detail =
      phase === 'error' && payload && typeof payload === 'object'
        ? String((payload as Record<string, unknown>)['error'] ?? '')
        : undefined;
    this.toolActivity.set({ tool, phase, label, detail, at: Date.now() });
    this.logs.voiceLog(
      'tool',
      phase === 'error' ? 'error' : 'info',
      label,
      detail,
    );
    if (phase === 'start') {
      this._jobRunning.set(true);
      this.appState.transitionTo('working');
    } else {
      this._jobRunning.set(false);
      this.syncAppState();
    }
  }

  private formatToolLabel(
    tool: string,
    phase: 'start' | 'done' | 'error',
    payload: unknown,
  ): string {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (phase === 'error') {
      return `${tool.replace(/_/g, ' ')} — failed`;
    }
    const agent = this.agentProviders.activeProviderName();
    if (phase === 'done') {
      if (tool === 'agent_job_status' && typeof p['activity'] === 'string') {
        const pid = typeof p['cli_pid'] === 'number' ? ` [pid ${p['cli_pid']}]` : '';
        return `Progress${pid} → ${p['activity']}`;
      }
      if (tool === 'agent_ask') return `${agent} answered`;
      if (tool === 'agent_submit') return 'Job started';
      return `${tool.replace(/_/g, ' ')} — done`;
    }
    switch (tool) {
      case 'agent_set_project':
        return `Setting project → ${String(p['project'] ?? '')}`;
      case 'agent_ask':
        return `Asking ${agent} → ${String(p['question'] ?? '').slice(0, 60)}`;
      case 'agent_submit':
        return `Sending to ${agent} → ${String(p['prompt'] ?? '').slice(0, 72)}`;
      case 'agent_job_status':
        return `Checking ${agent} progress`;
      default:
        return tool.replace(/_/g, ' ');
    }
  }

  /** Orb FFT + canvas are wasted while the screen is off. Wake-word Vosk stays up. */
  private pauseForegroundVisuals(): void {
    this.pauseMeterPoll();
    this._session?.pauseVisualMeter();
  }

  private resumeForegroundVisuals(): void {
    if (!this.conversationActive()) return;
    this._session?.resumeVisualMeter();
    if (!this.meterRaf) this.startMeterPoll();
  }

  private startMeterPoll(): void {
    this.pauseMeterPoll();
    let lastTs = 0;
    const minFrameMs = 1000 / 30;
    const tick = (ts: number): void => {
      this.meterRaf = requestAnimationFrame(tick);
      if (typeof document !== 'undefined' && document.hidden) return;
      if (ts - lastTs < minFrameMs) return;
      lastTs = ts;
      const next = getVoiceAudioMeter().sample();
      const prev = this._audioSpectrum();
      if (next.active < 0.01 && prev.active < 0.01) return;
      this._audioSpectrum.set(next);
    };
    this.meterRaf = requestAnimationFrame(tick);
  }

  private pauseMeterPoll(): void {
    if (this.meterRaf) cancelAnimationFrame(this.meterRaf);
    this.meterRaf = 0;
  }

  private stopMeterPoll(): void {
    this.pauseMeterPoll();
    disposeVoiceAudioMeter();
    this._audioSpectrum.set({
      bins: new Array(32).fill(0),
      mic: 0,
      out: 0,
      active: 0,
    });
  }

  /** Error earcon + optional spoken alert per voice TTS settings. */
  private notifyVoiceError(message: string): void {
    const trimmed = message.trim();
    if (!trimmed) return;

    const session = this._session;
    if (session instanceof LlmIntelligenceSession) {
      session.notifyError(trimmed);
      return;
    }

    const tts = this.voiceProviders.data()?.tts;
    if (tts?.errorSoundEnabled ?? true) {
      playVoiceCueNow('error', { force: true });
    }
  }
}
