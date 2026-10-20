import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DisplayRegistry, MAX_ITEMS, type DisplayFrame, type ShowOptions } from './registry.js';
import { handleMediaControl, handleShowMedia } from '../mcp/server/displayToolHandlers.js';
import { resolveAllowedImagePath } from '../mcp/server/imageRegistry.js';

const OPTS: ShowOptions = {
  display: 'fullscreen',
  autoplay: false,
  muted: false,
  loop: false,
  autoCloseMs: null,
  closeOnEnd: false,
  selfDestruct: 60,
};

/** A registry on a fake clock, recording every frame it would send the phone. */
function setup() {
  const frames: DisplayFrame[] = [];
  let now = 1_000_000;
  const timers: { at: number; fn: () => void; cleared: boolean }[] = [];
  const reg = new DisplayRegistry({
    emit: (f) => frames.push(f),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
    resolvePath: (p) => (p.startsWith('/ok/') ? p : null),
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers) if (!t.cleared && t.at <= now) {
      t.cleared = true;
      t.fn();
    }
  };
  return { reg, frames, advance };
}

describe('DisplayRegistry', () => {
  it('detects kind from the extension and opens the first item fullscreen', () => {
    const { reg, frames } = setup();
    const { items } = reg.add([{ path: '/ok/clip.mp4' }, { path: '/ok/song.mp3' }, { path: '/ok/shot.png' }], OPTS);
    assert.deepEqual(items.map((i) => i.kind), ['video', 'audio', 'image']);
    const show = frames[0];
    assert.equal(show?.type, 'media_show');
    if (show?.type !== 'media_show') return;
    assert.equal(show.open_id, items[0]!.id);
    assert.match(show.items[0]!.src, /^\/api\/display\/[\w-]+\?k=[\w-]+$/);
    assert.equal(show.items[0]!.expires_in_ms, 60_000);
  });

  it('a tray batch opens nothing', () => {
    const { reg, frames } = setup();
    reg.add([{ path: '/ok/clip.webm' }], { ...OPTS, display: 'tray' });
    assert.equal(frames[0]?.type === 'media_show' && frames[0].open_id, null);
  });

  it('self-destructs after its time, and tells the phone', () => {
    const { reg, frames, advance } = setup();
    const { items } = reg.add([{ path: '/ok/a.png' }], OPTS);
    advance(59_000);
    assert.ok(reg.get(items[0]!.id));
    advance(1_000);
    assert.equal(reg.get(items[0]!.id), null);
    assert.deepEqual(frames.at(-1), { type: 'media_remove', ids: [items[0]!.id], reason: 'self_destruct' });
  });

  it('"never" has no timer and lasts until the session ends', () => {
    const { reg, frames, advance } = setup();
    const { items } = reg.add([{ path: '/ok/a.png' }], { ...OPTS, selfDestruct: 'never' });
    advance(10 * 24 * 3600_000);
    assert.ok(reg.get(items[0]!.id));
    assert.equal(reg.toClient(items[0]!).expires_in_ms, null);
    reg.clear('session_ended');
    assert.equal(reg.list().length, 0);
    assert.deepEqual(frames.at(-1), { type: 'media_remove', ids: [items[0]!.id], reason: 'session_ended' });
  });

  it('a removed item does not self-destruct again later', () => {
    const { reg, frames, advance } = setup();
    const { items } = reg.add([{ path: '/ok/a.png' }], OPTS);
    reg.remove([items[0]!.id], 'agent');
    const count = frames.length;
    advance(120_000);
    assert.equal(frames.length, count);
  });

  it('serves an item only with its own key', () => {
    const { reg } = setup();
    const [a, b] = reg.add([{ path: '/ok/a.png' }, { path: '/ok/b.png' }], OPTS).items;
    assert.equal(reg.getWithKey(a!.id, a!.key)?.id, a!.id);
    assert.equal(reg.getWithKey(a!.id, b!.key), null);
    assert.equal(reg.getWithKey(a!.id, ''), null);
  });

  it('rejects paths outside the allowlist, unknown kinds, and live without a path', () => {
    const { reg } = setup();
    assert.throws(() => reg.add([{ path: '/etc/passwd.png' }], OPTS), /not a readable file/);
    assert.throws(() => reg.add([{ path: '/ok/notes.txt' }], OPTS), /image, video or audio/);
    assert.throws(() => reg.add([{ url: 'https://x.test/a.mp3', live: true }], OPTS), /live needs a path/);
    assert.throws(() => reg.add([{ path: '/ok/a.png', live: true }], OPTS), /live is for audio and video/);
  });

  it('validates the whole batch before storing any of it', () => {
    const { reg } = setup();
    assert.throws(() => reg.add([{ path: '/ok/a.png' }, { path: '/nope/b.png' }], OPTS));
    assert.equal(reg.list().length, 0);
  });

  it('an explicit kind covers a file with no telling extension', () => {
    const { reg } = setup();
    const { items } = reg.add([{ path: '/ok/render.bin', kind: 'audio' }], OPTS);
    assert.equal(items[0]!.kind, 'audio');
  });

  it('replace "origin" drops only that tool\'s earlier batch', () => {
    const { reg } = setup();
    const media = reg.add([{ path: '/ok/a.mp4' }], OPTS).items[0]!;
    const shot1 = reg.add([{ path: '/ok/1.png' }], OPTS, { origin: 'show_images', replace: 'origin' }).items[0]!;
    const shot2 = reg.add([{ path: '/ok/2.png' }], OPTS, { origin: 'show_images', replace: 'origin' }).items[0]!;
    assert.deepEqual(reg.list().map((i) => i.id), [media.id, shot2.id]);
    assert.equal(reg.get(shot1.id), null);
  });

  it('evicts the oldest items past the cap', () => {
    const { reg, advance } = setup();
    const first = reg.add([{ path: '/ok/first.png' }], OPTS).items[0]!;
    for (let i = 0; i < MAX_ITEMS; i++) {
      advance(1);
      reg.add([{ path: `/ok/${i}.png` }], { ...OPTS, selfDestruct: 'never' });
    }
    assert.equal(reg.list().length, MAX_ITEMS);
    assert.equal(reg.get(first.id), null);
  });

  it('keeps the playback the phone reports', () => {
    const { reg } = setup();
    const item = reg.add([{ path: '/ok/a.mp4' }], OPTS).items[0]!;
    reg.reportPlayback(item.id, { state: 'ended', open: true, position_s: 12, duration_s: 12, muted: false });
    assert.equal((reg.describe(item)['playback'] as { state: string }).state, 'ended');
  });

  it('finishing a live item tells the phone once and clears its live flag', () => {
    const { reg, frames } = setup();
    const item = reg.add([{ path: '/ok/render.mp3', live: true }], OPTS).items[0]!;
    assert.equal(reg.toClient(item).live, true);
    reg.finishLive(item.id);
    reg.finishLive(item.id);
    assert.equal(frames.filter((f) => f.type === 'media_control' && f.action === 'live_end').length, 1);
    assert.equal(reg.toClient(item).live, false);
  });
});

