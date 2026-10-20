/**
 * Plays the agent's own audio streams (docs/47) — `agent_audio` frames on the
 * voice socket: `open`, `chunk` (base64 PCM16LE mono), `end`, `stop`.
 *
 *   queue — the stream takes a place in the speech queue (TtsPile) as one
 *           "line": speech queued after it waits, and it waits for the line
 *           ahead. A barge-in pauses it like speech; a cancel resumes it.
 *   async — starts at once on its own scheduler, mixed with everything else.
 *
 * Either way a stream joins when its first audio arrives, not when it is
 * opened: an agent takes seconds between tool calls, and an empty stream must
 * not hold the speech queue (or keep the mic paused) meanwhile.
 *
 * Chunks are kept as bytes and handed to the PcmScheduler only a couple of
 * seconds ahead of the playhead, so a long clip never sits in memory as
 * decoded AudioBuffers. A stream that runs dry without being closed steps
 * aside after DRY_MS — it must not hold the speech queue (and so the mic)
 * while the agent is busy elsewhere — and picks up again, at the back of the
 * queue for `queue` streams, when more audio arrives. What each stream is doing (playing / ended /
 * stopped) is reported back to the bridge for the agent's stream log.
 */

import { PcmScheduler, type PcmContextLike } from './pcm-scheduler.js';
import type { TtsPlayContext } from './tts-interrupt.js';

/** How far ahead of the playhead audio is scheduled, seconds. */
const LEAD_SEC = 2;
const TICK_MS = 250;
/** An open stream with nothing left to play steps aside after this long. */
const DRY_MS = 1500;
/** Prefix that marks a TtsPile line as an agent audio stream, not text. */
const TOKEN_PREFIX = '🔊 audio';

export type AgentAudioState = 'playing' | 'ended' | 'stopped' | 'error';

