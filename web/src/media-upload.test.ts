import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeAsset,
  downmix,
  floatToPcm16,
  formatBytes,
  pickRecorderMime,
  recordingName,
  type MediaAssetView,
} from './media-upload.js';

describe('floatToPcm16', () => {
  test('full scale, zero and clipping, little-endian', () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    const view = new DataView(out.buffer);
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(i * 2, true)),
      [0, 32767, -32768, 32767, -32768, 16384],
    );
  });
});

describe('downmix', () => {
  test('mono passes through, stereo averages', () => {
    const mono = new Float32Array([0.1, 0.2]);
    assert.equal(downmix([mono]), mono);
    assert.deepEqual([...downmix([new Float32Array([1, 0]), new Float32Array([0, 1])])], [0.5, 0.5]);
  });
});

describe('recorder', () => {
  test('prefers Opus, falls back to AAC on Safari, null when nothing records', () => {
    assert.equal(pickRecorderMime(() => true), 'audio/webm;codecs=opus');
    assert.equal(pickRecorderMime((m) => m === 'audio/mp4'), 'audio/mp4');
    assert.equal(pickRecorderMime(() => false), null);
  });

  test('recording names carry the time and the right extension', () => {
    const at = new Date(2026, 9, 20, 8, 7, 9);
    assert.equal(recordingName('audio/webm;codecs=opus', at), 'memo-2026-10-20-080709.webm');
    assert.equal(recordingName('audio/mp4', at), 'memo-2026-10-20-080709.m4a');
    assert.equal(recordingName('audio/ogg;codecs=opus', at), 'memo-2026-10-20-080709.ogg');
  });
});

describe('describeAsset', () => {
  const base: MediaAssetView = {
    id: 'a', kind: 'audio', name: 'memo.webm', mime: 'audio/webm', size: 52_000,
    duration_sec: 65, transcript_status: 'done', transcript: 'hi', transcript_provider: 'groq',
    transcript_error: null, frames: 0, inline: false,
  };

  test('recording', () => {
    assert.equal(describeAsset(base), '51 KB · 1:05 · transcribed');
  });

  test('video with frames and no sound', () => {
    assert.equal(
      describeAsset({ ...base, kind: 'video', size: 3 * 1024 * 1024, duration_sec: 9, frames: 4, transcript_status: 'none' }),
      '3.0 MB · 0:09 · 4 frames',
    );
  });

  test('transcript problems read the same to the user', () => {
    assert.match(describeAsset({ ...base, transcript_status: 'needs_pcm' }), /no transcript$/);
    assert.match(describeAsset({ ...base, transcript_status: 'empty' }), /no speech heard$/);
  });

  test('formatBytes', () => {
    assert.equal(formatBytes(900), '900 B');
    assert.equal(formatBytes(2048), '2 KB');
  });
});
