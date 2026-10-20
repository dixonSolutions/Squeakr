/**
 * The upload routes (docs/46) end to end through Fastify: a raw body streamed
 * to disk and processed, the phone's PCM fallback, attach-mode staging — and
 * how a turn is composed from typed text, sent media and attached media.
 */

import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

import { reloadConfig, type ConfigFile } from '../config.js';
import { pcm16ToWav } from '../providers/speech/wav.js';
import { registerMediaRoutes } from './media.js';
import { getMedia, resetMediaStore } from '../media/store.js';
import { attachedCount, resetAttachedMedia, setInlineSupportResolver } from '../media/delivery.js';
import { setMediaToolsForTest } from '../media/decode.js';
import { withMedia, TurnError } from '../executor/agentTurns.js';
import type { PipelineDeps } from '../media/pipeline.js';

let dir: string;
let app: FastifyInstance;
const heard: number[] = [];

const stt: PipelineDeps = {
  canTranscribe: () => true,
  transcribe: async (pcm) => {
    heard.push(pcm.length);
    return { text: 'the button is broken', provider: 'fake', model: 'f1' };
  },
};

function tone(seconds: number): Buffer {
  const pcm = Buffer.alloc(seconds * 32_000);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i / 6) * 6000), i * 2);
  return pcm;
}

before(async () => {
  process.env['APP_TOKEN'] ??= 'test-token-0123456789abcdef';
  reloadConfig(JSON.parse(readFileSync('config.example.json', 'utf8')) as ConfigFile);
  dir = mkdtempSync(join(tmpdir(), 'squeakr-media-routes-'));
  app = Fastify();
  // The real server's buffering parser, which the upload route must not use.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
  await registerMediaRoutes(app, { dir: () => dir, pipeline: stt });
  await app.ready();
});

after(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  heard.length = 0;
  resetMediaStore();
  resetAttachedMedia();
  setMediaToolsForTest(null);
  setInlineSupportResolver(() => ({ supported: true, cli: 'Claude Code' }));
});

async function uploadRaw(name: string, body: Buffer, type: string) {
  return app.inject({ method: 'POST', url: `/api/media?name=${encodeURIComponent(name)}`, headers: { 'content-type': type }, payload: body });
}

describe('POST /api/media', () => {
  test('a recording is saved raw and transcribed', async () => {
    const res = await uploadRaw('memo.wav', pcm16ToWav(tone(2)), 'audio/wav');
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.kind, 'audio');
    assert.equal(body.transcript_status, 'done');
    assert.equal(body.transcript, 'the button is broken');
    assert.equal(body.transcript_provider, 'fake');
    assert.equal(body.duration_sec, 2, 'measured from the decoded audio');
    const asset = getMedia(body.id)!;
    assert.ok(existsSync(asset.path));
    assert.ok(asset.path.startsWith(dir));
    assert.equal(body.path, undefined, 'host paths are not echoed to the phone');
  });

  test('bodies over the 10 MB app limit stream through (the route has its own ceiling)', async () => {
    const big = Buffer.alloc(12 * 1024 * 1024, 1);
    const res = await uploadRaw('big.bin', big, 'application/octet-stream');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().size, big.length);
    assert.equal(res.json().kind, 'file');
  });

  test('the file name is sanitised and the type falls back to the extension', async () => {
    const res = await uploadRaw('../../etc/pass wd.png', Buffer.from('x'), 'application/octet-stream');
    const body = res.json();
    assert.equal(body.name, 'pass_wd.png');
    assert.equal(body.mime, 'image/png');
    assert.ok(getMedia(body.id)!.path.startsWith(dir), 'stays in the media dir');
  });

  test('an empty upload is refused', async () => {
    const res = await uploadRaw('x.png', Buffer.alloc(0), 'image/png');
    assert.equal(res.statusCode, 400);
  });

  test('a declared size over the ceiling is refused before reading', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media?name=huge.mp4',
      headers: { 'content-type': 'video/mp4', 'content-length': String(600 * 1024 * 1024) },
      payload: Buffer.from('x'),
    });
    assert.equal(res.statusCode, 413);
  });
});

