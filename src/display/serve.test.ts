import { strict as assert } from 'node:assert';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { DisplayRegistry, type ShowOptions } from './registry.js';
import { parseRange, registerDisplayRoutes, tailFile } from './serve.js';

const OPTS: ShowOptions = {
  display: 'tray',
  autoplay: false,
  muted: false,
  loop: false,
  autoCloseMs: null,
  closeOnEnd: false,
  selfDestruct: 'never',
};

describe('parseRange', () => {
  it('reads the forms browsers send', () => {
    assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange(undefined, 100), null);
    assert.equal(parseRange('bytes=0-1,5-6', 100), null);
  });
});

describe('tailFile', () => {
  it('follows a growing file until it is finished, waiting for it to appear', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sq-tail-'));
    const path = join(dir, 'render.mp3');
    let live = true;
    let step = 0;
    // Each "sleep" is one poll: the writer acts between polls.
    const sleep = async () => {
      step++;
      if (step === 2) writeFileSync(path, 'one ');
      if (step === 4) appendFileSync(path, 'two ');
      if (step === 6) {
        appendFileSync(path, 'three');
        live = false;
      }
    };
    const chunks: string[] = [];
    for await (const c of tailFile(path, { isLive: () => live, exists: () => true, sleep, idleMs: 60_000 })) {
      chunks.push(c.toString());
    }
    assert.equal(chunks.join(''), 'one two three');
  });

  it('stops after the idle limit when the writer goes quiet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sq-tail-'));
    const path = join(dir, 'stalled.mp3');
    writeFileSync(path, 'abc');
    let now = 0;
    const out: string[] = [];
    for await (const c of tailFile(path, {
      isLive: () => true,
      exists: () => true,
      idleMs: 1000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    })) {
      out.push(c.toString());
    }
    assert.deepEqual(out, ['abc']);
  });

  it('stops when the item is removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sq-tail-'));
    const path = join(dir, 'gone.mp3');
    writeFileSync(path, 'abc');
    let exists = true;
    const out: string[] = [];
    for await (const c of tailFile(path, { isLive: () => true, exists: () => exists, sleep: async () => { exists = false; } })) {
      out.push(c.toString());
    }
    assert.deepEqual(out, ['abc']);
  });
});

describe('GET /api/display/:id', () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'sq-serve-'));
    const reg = new DisplayRegistry({ resolvePath: (p) => p });
    const app = Fastify();
    registerDisplayRoutes(app, reg);
    await app.ready();
    return { dir, reg, app };
  }

  it('serves a file whole and by range, only with the item key', async () => {
    const { dir, reg, app } = await setup();
    const file = join(dir, 'clip.mp4');
    writeFileSync(file, Buffer.from('0123456789'));
    // serve.ts re-checks the real allowlist; the OS temp dir is on it.
    const item = reg.add([{ path: file }], OPTS).items[0]!;

    const whole = await app.inject({ url: `/api/display/${item.id}?k=${item.key}` });
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers['content-type'], 'video/mp4');
    assert.equal(whole.headers['accept-ranges'], 'bytes');
    assert.equal(whole.body, '0123456789');

    const part = await app.inject({ url: `/api/display/${item.id}?k=${item.key}`, headers: { range: 'bytes=2-5' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], 'bytes 2-5/10');
    assert.equal(part.body, '2345');

    assert.equal((await app.inject({ url: `/api/display/${item.id}?k=wrong` })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/display/${item.id}` })).statusCode, 401);

    reg.remove([item.id], 'agent');
    assert.equal((await app.inject({ url: `/api/display/${item.id}?k=${item.key}` })).statusCode, 404);
  });

  it('streams a live file to its end once finished', async () => {
    const { dir, reg, app } = await setup();
    const file = join(dir, 'render.mp3');
    writeFileSync(file, 'ID3 part one, ');
    const item = reg.add([{ path: file, live: true }], OPTS).items[0]!;
    setTimeout(() => appendFileSync(file, 'part two'), 300);
    setTimeout(() => reg.finishLive(item.id), 700);
    const res = await app.inject({ url: `/api/display/${item.id}?k=${item.key}`, headers: { range: 'bytes=0-' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.equal(res.body, 'ID3 part one, part two');
  });

  it('serves base64 data with ranges', async () => {
    const { reg, app } = await setup();
    const item = reg.add([{ data: `data:audio/wav;base64,${Buffer.from('RIFFdata').toString('base64')}` }], OPTS).items[0]!;
    const res = await app.inject({ url: `/api/display/${item.id}?k=${item.key}`, headers: { range: 'bytes=4-' } });
    assert.equal(res.statusCode, 206);
    assert.equal(res.body, 'data');
    assert.equal(res.headers['content-type'], 'audio/wav');
  });
});