export interface AgentAudioDeps {
  context(): PcmContextLike;
  /** A node to play one stream through at `volume` (a GainNode), and how to release it. */
  output(volume: number): { node: unknown; release(): void };
  /** Queue a stream in the speech pile as `line`. */
  enqueueLine(line: string): void;
  report(streamId: string, state: AgentAudioState, message?: string): void;
  log?(summary: string, detail?: string): void;
  /** Some async stream is (or is no longer) audible — keep it out of the mic. */
  onAsyncActiveChange?(active: boolean): void;
  /** False when the user turned agent audio off on this device. */
  enabled?(): boolean;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

interface ClientStream {
  id: string;
  label: string;
  mode: 'queue' | 'async';
  volume: number;
  rate: number;
  line: string;
  chunks: Uint8Array[];
  ended: boolean;
  stopped: boolean;
  /** Wakes the feeder when a chunk, end or stop arrives. */
  wake: (() => void) | null;
  /** The async stream's own abort. */
  abort: AbortController | null;
  /** Queued in the pile or playing — false while it has stepped aside, dry. */
  active: boolean;
  reported: AgentAudioState | null;
}

type PlayOutcome = 'ended' | 'dry' | 'aborted' | 'failed';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class AgentAudioPlayer {
  private readonly streams = new Map<string, ClientStream>();
  private readonly byLine = new Map<string, ClientStream>();
  private asyncPlaying = 0;

  constructor(private readonly deps: AgentAudioDeps) {}

  /** Is this pile line an agent audio stream rather than text to speak? */
  isStreamLine(line: string): boolean {
    return this.byLine.has(line);
  }

  get asyncActive(): boolean {
    return this.asyncPlaying > 0;
  }

  handle(msg: Record<string, unknown>): void {
    const id = typeof msg['stream_id'] === 'string' ? msg['stream_id'] : '';
    if (!id) return;
    switch (msg['op']) {
      case 'open':
        this.open(id, msg);
        break;
      case 'chunk': {
        const s = this.streams.get(id);
        if (!s || s.stopped || typeof msg['pcm'] !== 'string') return;
        s.chunks.push(base64ToBytes(msg['pcm']));
        if (s.active) s.wake?.();
        else this.activate(s);
        break;
      }
      case 'end': {
        const s = this.streams.get(id);
        if (!s) return;
        s.ended = true;
        s.wake?.();
        // Stepped aside with nothing left: it is over.
        if (!s.active && s.chunks.length === 0) {
          this.report(s, 'ended');
          this.forget(s);
        }
        break;
      }
      case 'stop': {
        const s = this.streams.get(id);
        if (!s) return;
        this.stopStream(s);
        break;
      }
      default:
        break;
    }
  }

  private open(id: string, msg: Record<string, unknown>): void {
    if (this.streams.has(id)) return;
    const label = typeof msg['label'] === 'string' && msg['label'] ? msg['label'] : id;
    const mode = msg['mode'] === 'async' ? 'async' : 'queue';
    const s: ClientStream = {
      id,
      label,
      mode,
      volume: typeof msg['volume'] === 'number' ? Math.max(0, Math.min(1, msg['volume'])) : 1,
      rate: typeof msg['sample_rate'] === 'number' && msg['sample_rate'] > 0 ? msg['sample_rate'] : 24_000,
      line: `${TOKEN_PREFIX} "${label}" (${id})`,
      chunks: [],
      ended: false,
      stopped: false,
      wake: null,
      abort: null,
      active: false,
      reported: null,
    };
    if (this.deps.enabled && !this.deps.enabled()) {
      this.streams.set(id, s);
      this.stopStream(s, 'agent audio is off on this device');
      return;
    }
    this.streams.set(id, s);
    this.deps.log?.(`Agent audio "${label}" (${mode})`, id);
    if (mode === 'queue') this.byLine.set(s.line, s);
  }

  /** Into the speech queue (queue) or straight to the speaker (async). */
  private activate(s: ClientStream): void {
    s.active = true;
    if (s.mode === 'queue') {
      this.deps.enqueueLine(s.line);
      return;
    }
    s.abort = new AbortController();
    this.setAsync(+1);
    void this.play(s, s.abort.signal).then((outcome) => {
      this.setAsync(-1);
      if (outcome === 'dry') s.active = false;
    });
  }

  /** TtsPile's turn for a queued stream. Resolves when it has played, ran dry, or was cut. */
  async playQueued(line: string, ctx: TtsPlayContext): Promise<void> {
    const s = this.byLine.get(line);
    if (!s) return;
    const outcome = await this.play(s, ctx.signal, ctx.onStart);
    if (outcome === 'dry') {
      s.active = false;
      return;
    }
    // Paused by a barge-in: keep it, the pile may resume this line.
    if (outcome === 'aborted' && !s.stopped) return;
    this.forget(s);
  }

  /** The pile dropped these lines without playing them (interrupt / new turn). */
  discardLines(lines: readonly string[]): void {
    for (const line of lines) {
      const s = this.byLine.get(line);
      if (s) this.stopStream(s, 'dropped from the speech queue');
    }
  }

  /** Everything off — the session is closing or the user stopped the agent. */
  stopAll(): void {
    for (const s of [...this.streams.values()]) this.stopStream(s);
  }

  /** Stop the async streams only (a hard interrupt; queued ones go with the pile). */
  stopAsync(): void {
    for (const s of [...this.streams.values()]) if (s.mode === 'async') this.stopStream(s);
  }

  private stopStream(s: ClientStream, message?: string): void {
    s.stopped = true;
    s.chunks.length = 0;
    s.abort?.abort();
    s.wake?.();
    this.report(s, 'stopped', message);
    this.forget(s);
  }

  private forget(s: ClientStream): void {
    this.streams.delete(s.id);
    this.byLine.delete(s.line);
  }

  private report(s: ClientStream, state: AgentAudioState, message?: string): void {
    if (s.reported === state) return;
    s.reported = state;
    this.deps.report(s.id, state, message);
  }

  private setAsync(delta: number): void {
    const was = this.asyncPlaying > 0;
    this.asyncPlaying = Math.max(0, this.asyncPlaying + delta);
    if (was !== this.asyncPlaying > 0) this.deps.onAsyncActiveChange?.(this.asyncPlaying > 0);
  }

  private wait(s: ClientStream, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
      const clearTimer = this.deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
      const done = () => {
        clearTimer(timer);
        signal.removeEventListener('abort', done);
        s.wake = null;
        resolve();
      };
      const timer = setTimer(done, TICK_MS);
      s.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  private async play(s: ClientStream, signal: AbortSignal, onStart?: () => void): Promise<PlayOutcome> {
    if (s.stopped || signal.aborted) return 'aborted';
    let out: { node: unknown; release(): void };
    let scheduler: PcmScheduler;
    try {
      out = this.deps.output(s.volume);
      scheduler = new PcmScheduler(this.deps.context(), out.node, s.rate, {
        onStart: () => {
          this.report(s, 'playing');
          onStart?.();
        },
      });
    } catch (err) {
      this.report(s, 'error', err instanceof Error ? err.message : String(err));
      this.forget(s);
      return 'failed';
    }
    try {
      let dryTicks = 0;
      while (!s.stopped && !signal.aborted) {
        let fed = false;
        while (s.chunks.length > 0 && scheduler.aheadSec < LEAD_SEC) {
          scheduler.push(s.chunks.shift()!);
          fed = true;
        }
        if (s.ended && s.chunks.length === 0) break;
        if (fed || s.chunks.length > 0 || scheduler.aheadSec > 0) dryTicks = 0;
        else if (++dryTicks * TICK_MS >= DRY_MS) {
          await scheduler.finish();
          return 'dry';
        }
        await this.wait(s, signal);
      }
      if (s.stopped || signal.aborted) {
        scheduler.stop();
        return 'aborted';
      }
      await Promise.race([
        scheduler.finish(),
        new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
      ]);
      if (signal.aborted) {
        scheduler.stop();
        return 'aborted';
      }
      this.report(s, 'ended');
      this.forget(s);
      return 'ended';
    } catch (err) {
      scheduler.stop();
      this.report(s, 'error', err instanceof Error ? err.message : String(err));
      this.forget(s);
      return 'failed';
    } finally {
      out.release();
    }
  }
}
