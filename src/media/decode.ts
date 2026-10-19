/**
 * Turning an upload into what the agent and the speech engines can use:
 * 16 kHz mono PCM for transcription, still frames from a video, and a small
 * JPEG when an image is too big (or the wrong format) to put in the chat.
 *
 * WAV and Ogg/Opus decode in-process, so a recording made on the phone needs
 * nothing installed. Everything else — WebM, MP4/M4A, MOV, MP3 — goes through
 * ffmpeg when the host has it. When it does not, the asset says `needs_pcm`
 * and the phone, which can decode its own recordings, sends the PCM instead
 * (routes/media.ts). Nothing here is required: a missing tool only means a
 * missing extra, never a failed upload.
 */

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findOnPath, parseWavHeader, PcmConverter } from '../cli/audioInput.js';
import { decodeOggOpusTo16k } from '../channels/audio.js';
import { childLogger } from '../log.js';

const log = childLogger('media:decode');

/** Image types every CLI's model accepts as an image block. */
export const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Raw images up to this size go inline untouched; larger ones are downscaled. */
export const INLINE_MAX_BYTES = 3_500_000;
/** Longest side of a downscaled image or a video frame. */
export const INLINE_MAX_EDGE = 1568;
/** Frames taken from one video. */
export const VIDEO_FRAME_COUNT = 4;

const FFMPEG_TIMEOUT_MS = 10 * 60 * 1000;
/** In-process WAV decode reads the whole file — keep that bounded. */
const MAX_IN_PROCESS_BYTES = 256 * 1024 * 1024;

export interface MediaTools {
  ffmpeg: string | null;
  ffprobe: string | null;
}

let toolsCache: MediaTools | null = null;

/** Which helpers the host has. Looked up once — installing ffmpeg needs a restart. */
export function mediaTools(): MediaTools {
  toolsCache ??= { ffmpeg: findOnPath('ffmpeg'), ffprobe: findOnPath('ffprobe') };
  return toolsCache;
}

/** Test hook: pretend the host has (or lacks) these. */
export function setMediaToolsForTest(tools: MediaTools | null): void {
  toolsCache = tools;
}

function run(bin: string, args: string[], timeoutMs = FFMPEG_TIMEOUT_MS): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 4000) err += c.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(Buffer.concat(out));
      else reject(new Error(`${bin.split('/').pop()} exited ${signal ?? code}: ${err.trim().split('\n').pop() ?? ''}`));
    });
  });
}

function head(path: string, bytes: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// ── Probing ────────────────────────────────────────────────────────────────

/** Length in seconds, or null when nothing could tell. */
export async function probeDuration(path: string): Promise<number | null> {
  const { ffprobe } = mediaTools();
  if (!ffprobe) return null;
  try {
    const out = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], 30_000);
    const sec = Number.parseFloat(out.toString().trim());
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec * 10) / 10 : null;
  } catch (err) {
    log.debug({ err: (err as Error).message }, 'ffprobe duration failed');
    return null;
  }
}

/**
 * Whether a "video" really has pictures. Browsers label every `.webm` as
 * `video/webm`, audio-only recordings included. Unknown counts as yes.
 */
export async function hasVideoStream(path: string): Promise<boolean> {
  const { ffprobe } = mediaTools();
  if (!ffprobe) return true;
  try {
    const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path], 30_000);
    return out.toString().trim().length > 0;
  } catch {
    return true;
  }
}

/** Whether a video has a sound track worth transcribing. Unknown counts as yes. */
export async function hasAudioStream(path: string): Promise<boolean> {
  const { ffprobe } = mediaTools();
  if (!ffprobe) return true;
  try {
    const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', path], 30_000);
    return out.toString().trim().length > 0;
  } catch {
    return true;
  }
}

// ── Audio ──────────────────────────────────────────────────────────────────

export type DecodeResult =
  | { ok: true; pcm: Buffer; via: 'wav' | 'ogg-opus' | 'ffmpeg' }
  | { ok: false; reason: string };

