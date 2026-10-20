/**
 * A voice call on a channel — the platform-free half of "call Squeakr on
 * Discord".
 *
 * Shaped like the direct audio stream (docs/41) because that is what a call
 * is: speech arrives continuously, each speaker's audio is cut into segments,
 * transcribed and handed to the voice agent as it lands
 * (voice/streamTurns.ts). Two differences from the phone pipe:
 *
 *   - Platforms send no audio while someone is silent, so a pause cannot be
 *     heard — the adapter calls `speakerPaused()` when the platform says a
 *     speaker stopped, and the segment is cut then.
 *   - Replies come back here. The call registers as a voice session (so the
 *     agent's speak() works with no phone connected) and as a listener (so
 *     the away policies see someone there); each line is synthesized as a
 *     stream (`stream: true`, docs/30) and played as its chunks arrive.
 *
 * Speaking over the agent interrupts it: the line playing is cut and the
 * queued ones dropped, like a barge-in on the phone.
 *
 * The agent's own audio streams (docs/47) play here too. A call has one
 * voice and no mixer, so a `queue` stream takes its place among the replies
 * and an `async` one goes to the front and plays next — it cannot play
 * under speech the way it does on the phone.
 *
 * And it is the phone's voice session: the same server settings decide when
 * speech is a request — input mode, wake words, VAD or end phrase, silence
 * (`settings.voice`, callTurns.ts) — and it plays the same cues (listening when
 * the call opens or the start phrase is heard, sent when a request goes to the
 * agent, cancel, error), after an optional spoken greeting. What the agent is
 * doing (tool calls, status) is reported through `onActivity`.
 *
 * Everything that happens on the call is also mirrored to the app (the PWA's
 * control socket) as `channel_call` frames — start and end, every phrase
 * heard, every line spoken, every cue played, activity and notices — so the
 * phone shows the call and plays the same sound effects as it happens.
 */

import { getConfig } from '../config.js';
import { childLogger } from '../log.js';
import { registerVoiceSession } from '../mcp/server/voiceToolHandlers.js';
import { hasServerSpeechInput, transcribe } from '../providers/speech/input/service.js';
import { hasServerSpeechOutput, synthesize } from '../providers/speech/output/service.js';
import type { PcmStream } from '../providers/speech/output/types.js';
import { recordTranscriptEvent } from '../logging/transcripts.js';
import { getPresence } from '../state/presence.js';
import { isControlSocketOpen, pushToPhone } from '../state/controlSocket.js';
import { AudioStreamPipe } from '../voice/audioStream/pipe.js';
import type { SegmenterOptions } from '../voice/audioStream/segmenter.js';
import { prepareAgentForChannels } from './prepare.js';
import { cueStream, type CallCue } from './cues.js';
import { CallTurns, type CallTurnSettings, type TurnVerdict } from './callTurns.js';
import { deliverStreamTurn, type StreamTurnOutcome } from '../voice/streamTurns.js';
import { reportAgentAudioPlayback } from '../mcp/server/audioStreamToolHandlers.js';

const log = childLogger('channels:voice-call');

export interface VoiceCallSink {
  /** Play one reply as it is synthesized. Resolves when it has played, or was stopped. */
  play(pcm: PcmStream, signal: AbortSignal): Promise<void>;
}

/** One `channel_call` frame for the app, minus the call's name and source. */
export type CallMirrorEvent =
  | { event: 'started'; wake: boolean }
  | { event: 'ended' }
  | { event: 'heard'; speaker: string; text: string; state: 'request' | 'armed' | 'held' | 'cancel' | 'ignored' }
  | { event: 'reply'; text: string; own: boolean }
  | { event: 'cue'; cue: CallCue }
  | { event: 'activity'; line: string }
  | { event: 'notice'; text: string };

