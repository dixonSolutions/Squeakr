import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseFinal, phraseHeard, spotterGrammar } from './wakeSpotter.js';
import { CallTurns, misheardPhraseEnd } from './callTurns.js';

describe('wake spotter', () => {
  it('builds the PWA’s grammar: the phrase, everything else unknown', () => {
    assert.deepEqual(spotterGrammar('Hey, Squeaker!'), ['hey squeaker', '[unk]']);
  });

  it('matches the whole phrase on its own or ending what was heard, like the PWA', () => {
    assert.equal(phraseHeard('hey squeaker', 'hey squeaker'), true);
    assert.equal(phraseHeard('[unk] hey squeaker', 'hey squeaker'), true);
    assert.equal(phraseHeard('hey', 'hey squeaker'), false);
    assert.equal(phraseHeard('hey squeaker [unk]', 'hey squeaker'), false);
    assert.equal(phraseHeard('', 'hey squeaker'), false);
  });

  it('reads a final result’s text and mean word confidence', () => {
    assert.deepEqual(parseFinal('{"result":[{"conf":0.9,"word":"hey"},{"conf":0.7,"word":"squeaker"}],"text":"hey squeaker"}'), {
      text: 'hey squeaker',
      confidence: 0.8,
    });
    assert.deepEqual(parseFinal('{"text":""}'), { text: '', confidence: null });
    assert.equal(parseFinal('not json'), null);
    assert.equal(parseFinal(null), null);
  });
});

describe('CallTurns.open — the phrase heard in the audio', () => {
  const turns = () =>
    new CallTurns(
      { inputMode: 'turns', wakeWordsEnabled: true, wakeWords: { start: 'hey squeaker', cancel: 'cancel' }, turnSubmit: { silenceMs: 700, vadEnabled: true } },
      () => undefined,
    );

  it('opens the capture, so the transcript is a request even when it lost the phrase', () => {
    const t = turns();
    t.open();
    assert.deepEqual(t.feed('run the tests'), { action: 'deliver', text: 'run the tests' });
  });

  it('cuts the phrase from the transcript, spelled right or not', () => {
    const t = turns();
    t.open();
    assert.deepEqual(t.feed('Hey Squeaker, run the tests.'), { action: 'deliver', text: 'run the tests' });
    t.open();
    assert.deepEqual(t.feed('Hey squeaking, run the tests.'), { action: 'deliver', text: 'run the tests' });
  });

  it('a phrase alone keeps the capture open for what is said next', () => {
    const t = turns();
    t.open();
    assert.deepEqual(t.feed("It's squeaker."), { action: 'armed' });
    assert.deepEqual(t.feed('what changed today'), { action: 'deliver', text: 'what changed today' });
  });

  it('without open(), room talk is still ignored', () => {
    assert.deepEqual(turns().feed('run the tests'), { action: 'ignore' });
  });

  it('finds a misspelled phrase end only among the first few words', () => {
    const phrase = ['hey', 'squeaker'];
    assert.equal(misheardPhraseEnd(['Hey', 'squeaking,', 'run'], phrase), 2);
    assert.equal(misheardPhraseEnd(['run', 'the', 'tests'], phrase), 0);
    assert.equal(misheardPhraseEnd(['please', 'run', 'the', 'tests', 'squeaker'], phrase), 0);
  });
});
