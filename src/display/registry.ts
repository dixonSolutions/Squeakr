/**
 * The display registry — images, video and audio the agent has put on the
 * user's screen with `show_media` (docs/47).
 *
 * Every item lives until it self-destructs (`self_destruct` seconds after it
 * was shown), the agent removes it, or the voice session ends — `never` means
 * exactly that: no timer, gone when the session is. Items are served to the
 * phone through `GET /api/display/:id?k=KEY` with a per-item key, because
 * `<img>` / `<video>` cannot send the Bearer token.
 *
 * The registry also keeps what the phone last reported about each item's
 * playback, so `media_control(status)` can answer without a round trip.
 *
 * Nothing here talks to a socket: frames for the phone go through `emit`,
 * wired to notifyPhone by the server, and timers are injectable for tests.
 */

import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { resolveAllowedImagePath } from '../mcp/server/imageRegistry.js';
import { childLogger } from '../log.js';

const log = childLogger('display:registry');

export const MAX_ITEMS_PER_CALL = 10;
/** Oldest items are dropped past this, so a chatty agent cannot grow it without bound. */
export const MAX_ITEMS = 50;
export const MAX_DATA_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SELF_DESTRUCT_S = 30 * 60;
export const MIN_SELF_DESTRUCT_S = 5;
export const MAX_SELF_DESTRUCT_S = 24 * 60 * 60;

export type MediaKind = 'image' | 'video' | 'audio';
export type DisplayMode = 'fullscreen' | 'tray';
export type SelfDestruct = number | 'never';

export interface MediaInput {
  path?: string;
  url?: string;
  data?: string;
  kind?: MediaKind;
  mime?: string;
  caption?: string;
  name?: string;
  /** A file another agent is still writing — streamed as it grows (path only). */
  live?: boolean;
}

export interface ShowOptions {
  display: DisplayMode;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  /** Close fullscreen after this long, unless the user closed it first. */
  autoCloseMs: number | null;
  /** Close fullscreen when playback ends. */
  closeOnEnd: boolean;
  selfDestruct: SelfDestruct;
}

/** `shown` is an image on screen; the rest are video / audio playback. */
export type PlaybackStateName = 'shown' | 'loading' | 'playing' | 'paused' | 'ended' | 'closed' | 'error';

/** What the phone last said about an item (`media_state` frames). */
export interface PlaybackReport {
  state: PlaybackStateName;
  /** Shown fullscreen right now. */
  open: boolean;
  position_s: number | null;
  duration_s: number | null;
  muted: boolean | null;
  message?: string;
  updated_at: string;
}

export type MediaSource =
  | { type: 'path'; path: string }
  | { type: 'url'; url: string }
  | { type: 'data'; bytes: Buffer };

export interface DisplayItem {
  id: string;
  /** Access key for GET /api/display/:id (not the app token). */
  key: string;
  batchId: string;
  /** Which tool put it there — show_images replaces only its own. */
  origin: string;
  kind: MediaKind;
  source: MediaSource;
  mime: string;
  caption?: string;
  name?: string;
  live: boolean;
  /** The agent said the live file is complete (media_control finish). */
  liveFinished: boolean;
  /** Post to chat channels when a live item finishes. */
  publishOnFinish: boolean;
  createdAt: number;
  /** Epoch ms, or null for `never` (lives as long as the session). */
  expiresAt: number | null;
  options: ShowOptions;
  playback: PlaybackReport | null;
}

/** One item as the phone receives it. */
export interface ClientMediaItem {
  id: string;
  batch_id: string;
  kind: MediaKind;
  src: string;
  mime: string;
  caption?: string;
  name?: string;
  live: boolean;
  /** Milliseconds from now until it self-destructs, or null for never. */
  expires_in_ms: number | null;
  display: DisplayMode;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  auto_close_ms: number | null;
  close_on_end: boolean;
}

export type RemoveReason = 'self_destruct' | 'agent' | 'replaced' | 'evicted' | 'session_ended';

export type DisplayFrame =
  | { type: 'media_show'; batch_id: string; items: ClientMediaItem[]; open_id: string | null; caption: string | null }
  | { type: 'media_remove'; ids: string[]; reason: RemoveReason }
  | { type: 'media_sync'; items: ClientMediaItem[] }
  | {
      type: 'media_control';
      media_id: string;
      action: 'open' | 'close' | 'play' | 'pause' | 'seek' | 'live_end';
      autoplay?: boolean;
      auto_close_ms?: number | null;
      position_s?: number;
    };

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.weba': 'audio/webm',
  '.flac': 'audio/flac',
};

