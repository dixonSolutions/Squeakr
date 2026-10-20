/**
 * The attachment bridge — files in a chat, both ways.
 *
 * In: what someone attaches to a `chat` message or sends in a stream. Voice
 * messages (Ogg/Opus) and audio files are transcribed into the turn's text; images, video,
 * recordings and documents are saved under the bridge's data directory and
 * handed to the agent by path ("Attached image: /…/shot.png") — every agent
 * CLI can open a file by path, so nothing here is per-CLI.
 *
 * Out: files the agent sends (`show_images`, `send_files`) arrive as an
 * `agent_files` event; the hub posts them as attachments wherever someone is
 * listening (hub.ts).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { getConfig } from '../config.js';
import { childLogger } from '../log.js';

const log = childLogger('channels:attachments');

/** Discord's upload limit without boosts; other platforms are no smaller in practice. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A file someone attached to a message, as the platform describes it. */
export interface ChannelAttachment {
  name: string;
  contentType: string | null;
  size: number;
  /** A voice message (Discord's voice-message flag, Telegram/WhatsApp voice). */
  voice?: boolean;
  /** Its bytes — downloaded only when the message is for the agent. */
  fetch(): Promise<Buffer>;
}

/** A file to post: by path on this host, or bytes. */
export interface OutboundFile {
  name: string;
  contentType: string;
  data: Buffer;
  caption?: string;
}

export type AttachmentKind = 'voice' | 'image' | 'video' | 'audio' | 'file';

export function kindOf(a: { name: string; contentType: string | null; voice?: boolean }): AttachmentKind {
  const type = (a.contentType ?? '').toLowerCase();
  if (a.voice) return 'voice';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  const ext = extname(a.name).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'].includes(ext)) return 'image';
  if (['.mp4', '.mov', '.webm', '.mkv'].includes(ext)) return 'video';
  if (['.mp3', '.m4a', '.wav', '.ogg', '.opus', '.flac'].includes(ext)) return 'audio';
  return 'file';
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
};

export function mimeOf(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** Where chat attachments are kept: `<data>/attachments/<YYYY-MM-DD>/`. */
export function attachmentDir(now = new Date()): string {
  const data = dirname(resolve(getConfig().env.DB_PATH));
  return join(data, 'attachments', now.toISOString().slice(0, 10));
}

function safeName(name: string): string {
  const base = basename(name).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  return base.slice(-120) || 'attachment';
}

/** Save one attachment's bytes; returns the absolute path. */
export function saveAttachment(name: string, data: Buffer, dir = attachmentDir()): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${Date.now().toString(36)}-${safeName(name)}`);
  writeFileSync(path, data);
  return path;
}

export interface PreparedTurn {
  /** The turn text: what was typed, what voice messages said, and where the files are. */
  text: string;
  /** What each voice message said (echoed back in the chat). */
  heard: string[];
  /** Saved files, for the log. */
  saved: string[];
  /** Attachments that could not be used, and why. */
  problems: string[];
}

/**
 * Turn a message and its attachments into one turn for the agent. Voice
 * messages and audio files are transcribed into the text — a voice message as
 * what was said, a file as "<name> (transcribed): …", saved too and referenced
 * by path; anything else is saved and referenced by path.
 */
export async function prepareTurn(
  typed: string,
  attachments: readonly ChannelAttachment[],
  transcribe: (data: Buffer, kind: 'voice' | 'audio') => Promise<string>,
  save: (name: string, data: Buffer) => string = saveAttachment,
): Promise<PreparedTurn> {
  const heard: string[] = [];
  const saved: string[] = [];
  const problems: string[] = [];
  const refs: string[] = [];
  for (const a of attachments) {
    if (a.size > MAX_ATTACHMENT_BYTES) {
      problems.push(`${a.name} is over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      continue;
    }
    let data: Buffer;
    try {
      data = await a.fetch();
    } catch (err) {
      problems.push(`${a.name} could not be downloaded (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const kind = kindOf(a);
    if (kind === 'voice' || kind === 'audio') {
      try {
        const words = (await transcribe(data, kind)).trim();
        if (words) heard.push(kind === 'voice' ? words : `${a.name} (transcribed): ${words}`);
        else if (kind === 'audio') problems.push(`${a.name} has no words in it that I could make out`);
      } catch (err) {
        problems.push(`${a.name} could not be transcribed (${err instanceof Error ? err.message : String(err)})`);
      }
      if (kind === 'voice') continue;
    }
    const path = save(a.name, data);
    saved.push(path);
    refs.push(`Attached ${kind === 'file' ? 'file' : kind}: ${path}`);
  }
  const text = [typed.trim(), ...heard, refs.length ? refs.join('\n') : ''].filter(Boolean).join('\n\n');
  if (saved.length) log.info({ files: saved.length }, 'chat attachments saved for the agent');
  return { text, heard, saved, problems };
}

/** A file the agent sent (agent_files event), loaded for posting. */
export interface AgentFile {
  path?: string;
  url?: string;
  data?: string;
  mime?: string;
  name?: string;
  caption?: string;
}

/** Bytes for an agent file: a path on this host, or base64 / data URI. URLs are posted as links instead. */
export function loadAgentFile(f: AgentFile): OutboundFile | null {
  try {
    if (f.path) {
      const name = f.name ?? basename(f.path);
      return { name, contentType: f.mime ?? mimeOf(name), data: readFileSync(f.path), ...(f.caption ? { caption: f.caption } : {}) };
    }
    if (f.data) {
      const m = /^data:([^;]+);base64,(.+)$/is.exec(f.data.trim());
      const contentType = m?.[1] ?? f.mime ?? 'application/octet-stream';
      const ext = Object.entries(MIME_BY_EXT).find(([, v]) => v === contentType)?.[0] ?? '';
      return {
        name: f.name ?? `attachment${ext}`,
        contentType,
        data: Buffer.from((m?.[2] ?? f.data).replace(/\s/g, ''), 'base64'),
        ...(f.caption ? { caption: f.caption } : {}),
      };
    }
  } catch (err) {
    log.warn({ err, path: f.path }, 'could not read a file the agent sent');
  }
  return null;
}

/**
 * Discord's voice-message waveform: up to 256 amplitude bytes (0–255),
 * base64. Taken from the PCM the voice note was made from.
 */
export function waveformOf(pcm: Buffer, points = 256): string {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(Math.max(1, Math.min(points, samples)));
  const per = Math.max(1, Math.floor(samples / out.length));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < per; j++) {
      const s = pcm.readInt16LE((i * per + j) * 2) / 32768;
      sum += s * s;
    }
    out[i] = Math.min(255, Math.round(Math.sqrt(sum / per) * 255 * 3));
  }
  return out.toString('base64');
}
