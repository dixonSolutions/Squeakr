import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseFinal } from './wakeSpotter.js';
import { CallTurns, confirmSpotted } from './callTurns.js';

describe('wake spotter', () => {
  it('reads a final result’s text and words with their confidence', () => {
    assert.deepEqual(parseFinal('{"result":[{"conf":0.9,"word":"hey"},{"conf":0.7,"word":"squeaker"}],"text":"hey squeaker"}'), {
      text: 'hey squeaker',
      words: [
        { word: 'hey', conf: 0.9 },
        { word: 'squeaker', conf: 0.7 },
      ],
    });
    assert.deepEqual(parseFinal('{"text":""}'), { text: '', words: [] });
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

  it('cuts the phrase from the transcript, spelled right or close to it', () => {
    const t = turns();
    t.open();
    assert.deepEqual(t.feed('Hey Squeaker, run the tests.'), { action: 'deliver', text: 'run the tests' });
    t.open();
    assert.deepEqual(t.feed('Hay squeaker, run the tests.'), { action: 'deliver', text: 'run the tests' });
    t.open();
    assert.deepEqual(t.feed('Okay, heysqueaker, run the tests.'), { action: 'deliver', text: 'run the tests' });
  });

  it('drops a look-alike the spotter fell for: the transcript does not open with the phrase', () => {
    const t = turns();
    t.open();
    assert.deepEqual(t.feed('He squeezed the lemon into the tea.'), { action: 'ignore' });
    // …and the capture is closed again: what follows is room talk.
    assert.deepEqual(t.feed('run the tests'), { action: 'ignore' });
    t.open();
    assert.deepEqual(t.feed('A squeaker clean kitchen is nice.'), { action: 'ignore' });
  });

  it('a short utterance is the phrase on its own, mangled or not: the capture stays open, none of it delivered', () => {
    const t = turns();
    t.open();
    assert.deepEqual(t.feed("It's squeaker."), { action: 'armed' });
    assert.deepEqual(t.feed('what changed today'), { action: 'deliver', text: 'what changed today' });
    t.open();
    assert.deepEqual(t.feed('Quite squeaky actually'), { action: 'armed' });
  });

  it('without open(), room talk is still ignored', () => {
    assert.deepEqual(turns().feed('run the tests'), { action: 'ignore' });
  });

  it('confirms the phrase only near the start, within the spelling distance', () => {
    const phrase = ['hey', 'squeaker'];
    assert.equal(confirmSpotted(['Hey,', 'squeaker,', 'run', 'the', 'tests'], phrase), 2);
    assert.equal(confirmSpotted(['Right', 'so,', 'hey', 'squeaker,', 'run', 'it'], phrase), 4);
    assert.equal(confirmSpotted(['please', 'run', 'the', 'tests', 'hey', 'squeaker'], phrase), null);
    assert.equal(confirmSpotted(['Hey,', 'speak', 'a', 'bit', 'louder'], phrase), null);
    assert.equal(confirmSpotted(['run', 'it'], phrase), 2, 'short: the phrase alone');
  });
});
