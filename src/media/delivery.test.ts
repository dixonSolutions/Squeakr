/**
 * Handing media to the agent (docs/46): what the turn text says, which
 * pictures go into the chat, attach-mode staging, `view_media`, and media
 * riding out on a Squeakr tool result — for path and inline delivery, and for
 * a CLI that declares it cannot show tool-result images.
 */

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerMedia, resetMediaStore, type MediaAsset } from './store.js';
import {
  attachMedia,
  attachedCount,
  composeTurnText,
  describeMediaForAgent,
  durationLabel,
  inlineImagesOf,
  isAttachTarget,
  mediaImageBlocks,
  resetAttachedMedia,
  setAttachTargetResolver,
  setInlineSupportResolver,
  takeAttachedMedia,
  turnImageBlocks,
} from './delivery.js';
import { handleViewMedia } from '../mcp/server/mediaToolHandlers.js';
import { attachListenerToResult } from '../mcp/server/listenerEnvelope.js';
import { voiceTurnQueue } from '../mcp/server/turnQueue.js';
import { reloadConfig, type ConfigFile } from '../config.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let dir: string;
let n = 0;

function asset(over: Partial<MediaAsset>): MediaAsset {
  n += 1;
  const a: MediaAsset = {
    id: `id-${n}`,
    kind: 'image',
    name: `file-${n}`,
    mime: 'image/png',
    size: 2048,
    path: join(dir, `file-${n}`),
    createdAt: new Date().toISOString(),
    durationSec: null,
    transcriptStatus: 'none',
    transcript: null,
    transcriptError: null,
    transcriptPath: null,
    frames: [],
    inline: null,
    ...over,
  };
  registerMedia(a);
  return a;
}

function image(): MediaAsset {
  const path = join(dir, `shot-${n + 1}.png`);
  writeFileSync(path, PNG);
  return asset({ name: 'shot.png', path, inline: { path, mime: 'image/png' } });
}

function recording(text = 'please fix the login button'): MediaAsset {
  return asset({
    kind: 'audio',
    name: 'memo.webm',
    mime: 'audio/webm',
    durationSec: 42,
    transcriptStatus: 'done',
    transcript: { text, provider: 'groq', model: 'whisper-large-v3' },
    transcriptPath: join(dir, 'memo.webm.transcript.txt'),
  });
}

function video(): MediaAsset {
  const frames = [1, 2].map((i) => {
    const p = join(dir, `clip.frame-${i}.jpg`);
    writeFileSync(p, PNG);
    return p;
  });
  return asset({
    kind: 'video',
    name: 'clip.mp4',
    mime: 'video/mp4',
    durationSec: 75,
    frames,
    transcriptStatus: 'done',
    transcript: { text: 'this is the bug', provider: 'fake', model: null },
  });
}

