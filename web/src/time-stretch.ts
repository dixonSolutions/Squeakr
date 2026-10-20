/**
 * Pitch-preserving speed change for server speech (docs/48).
 *
 * `HTMLAudioElement.playbackRate` keeps the pitch, but most server replies do
 * not play through an element: streamed `audio/pcm` goes through the PCM
 * scheduler, and iOS decodes whole files into an AudioBuffer. Changing an
 * AudioBufferSourceNode's playbackRate there would turn the voice into a
 * chipmunk, so the samples themselves are stretched instead.
 *
 * WSOLA (waveform-similarity overlap-add): cut the input into overlapping
 * Hann-windowed frames, read them `speed` times faster than they are written,
 * and nudge each read position by up to a few milliseconds to where the
 * waveform best lines up with the previous frame. The nudge is what stops
 * the phasey "robot" sound of plain overlap-add.
 *
 * Streaming-safe: feed chunks as they arrive, call flush() once at the end.
 * Speed 1 is a pass-through, so the default costs nothing.
 */

/** Frame length — long enough to hold a couple of pitch periods of a low voice. */
const FRAME_SEC = 0.03;
/** How far a read position may move to find a matching waveform. */
const SEEK_SEC = 0.008;

export class WsolaStretcher {
  readonly speed: number;
  private readonly frame: number;
  private readonly hop: number;
  private readonly seek: number;
  private readonly window: Float32Array;

  /** Unconsumed input; `bufStart` is the absolute sample index of buf[0]. */
  private buf = new Float32Array(0);
  private bufLen = 0;
  private bufStart = 0;

  /** Where the next frame should nominally be read from (absolute, fractional). */
  private readPos = 0;
  /** Where the previous frame was actually read from; -1 before the first. */
  private prevPos = -1;
  /** Falling half of the previous frame, waiting for the next one to overlap it. */
  private overlap: Float32Array;

  private totalIn = 0;
  private totalOut = 0;
  private flushed = false;