export interface VoiceCallDeps {
  transcribe(pcm: Buffer, signal: AbortSignal): Promise<{ text: string; provider?: string }>;
  deliver(text: string, source: string): StreamTurnOutcome;
  synthesize(text: string, signal: AbortSignal): Promise<PcmStream | null>;
  registerVoiceSession(send: (payload: unknown) => void, name: string): () => void;
  registerPresence(): { release(): void } | null;
  /** Where speech is cut — `settings.voice.stream`, as for the phone's direct stream. */
  segmentSettings(): Omit<SegmenterOptions, 'sampleRate'>;
  /** The phone's voice-session settings: input mode, wake words, VAD / end phrase. */
  turnSettings(): CallTurnSettings;
  /** Make sure the agent CLI can reach the bridge (first turn waits for it). */
  prepare(): Promise<void>;
  /** Send one frame to the app; dropped when no app is connected. */
  mirror(frame: Record<string, unknown>): void;
  /** Tell the agent's stream log what the call did with one of its audio streams. */
  reportAudio(client: string, streamId: string, state: 'playing' | 'ended' | 'stopped', message?: string): void;
}

export interface VoiceCallOptions {
  /** "Discord call in #dev" — logs, transcript and the voice-session name. */
  name: string;
  /** Turn source recorded with every turn: `discord`, `telegram`, … */
  source: string;
  sink: VoiceCallSink;
  /** Mirror of the conversation, e.g. into the text channel the call was started from. */
  onLine?(line: { who: 'user' | 'agent'; speaker?: string; text: string }): void;
  /** Problems worth telling the people on the call about. */
  onNotice?(text: string): void;
  /** What the agent is doing — tool calls, status — one line at a time. */
  onActivity?(line: string): void;
  /** Play the phone's cues into the call. Default on. */
  cues?: boolean;
  /** Something the call cannot go on without happened, was said, and the call should end ("stream broken"). */
  onBroken?(reason: string): void;
  /** Spoken when the call opens ("Squeakr here — continuing …"). */
  greeting?: string;
  deps?: Partial<VoiceCallDeps>;
}

const defaultDeps: VoiceCallDeps = {
  transcribe: async (pcm, signal) => {
    const r = await transcribe(pcm, { signal });
    return { text: r.text, provider: r.provider };
  },
  deliver: deliverStreamTurn,
  synthesize: async (text, signal) => {
    const spoken = await synthesize(text, { stream: true, signal });
    return spoken.pcm ?? null;
  },
  registerVoiceSession,
  registerPresence: () => getPresence().register({ kind: 'channel_call' }),
  segmentSettings: () => getConfig().settings.voice.stream,
  turnSettings: () => {
    const v = getConfig().settings.voice;
    return { inputMode: v.inputMode, wakeWordsEnabled: v.wakeWordsEnabled !== false, wakeWords: v.wakeWords, turnSubmit: v.turnSubmit };
  },
  prepare: prepareAgentForChannels,
  mirror: (frame) => {
    if (isControlSocketOpen()) pushToPhone(frame);
  },
  reportAudio: (client, streamId, state, message) =>
    reportAgentAudioPlayback(client, { stream_id: streamId, state, ...(message ? { message } : {}) }),
};

/**
 * An open agent audio stream with nothing left to play steps aside after this
 * long, so replies are not held behind a stream the agent forgot to close.
 */
const AUDIO_DRY_MS = 1500;

/** One of the agent's audio streams, as this call receives it. */
interface CallAudio {
  id: string;
  label: string;
  volume: number;
  sampleRate: number;
  /** Plays next rather than at the back of the replies. */
  async: boolean;
  chunks: Buffer[];
  ended: boolean;
  stopped: boolean;
  /** In the reply queue or playing — false while it has stepped aside, dry. */
  active: boolean;
  wake: (() => void) | null;
}

interface CallLine {
  text: string;
  ownLine: boolean;
  /** Set when this "line" is an agent audio stream rather than text to speak. */
  audio?: CallAudio;
}

function scalePcm16(pcm: Buffer, volume: number): Buffer {
  if (volume >= 1) return pcm;
  const out = Buffer.alloc(pcm.length - (pcm.length % 2));
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(Math.round(pcm.readInt16LE(i) * volume), i);
  return out;
}

interface Speaker {
  pipe: AudioStreamPipe;
  name: string;
}