// The listener envelope reads the away policy from config.
before(() => {
  process.env['APP_TOKEN'] ??= 'test-token-0123456789abcdef';
  reloadConfig(JSON.parse(readFileSync('config.example.json', 'utf8')) as ConfigFile);
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'squeakr-delivery-'));
  resetMediaStore();
  resetAttachedMedia();
  setInlineSupportResolver(() => ({ supported: true, cli: 'Claude Code' }));
  voiceTurnQueue.clear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('describeMediaForAgent', () => {
  test('a recording gives the raw path and the full transcript', () => {
    const r = recording();
    const text = describeMediaForAgent([r], 'path');
    assert.match(text, /Recording "memo\.webm" \(audio\/webm, 2 KB, 0:42\): /);
    assert.ok(text.includes(r.path), 'raw file path');
    assert.match(text, /Transcript \(automatic, groq \/ whisper-large-v3; saved at .*memo\.webm\.transcript\.txt\):/);
    assert.match(text, /> please fix the login button/);
  });

  test('a video lists its frames and its sound transcript', () => {
    const text = describeMediaForAgent([video()], 'path');
    assert.match(text, /Video "clip\.mp4" \(video\/mp4, 2 KB, 1:15\)/);
    assert.match(text, /Frames: clip\.frame-1\.jpg, clip\.frame-2\.jpg/);
    assert.match(text, /Sound transcript .*:\n  > this is the bug/);
  });

  test('a missing transcript says why', () => {
    const r = asset({ kind: 'audio', transcriptStatus: 'unavailable', transcriptError: 'No speech-to-text engine is configured on the bridge.' });
    assert.match(describeMediaForAgent([r], 'path'), /Transcript: not available — No speech-to-text engine/);
  });

  test('inline names view_media with the ids that have pictures', () => {
    const img = image();
    const rec = recording();
    const text = describeMediaForAgent([img, rec], 'inline');
    assert.match(text, new RegExp(`view_media\\(ids=\\["${img.id}"\\]\\)`));
    assert.doesNotMatch(text, new RegExp(rec.id));
  });

  test('inline on a CLI without tool-result images falls back to the paths, and says so', () => {
    setInlineSupportResolver(() => ({ supported: false, cli: 'Codewhale' }));
    const text = describeMediaForAgent([image()], 'inline');
    assert.match(text, /Codewhale does not show images from tool results — open the files by path/);
    assert.doesNotMatch(text, /view_media/);
  });

  test('attach mode says it is context, not a new request', () => {
    assert.match(describeMediaForAgent([image()], 'path', 'attach'), /not a new request/);
  });

  test('composeTurnText keeps what was typed first, and stands alone with no text', () => {
    const img = image();
    assert.match(composeTurnText('what is wrong here?', [img], 'path'), /^what is wrong here\?\n\nThe user sent a file/);
    assert.match(composeTurnText('', [img], 'path'), /^The user sent a file/);
    assert.equal(composeTurnText('just text', [], 'path'), 'just text');
  });

  test('durationLabel', () => {
    assert.equal(durationLabel(5), '0:05');
    assert.equal(durationLabel(3725), '1:02:05');
    assert.equal(durationLabel(null), null);
  });
});

describe('image blocks', () => {
  test('images give themselves, videos their frames, recordings nothing', () => {
    assert.equal(inlineImagesOf(image()).length, 1);
    assert.equal(inlineImagesOf(video()).length, 2);
    assert.equal(inlineImagesOf(recording()).length, 0);
  });

  test('each picture is a labelled MCP image block with the file bytes', () => {
    const img = image();
    const blocks = mediaImageBlocks([img, recording()]);
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: 'text', text: `[media ${img.id}] shot.png` });
    assert.deepEqual(blocks[1], { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' });
  });

  test('capped per result', () => {
    const blocks = mediaImageBlocks([image(), image(), image()], 2);
    assert.equal(blocks.filter((b) => b.type === 'image').length, 2);
    assert.match((blocks.at(-1) as { text: string }).text, /More pictures/);
  });

  test('turnImageBlocks: only for inline, only when the CLI shows images', () => {
    const img = image();
    assert.equal(turnImageBlocks({ ids: [img.id], delivery: 'path' }).length, 0);
    assert.equal(turnImageBlocks({ ids: [img.id], delivery: 'inline' }).length, 2);
    setInlineSupportResolver(() => ({ supported: false, cli: 'Codewhale' }));
    assert.equal(turnImageBlocks({ ids: [img.id], delivery: 'inline' }).length, 0);
  });
});