describe('show_media / media_control', () => {
  it('autoplay, auto_close_ms and close_on_end need fullscreen', () => {
    const { reg } = setup();
    for (const extra of [{ autoplay: true }, { auto_close_ms: 5000 }, { close_on_end: true }]) {
      const r = handleShowMedia({ items: [{ path: '/ok/a.mp4' }], display: 'tray', ...extra }, {}, reg);
      assert.equal(r['ok'], false);
      assert.match(String(r['error']), /only works with display "fullscreen"/);
    }
    const ok = handleShowMedia(
      { items: [{ path: '/ok/a.mp4' }], autoplay: true, auto_close_ms: 5000, close_on_end: true, self_destruct: 'never', publish: false },
      {},
      reg,
    );
    assert.equal(ok['ok'], true);
    const [item] = reg.list();
    assert.deepEqual(
      { ...item!.options },
      { display: 'fullscreen', autoplay: true, muted: false, loop: false, autoCloseMs: 5000, closeOnEnd: true, selfDestruct: 'never' },
    );
  });

  it('defaults to fullscreen with a 30-minute self-destruct', () => {
    const { reg } = setup();
    const r = handleShowMedia({ items: [{ path: '/ok/a.png' }], publish: false }, {}, reg);
    assert.deepEqual((r['items'] as { self_destruct_in_s: number }[])[0]!.self_destruct_in_s, 1800);
    assert.equal(reg.list()[0]!.options.display, 'fullscreen');
  });

  it('controls reach the phone; play on an image is refused', () => {
    const { reg, frames } = setup();
    handleShowMedia({ items: [{ path: '/ok/a.mp4' }, { path: '/ok/b.png' }], publish: false }, {}, reg);
    const [video, image] = reg.list();
    assert.equal(handleMediaControl({ action: 'close', media_id: video!.id }, reg)['ok'], true);
    assert.deepEqual(frames.at(-1), { type: 'media_control', media_id: video!.id, action: 'close' });
    assert.equal(handleMediaControl({ action: 'open', media_id: video!.id, autoplay: true }, reg)['ok'], true);
    assert.deepEqual(frames.at(-1), { type: 'media_control', media_id: video!.id, action: 'open', autoplay: true });
    assert.equal(handleMediaControl({ action: 'play', media_id: image!.id }, reg)['ok'], false);
    assert.equal(handleMediaControl({ action: 'seek', media_id: video!.id }, reg)['ok'], false);
    assert.equal(handleMediaControl({ action: 'remove', all: true }, reg)['ok'], true);
    assert.equal(reg.list().length, 0);
    assert.equal(handleMediaControl({ action: 'open', media_id: video!.id }, reg)['ok'], false);
  });
});

describe('path allowlist', () => {
  it('follows links: a link inside an allowed root to a file outside is refused', () => {
    const inside = mkdtempSync(join(tmpdir(), 'sq-display-in-'));
    const outsideRoot = mkdtempSync(join(tmpdir(), 'sq-display-out-'));
    const secret = join(outsideRoot, 'secret.png');
    writeFileSync(secret, 'x');
    symlinkSync(secret, join(inside, 'link.png'));
    writeFileSync(join(inside, 'real.png'), 'x');
    assert.equal(resolveAllowedImagePath(join(inside, 'link.png'), { roots: [inside] }), null);
    assert.ok(resolveAllowedImagePath(join(inside, 'real.png'), { roots: [inside] }));
  });

  it('accepts a not-yet-written file only when asked, and never a directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'sq-display-root-'));
    mkdirSync(join(root, 'dir'));
    const future = join(root, 'out', 'render.mp3');
    assert.equal(resolveAllowedImagePath(future, { roots: [root] }), null);
    assert.equal(resolveAllowedImagePath(future, { roots: [root], allowMissing: true }), future);
    assert.equal(resolveAllowedImagePath(join(root, 'dir'), { roots: [root] }), null);
    assert.equal(resolveAllowedImagePath(join(root, '..', 'x.mp3'), { roots: [root], allowMissing: true }), null);
  });
});
