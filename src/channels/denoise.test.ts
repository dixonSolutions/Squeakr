import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { CallDenoiser, DENOISE_FRAME, DENOISE_LAG, DENOISE_MIX, loadDenoiser, type RnnoiseModule } from './denoise.js';

/** RNNoise that leaves every frame as it is — so only the mixing and the delay are under test. */
function passThrough(): RnnoiseModule & { frees: number } {
  return {
    HEAPF32: new Float32Array(4096),
    frees: 0,
    _rnnoise_create: () => 1,
    _rnnoise_destroy() {},
    _rnnoise_process_frame: () => 0.9,
    _malloc: () => 64,
    _free() {
      this.frees++;
    },
  };
}

const pcm = (samples: number[]) => {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
};
const read = (b: Buffer) => Array.from({ length: b.length >> 1 }, (_, i) => b.readInt16LE(i * 2));

describe('call denoiser', () => {
  it('mixes the cleaned frame with the original from DENOISE_LAG samples back', () => {
    const d = new CallDenoiser(passThrough());
    const input = Array.from({ length: DENOISE_FRAME * 6 }, (_, i) => (i * 37) % 2000 - 1000);
    const out = read(d.process(pcm(input)));
    assert.equal(out.length, input.length);
    for (const i of [0, 100, DENOISE_LAG - 1, DENOISE_LAG, DENOISE_LAG + 5, input.length - 1]) {
      const original = i >= DENOISE_LAG ? input[i - DENOISE_LAG]! : 0;
      assert.equal(out[i], Math.round(DENOISE_MIX * input[i]! + (1 - DENOISE_MIX) * original), `sample ${i}`);
    }
  });

  it('holds a partial frame until the rest arrives, and returns whole frames only', () => {
    const d = new CallDenoiser(passThrough());
    const samples = (b: Buffer) => b.length >> 1;
    assert.equal(samples(d.process(pcm(new Array(300).fill(100)))), 0);
    assert.equal(samples(d.process(pcm(new Array(300).fill(100)))), DENOISE_FRAME); // 120 left over
    assert.equal(samples(d.process(pcm(new Array(360).fill(100)))), DENOISE_FRAME);
    // Discord's 20 ms packets are exactly two frames: nothing waits.
    const discord = new CallDenoiser(passThrough());
    for (let i = 0; i < 3; i++) assert.equal(samples(discord.process(pcm(new Array(960).fill(5)))), 960);
  });

  it('reports the speech probability and frees its memory once', () => {
    const rn = passThrough();
    const d = new CallDenoiser(rn);
    d.process(pcm(new Array(DENOISE_FRAME).fill(0)));
    assert.equal(d.speech, 0.9);
    d.close();
    d.close();
    assert.equal(rn.frees, 1);
    // After close, audio passes through untouched rather than throwing.
    assert.deepEqual(read(d.process(pcm([1, 2, 3]))), [1, 2, 3]);
  });

  it('runs the real RNNoise when installed: quieter noise, same stream length', async () => {
    const factory = await loadDenoiser();
    if (!factory) return; // optional dependency
    const d = factory();
    let seed = 7;
    const noise = Array.from({ length: 48_000 }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 6000);
    const out = read(d.process(pcm(noise)));
    d.close();
    assert.equal(out.length, noise.length);
    const rms = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / xs.length);
    // Steady noise: the cleaned 40 % is near silent, so what is left is mostly the 60 % original.
    assert.ok(rms(out.slice(24_000)) < rms(noise.slice(24_000)) * 0.75);
  });
});
