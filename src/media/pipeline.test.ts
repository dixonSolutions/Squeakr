/**
 * The media pipe (docs/46): uploads land on disk, recordings come back with a
 * transcript, videos with frames and a transcript of their sound, images with
 * a copy small enough for the agent's chat — and every missing extra says why.
 *
 * Speech-to-text is faked (it is the configured chain's job, tested there);
 * decoding is real. The ffmpeg cases run when the host has ffmpeg and are
 * skipped, saying so, when it does not.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { pcm16ToWav } from '../providers/speech/wav.js';
import { encodeOggOpus } from '../channels/audio.js';
import { findOnPath } from '../cli/audioInput.js';
import { saveMediaStream, resetMediaStore, type MediaAsset } from './store.js';
import { mediaTools, setMediaToolsForTest, frameTimes, decodeToPcm16k } from './decode.js';
import { processMedia, splitPcm, transcribePcm, transcribeAssetPcm, type PipelineDeps } from './pipeline.js';

const FFMPEG = findOnPath('ffmpeg');
const FFPROBE = findOnPath('ffprobe');
const needsFfmpeg = FFMPEG && FFPROBE ? false : 'ffmpeg/ffprobe not installed on this host';

/** A tone, so "speech" has energy; `gaps` puts silence at those seconds. */
function tone(seconds: number, rate = 16_000, gaps: number[] = []): Buffer {
  const pcm = Buffer.alloc(seconds * rate * 2);
  for (let i = 0; i < seconds * rate; i++) {
    const t = i / rate;
    const silent = gaps.some((g) => Math.abs(t - g) < 0.2);
    pcm.writeInt16LE(silent ? 0 : Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000), i * 2);
  }
  return pcm;
}

function fakeStt(reply = 'hello from the recording'): PipelineDeps & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    canTranscribe: () => true,
    transcribe: async (pcm) => {
      calls.push(pcm.length);
      return { text: reply, provider: 'fake', model: 'fake-1' };
    },
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'squeakr-media-'));
  resetMediaStore();
  setMediaToolsForTest(null);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  setMediaToolsForTest(null);
});

async function upload(name: string, data: Buffer, mime: string | null = null): Promise<MediaAsset> {
  return saveMediaStream(Readable.from([data]), { name, mime, dir });
}

describe('splitPcm', () => {
  test('short audio is one piece', () => {
    const pcm = tone(5);
    assert.deepEqual(splitPcm(pcm, 120).map((p) => p.length), [pcm.length]);
  });

  test('long audio is cut near the target, in the quiet, without losing a byte', () => {
    const pcm = tone(30, 16_000, [9.5, 21]);
    const pieces = splitPcm(pcm, 10);
    assert.equal(pieces.reduce((n, p) => n + p.length, 0), pcm.length);
    assert.ok(pieces.length >= 2);
    // The first cut lands inside the silent gap around 9.5 s, not at exactly 10 s.
    const firstCutSec = pieces[0]!.length / 32_000;
    assert.ok(Math.abs(firstCutSec - 9.5) < 0.25, `cut at ${firstCutSec}s`);
    for (const p of pieces) assert.equal(p.length % 2, 0, 'cuts stay on sample boundaries');
  });
});

describe('transcribePcm', () => {
  test('joins the pieces in order and keeps the first provider', async () => {
    let n = 0;
    const deps: PipelineDeps = {
      canTranscribe: () => true,
      transcribe: async () => ({ text: `part ${++n}`, provider: n === 1 ? 'groq' : 'other', model: 'w' }),
    };
    const out = await transcribePcm(tone(300), deps);
    assert.match(out.text, /^part 1 part 2( part 3)?$/);
    assert.equal(out.provider, 'groq');
  });

  test('silence markers from the engine are not a transcript', async () => {
    const out = await transcribePcm(tone(2), { canTranscribe: () => true, transcribe: async () => ({ text: '[silence]' }) });
    assert.equal(out.text, '');
  });
});

