/**
 * Plays PCM16LE mono as it arrives — each network chunk becomes an
 * AudioBuffer scheduled to start exactly where the previous one ends, so
 * playback begins on the first chunk and runs gaplessly while the rest of
 * the reply is still being synthesized (docs/30 § Streaming).
 *
 * Written against the slice of AudioContext it needs, so it runs on the real
 * thing in the browser and on a fake clock in tests.
 */

export interface PcmBufferLike {
  getChannelData(channel: number): Float32Array;
}

export interface PcmSourceLike {
  buffer: unknown;
  onended: (() => void) | null;
  connect(destination: never): unknown;
  start(when: number): void;
  stop(): void;
  disconnect(): void;
}

export interface PcmContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  createBuffer(channels: number, length: number, sampleRate: number): PcmBufferLike;
  createBufferSource(): PcmSourceLike;
}

export interface PcmSchedulerOptions {
  /**
   * Head start before the first chunk (and after an underrun), seconds. Just
   * enough that the next network chunk lands before this one runs out.
   */
  leadSec?: number;
  /** The first chunk has been scheduled — the line is audible now. */
  onStart?: () => void;
}

const DEFAULT_LEAD_SEC = 0.04;

export class PcmScheduler {
  private carry: number | null = null;
  private nextAt = 0;
  private readonly live = new Set<PcmSourceLike>();
  private started = false;
  private stopped = false;
  private inputDone = false;
  /** Set when the context cannot make buffers at the stream's own rate (old Safari < 22.05 kHz). */
  private resampleTo: number | null = null;
  private resolveEnded!: () => void;
  private readonly ended = new Promise<void>((resolve) => {
    this.resolveEnded = resolve;
  });
  /** Seconds of audio scheduled so far. */
  scheduledSec = 0;

  constructor(
    private readonly ctx: PcmContextLike,
    private readonly destination: unknown,
    private readonly sampleRate: number,
    private readonly opts: PcmSchedulerOptions = {},
  ) {}

  /** Queue the next bytes. A sample split across chunks is carried over. */
  push(bytes: Uint8Array): void {
    if (this.stopped || bytes.byteLength === 0) return;
    let data = bytes;
    if (this.carry !== null) {
      data = new Uint8Array(bytes.byteLength + 1);
      data[0] = this.carry;
      data.set(bytes, 1);
      this.carry = null;
    }
    const samples = data.byteLength >> 1;
    if (data.byteLength & 1) this.carry = data[data.byteLength - 1]!;
    if (samples === 0) return;

    const view = new DataView(data.buffer, data.byteOffset, samples * 2);
    let floats: Float32Array = new Float32Array(samples);
    for (let i = 0; i < samples; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
    let rate = this.sampleRate;
    if (this.resampleTo !== null) {
      floats = resampleLinear(floats, rate, this.resampleTo);
      rate = this.resampleTo;
    }

    let buffer: PcmBufferLike;
    try {
      buffer = this.ctx.createBuffer(1, floats.length, rate);
    } catch {
      if (this.resampleTo !== null) throw new Error(`Cannot play ${this.sampleRate} Hz audio here`);
      this.resampleTo = this.ctx.sampleRate;
      floats = resampleLinear(floats, rate, this.resampleTo);
      rate = this.resampleTo;
      buffer = this.ctx.createBuffer(1, floats.length, rate);
    }
    buffer.getChannelData(0).set(floats);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination as never);
    const lead = this.opts.leadSec ?? DEFAULT_LEAD_SEC;
    // Behind the clock means the network fell behind: re-anchor rather than
    // schedule in the past (which would play the chunk instantly, overlapped).
    const at = Math.max(this.nextAt, this.ctx.currentTime + lead);
    const duration = floats.length / rate;
    this.nextAt = at + duration;
    this.scheduledSec += duration;
    this.live.add(source);
    source.onended = () => {
      this.live.delete(source);
      source.disconnect();
      this.settle();
    };
    source.start(at);
    if (!this.started) {
      this.started = true;
      this.opts.onStart?.();
    }
  }

  /** No more input. Resolves once everything scheduled has played (or `stop()`). */
  finish(): Promise<void> {
    this.inputDone = true;
    this.settle();
    return this.ended;
  }

  /** Silence now and drop anything still queued. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const source of this.live) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // never started or already stopped
      }
      source.disconnect();
    }
    this.live.clear();
    this.resolveEnded();
  }

  get isStarted(): boolean {
    return this.started;
  }

  /** Audio already scheduled but not yet played, seconds. */
  get aheadSec(): number {
    return Math.max(0, this.nextAt - this.ctx.currentTime);
  }

  private settle(): void {
    if (this.inputDone && this.live.size === 0) this.resolveEnded();
  }
}

/** Linear interpolation — only used where the context refuses the stream's rate. */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;
  const length = Math.max(1, Math.round((input.length * to) / from));
  const out = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = input[Math.min(j, input.length - 1)]!;
    const b = input[Math.min(j + 1, input.length - 1)]!;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** `audio/pcm;rate=24000;…` (plus the X-Audio-Sample-Rate header) → its rate, or null if not streamed PCM. */
export function streamedPcmRate(contentType: string | null, rateHeader: string | null): number | null {
  if (!contentType || !/^audio\/pcm\b/i.test(contentType.trim())) return null;
  const rate = Number(rateHeader) || Number(/rate=(\d+)/i.exec(contentType)?.[1]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}
