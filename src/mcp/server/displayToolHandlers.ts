/**
 * show_media / media_control — the agent puts images, video and audio on the
 * user's screen and drives them (docs/48). Non-blocking, like show_images.
 *
 * Provider-neutral: these are Squeakr MCP tools, so Cursor, Codex, Claude
 * Code and Codewhale all get them the same way.
 */

import { childLogger } from '../../log.js';
import { isControlSocketOpen } from '../../state/controlSocket.js';
import { MediaControlSchema, ShowMediaSchema } from '../schemas.js';
import {
  DEFAULT_SELF_DESTRUCT_S,
  getDisplayRegistry,
  type DisplayItem,
  type DisplayRegistry,
  type MediaInput,
  type ShowOptions,
} from '../../display/registry.js';
import { publishAgentFiles, type AgentFileOut } from './fileToolHandlers.js';

const log = childLogger('mcp:server:displayTools');

function zodMessage(error: { errors: { path: (string | number)[]; message: string }[] }): string {
  return error.errors.map((e) => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).join('; ');
}

/** A shown item as a file for chat channels (live items wait for finish). */
function asAgentFile(item: DisplayItem): AgentFileOut | null {
  const base = { mime: item.mime, ...(item.name ? { name: item.name } : {}), ...(item.caption ? { caption: item.caption } : {}) };
  if (item.source.type === 'path') return { ...base, path: item.source.path };
  if (item.source.type === 'url') return { ...base, url: item.source.url };
  return { ...base, data: item.source.bytes.toString('base64') };
}

function summary(item: DisplayItem) {
  return {
    media_id: item.id,
    kind: item.kind,
    live: item.live,
    self_destruct_in_s: item.expiresAt === null ? 'never' : Math.round((item.expiresAt - item.createdAt) / 1000),
  };
}

export interface ShowMediaInternal {
  /** Which tool is showing — show_images replaces only its own previous batch. */
  origin?: string;
  replaceOrigin?: boolean;
}

export function handleShowMedia(
  args: unknown,
  internal: ShowMediaInternal = {},
  registry: DisplayRegistry = getDisplayRegistry(),
): Record<string, unknown> {
  const parsed = ShowMediaSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const a = parsed.data;
  const display = a.display ?? 'fullscreen';

  // Playing on its own, closing on its own: only for media on the user's screen.
  if (display !== 'fullscreen') {
    for (const [flag, set] of [
      ['autoplay', a.autoplay],
      ['auto_close_ms', a.auto_close_ms !== undefined],
      ['close_on_end', a.close_on_end],
    ] as const) {
      if (set) {
        return { ok: false, error: `${flag} only works with display "fullscreen" — media plays and closes by itself only while it is on the user's screen` };
      }
    }
  }

  const options: ShowOptions = {
    display,
    autoplay: a.autoplay ?? false,
    muted: a.muted ?? false,
    loop: a.loop ?? false,
    autoCloseMs: a.auto_close_ms ?? null,
    closeOnEnd: a.close_on_end ?? false,
    selfDestruct: a.self_destruct ?? DEFAULT_SELF_DESTRUCT_S,
  };

  try {
    const { batchId, items } = registry.add(a.items as MediaInput[], options, {
      origin: internal.origin ?? 'show_media',
      replace: a.replace ? 'all' : internal.replaceOrigin ? 'origin' : 'none',
      caption: a.caption ?? null,
      publish: a.publish !== false,
    });

    if (a.publish !== false) {
      const files = items.filter((i) => !i.live).map(asAgentFile).filter((f): f is AgentFileOut => f !== null);
      publishAgentFiles(files, a.caption ?? null);
    }

    return {
      ok: true,
      batch_id: batchId,
      delivered: isControlSocketOpen(),
      items: items.map(summary),
      ...(items.some((i) => i.live) ? { next: 'Call media_control({ action: "finish", media_id }) once the live file is complete.' } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err }, 'show_media failed');
    return { ok: false, error: message };
  }
}

export function handleMediaControl(args: unknown, registry: DisplayRegistry = getDisplayRegistry()): Record<string, unknown> {
  const parsed = MediaControlSchema.safeParse(args);
  if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
  const a = parsed.data;

  if (a.action === 'status') {
    if (a.media_id) {
      const item = registry.get(a.media_id);
      return item ? { ok: true, ...registry.describe(item) } : { ok: false, error: `No media ${a.media_id} — it may have self-destructed` };
    }
    return { ok: true, phone_connected: isControlSocketOpen(), items: registry.list().map((i) => registry.describe(i)) };
  }

  if (a.action === 'remove') {
    const ids = a.all ? registry.list().map((i) => i.id) : [...(a.media_ids ?? []), ...(a.media_id ? [a.media_id] : [])];
    if (!ids.length) return { ok: false, error: 'remove needs media_id, media_ids or all: true' };
    const removed = registry.remove(ids, 'agent');
    return { ok: true, removed };
  }

  if (!a.media_id) return { ok: false, error: `${a.action} needs media_id` };
  const item = registry.get(a.media_id);
  if (!item) return { ok: false, error: `No media ${a.media_id} — it may have self-destructed` };

  if (a.action === 'finish') {
    if (!item.live) return { ok: false, error: 'finish is for items shown with live: true' };
    registry.finishLive(item.id);
    if (item.publishOnFinish) {
      const file = asAgentFile(item);
      if (file) publishAgentFiles([file], null);
    }
    return { ok: true, media_id: item.id, live: false };
  }

  if (item.kind === 'image' && (a.action === 'play' || a.action === 'pause' || a.action === 'seek')) {
    return { ok: false, error: `${a.action} is for video and audio — ${item.id} is an image` };
  }
  if (a.action === 'seek' && a.position_s === undefined) return { ok: false, error: 'seek needs position_s' };

  registry.control(item.id, a.action, {
    ...(a.action === 'open' && a.autoplay !== undefined ? { autoplay: a.autoplay } : {}),
    ...(a.action === 'open' && a.auto_close_ms !== undefined ? { auto_close_ms: a.auto_close_ms } : {}),
    ...(a.action === 'seek' ? { position_s: a.position_s } : {}),
  });
  return { ok: true, media_id: item.id, action: a.action, delivered: isControlSocketOpen() };
}