describe('processMedia — recordings', () => {
  test('a WAV recording keeps its raw file and gets a transcript saved next to it', async () => {
    const asset = await upload('memo.wav', pcm16ToWav(tone(3)), 'audio/wav');
    const stt = fakeStt();
    await processMedia(asset, stt);
    assert.equal(asset.kind, 'audio');
    assert.equal(asset.transcriptStatus, 'done');
    assert.equal(asset.transcript?.text, 'hello from the recording');
    assert.equal(asset.transcript?.provider, 'fake');
    assert.ok(existsSync(asset.path), 'raw file kept');
    assert.equal(readFileSync(asset.transcriptPath!, 'utf8').trim(), 'hello from the recording');
    assert.equal(stt.calls.length, 1);
    // 3 s of 16 kHz mono PCM16 reached the engine.
    assert.ok(Math.abs(stt.calls[0]! - 96_000) < 64);
  });

  test('a 44.1 kHz stereo WAV is downmixed and resampled before transcription', async () => {
    const rate = 44_100;
    const mono = tone(2, rate);
    const stereo = Buffer.alloc(mono.length * 2);
    for (let i = 0; i < mono.length / 2; i++) {
      stereo.writeInt16LE(mono.readInt16LE(i * 2), i * 4);
      stereo.writeInt16LE(mono.readInt16LE(i * 2), i * 4 + 2);
    }
    const wav = pcm16ToWav(stereo, rate);
    wav.writeUInt16LE(2, 22); // channels
    wav.writeUInt32LE(rate * 4, 28); // byte rate
    wav.writeUInt16LE(4, 32); // block align
    const asset = await upload('stereo.wav', wav);
    const stt = fakeStt();
    await processMedia(asset, stt);
    assert.equal(asset.transcriptStatus, 'done');
    assert.ok(Math.abs(stt.calls[0]! - 64_000) < 200, `got ${stt.calls[0]} bytes`);
  });

  test('an Ogg/Opus voice note decodes in-process (no ffmpeg needed)', async (t) => {
    let ogg: Buffer;
    try {
      ogg = encodeOggOpus(tone(2), 16_000);
    } catch {
      t.skip('opusscript (optional dependency) is not installed');
      return;
    }
    setMediaToolsForTest({ ffmpeg: null, ffprobe: null });
    const asset = await upload('voice.ogg', ogg, 'audio/ogg');
    const stt = fakeStt();
    await processMedia(asset, stt);
    assert.equal(asset.transcriptStatus, 'done');
    assert.ok(stt.calls[0]! > 50_000);
  });

  test('a format the bridge cannot decode asks the phone for PCM, and PCM finishes the job', async () => {
    setMediaToolsForTest({ ffmpeg: null, ffprobe: null });
    const asset = await upload('memo.webm', Buffer.from('\x1aE\xdf\xa3not really webm'), 'audio/webm');
    const stt = fakeStt('decoded on the phone');
    await processMedia(asset, stt);
    assert.equal(asset.transcriptStatus, 'needs_pcm');
    assert.match(asset.transcriptError ?? '', /ffmpeg/);

    await transcribeAssetPcm(asset, tone(2), stt);
    assert.equal(asset.transcriptStatus, 'done');
    assert.equal(asset.transcript?.text, 'decoded on the phone');
    assert.equal(asset.durationSec, 2);
  });

  test('no speech engine configured → unavailable, raw file still there', async () => {
    const asset = await upload('memo.wav', pcm16ToWav(tone(1)));
    await processMedia(asset, { canTranscribe: () => false, transcribe: async () => assert.fail('must not be called') });
    assert.equal(asset.transcriptStatus, 'unavailable');
    assert.ok(existsSync(asset.path));
  });

  test('an engine error is recorded, not thrown', async () => {
    const asset = await upload('memo.wav', pcm16ToWav(tone(1)));
    await processMedia(asset, {
      canTranscribe: () => true,
      transcribe: async () => {
        throw new Error('rate limited');
      },
    });
    assert.equal(asset.transcriptStatus, 'failed');
    assert.equal(asset.transcriptError, 'rate limited');
  });

  test('silence is "empty", not "done" with nothing in it', async () => {
    const asset = await upload('quiet.wav', pcm16ToWav(Buffer.alloc(32_000)));
    await processMedia(asset, fakeStt(''));
    assert.equal(asset.transcriptStatus, 'empty');
    assert.equal(asset.transcriptPath, null);
  });
});

describe('processMedia — images', () => {
  test('a small PNG goes inline as itself', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const asset = await upload('dot.png', png, 'image/png');
    await processMedia(asset, fakeStt());
    assert.equal(asset.kind, 'image');
    assert.deepEqual(asset.inline, { path: asset.path, mime: 'image/png' });
    assert.equal(asset.transcriptStatus, 'none');
  });

  test('an image type models do not take, with no ffmpeg, has no inline copy', async () => {
    setMediaToolsForTest({ ffmpeg: null, ffprobe: null });
    const asset = await upload('scan.bmp', Buffer.from('BM fake'), 'image/bmp');
    await processMedia(asset, fakeStt());
    assert.equal(asset.inline, null);
  });

  test('a BMP is converted to an inline JPEG', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'src.bmp');
    execFileSync(FFMPEG!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', src]);
    const asset = await upload('src.bmp', readFileSync(src), 'image/bmp');
    await processMedia(asset, fakeStt());
    assert.equal(asset.inline?.mime, 'image/jpeg');
    assert.notEqual(asset.inline?.path, asset.path);
    assert.ok(statSync(asset.inline!.path).size > 0);
  });

  test('a huge PNG is downscaled to the inline edge', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'big.png');
    execFileSync(FFMPEG!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=4000x3000,geq=random(1)*255:128:128', '-frames:v', '1', src]);
    assert.ok(statSync(src).size > 3_500_000, 'fixture is over the inline limit');
    const asset = await upload('big.png', readFileSync(src), 'image/png');
    await processMedia(asset, fakeStt());
    assert.equal(asset.inline?.mime, 'image/jpeg');
    const dims = execFileSync(FFPROBE!, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', asset.inline!.path]).toString().trim();
    assert.equal(dims, '1568,1176');
  });
});