describe('POST /api/media/:id/pcm', () => {
  test('finishes a recording the bridge could not decode', async () => {
    setMediaToolsForTest({ ffmpeg: null, ffprobe: null });
    const up = (await uploadRaw('memo.webm', Buffer.from('webm bytes'), 'audio/webm')).json();
    assert.equal(up.transcript_status, 'needs_pcm');

    const res = await app.inject({
      method: 'POST',
      url: `/api/media/${up.id}/pcm`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: tone(3),
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().transcript_status, 'done');
    assert.equal(res.json().duration_sec, 3);
    assert.equal(heard[0], 96_000);
  });

  test('unknown id → 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/media/nope/pcm', headers: { 'content-type': 'application/octet-stream' }, payload: tone(1) });
    assert.equal(res.statusCode, 404);
  });
});

describe('POST /api/media/attach', () => {
  test('stages media for the next tool call or turn', async () => {
    const up = (await uploadRaw('shot.png', Buffer.from('png'), 'image/png')).json();
    const res = await app.inject({ method: 'POST', url: '/api/media/attach', payload: { ids: [up.id, 'gone'], delivery: 'inline' } });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.attached, 1);
    assert.deepEqual(body.missing, ['gone']);
    assert.equal(body.when, 'next_turn', 'no agent running in the test');
    assert.equal(body.delivery, 'inline');
    assert.equal(attachedCount(), 1);
  });

  test('reports path delivery when the CLI cannot show images', async () => {
    setInlineSupportResolver(() => ({ supported: false, cli: 'Codewhale' }));
    const up = (await uploadRaw('shot.png', Buffer.from('png'), 'image/png')).json();
    const body = (await app.inject({ method: 'POST', url: '/api/media/attach', payload: { ids: [up.id], delivery: 'inline' } })).json();
    assert.equal(body.delivery, 'path');
  });

  test('nothing found → 404, bad body → 400', async () => {
    assert.equal((await app.inject({ method: 'POST', url: '/api/media/attach', payload: { ids: ['x'] } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/api/media/attach', payload: { ids: [] } })).statusCode, 400);
  });
});

describe('composing a turn with media (withMedia)', () => {
  test('typed text, then the sent files with their transcript', async () => {
    const rec = (await uploadRaw('memo.wav', pcm16ToWav(tone(1)), 'audio/wav')).json();
    const out = withMedia('see the memo', { ids: [rec.id], delivery: 'path' });
    assert.match(out.text, /^see the memo\n\nThe user sent a file with this message/);
    assert.match(out.text, /> the button is broken/);
    assert.deepEqual(out.media, { ids: [rec.id], delivery: 'path' });
  });

  test('attached media joins the next turn and is consumed', async () => {
    const shot = (await uploadRaw('shot.png', Buffer.from('png'), 'image/png')).json();
    await app.inject({ method: 'POST', url: '/api/media/attach', payload: { ids: [shot.id], delivery: 'inline' } });
    const out = withMedia('carry on', undefined);
    assert.match(out.text, /^carry on\n\nThe user attached a file to the conversation/);
    assert.deepEqual(out.media, { ids: [shot.id], delivery: 'inline' });
    assert.equal(attachedCount(), 0);
    assert.equal(withMedia('again', undefined).media, undefined);
  });

  test('media-only turn', async () => {
    const shot = (await uploadRaw('shot.png', Buffer.from('png'), 'image/png')).json();
    const out = withMedia('', { ids: [shot.id], delivery: 'inline' });
    assert.match(out.text, /^The user sent a file/);
  });

  test('every sent id expired → MEDIA_GONE; some expired → reported', async () => {
    assert.throws(() => withMedia('x', { ids: ['gone'], delivery: 'path' }), (e: unknown) => e instanceof TurnError && e.code === 'MEDIA_GONE');
    const shot = (await uploadRaw('shot.png', Buffer.from('png'), 'image/png')).json();
    assert.deepEqual(withMedia('x', { ids: [shot.id, 'gone'], delivery: 'path' }).missing, ['gone']);
  });
});