/** A WAV file → 16 kHz mono PCM16, in-process. */
export function decodeWav(file: Buffer): Buffer {
  const info = parseWavHeader(file);
  if (!info) throw new Error('truncated WAV header');
  const converter = new PcmConverter(info, info.audioFormat === 3 ? 'float32' : 'int16');
  return converter.push(file.subarray(info.dataOffset));
}

/**
 * Any recording (or a video's sound track) → 16 kHz mono PCM16.
 * Tries in-process decoders first, then ffmpeg.
 */
export async function decodeToPcm16k(path: string): Promise<DecodeResult> {
  const size = statSync(path).size;
  const magic = head(path, 64);
  const tag = magic.toString('ascii', 0, 4);

  if (tag === 'RIFF' && magic.toString('ascii', 8, 12) === 'WAVE' && size <= MAX_IN_PROCESS_BYTES) {
    try {
      return { ok: true, pcm: decodeWav(readFileSync(path)), via: 'wav' };
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'in-process WAV decode failed — trying ffmpeg');
    }
  }
  if (tag === 'OggS' && magic.includes(Buffer.from('OpusHead')) && size <= MAX_IN_PROCESS_BYTES) {
    try {
      return { ok: true, pcm: decodeOggOpusTo16k(readFileSync(path)), via: 'ogg-opus' };
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'in-process Ogg/Opus decode failed — trying ffmpeg');
    }
  }

  const { ffmpeg } = mediaTools();
  if (!ffmpeg) {
    return { ok: false, reason: 'ffmpeg is not installed on the bridge host, and this format cannot be decoded without it' };
  }
  try {
    const pcm = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
    return { ok: true, pcm, via: 'ffmpeg' };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

// ── Images and frames ──────────────────────────────────────────────────────

const SCALE = `scale='if(gt(iw,ih),min(${INLINE_MAX_EDGE},iw),-2)':'if(gt(iw,ih),-2,min(${INLINE_MAX_EDGE},ih))'`;

/**
 * Something the agent can see as an image block: the file itself when it is
 * a small PNG/JPEG/GIF/WebP, else a downscaled JPEG next to it, else null.
 */
export async function prepareInlineImage(
  path: string,
  mime: string,
  outPath: string,
): Promise<{ path: string; mime: string } | null> {
  if (INLINE_IMAGE_MIMES.has(mime) && statSync(path).size <= INLINE_MAX_BYTES) return { path, mime };
  const { ffmpeg } = mediaTools();
  if (!ffmpeg) return null;
  try {
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path, '-vf', SCALE, '-frames:v', '1', '-q:v', '3', outPath], 60_000);
    if (statSync(outPath).size > INLINE_MAX_BYTES) return null;
    return { path: outPath, mime: 'image/jpeg' };
  } catch (err) {
    log.info({ err: (err as Error).message, mime }, 'could not make an inline copy of the image');
    return null;
  }
}

/** Evenly spaced timestamps, avoiding the very first and last frame. */
export function frameTimes(durationSec: number | null, count = VIDEO_FRAME_COUNT): number[] {
  if (!durationSec || durationSec <= 0) return [0];
  if (durationSec < 1) return [0];
  const n = Math.max(1, Math.min(count, Math.floor(durationSec)));
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * durationSec * 100) / n) / 100);
}

/** Still JPEGs from a video, so the agent can see it without a video decoder. */
export async function extractFrames(
  path: string,
  durationSec: number | null,
  outDir: string,
  stem: string,
): Promise<string[]> {
  const { ffmpeg } = mediaTools();
  if (!ffmpeg) return [];
  const frames: string[] = [];
  const times = frameTimes(durationSec);
  for (const [i, t] of times.entries()) {
    const out = join(outDir, `${stem}.frame-${i + 1}.jpg`);
    try {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', SCALE, '-q:v', '3', out], 60_000);
      if (statSync(out).size > 0) frames.push(out);
    } catch (err) {
      log.info({ err: (err as Error).message, t }, 'frame extraction failed');
    }
  }
  return frames;
}
