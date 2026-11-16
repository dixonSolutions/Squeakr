/**
 * RNNoise for the main interface's microphone — the same suppressor Discord
 * calls use (src/channels/denoise.ts), but as a stream that consumes and
 * produces the same number of samples.
 *
 * RNNoise works on 10 ms frames at 48 kHz and its cleaned frame is always
 * 20 ms behind its input. Only `DENOISE_MIX` of the cleaned signal is used;
 * the rest is the original, delayed by `DENOISE_LAG` so the two line up.
 * Fully cleaned audio made Whisper invent sentences out of background
 * chatter, and lost wake phrases in loud noise (docs/50).
 *
 * The caller keeps one instance for the whole microphone stream: RNNoise
 * learns the room as it goes, so a new instance per utterance would start
 * every turn knowing nothing about the noise.
 */

/** RNNoise works on 10 ms frames at 48 kHz. */
export const DENOISE_RATE = 48_000;
export const DENOISE_FRAME = 480;
/** RNNoise's output is this many samples (20 ms) behind its input. */
export const DENOISE_LAG = 960;
/** Share of the cleaned signal in what the recognizer hears. */
export const DENOISE_MIX = 0.4;

/** Plenty for the 960-sample alignment backlog plus a frame being written. */
const RING_SAMPLES = DENOISE_FRAME * 8;

/** The slice of the Emscripten module `@jitsi/rnnoise-wasm` builds. */
export interface RnnoiseModule {
  _rnnoise_create(model: number): number;
  _rnnoise_destroy(state: number): void;
  /** Denoises the frame at `input` into `output` (byte offsets); returns the speech probability. */
  _rnnoise_process_frame(state: number, output: number, input: number): number;
  _malloc(bytes: number): number;
  _free(ptr: number): void;
  HEAPF32: Float32Array;
}

/**
 * One microphone's noise suppressor. Feed it fixed or varying chunks; it
 * writes exactly the same number of samples back, delayed by `DENOISE_LAG`.
 * The delay is real audio, not padding: sample *n* out is sample *n − 960*
 * in, mixed with RNNoise's estimate of the clean version of it.
 */
export class StreamDenoiser {
  private readonly state: number;
  private readonly ptr: number;
  private readonly frame = new Float32Array(DENOISE_FRAME);
  private filled = 0;
  /** The original, `DENOISE_LAG` samples back, to line up with RNNoise's output. */
  private readonly dry = new Float32Array(DENOISE_LAG);
  private dryAt = 0;
  /** Mixed frames waiting to be emitted, oldest at `wetRead`. */
  private readonly wet = new Float32Array(RING_SAMPLES);
  private wetRead = 0;
  private wetWrite = 0;
  private wetAvailable = 0;
  /** Output samples still owed as silence while the stream starts up. */
  private delay = DENOISE_LAG;
  private closed = false;
  /** Speech probability of the last frame (0–1). */
  speech = 0;

  constructor(private readonly rn: RnnoiseModule) {
    this.state = rn._rnnoise_create(0);
    this.ptr = rn._malloc(DENOISE_FRAME * 4);
    if (!this.state || !this.ptr) {
      if (this.state) rn._rnnoise_destroy(this.state);
      if (this.ptr) rn._free(this.ptr);
      throw new Error('RNNoise could not allocate its state');
    }
  }

  /**
   * Process `input` and write the same number of samples to `output`.
   * A short `output` drops the tail; a long one is zero-filled.
   */
  process(input: Float32Array, output: Float32Array): void {
    if (this.closed) {
      output.set(input.subarray(0, Math.min(input.length, output.length)));
      output.fill(0, Math.min(input.length, output.length));
      return;
    }

    const samples = Math.min(input.length, output.length);
    for (let i = 0; i < samples; i++) {
      // RNNoise takes int16-range samples (the bridge's PCM16 path passes them
      // through unscaled); the graph works in floats, so scale at the edge.
      this.frame[this.filled++] = input[i]! * 32_768;
      if (this.filled < DENOISE_FRAME) continue;
      this.flushFrame();
      this.filled = 0;
    }
    this.emit(output, samples);
    output.fill(0, samples);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rn._rnnoise_destroy(this.state);
    this.rn._free(this.ptr);
  }

  private flushFrame(): void {
    const heap = this.rn.HEAPF32; // re-read: a grown WASM memory replaces the view
    const base = this.ptr >> 2;
    heap.set(this.frame, base);
    this.speech = this.rn._rnnoise_process_frame(this.state, this.ptr, this.ptr);
    const fromPcm16 = 1 / 32_768;
    for (let i = 0; i < DENOISE_FRAME; i++) {
      const original = this.dry[this.dryAt]!;
      this.dry[this.dryAt] = this.frame[i]! * fromPcm16;
      this.dryAt = (this.dryAt + 1) % DENOISE_LAG;
      const cleaned = heap[base + i]! * fromPcm16;
      const mixed = DENOISE_MIX * cleaned + (1 - DENOISE_MIX) * original;
      this.wet[this.wetWrite] = mixed;
      this.wetWrite = (this.wetWrite + 1) % RING_SAMPLES;
      this.wetAvailable++;
    }
    // More than the ring can hold means the consumer stopped; keep the newest
    // audio rather than overflowing. This cannot happen at a steady rate.
    if (this.wetAvailable > RING_SAMPLES) {
      const drop = this.wetAvailable - RING_SAMPLES;
      this.wetRead = (this.wetRead + drop) % RING_SAMPLES;
      this.wetAvailable = RING_SAMPLES;
    }
  }

  private emit(output: Float32Array, count: number): void {
    let at = 0;
    while (at < count) {
      if (this.delay > 0) {
        const zeros = Math.min(this.delay, count - at);
        output.fill(0, at, at + zeros);
        at += zeros;
        this.delay -= zeros;
        continue;
      }
      if (this.wetAvailable === 0) {
        // Underrun is impossible after the start-up delay (frames arrive at the
        // same rate they are emitted); stay silent rather than repeat audio.
        output.fill(0, at, count);
        return;
      }
      const run = Math.min(this.wetAvailable, count - at);
      const first = Math.min(run, RING_SAMPLES - this.wetRead);
      output.set(this.wet.subarray(this.wetRead, this.wetRead + first), at);
      if (run > first) output.set(this.wet.subarray(0, run - first), at + first);
      this.wetRead = (this.wetRead + run) % RING_SAMPLES;
      this.wetAvailable -= run;
      at += run;
    }
  }
}
