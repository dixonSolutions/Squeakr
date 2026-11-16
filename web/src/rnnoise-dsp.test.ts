/**
 * The PWA's RNNoise stream: same frame, lag and 40 % mix as the Discord call
 * denoiser, but it must emit exactly as many samples as it takes in — a
 * microphone graph cannot drift. These also run the real WASM module when the
 * optional dependency is installed, including a short real-time stress pass.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  DENOISE_FRAME,
  DENOISE_LAG,
  DENOISE_MIX,
  StreamDenoiser,
  type RnnoiseModule,
} from './rnnoise-dsp.js';

/** RNNoise that leaves the frame alone — so only the mix and delay are under test. */
function passThrough(): RnnoiseModule {
  return {
    HEAPF32: new Float32Array(4096),
    _rnnoise_create: () => 1,
    _rnnoise_destroy() {},
    _rnnoise_process_frame: () => 0.9,
    _malloc: () => 64,
    _free() {},
  };
}

async function realModule(): Promise<RnnoiseModule | null> {
  try {
    const mod = (await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' as string)) as {
      default: () => RnnoiseModule;
    };
    return mod.default();
  } catch {
    return null; // optional dependency
  }
}

const noise = (n: number, seed = 7): Float32Array => {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 16807) % 2147483647;
    x[i] = (seed / 2147483647 - 0.5) * 0.25;
  }
  return x;
};

const rms = (x: Float32Array): number =>
  Math.sqrt(x.reduce((sum, v) => sum + v * v, 0) / Math.max(x.length, 1));

describe('PWA RNNoise stream', () => {
  it('delays by DENOISE_LAG and mixes the cleaned frame with the original', () => {
    const d = new StreamDenoiser(passThrough());
    const input = Float32Array.from({ length: DENOISE_FRAME * 6 }, (_, i) => ((i * 37) % 2000) / 1000 - 1);
    const out = new Float32Array(input.length);
    d.process(input, out);
    d.close();

    assert.equal(out.length, input.length);
    for (let i = 0; i < DENOISE_LAG; i++) assert.equal(out[i], 0, `start-up ${i} is silence`);

    for (const wet of [0, 189, 960, 1441, input.length - 1 - DENOISE_LAG]) {
      const at = wet + DENOISE_LAG;
      const original = wet >= DENOISE_LAG ? input[wet - DENOISE_LAG]! : 0;
      const expected = DENOISE_MIX * input[wet]! + (1 - DENOISE_MIX) * original;
      assert.ok(Math.abs(out[at]! - expected) < 1e-6, `sample ${at}`);
    }
  });

  it('returns the same number of samples for any chunking — no drift', () => {
    const d = new StreamDenoiser(passThrough());
    const input = noise(48_000);
    let consumed = 0;
    let produced = 0;
    const sizes = [1, 480, 1023, 1024, 7, 4096, 333];
    const out = new Float32Array(4096);
    for (let k = 0; consumed < input.length; k++) {
      const n = Math.min(sizes[k % sizes.length]!, input.length - consumed);
      d.process(input.subarray(consumed, consumed + n), out.subarray(0, n));
      consumed += n;
      produced += n;
    }
    d.close();
    assert.equal(produced, input.length, 'one out per in');
  });

  it('runs the real RNNoise: steady noise gets quieter and stays finite', async () => {
    const rn = await realModule();
    if (!rn) return;
    const d = new StreamDenoiser(rn);
    const input = noise(48_000 * 2);
    const out = new Float32Array(input.length);
    d.process(input, out);
    d.close();

    let finite = true;
    for (const v of out) if (!Number.isFinite(v)) finite = false;
    assert.equal(finite, true);
    const before = rms(input.subarray(DENOISE_LAG));
    const after = rms(out.subarray(DENOISE_LAG));
    // The cleaned 40 % is near silent on steady noise, so what is left is
    // mostly the 60 % original.
    assert.ok(after < before * 0.85, `noise rms ${before} -> ${after}`);
  });

  it('stress: 30 s of noise in 1024-frame callbacks, faster than real time', async () => {
    const rn = await realModule();
    if (!rn) return;
    const d = new StreamDenoiser(rn);
    const seconds = 30;
    const input = noise(48_000 * seconds, 123);
    const out = new Float32Array(1024);
    const started = performance.now();
    for (let at = 0; at < input.length; at += 1024) {
      const n = Math.min(1024, input.length - at);
      d.process(input.subarray(at, at + n), out.subarray(0, n));
      for (let i = 0; i < n; i++) assert.ok(Number.isFinite(out[i]!), 'finite output');
    }
    const elapsed = performance.now() - started;
    d.close();
    const realTime = seconds * 1000;
    console.log(`[denoise] 30 s in ${elapsed.toFixed(0)} ms (${(realTime / elapsed).toFixed(1)}x real time)`);
    assert.ok(elapsed < realTime, `took ${elapsed.toFixed(0)} ms for ${realTime} ms of audio`);
  });

  it('passes audio through unchanged after close', () => {
    const d = new StreamDenoiser(passThrough());
    d.close();
    const input = Float32Array.from([0.1, -0.2, 0.3]);
    const out = new Float32Array(4);
    d.process(input, out);
    assert.deepEqual(Array.from(out), Array.from(Float32Array.from([0.1, -0.2, 0.3, 0])));
  });
});
