import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { Pcm16Stretcher, WsolaStretcher, floatsToPcm16, stretchSamples } from './time-stretch.js';

const RATE = 24_000;

function tone(freq: number, seconds: number, rate = RATE, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Dominant frequency by zero-crossing count — enough to tell "same pitch" from "chipmunk". */
function zeroCrossingHz(samples: Float32Array, rate = RATE): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if ((samples[i - 1]! < 0) !== (samples[i]! < 0)) crossings++;
  }
  return crossings / 2 / (samples.length / rate);
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function streamThrough(stretcher: WsolaStretcher, input: Float32Array, chunk: number): Float32Array {
  const parts: Float32Array[] = [];
  for (let i = 0; i < input.length; i += chunk) parts.push(stretcher.process(input.subarray(i, i + chunk)));
  parts.push(stretcher.flush());
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('WsolaStretcher', () => {
  it('speed 1 passes the samples through untouched', () => {
    const input = tone(220, 0.2);
    assert.equal(stretchSamples(input, RATE, 1), input);
  });

  for (const speed of [0.5, 0.75, 1.25, 1.5, 2]) {
    it(`speed ${speed}: length is input ÷ speed and the pitch is kept`, () => {
      const input = tone(220, 1);
      const out = stretchSamples(input, RATE, speed);
      assert.equal(out.length, Math.round(input.length / speed));
      // Skip the edges; the middle must still be a 220 Hz tone.
      const mid = out.subarray(Math.round(out.length * 0.2), Math.round(out.length * 0.8));
      const hz = zeroCrossingHz(mid);
      assert.ok(Math.abs(hz - 220) < 6, `pitch drifted to ${hz.toFixed(1)} Hz at ${speed}×`);
      // No level dip or blow-up from the overlap-add.
      assert.ok(Math.abs(rms(mid) - rms(input)) < 0.05, `rms ${rms(mid)} vs ${rms(input)}`);
    });
  }

  it('splices frames in phase — no clicks at the joins', () => {
    const input = tone(233, 1);
    const maxStep = (s: Float32Array) => {
      let m = 0;
      for (let i = 1; i < s.length; i++) m = Math.max(m, Math.abs(s[i]! - s[i - 1]!));
      return m;
    };
    for (const speed of [0.6, 1.7]) {
      const out = stretchSamples(input, RATE, speed);
      // A mis-aligned overlap-add shows up as a sample jump far steeper than the sine's.
      assert.ok(maxStep(out) < maxStep(input) * 1.5, `click at ${speed}×: ${maxStep(out)} vs ${maxStep(input)}`);
    }
  });

  it('streaming in odd chunk sizes gives the same length as one shot', () => {
    const input = tone(180, 0.7);
    const whole = stretchSamples(input, RATE, 1.5);
    const streamed = streamThrough(new WsolaStretcher(RATE, 1.5), input, 517);
    assert.equal(streamed.length, whole.length);
    assert.ok(Math.abs(zeroCrossingHz(streamed.subarray(2000, -2000)) - 180) < 6);
  });

  it('copes with input shorter than one frame', () => {
    const out = stretchSamples(tone(300, 0.005), RATE, 2);
    assert.equal(out.length, Math.round((0.005 * RATE) / 2));
  });

  it('copes with empty input', () => {
    const s = new WsolaStretcher(RATE, 1.5);
    assert.equal(s.process(new Float32Array(0)).length, 0);
    assert.equal(s.flush().length, 0);
  });

  it('never produces NaN or out-of-range samples', () => {
    const noise = new Float32Array(RATE);
    for (let i = 0; i < noise.length; i++) noise[i] = Math.sin(i * 12.9898) * 0.9;
    for (const speed of [0.5, 2]) {
      for (const s of stretchSamples(noise, RATE, speed)) {
        assert.ok(Number.isFinite(s) && Math.abs(s) <= 1.0001);
      }
    }
  });
});

describe('Pcm16Stretcher', () => {
  it('handles a sample split across chunks and matches the float path', () => {
    const input = tone(200, 0.5);
    const bytes = floatsToPcm16(input);
    const pcm = new Pcm16Stretcher(RATE, 1.25);
    const parts: Uint8Array[] = [];
    // Odd chunk size: every other chunk ends mid-sample.
    for (let i = 0; i < bytes.length; i += 333) parts.push(pcm.push(bytes.subarray(i, i + 333)));
    parts.push(pcm.flush());
    const total = parts.reduce((n, p) => n + p.length, 0);
    assert.equal(total % 2, 0);
    assert.equal(total / 2, Math.round(input.length / 1.25));
  });

  it('is a pass-through at speed 1', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const pcm = new Pcm16Stretcher(RATE, 1);
    assert.equal(pcm.push(bytes), bytes);
    assert.equal(pcm.flush().length, 0);
  });
});