export function mimeFromName(name: string): string | null {
  const clean = name.split(/[?#]/)[0] ?? name;
  return MIME_BY_EXT[extname(clean).toLowerCase()] ?? null;
}

export function kindFromMime(mime: string): MediaKind | null {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return null;
}

function parseData(data: string): { mime: string | null; bytes: Buffer } {
  const trimmed = data.trim();
  const match = /^data:([^;]+);base64,(.+)$/is.exec(trimmed);
  const base64 = (match?.[2] ?? trimmed).replace(/\s/g, '');
  if (Math.floor((base64.length * 3) / 4) > MAX_DATA_BYTES) {
    throw new Error(`data exceeds ${MAX_DATA_BYTES / (1024 * 1024)} MB — pass a path for anything bigger`);
  }
  return { mime: match?.[1] ?? null, bytes: Buffer.from(base64, 'base64') };
}

export interface RegistryDeps {
  emit: (frame: DisplayFrame) => void;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** Path allowlist — injectable so tests need no database. */
  resolvePath: (path: string, allowMissing: boolean) => string | null;
}

const defaultDeps: RegistryDeps = {
  emit: () => {},
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  resolvePath: (path, allowMissing) => resolveAllowedImagePath(path, { allowMissing }),
};

export class DisplayRegistry {
  private readonly items = new Map<string, DisplayItem>();
  private readonly timers = new Map<string, unknown>();
  private deps: RegistryDeps;

  constructor(deps: Partial<RegistryDeps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  /** Re-point the outbound frames (the server wires notifyPhone here at startup). */
  setEmitter(emit: (frame: DisplayFrame) => void): void {
    this.deps = { ...this.deps, emit };
  }

  /** Validate and resolve one input into an item (no side effects). */
  private build(input: MediaInput, batchId: string, origin: string, options: ShowOptions, publish: boolean): DisplayItem {
    const sources = [input.path, input.url, input.data].filter((v) => v != null && v !== '');
    if (sources.length !== 1) throw new Error('Each item needs exactly one of path, url, or data');

    let source: MediaSource;
    let detected: string | null;
    let name = input.name;
    if (input.path) {
      const resolved = this.deps.resolvePath(input.path, input.live === true);
      if (!resolved) {
        throw new Error(`${input.path} is not a readable file under an enabled project or the temp directory`);
      }
      source = { type: 'path', path: resolved };
      detected = mimeFromName(resolved);
      name ??= resolved.split(/[\\/]/).pop();
    } else if (input.url) {
      const url = input.url.trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://');
      source = { type: 'url', url };
      detected = mimeFromName(new URL(url).pathname);
    } else {
      const parsed = parseData(input.data!);
      source = { type: 'data', bytes: parsed.bytes };
      detected = parsed.mime;
    }

    const mime = input.mime ?? detected ?? (input.kind ? `${input.kind}/*` : null);
    const kind = input.kind ?? (mime ? kindFromMime(mime) : null);
    if (!mime || !kind) {
      throw new Error(
        `Cannot tell whether ${input.path ?? input.url ?? 'the data'} is an image, video or audio — pass kind or mime (other files go through send_files)`,
      );
    }
    if (input.live) {
      if (source.type !== 'path') throw new Error('live needs a path — it streams a file that is still being written');
      if (kind === 'image') throw new Error('live is for audio and video — an image is shown once it is written');
    }

    const now = this.deps.now();
    return {
      id: randomUUID(),
      key: randomUUID(),
      batchId,
      origin,
      kind,
      source,
      mime,
      caption: input.caption,
      name,
      live: input.live === true,
      liveFinished: false,
      publishOnFinish: publish && input.live === true,
      createdAt: now,
      expiresAt: options.selfDestruct === 'never' ? null : now + options.selfDestruct * 1000,
      options,
      playback: null,
    };
  }

  /**
   * Show a batch. All items are validated before any is stored, so a bad item
   * fails the call without leaving half a batch behind.
   */
  add(
    inputs: MediaInput[],
    options: ShowOptions,
    opts: { origin?: string; replace?: 'all' | 'origin' | 'none'; caption?: string | null; publish?: boolean } = {},
  ): { batchId: string; items: DisplayItem[] } {
    if (inputs.length === 0) throw new Error('items must not be empty');
    if (inputs.length > MAX_ITEMS_PER_CALL) throw new Error(`Too many items (max ${MAX_ITEMS_PER_CALL})`);
    const origin = opts.origin ?? 'show_media';
    const batchId = randomUUID();
    const built = inputs.map((input) => this.build(input, batchId, origin, options, opts.publish !== false));

    const replace = opts.replace ?? 'none';
    if (replace !== 'none') {
      const old = [...this.items.values()].filter((i) => replace === 'all' || i.origin === origin).map((i) => i.id);
      this.remove(old, 'replaced');
    }

    for (const item of built) {
      this.items.set(item.id, item);
      if (item.expiresAt !== null) {
        const id = item.id;
        this.timers.set(id, this.deps.setTimer(() => this.remove([id], 'self_destruct'), item.expiresAt - item.createdAt));
      }
    }
    this.evictOverflow();

    const fullscreen = options.display === 'fullscreen';
    this.deps.emit({
      type: 'media_show',
      batch_id: batchId,
      items: built.map((i) => this.toClient(i)),
      open_id: fullscreen ? built[0]!.id : null,
      caption: opts.caption ?? null,
    });
    log.info(
      { batchId, count: built.length, kinds: built.map((i) => i.kind), display: options.display, selfDestruct: options.selfDestruct },
      'media shown',
    );
    return { batchId, items: built };
  }

  private evictOverflow(): void {
    const overflow = this.items.size - MAX_ITEMS;
    if (overflow <= 0) return;
    const oldest = [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt).slice(0, overflow);
    this.remove(oldest.map((i) => i.id), 'evicted');
  }

  get(id: string): DisplayItem | null {
    return this.items.get(id) ?? null;
  }

  /** The item, only when `key` is its access key. */
  getWithKey(id: string, key: string): DisplayItem | null {
    const item = this.items.get(id);
    return item && key && item.key === key ? item : null;
  }

  list(): DisplayItem[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Remove items; returns the ids that existed. */
  remove(ids: string[], reason: RemoveReason): string[] {
    const removed: string[] = [];
    for (const id of ids) {
      if (!this.items.delete(id)) continue;
      const t = this.timers.get(id);
      if (t !== undefined) this.deps.clearTimer(t);
      this.timers.delete(id);
      removed.push(id);
    }
    if (removed.length) {
      this.deps.emit({ type: 'media_remove', ids: removed, reason });
      log.info({ count: removed.length, reason }, 'media removed');
    }
    return removed;
  }

  /** The session ended (or the bridge is resetting): everything goes, `never` included. */
  clear(reason: RemoveReason = 'session_ended'): void {
    this.remove([...this.items.keys()], reason);
  }

  /** The live file is complete: streams end once they reach its end. */
  finishLive(id: string): DisplayItem | null {
    const item = this.items.get(id);
    if (!item || !item.live || item.liveFinished) return item ?? null;
    item.liveFinished = true;
    this.deps.emit({ type: 'media_control', media_id: id, action: 'live_end' });
    return item;
  }

  /** Ask the phone to open / close / play / pause / seek an item. */
  control(
    id: string,
    action: 'open' | 'close' | 'play' | 'pause' | 'seek',
    extra: { autoplay?: boolean; auto_close_ms?: number | null; position_s?: number } = {},
  ): boolean {
    if (!this.items.has(id)) return false;
    this.deps.emit({ type: 'media_control', media_id: id, action, ...extra });
    return true;
  }

  reportPlayback(id: string, report: Omit<PlaybackReport, 'updated_at'>): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.playback = { ...report, updated_at: new Date(this.deps.now()).toISOString() };
    return true;
  }

  /** Everything still shown, for a phone that just (re)connected. Never opens anything. */
  syncFrame(): DisplayFrame {
    return { type: 'media_sync', items: this.list().map((i) => this.toClient(i)) };
  }

  toClient(item: DisplayItem): ClientMediaItem {
    const src = item.source.type === 'url' ? item.source.url : `/api/display/${item.id}?k=${item.key}`;
    return {
      id: item.id,
      batch_id: item.batchId,
      kind: item.kind,
      src,
      mime: item.mime,
      ...(item.caption ? { caption: item.caption } : {}),
      ...(item.name ? { name: item.name } : {}),
      live: item.live && !item.liveFinished,
      expires_in_ms: item.expiresAt === null ? null : Math.max(0, item.expiresAt - this.deps.now()),
      display: item.options.display,
      autoplay: item.options.autoplay,
      muted: item.options.muted,
      loop: item.options.loop,
      auto_close_ms: item.options.autoCloseMs,
      close_on_end: item.options.closeOnEnd,
    };
  }

  /** What the agent sees in `media_control(status)`. */
  describe(item: DisplayItem): Record<string, unknown> {
    return {
      media_id: item.id,
      kind: item.kind,
      ...(item.name ? { name: item.name } : {}),
      ...(item.caption ? { caption: item.caption } : {}),
      live: item.live && !item.liveFinished,
      self_destruct_in_s: item.expiresAt === null ? 'never' : Math.max(0, Math.round((item.expiresAt - this.deps.now()) / 1000)),
      display: item.options.display,
      playback: item.playback ?? { state: 'unreported' },
    };
  }
}

let registry: DisplayRegistry | null = null;

/** The process-wide registry the tools, the HTTP route and the control socket share. */
export function getDisplayRegistry(): DisplayRegistry {
  registry ??= new DisplayRegistry();
  return registry;
}