describe('processMedia — video', () => {
  test('frames are taken across the clip and its sound is transcribed', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'clip.mp4');
    execFileSync(FFMPEG!, [
      '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-shortest', '-pix_fmt', 'yuv420p', src,
    ]);
    const asset = await upload('clip.mp4', readFileSync(src), 'video/mp4');
    const stt = fakeStt('narration');
    await processMedia(asset, stt);
    assert.equal(asset.kind, 'video');
    assert.ok(asset.durationSec! > 5.5 && asset.durationSec! < 6.5);
    assert.equal(asset.frames.length, 4);
    for (const f of asset.frames) assert.ok(statSync(f).size > 0);
    assert.equal(asset.transcriptStatus, 'done');
    assert.equal(asset.transcript?.text, 'narration');
    assert.ok(Math.abs(stt.calls[0]! - 6 * 32_000) < 3_200);
  });

  test('a silent video gets frames and no transcript', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'silent.webm');
    execFileSync(FFMPEG!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=5:duration=3', src]);
    const asset = await upload('silent.webm', readFileSync(src), 'video/webm');
    const stt = fakeStt();
    await processMedia(asset, stt);
    assert.equal(asset.frames.length, 3);
    assert.equal(asset.transcriptStatus, 'none');
    assert.equal(stt.calls.length, 0);
  });

  test('an audio-only WebM labelled video/webm is treated as a recording', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'memo.webm');
    execFileSync(FFMPEG!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'libopus', src]);
    const asset = await upload('memo.webm', readFileSync(src), 'video/webm');
    const stt = fakeStt();
    await processMedia(asset, stt);
    assert.equal(asset.kind, 'audio');
    assert.equal(asset.mime, 'audio/webm');
    assert.deepEqual(asset.frames, []);
    assert.equal(asset.transcriptStatus, 'done');
  });

  test('without ffmpeg a video is still saved and handed over by path', async () => {
    setMediaToolsForTest({ ffmpeg: null, ffprobe: null });
    const asset = await upload('clip.mov', Buffer.from('not decodable here'), 'video/quicktime');
    await processMedia(asset, fakeStt());
    assert.deepEqual(asset.frames, []);
    assert.equal(asset.transcriptStatus, 'needs_pcm');
    assert.ok(existsSync(asset.path));
  });
});

describe('decodeToPcm16k via ffmpeg', () => {
  test('a WebM/Opus recording (what Chrome records) decodes', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'rec.webm');
    execFileSync(FFMPEG!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'libopus', src]);
    const out = await decodeToPcm16k(src);
    assert.ok(out.ok);
    if (out.ok) {
      assert.equal(out.via, 'ffmpeg');
      assert.ok(Math.abs(out.pcm.length - 64_000) < 3_200);
    }
  });

  test('an M4A/AAC recording (what Safari records) decodes', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'rec.m4a');
    execFileSync(FFMPEG!, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', '-c:a', 'aac', src]);
    const out = await decodeToPcm16k(src);
    assert.ok(out.ok);
  });

  test('garbage reports why instead of throwing', { skip: needsFfmpeg }, async () => {
    const src = join(dir, 'junk.mp3');
    writeFileSync(src, 'definitely not audio');
    const out = await decodeToPcm16k(src);
    assert.equal(out.ok, false);
  });
});

describe('frameTimes', () => {
  test('evenly spread, never at the very ends', () => {
    assert.deepEqual(frameTimes(8, 4), [1, 3, 5, 7]);
    assert.deepEqual(frameTimes(null), [0]);
    assert.deepEqual(frameTimes(0.4), [0]);
    assert.deepEqual(frameTimes(2, 4), [0.5, 1.5]);
  });
});

test('mediaTools reports what the host has', () => {
  const tools = mediaTools();
  assert.equal(tools.ffmpeg, FFMPEG);
});