describe('attach mode', () => {
  test('staged media is merged, inline wins, and it is handed over once', () => {
    const a = image();
    const b = recording();
    attachMedia([a.id], 'path');
    attachMedia([b.id, a.id], 'inline');
    assert.equal(attachedCount(), 2);
    const taken = takeAttachedMedia();
    assert.equal(taken?.delivery, 'inline');
    assert.deepEqual(taken?.assets.map((x) => x.id), [a.id, b.id]);
    assert.equal(takeAttachedMedia(), null);
    assert.equal(attachedCount(), 0);
  });

  test('only the voice agent session is a target', () => {
    assert.equal(isAttachTarget('mcp-1'), false);
    setAttachTargetResolver((k) => k === 'mcp-voice');
    assert.equal(isAttachTarget('mcp-voice'), true);
    assert.equal(isAttachTarget('mcp-worker'), false);
    assert.equal(isAttachTarget(undefined), false);
  });

  test('rides out on the voice agent\'s next Squeakr tool result, with the pictures when inline', () => {
    setAttachTargetResolver((k) => k === 'mcp-voice');
    const img = image();
    attachMedia([img.id], 'inline');

    // A worker's tool call does not take it.
    const worker = attachListenerToResult('speak', { content: [{ type: 'text', text: '{"ok":true}' }] }, 'mcp-worker') as { content: { type: string; text?: string }[] };
    assert.equal(worker.content.length, 1);
    assert.equal(attachedCount(), 1);

    const res = attachListenerToResult('speak', { content: [{ type: 'text', text: '{"ok":true}' }] }, 'mcp-voice') as {
      content: { type: string; text?: string; data?: string }[];
    };
    const payload = JSON.parse(res.content[0]!.text!);
    assert.match(payload.attached_media, /attached a file to the conversation/);
    assert.deepEqual(payload.attached_media_ids, [img.id]);
    assert.equal(res.content.length, 3, 'JSON + label + image');
    assert.equal(res.content[2]!.type, 'image');
    assert.equal(attachedCount(), 0, 'consumed');
  });

  test('path delivery adds the text only', () => {
    setAttachTargetResolver(() => true);
    const img = image();
    attachMedia([img.id], 'path');
    const res = attachListenerToResult('get_agent_status', { content: [{ type: 'text', text: '{}' }] }, 'k') as { content: unknown[] };
    assert.equal(res.content.length, 1);
    assert.match(JSON.parse((res.content[0] as { text: string }).text).attached_media, /Open the files by path/);
  });
});

describe('view_media', () => {
  test('returns the files as text plus the pictures', () => {
    const img = image();
    const vid = video();
    const out = handleViewMedia({ ids: [img.id, vid.id, 'gone'] });
    const summary = JSON.parse((out.content[0] as { text: string }).text);
    assert.deepEqual(summary.found, [img.id, vid.id]);
    assert.deepEqual(summary.missing, ['gone']);
    assert.match(summary.files, /Sound transcript/);
    assert.equal(out.content.filter((c) => c.type === 'image').length, 3);
  });

  test('unknown ids are an error that still points at the paths', () => {
    const out = handleViewMedia({ ids: ['nope'] });
    assert.equal(out.isError, true);
    assert.match((out.content[0] as { text: string }).text, /still at the paths/);
  });

  test('a CLI without image support gets text and a note', () => {
    setInlineSupportResolver(() => ({ supported: false, cli: 'Codewhale' }));
    const out = handleViewMedia({ ids: [image().id] });
    assert.equal(out.content.length, 1);
    assert.match((out.content[0] as { text: string }).text, /Codewhale does not show images/);
  });
});

describe('turn queue', () => {
  test('a turn carries its media to next_voice_turn', async () => {
    const img = image();
    voiceTurnQueue.enqueue('look at this', { source: 'phone', media: { ids: [img.id], delivery: 'inline' } });
    const turn = await voiceTurnQueue.dequeue(10);
    assert.deepEqual(turn?.media, { ids: [img.id], delivery: 'inline' });
  });

  test('a turn without media has none', async () => {
    voiceTurnQueue.enqueue('hi', { source: 'phone', media: { ids: [], delivery: 'path' } });
    const turn = await voiceTurnQueue.dequeue(10);
    assert.equal(turn?.media, undefined);
  });
});