export class VoiceCall {
  private readonly deps: VoiceCallDeps;
  private readonly speakers = new Map<string, Speaker>();
  private readonly lines: CallLine[] = [];
  private readonly audio = new Map<string, CallAudio>();
  private cueChain: Promise<void> = Promise.resolve();
  /** Read once, when the call starts — as a phone session reads them at auth. */
  readonly turns: CallTurns;
  /** Who spoke last — whose capture the silence timer submits (VAD off). */
  private lastSpeaker: Speaker | null = null;
  private playing: AbortController | null = null;
  private drainLoop: Promise<void> | null = null;
  private unregister: (() => void) | null = null;
  private presence: { release(): void } | null = null;
  /** Hanging up: no new audio, but segments already heard still reach the agent. */
  private closing = false;
  private closed = false;
  private readonly abort = new AbortController();

  constructor(private readonly opts: VoiceCallOptions) {
    this.deps = { ...defaultDeps, ...opts.deps };
    this.turns = new CallTurns(this.deps.turnSettings(), (text) => {
      if (this.lastSpeaker && !this.closed) this.request(this.lastSpeaker, text);
    });
  }

  private mirror(e: CallMirrorEvent): void {
    try {
      this.deps.mirror({ type: 'channel_call', call: this.opts.name, source: this.opts.source, at: Date.now(), ...e });
    } catch (err) {
      log.debug({ err }, 'mirroring the call to the app failed');
    }
  }

  private notice(text: string): void {
    this.mirror({ event: 'notice', text });
    this.opts.onNotice?.(text);
  }

  private activity(line: string): void {
    this.mirror({ event: 'activity', line });
    this.opts.onActivity?.(line);
  }

  get wakeWordsOn(): boolean {
    return this.turns.wakeWords;
  }

  /**
   * Quiet that ends what someone said: the phone's VAD silence in turns mode,
   * the direct stream's segment silence in stream mode.
   */
  get endOfSpeechMs(): number {
    const t = this.turns.settings;
    return t.inputMode === 'stream' ? this.deps.segmentSettings().segmentSilenceMs : t.turnSubmit.silenceMs;
  }

  /** The phone's voice-session settings, as the next call will use them. */
  static turnSettings(): CallTurnSettings {
    return defaultDeps.turnSettings();
  }

  /** What is missing for a call to work at all, or null. */
  static unavailableReason(): string | null {
    if (getConfig().settings.workflow.default !== 'agent_native') {
      return 'Voice calls drive the agent_native voice agent — switch Config → Workflow to agent_native.';
    }
    if (!hasServerSpeechInput()) {
      return 'No server speech-to-text provider is configured (Config → Speech) — a call cannot use the browser recogniser.';
    }
    if (!hasServerSpeechOutput()) {
      return 'No server voice is configured (Config → Speech → output) — the agent would have no way to answer.';
    }
    return null;
  }

  private ready: Promise<boolean> | null = null;

  start(): void {
    // Registered now so the first transcript does not wait on it.
    this.ready = this.deps.prepare().then(
      () => true,
      (err: unknown) => {
        // The agent cannot reach the bridge: nothing said on this call would get anywhere.
        void this.fail(err instanceof Error ? err.message : String(err));
        return false;
      },
    );
    this.unregister = this.deps.registerVoiceSession((payload) => this.onBridgeEvent(payload), this.opts.name);
    this.presence = this.deps.registerPresence();
    recordTranscriptEvent(`${this.opts.name} started`);
    const t = this.turns.settings;
    log.info({ call: this.opts.name, input: t.inputMode, wake: this.wakeWordsOn, vad: this.turns.vad }, 'voice call started');
    this.mirror({ event: 'started', wake: this.wakeWordsOn });
    this.cue('listening');
    if (this.opts.greeting) this.say(this.opts.greeting);
  }

