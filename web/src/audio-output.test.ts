import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { limiterSettingsFor } from './audio-output.js';

/** Steady-state output of a hard-knee compressor plus the spec's automatic make-up gain. */
function compressorOut(inputDb: number, threshold: number, ratio: number): number {
  const curve = inputDb <= threshold ? inputDb : threshold + (inputDb - threshold) / ratio;
  const fullRangeDb = threshold + (0 - threshold) / ratio;
  const makeupDb = 0.6 * -fullRangeDb;
  return curve + makeupDb;
}

describe('limiterSettingsFor', () => {
  it('is transparent at or below unity', () => {
    for (const boost of [0, 0.5, 1]) {
      const s = limiterSettingsFor(boost);
      assert.equal(s.ratio, 1);
      assert.equal(s.makeupTrim, 1);
    }
  });

  it('keeps a boosted full-scale signal at or below 0 dBFS once make-up gain is undone', () => {
    for (const boostDb of [3, 6, 12]) {
      const s = limiterSettingsFor(10 ** (boostDb / 20));
      const outDb = compressorOut(boostDb, s.threshold, s.ratio) + 20 * Math.log10(s.makeupTrim);
      assert.ok(outDb <= 0.75, `+${boostDb} dB peaks at ${outDb.toFixed(2)} dBFS`);
    }
  });

  it('leaves quiet speech below the threshold at the full boost', () => {
    const s = limiterSettingsFor(4);
    // −20 dBFS speech boosted by 12 dB is still under −3 dB: only the trim applies.
    const outDb = compressorOut(-8, s.threshold, s.ratio) + 20 * Math.log10(s.makeupTrim);
    assert.ok(Math.abs(outDb - -8) < 0.01);
  });
});
