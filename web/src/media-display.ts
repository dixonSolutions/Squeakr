/**
 * Media the agent puts on the screen (show_media, docs/48) — the phone's
 * side, kept free of Angular so it can be unit-tested.
 *
 * `MediaShelf` holds what is shown, which item is fullscreen, and the
 * remembered frame of every video / audio the user closed: closing a playing
 * video pauses it on its frame, and opening it again carries on playing from
 * there. Expiry (self-destruct) is computed on the phone's clock from the
 * `expires_in_ms` the bridge sends, so clock skew does not matter.
 */

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaItem {
  id: string;
  batchId: string;
  kind: MediaKind;
  src: string;
  mime: string;
  caption?: string;
  name?: string;
  live: boolean;
  /** Local epoch ms it self-destructs at, or null for never (session-long). */
  expiresAt: number | null;
  display: 'fullscreen' | 'tray';
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  autoCloseMs: number | null;
  closeOnEnd: boolean;
}

/** Where a closed video / audio stopped. */
export interface Resume {
  time: number;
  /** It was playing when closed — opening it again plays. */
  playing: boolean;
}

export type OpenedBy = 'agent' | 'user';

export interface OpenState {
  id: string;
  by: OpenedBy;
  /** Start playing as it opens (the agent's autoplay, or a resumed video). */
  autoplay: boolean;
  autoCloseMs: number | null;
  /** Bumps on every open, so a stale auto-close timer can tell it is stale. */
  seq: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

export function parseMediaItem(raw: unknown, now: number): MediaItem | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r['id']);
  const src = str(r['src']);
  const kind = r['kind'];
  if (!id || !src || (kind !== 'image' && kind !== 'video' && kind !== 'audio')) return null;
  const expiresIn = num(r['expires_in_ms']);
  const caption = str(r['caption']);
  const name = str(r['name']);
  return {
    id,
    batchId: str(r['batch_id']) ?? id,
    kind,
    src,
    mime: str(r['mime']) ?? `${kind}/*`,
    ...(caption ? { caption } : {}),
    ...(name ? { name } : {}),
    live: r['live'] === true,
    expiresAt: expiresIn === null ? null : now + expiresIn,
    display: r['display'] === 'tray' ? 'tray' : 'fullscreen',
    autoplay: r['autoplay'] === true,
    muted: r['muted'] === true,
    loop: r['loop'] === true,
    autoCloseMs: num(r['auto_close_ms']),
    closeOnEnd: r['close_on_end'] === true,
  };
}

export function parseMediaItems(raw: unknown, now: number): MediaItem[] {
  return Array.isArray(raw) ? raw.map((r) => parseMediaItem(r, now)).filter((i): i is MediaItem => i !== null) : [];
}

export class MediaShelf {
  items: MediaItem[] = [];
  open: OpenState | null = null;
  private readonly resume = new Map<string, Resume>();
  private seq = 0;

  get(id: string): MediaItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** A `media_show` batch: add (newest last); returns the item to open, if any. */
  show(items: MediaItem[], openId: string | null): OpenState | null {
    const ids = new Set(items.map((i) => i.id));
    this.items = [...this.items.filter((i) => !ids.has(i.id)), ...items];
    const toOpen = openId ? this.get(openId) : undefined;
    if (!toOpen) return null;
    return this.openItem(toOpen.id, 'agent', { autoplay: toOpen.autoplay, autoCloseMs: toOpen.autoCloseMs });
  }

  /** `media_sync` after a reconnect: the bridge's list is the truth. Never opens anything. */
  sync(items: MediaItem[]): void {
    const keep = new Map(this.items.map((i) => [i.id, i]));
    // Keep the local copy (its expiry clock) for items the phone already had.
    this.items = items.map((i) => keep.get(i.id) ?? i);
    this.forgetMissing();
  }

  remove(ids: string[]): void {
    const gone = new Set(ids);
    this.items = this.items.filter((i) => !gone.has(i.id));
    this.forgetMissing();
  }

  /** Drop self-destructed items; returns their ids. */
  expire(now: number): string[] {
    const dead = this.items.filter((i) => i.expiresAt !== null && i.expiresAt <= now).map((i) => i.id);
    if (dead.length) this.remove(dead);
    return dead;
  }

  /** Local ms of the next self-destruct, or null. */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const i of this.items) if (i.expiresAt !== null && (next === null || i.expiresAt < next)) next = i.expiresAt;
    return next;
  }

  private forgetMissing(): void {
    for (const id of [...this.resume.keys()]) if (!this.get(id)) this.resume.delete(id);
    if (this.open && !this.get(this.open.id)) this.open = null;
  }

  /**
   * Open an item fullscreen. A video the user closed while it played starts
   * playing again; the agent's `autoplay` only applies to what it opens.
   */
  openItem(id: string, by: OpenedBy, opts: { autoplay?: boolean; autoCloseMs?: number | null } = {}): OpenState | null {
    if (!this.get(id)) return null;
    const resumed = this.resume.get(id)?.playing ?? false;
    this.open = {
      id,
      by,
      autoplay: (by === 'agent' && opts.autoplay === true) || resumed,
      // Only the agent sets a timer: a video the user opened stays until they close it.
      autoCloseMs: by === 'agent' ? (opts.autoCloseMs ?? null) : null,
      seq: ++this.seq,
    };
    return this.open;
  }

  /** Close fullscreen, remembering where a video / audio stopped. */
  close(frame?: Resume): void {
    if (this.open && frame) this.resume.set(this.open.id, frame);
    this.open = null;
  }

  resumeFor(id: string): Resume | undefined {
    return this.resume.get(id);
  }

  /** The agent paused / seeked something that is not on screen. */
  updateResume(id: string, patch: Partial<Resume>): void {
    const cur = this.resume.get(id) ?? { time: 0, playing: false };
    this.resume.set(id, { ...cur, ...patch });
  }

  /** The item next to the open one in its batch (swipe), or null. */
  neighbour(step: 1 | -1): MediaItem | null {
    if (!this.open) return null;
    const cur = this.get(this.open.id);
    if (!cur) return null;
    const batch = this.items.filter((i) => i.batchId === cur.batchId);
    if (batch.length < 2) return null;
    const at = batch.findIndex((i) => i.id === cur.id);
    return batch[(at + step + batch.length) % batch.length] ?? null;
  }
}
