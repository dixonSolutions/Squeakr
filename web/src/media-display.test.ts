import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { MediaShelf, parseMediaItem, parseMediaItems } from './media-display.js';

const raw = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  batch_id: 'b1',
  kind: 'video',
  src: `/api/display/${id}?k=key`,
  mime: 'video/mp4',
  live: false,
  expires_in_ms: 60_000,
  display: 'fullscreen',
  autoplay: false,
  muted: false,
  loop: false,
  auto_close_ms: null,
  close_on_end: false,
  ...extra,
});

describe('parseMediaItem', () => {
  it('turns expires_in_ms into a local deadline; null means never', () => {
    assert.equal(parseMediaItem(raw('a'), 1000)?.expiresAt, 61_000);
    assert.equal(parseMediaItem(raw('a', { expires_in_ms: null }), 1000)?.expiresAt, null);
  });

  it('drops malformed items', () => {
    assert.equal(parseMediaItem(raw('a', { kind: 'pdf' }), 0), null);
    assert.equal(parseMediaItem({ id: 'x' }, 0), null);
    assert.deepEqual(parseMediaItems('nope', 0), []);
  });
});

describe('MediaShelf', () => {
  it('opens what the agent asked for, with its autoplay and auto-close', () => {
    const shelf = new MediaShelf();
    const open = shelf.show(parseMediaItems([raw('a', { autoplay: true, auto_close_ms: 5000 })], 0), 'a');
    assert.deepEqual({ ...open, seq: 0 }, { id: 'a', by: 'agent', autoplay: true, autoCloseMs: 5000, seq: 0 });
  });

  it('a video closed while playing keeps its frame and plays again when reopened', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a')], 0), 'a');
    shelf.close({ time: 42.5, playing: true });
    assert.equal(shelf.open, null);
    assert.deepEqual(shelf.resumeFor('a'), { time: 42.5, playing: true });
    const again = shelf.openItem('a', 'user');
    assert.equal(again?.autoplay, true);
    assert.equal(again?.autoCloseMs, null);
  });

  it('a video closed while paused reopens paused on its frame', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a')], 0), 'a');
    shelf.close({ time: 3, playing: false });
    assert.equal(shelf.openItem('a', 'user')?.autoplay, false);
  });

  it('the user opening an item never inherits the agent\'s auto-close or autoplay', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a', { display: 'tray', autoplay: true, auto_close_ms: 4000 })], 0), null);
    assert.equal(shelf.open, null);
    const open = shelf.openItem('a', 'user', { autoplay: true, autoCloseMs: 4000 });
    assert.equal(open?.autoplay, false);
    assert.equal(open?.autoCloseMs, null);
  });

  it('every open gets a new seq, so an old auto-close timer is stale', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a')], 0), null);
    const first = shelf.openItem('a', 'agent', { autoCloseMs: 1000 })!.seq;
    shelf.close();
    const second = shelf.openItem('a', 'agent', { autoCloseMs: 1000 })!.seq;
    assert.notEqual(first, second);
  });

  it('self-destructs on its own clock and closes what was open', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a', { expires_in_ms: 1000 }), raw('b', { expires_in_ms: null })], 0), 'a');
    assert.equal(shelf.nextExpiry(), 1000);
    assert.deepEqual(shelf.expire(999), []);
    assert.deepEqual(shelf.expire(1000), ['a']);
    assert.equal(shelf.open, null);
    assert.equal(shelf.nextExpiry(), null);
    assert.deepEqual(shelf.items.map((i) => i.id), ['b']);
  });

  it('sync takes the bridge\'s list without opening anything', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a'), raw('b')], 0), null);
    shelf.close();
    shelf.sync(parseMediaItems([raw('b'), raw('c')], 0));
    assert.deepEqual(shelf.items.map((i) => i.id), ['b', 'c']);
    assert.equal(shelf.open, null);
  });

  it('removing the open item closes it and forgets its frame', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a')], 0), 'a');
    shelf.updateResume('a', { time: 9 });
    shelf.remove(['a']);
    assert.equal(shelf.open, null);
    assert.equal(shelf.resumeFor('a'), undefined);
  });

  it('swipes within the open item\'s batch', () => {
    const shelf = new MediaShelf();
    shelf.show(parseMediaItems([raw('a'), raw('b'), raw('c', { batch_id: 'other' })], 0), 'a');
    assert.equal(shelf.neighbour(1)?.id, 'b');
    assert.equal(shelf.neighbour(-1)?.id, 'b');
  });
});
