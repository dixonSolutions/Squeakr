/**
 * Handing uploaded media to the agent (docs/46).
 *
 * Two deliveries, picked per send on the phone:
 *
 *   path   — the turn text lists where each file was saved, with any
 *            transcript written out in full. Every CLI can open a path, so
 *            this always works.
 *   inline — the same text, and the pictures themselves (images, video
 *            frames) ride in the Squeakr tool result that carries the turn
 *            as MCP image blocks, straight into the agent's chat. The text
 *            names `view_media` as the way back to them, which also covers a
 *            turn that opened a new agent process (no tool result to ride).
 *
 * Inline needs a CLI that passes tool-result images to its model; each
 * provider declares that (`mediaInput()`), and a CLI that does not falls back
 * to path delivery with a note saying so.
 *
 * Two modes, also picked on the phone:
 *
 *   turn   — the media is (part of) a new user turn.
 *   attach — the media joins the conversation in flight: it rides on the
 *            agent's next Squeakr tool call without being a new request, or,
 *            if no agent is running, on the user's next turn.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { childLogger } from '../log.js';
import { resolveMediaIds, type MediaAsset } from './store.js';

const log = childLogger('media:delivery');

export type MediaDelivery = 'path' | 'inline';
export type MediaMode = 'turn' | 'attach';

/** Images handed over in one tool result. */
export const MAX_INLINE_IMAGES = 12;
/** Transcripts longer than this are cut in the turn text; the file has all of it. */
export const MAX_TRANSCRIPT_CHARS = 12_000;

/** A turn's media, as carried through the queue. */
export interface TurnMedia {
  ids: string[];
  delivery: MediaDelivery;
}

// ── Inline support (provider rule: declared per CLI) ───────────────────────

let inlineSupport: () => { supported: boolean; cli: string } = () => ({ supported: true, cli: 'the agent' });

/** Wired at startup to the active provider's `mediaInput()`. */
export function setInlineSupportResolver(fn: () => { supported: boolean; cli: string }): void {
  inlineSupport = fn;
}

export function inlineSupported(): { supported: boolean; cli: string } {
  try {
    return inlineSupport();
  } catch {
    return { supported: false, cli: 'the agent' };
  }
}

// ── Text ───────────────────────────────────────────────────────────────────

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function durationLabel(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec)) return null;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

const KIND_LABEL: Record<MediaAsset['kind'], string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Recording',
  file: 'File',
};

function transcriptLines(asset: MediaAsset): string[] {
  const label = asset.kind === 'video' ? 'Sound transcript' : 'Transcript';
  switch (asset.transcriptStatus) {
    case 'done': {
      const t = asset.transcript!;
      const by = [t.provider, t.model].filter(Boolean).join(' / ');
      let text = t.text;
      if (text.length > MAX_TRANSCRIPT_CHARS) text = `${text.slice(0, MAX_TRANSCRIPT_CHARS)}… [cut — full text in the file]`;
      return [
        `  ${label} (automatic${by ? `, ${by}` : ''}${asset.transcriptPath ? `; saved at ${asset.transcriptPath}` : ''}):`,
        ...text.split('\n').map((l) => `  > ${l}`),
      ];
    }
    case 'empty':
      return [`  ${label}: no speech was heard in it.`];
    case 'none':
      return [];
    default:
      return [`  ${label}: not available — ${asset.transcriptError ?? asset.transcriptStatus}.`];
  }
}

/** Images an asset contributes to an inline result: itself, or its frames. */
export function inlineImagesOf(asset: MediaAsset): { path: string; mime: string; label: string }[] {
  if (asset.kind === 'image' && asset.inline) return [{ ...asset.inline, label: `${asset.name}` }];
  if (asset.kind === 'video') {
    return asset.frames.map((path, i) => ({
      path,
      mime: 'image/jpeg',
      label: `${asset.name} — frame ${i + 1} of ${asset.frames.length}`,
    }));
  }
  return [];
}

/**
 * The block appended to the turn text. Self-contained: an agent that only
 * ever sees text (a respawn, a CLI without image support) still has every
 * path and every transcript.
 */
