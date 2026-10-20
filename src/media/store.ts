/**
 * Media the user hands the agent from the phone — images, video and
 * recordings (docs/46-media-pipe.md).
 *
 * Every upload is written to disk first, under the bridge's data directory,
 * because the one thing all four CLIs can do with a file is open it by path.
 * Everything else — a transcript of a recording, frames from a video, a
 * downscaled copy small enough to put straight into the agent's chat — is
 * derived from that file and recorded on the asset.
 *
 * The registry is in memory: the turn text already carries every path, so a
 * bridge restart loses only the ability to look an asset up by id
 * (`view_media`), never the files.
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('media:store');

/** One upload's ceiling — a few minutes of phone video. */
export const MAX_MEDIA_BYTES = 512 * 1024 * 1024;

/** How long an asset stays addressable by id. The file itself is kept. */
export const MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

/**
 * Where a recording's transcript stands.
 *  - done:        transcribed (text may still be empty — see `empty`)
 *  - empty:       the audio held no speech
 *  - needs_pcm:   the bridge cannot decode this container; the phone can
 *                 decode it and post PCM to /api/media/:id/pcm
 *  - unavailable: no speech-to-text engine is configured on the bridge
 *  - failed:      the engine was asked and errored
 *  - none:        nothing to transcribe (an image, a silent video)
 */
export type TranscriptStatus = 'none' | 'done' | 'empty' | 'needs_pcm' | 'unavailable' | 'failed';

export interface MediaTranscript {
  text: string;
  provider: string | null;
  model: string | null;
}

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  /** The file name the phone gave it, sanitised. */
  name: string;
  mime: string;
  size: number;
  /** Absolute path of the raw upload. */
  path: string;
  createdAt: string;
  /** Seconds, for audio and video when it could be measured. */
  durationSec: number | null;
  transcriptStatus: TranscriptStatus;
  transcript: MediaTranscript | null;
  transcriptError: string | null;
  /** Absolute path of the transcript saved next to the raw file. */
  transcriptPath: string | null;
  /** Still frames taken from a video, absolute paths, in time order. */
  frames: string[];
  /**
   * A copy small enough to hand to the agent as an image block — the image
   * itself when it already is, a downscaled JPEG when not, null when neither
   * could be made (inline delivery then falls back to the path).
   */
  inline: { path: string; mime: string } | null;
}

const assets = new Map<string, { asset: MediaAsset; expiresAt: number }>();

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};

/** The MIME type to trust: the phone's, unless it is the generic one. */
export function resolveMime(name: string, declared: string | null | undefined): string {
  const type = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (type && type !== 'application/octet-stream') return type;
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

export function kindOfMime(mime: string): MediaKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export function safeMediaName(name: string): string {
  const base = basename(name).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  return base.slice(-120) || 'upload';
}

/** `<data>/media/<YYYY-MM-DD>/` — next to the database, like chat attachments. */
export function mediaDir(now = new Date()): string {
  const data = dirname(resolve(getConfig().env.DB_PATH));
  return join(data, 'media', now.toISOString().slice(0, 10));
}

export class MediaTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Upload is over ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    this.name = 'MediaTooLargeError';
  }
}

/** Counts bytes on the way to disk and stops the upload at the ceiling. */
function byteLimit(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      seen += chunk.length;
      if (seen > maxBytes) done(new MediaTooLargeError(maxBytes));
      else done(null, chunk);
    },
  });
}

export interface SaveMediaOptions {
  name: string;
  mime?: string | null;
  maxBytes?: number;
  dir?: string;
}

/**
 * Stream an upload to disk and register it. Nothing is buffered in memory, so
 * a long video costs the same as a screenshot until it is processed.
 */
export async function saveMediaStream(body: Readable, opts: SaveMediaOptions): Promise<MediaAsset> {
  const id = randomUUID();
  const name = safeMediaName(opts.name);
  const mime = resolveMime(name, opts.mime);
  const dir = opts.dir ?? mediaDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id.slice(0, 8)}-${name}`);
  try {
    await pipeline(body, byteLimit(opts.maxBytes ?? MAX_MEDIA_BYTES), createWriteStream(path));
  } catch (err) {
    rmSync(path, { force: true });
    throw err;
  }
  const size = statSync(path).size;
  if (size === 0) {
    rmSync(path, { force: true });
    throw new Error('The upload was empty.');
  }
  const asset: MediaAsset = {
    id,
    kind: kindOfMime(mime),
    name,
    mime,
    size,
    path,
    createdAt: new Date().toISOString(),
    durationSec: null,
    transcriptStatus: 'none',
    transcript: null,
    transcriptError: null,
    transcriptPath: null,
    frames: [],
    inline: null,
  };
  registerMedia(asset);
  log.info({ id, kind: asset.kind, mime, size }, 'media saved');
  return asset;
}

export function registerMedia(asset: MediaAsset, now = Date.now()): void {
  sweep(now);
  assets.set(asset.id, { asset, expiresAt: now + MEDIA_TTL_MS });
}

export function getMedia(id: string, now = Date.now()): MediaAsset | null {
  const entry = assets.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    assets.delete(id);
    return null;
  }
  return entry.asset;
}

/** Look several up, keeping order and reporting the ids that are gone. */
export function resolveMediaIds(ids: readonly string[]): { found: MediaAsset[]; missing: string[] } {
  const found: MediaAsset[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const asset = getMedia(id);
    if (asset) found.push(asset);
    else missing.push(id);
  }
  return { found, missing };
}

function sweep(now: number): void {
  for (const [id, entry] of assets) {
    if (entry.expiresAt <= now) assets.delete(id);
  }
}

/** Test hook. */
export function resetMediaStore(): void {
  assets.clear();
}

/** What the phone gets back — no host paths beyond what it already uploaded. */
export interface MediaAssetView {
  id: string;
  kind: MediaKind;
  name: string;
  mime: string;
  size: number;
  duration_sec: number | null;
  transcript_status: TranscriptStatus;
  transcript: string | null;
  transcript_provider: string | null;
  transcript_error: string | null;
  frames: number;
  inline: boolean;
}

export function viewMedia(asset: MediaAsset): MediaAssetView {
  return {
    id: asset.id,
    kind: asset.kind,
    name: asset.name,
    mime: asset.mime,
    size: asset.size,
    duration_sec: asset.durationSec,
    transcript_status: asset.transcriptStatus,
    transcript: asset.transcript?.text ?? null,
    transcript_provider: asset.transcript?.provider ?? null,
    transcript_error: asset.transcriptError,
    frames: asset.frames.length,
    inline: asset.inline !== null || asset.frames.length > 0,
  };
}
