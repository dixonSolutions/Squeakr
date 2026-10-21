import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { WAKE_DECOYS } from './wakeDecoys.js';
import { PhraseDecision, SPOT_HOLD_MS, spottingGrammar, spottingRule, type HeardWord } from './wakeSpotting.js';

const heard = (s: string): HeardWord[] =>
  s.split(' ').map((w) => {
    const [word, conf] = w.split(':');
    return { word: word!, conf: conf === undefined ? 1 : Number(conf) };
  });

describe('wake spotting grammar', () => {
  it('is the phrase, its words, the decoys and [unk] — each once', () => {
    const g = spottingGrammar('Hey, Squeaky!');
    assert.equal(g[0], 'hey squeaky');
    assert.equal(g.at(-1), '[unk]');
    assert.ok(g.includes('squeaky') && g.includes('the'));
    assert.equal(new Set(g).size, g.length);
    assert.equal(g.length, 1 + new Set(['hey', 'squeaky', ...WAKE_DECOYS]).size + 1);
  });
});

describe('wake spotting rule', () => {
  it('maps the sensitivity setting onto confidence and the instant partial match', () => {
    assert.deepEqual(spottingRule('start'), { role: 'start', minConfidence: 0.7, matchPartial: true, holdMs: SPOT_HOLD_MS });
    assert.deepEqual(spottingRule('start', 0.65), { role: 'start', minConfidence: 0.9, matchPartial: false, holdMs: SPOT_HOLD_MS });
    assert.equal(spottingRule('start', 0.15).minConfidence, 0.5);
    assert.equal(spottingRule('end', 0.15).matchPartial, false, 'only the start phrase fires on partials');
  });

  it('start phrase: every phrase word heard confidently, near the start', () => {
    const d = () => new PhraseDecision('hey squeaky', spottingRule('start'));
    assert.equal(d().final(heard('hey squeaky open the readme')), true);
    assert.equal(d().final(heard('okay so hey squeaky stop')), true);
    assert.equal(d().final(heard('[unk]:0.9 hey squeaky')), true);
    assert.equal(d().final(heard('hey squeaky:0.6')), false, 'a word heard without confidence');
    assert.equal(d().final(heard('we went to the shop and hey squeaky')), false, 'deep inside a sentence');
    assert.equal(d().final(heard('hey sneaky')), false);
  });

  it('end and cancel phrases close what was said: nothing confident after them', () => {
    const end = () => new PhraseDecision('cursor send', spottingRule('end'));
    assert.equal(end().final(heard('open the readme cursor send')), true);
    assert.equal(end().final(heard('cursor send eu:0.16')), true, 'a breath after the phrase');
    assert.equal(end().final(heard('the cursor send me some where else')), false);
    const cancel = new PhraseDecision('cancel', spottingRule('cancel'));
    assert.equal(cancel.final(heard('cancel culture is strange')), false);
    assert.equal(cancel.final(heard('oh never mind cancel')), true);
  });

  it('a partial match fires only once it has held for the hold time', () => {
    const d = new PhraseDecision('hey squeaky', spottingRule('start'));
    assert.equal(d.partial('hey squeaky', 1000), false);
    assert.equal(d.partial('hey squeaky', 1000 + SPOT_HOLD_MS - 20), false);
    assert.equal(d.partial('hey squeaky open', 1000 + SPOT_HOLD_MS), true);
    // A look-alike that turns into other words starts the clock again.
    d.reset();
    assert.equal(d.partial('the kids are hey squeaky', 0), false, 'too far from the start');
    assert.equal(d.partial('hey squeaky', 100), false);
    assert.equal(d.partial('hey squeezed', 200), false);
    assert.equal(d.partial('hey squeaky', 300), false);
    assert.equal(d.partial('hey squeaky', 300 + SPOT_HOLD_MS), true);
  });

  it('a final result ends the running partial', () => {
    const d = new PhraseDecision('hey squeaky', spottingRule('start'));
    d.partial('hey squeaky', 0);
    assert.equal(d.final(heard('hey sweetie dinner')), false);
    assert.equal(d.partial('hey squeaky', SPOT_HOLD_MS), false);
  });

  it('never fires on partials when the rule says not to', () => {
    const d = new PhraseDecision('cursor send', spottingRule('end'));
    assert.equal(d.partial('cursor send', 0), false);
    assert.equal(d.partial('cursor send', 5000), false);
  });
});