export function describeMediaForAgent(assets: readonly MediaAsset[], delivery: MediaDelivery, mode: MediaMode = 'turn'): string {
  if (assets.length === 0) return '';
  const n = assets.length;
  const lines: string[] = [
    mode === 'attach'
      ? `The user attached ${n === 1 ? 'a file' : `${n} files`} to the conversation (context for what you are doing, not a new request). Saved on this machine:`
      : `The user sent ${n === 1 ? 'a file' : `${n} files`} with this message. Saved on this machine:`,
  ];
  for (const a of assets) {
    const meta = [a.mime, sizeLabel(a.size), durationLabel(a.durationSec)].filter(Boolean).join(', ');
    lines.push(`- ${KIND_LABEL[a.kind]} "${a.name}" (${meta}): ${a.path}`);
    if (a.kind === 'video' && a.frames.length > 0) {
      lines.push(`  Frames: ${a.frames.map((f) => basename(f)).join(', ')} (same folder)`);
    }
    lines.push(...transcriptLines(a));
  }

  const viewable = assets.filter((a) => inlineImagesOf(a).length > 0);
  if (delivery === 'inline' && viewable.length > 0) {
    const { supported, cli } = inlineSupported();
    const ids = viewable.map((a) => `"${a.id}"`).join(', ');
    lines.push(
      supported
        ? `To see the pictures in this chat, call view_media(ids=[${ids}]) — skip that if they are already shown below as images.`
        : `${cli} does not show images from tool results — open the files by path instead.`,
    );
  } else if (viewable.length > 0) {
    lines.push('Open the files by path to look at them.');
  }
  return lines.join('\n');
}

/** Turn text plus its media block; media-only turns get a stand-in line. */
export function composeTurnText(text: string, assets: readonly MediaAsset[], delivery: MediaDelivery): string {
  const typed = text.trim();
  const block = describeMediaForAgent(assets, delivery, 'turn');
  if (!block) return typed;
  return typed ? `${typed}\n\n${block}` : block;
}

// ── Image blocks ───────────────────────────────────────────────────────────

export type McpMediaContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** MCP content blocks for the pictures in `assets`, each led by a one-line label. */
export function mediaImageBlocks(assets: readonly MediaAsset[], max = MAX_INLINE_IMAGES): McpMediaContent[] {
  const out: McpMediaContent[] = [];
  let count = 0;
  for (const asset of assets) {
    for (const img of inlineImagesOf(asset)) {
      if (count >= max) {
        out.push({ type: 'text', text: `(More pictures than fit in one result — open the rest by path.)` });
        return out;
      }
      try {
        const data = readFileSync(img.path).toString('base64');
        out.push({ type: 'text', text: `[media ${asset.id}] ${img.label}` });
        out.push({ type: 'image', data, mimeType: img.mime });
        count += 1;
      } catch (err) {
        log.warn({ id: asset.id, err: (err as Error).message }, 'inline image unreadable');
      }
    }
  }
  return out;
}

/** Image blocks for a turn's media — empty unless inline was asked for and works. */
export function turnImageBlocks(media: TurnMedia | null | undefined): McpMediaContent[] {
  if (!media || media.delivery !== 'inline' || !inlineSupported().supported) return [];
  return mediaImageBlocks(resolveMediaIds(media.ids).found);
}

// ── Attach mode ────────────────────────────────────────────────────────────

interface Attached {
  ids: string[];
  delivery: MediaDelivery;
}

let attached: Attached | null = null;

/** Whether `sessionKey` is the agent attached media should ride out to. */
let attachTarget: (sessionKey: string) => boolean = () => false;

export function setAttachTargetResolver(fn: (sessionKey: string) => boolean): void {
  attachTarget = fn;
}

export function isAttachTarget(sessionKey: string | undefined): boolean {
  if (!sessionKey) return false;
  try {
    return attachTarget(sessionKey);
  } catch {
    return false;
  }
}

/** Stage media for the conversation in flight. Inline wins if any send asked for it. */
export function attachMedia(ids: readonly string[], delivery: MediaDelivery): number {
  const merged = new Set([...(attached?.ids ?? []), ...ids]);
  attached = {
    ids: [...merged],
    delivery: attached?.delivery === 'inline' || delivery === 'inline' ? 'inline' : 'path',
  };
  log.info({ count: attached.ids.length, delivery: attached.delivery }, 'media attached to the conversation');
  return attached.ids.length;
}

export function attachedCount(): number {
  return attached?.ids.length ?? 0;
}

/** Take everything staged (consumed on read — handing it over twice reads as a repeat). */
export function takeAttachedMedia(): { assets: MediaAsset[]; delivery: MediaDelivery } | null {
  if (!attached) return null;
  const { ids, delivery } = attached;
  attached = null;
  const { found } = resolveMediaIds(ids);
  return found.length > 0 ? { assets: found, delivery } : null;
}

/** Test hook. */
export function resetAttachedMedia(): void {
  attached = null;
  attachTarget = () => false;
}