  constructor(sampleRate: number, speed: number) {
    this.speed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    const frame = Math.max(64, Math.round(sampleRate * FRAME_SEC));
    this.frame = frame - (frame % 2);
    this.hop = this.frame / 2;
    this.seek = Math.max(8, Math.round(sampleRate * SEEK_SEC));
    this.window = new Float32Array(this.frame);
    // Periodic Hann at 50 % overlap sums to exactly 1 — no level ripple.
    for (let i = 0; i < this.frame; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.frame);
    }
    this.overlap = new Float32Array(this.hop);
  }

  get isPassThrough(): boolean {
    return this.speed === 1;
  }

  /** Stretch the next chunk. Output may be shorter or longer than the input, or empty. */
  process(input: Float32Array): Float32Array {
    if (this.flushed) throw new Error('WsolaStretcher: process() after flush()');
    this.totalIn += input.length;
    if (this.isPassThrough) {
      this.totalOut += input.length;
      return input;
    }
    this.append(input);
    return this.run();
  }

  /** No more input — emit the tail, trimmed so the total length is input ÷ speed. */
  flush(): Float32Array {
    if (this.flushed) return new Float32Array(0);
    this.flushed = true;
    if (this.isPassThrough) return new Float32Array(0);

    // Pad with silence so the frames that cover the real tail can be read.
    this.append(new Float32Array(this.frame + 2 * this.seek + Math.ceil(this.hop * this.speed) + 1));
    const realEnd = this.totalIn;
    const emittedBefore = this.totalOut;
    const parts: Float32Array[] = [];
    while (this.prevPos < realEnd) {
      const out = this.run(1);
      if (out.length === 0) break;
      parts.push(out);
    }
    parts.push(this.overlap);

    const target = Math.round(this.totalIn / this.speed);
    const remaining = Math.max(0, target - emittedBefore);
    const tail = concat(parts);
    const result = new Float32Array(remaining);
    result.set(tail.subarray(0, Math.min(remaining, tail.length)));
    this.totalOut = emittedBefore + result.length;
    return result;
  }

  private append(input: Float32Array): void {
    if (this.bufLen + input.length > this.buf.length) {
      const grown = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + input.length));
      grown.set(this.buf.subarray(0, this.bufLen));
      this.buf = grown;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen += input.length;
  }

  /** Emit as many frames as the buffered input allows (or at most `maxFrames`). */
  private run(maxFrames = Infinity): Float32Array {
    const { frame, hop, seek, window } = this;
    const parts: Float32Array[] = [];
    let frames = 0;

    while (frames < maxFrames) {
      const end = this.bufStart + this.bufLen;
      let pos: number;
      if (this.prevPos < 0) {
        if (frame > end) break;
        pos = 0;
      } else {
        const nominal = Math.round(this.readPos);
        if (nominal + seek + frame > end) break;
        pos = this.bestOffset(nominal, this.prevPos + hop);
      }

      const at = pos - this.bufStart;
      const out = new Float32Array(hop);
      if (this.prevPos < 0) {
        // First frame: no previous frame to cross-fade with, so no fade-in.
        out.set(this.buf.subarray(at, at + hop));
      } else {
        for (let i = 0; i < hop; i++) out[i] = this.overlap[i]! + window[i]! * this.buf[at + i]!;
      }
      for (let i = 0; i < hop; i++) this.overlap[i] = window[hop + i]! * this.buf[at + hop + i]!;

      parts.push(out);
      this.totalOut += hop;
      this.prevPos = pos;
      this.readPos += hop * this.speed;
      frames++;
      this.trim();
    }
    return concat(parts);
  }

  /**
   * Read position within ±seek of `nominal` whose start best matches the
   * natural continuation of the previous frame (normalized cross-correlation).
   * Coarse pass on every other sample, then a fine pass around the winner.
   */
  private bestOffset(nominal: number, natural: number): number {
    const lo = Math.max(this.bufStart, nominal - this.seek);
    const hi = nominal + this.seek;
    const ref = natural - this.bufStart;
    const len = this.hop;

    const score = (pos: number, stride: number): number => {
      const at = pos - this.bufStart;
      let dot = 0;
      let energy = 1e-9;
      for (let i = 0; i < len; i += stride) {
        const x = this.buf[at + i]!;
        dot += x * this.buf[ref + i]!;
        energy += x * x;
      }
      return dot / Math.sqrt(energy);
    };

    let best = Math.min(Math.max(nominal, lo), hi);
    let bestScore = -Infinity;
    for (let pos = lo; pos <= hi; pos += 2) {
      const s = score(pos, 2);
      if (s > bestScore) {
        bestScore = s;
        best = pos;
      }
    }
    const coarse = best;
    bestScore = -Infinity;
    for (let pos = Math.max(lo, coarse - 2); pos <= Math.min(hi, coarse + 2); pos++) {
      const s = score(pos, 1);
      if (s > bestScore) {
        bestScore = s;
        best = pos;
      }
    }
    return best;
  }

  /** Drop input no future frame can read: before the previous frame and the next search window. */
  private trim(): void {
    const keepFrom = Math.min(this.prevPos, Math.floor(this.readPos) - this.seek);
    const drop = keepFrom - this.bufStart;
    if (drop <= 0 || drop < this.frame * 4) return;
    this.buf.copyWithin(0, drop, this.bufLen);
    this.bufLen -= drop;
    this.bufStart += drop;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  if (parts.length === 1) return parts[0]!;
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Float32Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Stretch a whole buffer in one go (decoded files, the speech test). */
export function stretchSamples(samples: Float32Array, sampleRate: number, speed: number): Float32Array {
  const stretcher = new WsolaStretcher(sampleRate, speed);
  if (stretcher.isPassThrough) return samples;
  return concat([stretcher.process(samples), stretcher.flush()]);
}

/**
 * The same, for a PCM16LE byte stream: bytes in, bytes out, with a sample
 * split across network chunks carried over — so it can sit in front of the
 * PCM scheduler without the scheduler knowing.
 */
export class Pcm16Stretcher {
  private readonly stretcher: WsolaStretcher;
  private carry: number | null = null;

  constructor(sampleRate: number, speed: number) {
    this.stretcher = new WsolaStretcher(sampleRate, speed);
  }

  get isPassThrough(): boolean {
    return this.stretcher.isPassThrough;
  }

  push(bytes: Uint8Array): Uint8Array {
    if (this.isPassThrough) return bytes;
    return floatsToPcm16(this.stretcher.process(this.decode(bytes)));
  }

  flush(): Uint8Array {
    if (this.isPassThrough) return new Uint8Array(0);
    return floatsToPcm16(this.stretcher.flush());
  }

  private decode(bytes: Uint8Array): Float32Array {
    let data = bytes;
    if (this.carry !== null) {
      data = new Uint8Array(bytes.byteLength + 1);
      data[0] = this.carry;
      data.set(bytes, 1);
      this.carry = null;
    }
    const samples = data.byteLength >> 1;
    if (data.byteLength & 1) this.carry = data[data.byteLength - 1]!;
    const view = new DataView(data.buffer, data.byteOffset, samples * 2);
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / 32768;
    return out;
  }
}

export function floatsToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return out;
}
