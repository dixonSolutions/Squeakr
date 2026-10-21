/**
 * Noise suppression on call audio — RNNoise, run in the bridge on each
 * speaker's 48 kHz audio before it is resampled to the 16 kHz the speech
 * pipeline takes (channels/audio.ts).
 *
 * Only part of the cleaned signal is used: DENOISE_MIX of it, the rest the
 * original. Fully cleaned audio made both engines worse in the noise sweep
 * (docs/50) — Whisper made more mistakes at ordinary room noise and invented
 * whole sentences out of background chatter, and Vosk lost wake phrases. A
 * 40 % mix was the best measured setting for both: wake phrases held up in
 * loud steady noise, music and sirens stopped drowning out commands, and
 * nothing was invented. RNNoise's output lags its input by DENOISE_LAG
 * samples, so the original is delayed by as much before the two are added;
 * unaligned, they comb-filter into a hollow, phasey sound.
 *
 * Optional all the way: `@jitsi/rnnoise-wasm` is an optional dependency,
 * loaded on first use. Without it, calls hear the audio as it arrives.
 */

import { childLogger } from '../log.js';

const log = childLogger('channels:denoise');

/** RNNoise works on 10 ms frames at 48 kHz. */
export const DENOISE_FRAME = 480;
/** RNNoise's output is this many samples (20 ms) behind its input. */
export const DENOISE_LAG = 960;
/** Share of the cleaned signal in what the speech pipeline hears. */
export const DENOISE_MIX = 0.4;

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
 * One speaker's noise suppressor. Keep one per speaker for the whole call:
 * RNNoise learns the noise as it goes, so a fresh one per utterance would
 * start every utterance knowing nothing about the room.
 */
export class CallDenoiser {
  private readonly state: number;
  private readonly ptr: number;
  private readonly frame = new Float32Array(DENOISE_FRAME);
  private filled = 0;
  /** The original, DENOISE_LAG samples back, to line up with RNNoise's output. */
  private readonly dry = new Float32Array(DENOISE_LAG);
  private dryAt = 0;
  private closed = false;
  /** Speech probability of the last frame (0–1). */
  speech = 0;

  constructor(private readonly rn: RnnoiseModule) {
    this.state = rn._rnnoise_create(0);
    this.ptr = rn._malloc(DENOISE_FRAME * 4);
  }

  /**
   * Mono PCM16LE at 48 kHz in, the same out — whole 10 ms frames, 20 ms late.
   * A remainder short of a frame waits for the next call (Discord's 20 ms
   * packets are exactly two frames, so nothing waits there).
   */
  process(pcm: Buffer): Buffer {
    if (this.closed) return pcm;
    const samples = pcm.length >> 1;
    const out = Buffer.alloc((Math.floor((this.filled + samples) / DENOISE_FRAME) * DENOISE_FRAME) * 2);
    let written = 0;
    for (let i = 0; i < samples; i++) {
      this.frame[this.filled++] = pcm.readInt16LE(i * 2);
      if (this.filled < DENOISE_FRAME) continue;
      written = this.flushFrame(out, written);
      this.filled = 0;
    }
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rn._rnnoise_destroy(this.state);
    this.rn._free(this.ptr);
  }

  private flushFrame(out: Buffer, at: number): number {
    const heap = this.rn.HEAPF32; // re-read: a grown WASM memory replaces the view
    const base = this.ptr >> 2;
    heap.set(this.frame, base);
    this.speech = this.rn._rnnoise_process_frame(this.state, this.ptr, this.ptr);
    for (let i = 0; i < DENOISE_FRAME; i++) {
      const original = this.dry[this.dryAt]!;
      this.dry[this.dryAt] = this.frame[i]!;
      this.dryAt = (this.dryAt + 1) % DENOISE_LAG;
      const v = DENOISE_MIX * heap[base + i]! + (1 - DENOISE_MIX) * original;
      out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), (at + i) * 2);
    }
    return at + DENOISE_FRAME;
  }
}

export type DenoiserFactory = () => CallDenoiser;

let loading: Promise<DenoiserFactory | null> | null = null;

/** The noise suppressor, loaded once; null when `@jitsi/rnnoise-wasm` is not installed. */
export function loadDenoiser(): Promise<DenoiserFactory | null> {
  loading ??= (async () => {
    try {
      // The package's own entry imports extension-less paths Node cannot resolve; its synchronous build loads directly.
      const mod = (await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' as string)) as { default: () => RnnoiseModule };
      const rn = mod.default();
      log.info('call noise suppression ready');
      return () => new CallDenoiser(rn);
    } catch (err) {
      log.info({ err: String(err) }, '@jitsi/rnnoise-wasm not available — call audio is not denoised');
      return null;
    }
  })();
  return loading;
}