  /**
   * The call cannot go on: post and read the error out, then end it — the
   * adapter hangs up on `onBroken` ("stream broken").
   */
  async fail(reason: string): Promise<void> {
    if (this.closing || this.failed) return;
    this.failed = true;
    log.warn({ call: this.opts.name, reason }, 'voice call broken');
    this.notice(reason);
    this.cue('error', true);
    this.say(`Sorry — ${reason.replace(/[`*_]/g, '')}. I'm ending the call.`);
    // Let it be heard (bounded: a voice that cannot speak must not hold the call open).
    await Promise.race([this.drainLoop ?? Promise.resolve(), new Promise((r) => setTimeout(r, 15_000))]);
    this.opts.onBroken?.(reason);
  }

  private failed = false;

  /** Speak something of the bridge's own (not the agent's) into the call. */
  say(text: string): void {
    this.mirror({ event: 'reply', text, own: true });
    this.enqueue(text, true);
  }

  /**
   * One of the phone's cues. Skipped while a reply is playing (it would cut
   * the reply off) unless `force` — errors should always be heard.
   */
  cue(name: CallCue, force = false): void {
    if (this.opts.cues === false || this.closed) return;
    if (this.playing && !force) return;
    this.mirror({ event: 'cue', cue: name });
    this.cueChain = this.cueChain
      .then(() => this.opts.sink.play(cueStream(name), this.abort.signal))
      .catch(() => undefined);
  }

  get speakerCount(): number {
    return this.speakers.size;
  }

  get isSpeaking(): boolean {
    return this.playing !== null;
  }

  /** 16 kHz mono PCM16 from one participant. */
  pushAudio(speakerId: string, speakerName: string, pcm: Buffer): void {
    if (this.closing) return;
    this.speakerFor(speakerId, speakerName).pipe.push(pcm);
  }

  /** The platform says this participant stopped talking — cut their segment now. */
  speakerPaused(speakerId: string): void {
    this.speakers.get(speakerId)?.pipe.flush();
  }

  /** Cut the agent off: stop the line playing, drop the rest. */
  interrupt(): void {
    for (const line of this.lines) if (line.audio) this.dropAudio(line.audio, 'interrupted');
    this.lines.length = 0;
    this.playing?.abort();
  }

  private dropAudio(a: CallAudio, message?: string): void {
    a.stopped = true;
    a.chunks.length = 0;
    a.wake?.();
    if (this.audio.delete(a.id)) this.deps.reportAudio(this.opts.name, a.id, 'stopped', message);
  }

  /** `agent_audio` frames from the bridge (docs/47). */
  private onAgentAudio(msg: Record<string, unknown>): void {
    const id = typeof msg['stream_id'] === 'string' ? msg['stream_id'] : '';
    if (!id || this.closed) return;
    const a = this.audio.get(id);
    switch (msg['op']) {
      case 'open': {
        if (a) return;
        const stream: CallAudio = {
          id,
          label: typeof msg['label'] === 'string' && msg['label'] ? msg['label'] : id,
          volume: typeof msg['volume'] === 'number' ? Math.max(0, Math.min(1, msg['volume'])) : 1,
          sampleRate: typeof msg['sample_rate'] === 'number' ? msg['sample_rate'] : 24_000,
          async: msg['mode'] === 'async',
          chunks: [],
          ended: false,
          stopped: false,
          active: false,
          wake: null,
        };
        this.audio.set(id, stream);
        this.activity(`🔊 ${stream.label}`);
        // Queued with its first audio, so an empty stream never holds the replies.
        return;
      }
      case 'chunk':
        if (!a || a.stopped || typeof msg['pcm'] !== 'string') return;
        a.chunks.push(scalePcm16(Buffer.from(msg['pcm'], 'base64'), a.volume));
        if (a.active) a.wake?.();
        else this.queueAudio(a, a.async);
        return;
      case 'end':
        if (!a) return;
        a.ended = true;
        a.wake?.();
        if (!a.active && a.chunks.length === 0 && this.audio.delete(a.id)) {
          this.deps.reportAudio(this.opts.name, a.id, 'ended');
        }
        return;
      case 'stop': {
        if (!a) return;
        const queued = this.lines.findIndex((l) => l.audio === a);
        if (queued >= 0) this.lines.splice(queued, 1);
        this.dropAudio(a);
        return;
      }
      default:
        return;
    }
  }

  /** Into the reply queue: at the back, or (async) next. */
  private queueAudio(a: CallAudio, next: boolean): void {
    a.active = true;
    const line: CallLine = { text: a.label, ownLine: false, audio: a };
    if (next) this.lines.unshift(line);
    else this.lines.push(line);
    this.drainLoop ??= this.drain().finally(() => {
      this.drainLoop = null;
    });
  }

  /** Play one agent audio stream into the call as its chunks arrive. */
  private async playAudio(a: CallAudio, signal: AbortSignal): Promise<void> {
    if (a.stopped) return;
    let dry = false;
    const onAbort = () => a.wake?.();
    signal.addEventListener('abort', onAbort, { once: true });
    async function* chunks(): AsyncIterable<Buffer> {
      for (;;) {
        if (a.stopped || signal.aborted) return;
        const next = a.chunks.shift();
        if (next) {
          yield next;
          continue;
        }
        if (a.ended) return;
        const woken = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            a.wake = null;
            resolve(false);
          }, AUDIO_DRY_MS);
          a.wake = () => {
            clearTimeout(timer);
            a.wake = null;
            resolve(true);
          };
        });
        if (!woken && a.chunks.length === 0 && !a.ended) {
          dry = true;
          return;
        }
      }
    }
    this.deps.reportAudio(this.opts.name, a.id, 'playing');
    try {
      await this.opts.sink.play({ sampleRate: a.sampleRate, chunks: chunks() }, signal);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    if (a.stopped) return;
    if (signal.aborted) this.dropAudio(a, 'interrupted');
    else if (dry) {
      // Stepped aside; more audio queues it again, `end` finishes it.
      a.active = false;
      if (a.chunks.length > 0) this.queueAudio(a, false);
    } else if (this.audio.delete(a.id)) this.deps.reportAudio(this.opts.name, a.id, 'ended');
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    // What was said right before hanging up still reaches the agent.
    await Promise.all([...this.speakers.values()].map((s) => s.pipe.drain().catch(() => undefined)));
    this.closed = true;
    this.turns.dispose();
    for (const s of this.speakers.values()) s.pipe.close();
    this.speakers.clear();
    this.interrupt();
    this.abort.abort();
    this.unregister?.();
    this.presence?.release();
    recordTranscriptEvent(`${this.opts.name} ended`);
    log.info({ call: this.opts.name }, 'voice call ended');
    this.mirror({ event: 'ended' });
  }

  private speakerFor(id: string, name: string): Speaker {
    const existing = this.speakers.get(id);
    if (existing) return existing;
    const speaker: Speaker = {
      name,
      pipe: new AudioStreamPipe({
        segmenter: { sampleRate: 16_000, ...this.deps.segmentSettings(), segmentSilenceMs: this.endOfSpeechMs },
        transcribe: async (pcm, signal) => {
          await this.ready;
          return this.deps.transcribe(pcm, signal);
        },
        onTranscript: (t) => this.onTranscript(id, t.text),
        onError: (err) => {
          log.warn({ err, call: this.opts.name, speaker: name }, 'call segment transcription failed');
          this.notice(`Could not transcribe ${name}: ${err.message}`);
        },
      }),
    };
    this.speakers.set(id, speaker);
    return speaker;
  }

  private onTranscript(speakerId: string, heard: string): void {
    const speaker = this.speakers.get(speakerId);
    if (!speaker || this.closed) return;
    this.lastSpeaker = speaker;
    const verdict: TurnVerdict = this.turns.feed(heard);
    switch (verdict.action) {
      case 'ignore':
        // Room talk, not addressed to the agent — the app still shows it was heard.
        this.mirror({ event: 'heard', speaker: speaker.name, text: heard, state: 'ignored' });
        return;
      case 'armed':
        if (this.playing || this.lines.length) this.interrupt();
        this.mirror({ event: 'heard', speaker: speaker.name, text: heard, state: 'armed' });
        this.cue('listening', true);
        this.opts.onLine?.({ who: 'user', speaker: speaker.name, text: `${heard} 👂` });
        return;
      case 'buffered':
        if (this.playing || this.lines.length) this.interrupt();
        this.mirror({ event: 'heard', speaker: speaker.name, text: heard, state: 'held' });
        this.opts.onLine?.({ who: 'user', speaker: speaker.name, text: `${heard} …` });
        return;
      case 'cancel':
        this.mirror({ event: 'heard', speaker: speaker.name, text: heard, state: 'cancel' });
        this.cue('cancel', true);
        this.opts.onLine?.({ who: 'user', speaker: speaker.name, text: `${heard} ✋` });
        return;
      case 'deliver':
        this.request(speaker, verdict.text);
    }
  }

  /** One request to the agent — like the phone sending a turn. */
  private request(speaker: Speaker, text: string): void {
    // Talking over the agent is a barge-in.
    if (this.playing || this.lines.length) this.interrupt();
    this.mirror({ event: 'heard', speaker: speaker.name, text, state: 'request' });
    this.opts.onLine?.({ who: 'user', speaker: speaker.name, text });
    // With several people on the call the agent is told who is talking.
    const turn = this.speakers.size > 1 ? `${speaker.name}: ${text}` : text;
    const outcome = this.deps.deliver(turn, this.opts.source);
    if (outcome.ok) this.cue('sent', true);
    else {
      this.cue('error', true);
      this.notice(outcome.message);
    }
  }

  private onBridgeEvent(payload: unknown): void {
    const msg = payload as {
      type?: string;
      text?: unknown;
      label?: unknown;
      detail?: unknown;
      phase?: unknown;
      state?: unknown;
      provider_name?: unknown;
    };
    if (msg?.type === 'tool_activity' && typeof msg.label === 'string') {
      const detail = typeof msg.detail === 'string' && msg.detail.trim() ? `: ${msg.detail.trim().split('\n')[0]!.slice(0, 100)}` : '';
      const icon = msg.phase === 'error' ? '❌' : msg.phase === 'done' ? '✅' : '🔧';
      this.activity(`${icon} ${msg.label}${detail}`);
      return;
    }
    if (msg?.type === 'voice_agent_status' && typeof msg.state === 'string') {
      const who = typeof msg.provider_name === 'string' ? msg.provider_name : 'agent';
      this.activity(`· ${who} ${msg.state}`);
      if (msg.state === 'error') this.cue('error', true);
      return;
    }
    if (msg?.type === 'agent_audio') {
      this.onAgentAudio(payload as Record<string, unknown>);
      return;
    }
    if (msg?.type !== 'speak' || typeof msg.text !== 'string' || !msg.text.trim()) return;
    this.opts.onLine?.({ who: 'agent', text: msg.text });
    this.mirror({ event: 'reply', text: msg.text, own: false });
    this.enqueue(msg.text, false);
  }

  private enqueue(text: string, ownLine: boolean): void {
    this.lines.push({ text, ownLine });
    this.drainLoop ??= this.drain().finally(() => {
      this.drainLoop = null;
    });
  }

  private async drain(): Promise<void> {
    while (this.lines.length && !this.closed) {
      // A cue already started finishes before speech, so they never overlap.
      await this.cueChain;
      // A barge-in while the cue played may have emptied the queue.
      const next = this.lines.shift();
      if (!next || this.closed) break;
      const { text } = next;
      const line = new AbortController();
      const onClose = () => line.abort();
      this.abort.signal.addEventListener('abort', onClose, { once: true });
      this.playing = line;
      try {
        if (next.audio) {
          await this.playAudio(next.audio, line.signal);
          continue;
        }
        const pcm = await this.deps.synthesize(text, line.signal);
        if (!pcm) {
          this.notice('The configured voice cannot stream — pick a server voice in Config → Speech.');
          continue;
        }
        if (!line.signal.aborted) await this.opts.sink.play(pcm, line.signal);
      } catch (err) {
        if (!line.signal.aborted) {
          log.warn({ err, call: this.opts.name }, 'call reply could not be spoken');
          this.notice(`Could not speak the reply: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        this.abort.signal.removeEventListener('abort', onClose);
        if (this.playing === line) this.playing = null;
      }
    }
  }
}
