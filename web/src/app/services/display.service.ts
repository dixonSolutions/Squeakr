import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { MediaShelf, parseMediaItems, type MediaItem, type OpenState, type OpenedBy, type Resume } from '../../media-display';
import { BridgeService } from './bridge.service';

/** Playback commands for whatever is on screen (the viewer owns the element). */
export type PlayerCommand =
  | { id: string; action: 'play' | 'pause' }
  | { id: string; action: 'seek'; positionS: number };

/**
 * DisplayService — media the agent puts on the screen (show_media, docs/48).
 *
 * Owns the shelf (what is shown, what is open, remembered frames), the
 * self-destruct and auto-close timers, and the agent's controls. The viewer
 * component owns the <video> / <audio> element and registers `frameSaver` so
 * that whatever closes an item — the user, the agent, the auto-close timer,
 * another item opening — first records the frame it stopped on.
 */
@Injectable({ providedIn: 'root' })
export class DisplayService {
  private readonly bridge = inject(BridgeService);
  private readonly shelf = new MediaShelf();

  /** Bumped on every shelf change so computed views re-read it. */
  private readonly version = signal(0);
  readonly items = computed<MediaItem[]>(() => (this.version(), [...this.shelf.items]));
  readonly open = computed<OpenState | null>(() => (this.version(), this.shelf.open));
  readonly openItem = computed<MediaItem | null>(() => {
    const open = this.open();
    return open ? (this.items().find((i) => i.id === open.id) ?? null) : null;
  });

  readonly commands$ = new Subject<PlayerCommand>();

  /** Registered by the viewer: where the on-screen element stopped (null for images). */
  frameSaver: (() => Resume | null) | null = null;

  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private autoCloseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const sub = this.bridge.mediaFrames$.subscribe((msg) => this.onFrame(msg));
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      this.clearTimers();
    });
  }

  resumeFor(id: string): Resume | undefined {
    return this.shelf.resumeFor(id);
  }

  /** The user (or the agent) opens an item. Whatever was open keeps its frame. */
  openMedia(id: string, by: OpenedBy, opts: { autoplay?: boolean; autoCloseMs?: number | null } = {}): void {
    if (this.shelf.open?.id === id && by === 'user') return;
    this.closeCurrent();
    this.applyOpen(this.shelf.openItem(id, by, opts));
  }

  /** Close fullscreen; a video stops on its frame. */
  close(): void {
    if (!this.shelf.open) return;
    this.closeCurrent();
    this.changed();
  }

  /** Swipe / arrow to the next item of the open batch. */
  step(dir: 1 | -1): void {
    const next = this.shelf.neighbour(dir);
    if (next) this.openMedia(next.id, 'user');
  }

  /** Playback report for the bridge (`media_control` status). */
  report(id: string, state: Record<string, unknown>): void {
    this.bridge.sendMediaState({ media_id: id, ...state });
  }

  /** Close whatever is open, keeping the frame it stopped on. */
  private closeCurrent(): void {
    const open = this.shelf.open;
    if (!open) return;
    const frame = this.frameSaver?.() ?? null;
    this.shelf.close(frame ?? undefined);
    this.clearAutoClose();
    this.report(open.id, { state: 'closed', open: false, position_s: frame?.time ?? null });
  }

  private applyOpen(open: OpenState | null): void {
    this.clearAutoClose();
    if (open?.autoCloseMs) {
      const seq = open.seq;
      this.autoCloseTimer = setTimeout(() => {
        this.autoCloseTimer = null;
        // The user closed or swapped it already: nothing to do.
        if (this.shelf.open?.seq === seq) this.close();
      }, open.autoCloseMs);
    }
    this.changed();
  }

  private onFrame(msg: Record<string, unknown>): void {
    const now = Date.now();
    switch (msg['type']) {
      case 'media_show': {
        const items = parseMediaItems(msg['items'], now);
        if (!items.length) return;
        const openId = typeof msg['open_id'] === 'string' ? msg['open_id'] : null;
        if (openId) {
          this.closeCurrent();
          this.applyOpen(this.shelf.show(items, openId));
        } else {
          // Tray items arrive quietly: whatever is open (and its timer) is left alone.
          this.shelf.show(items, null);
          this.changed();
        }
        break;
      }
      case 'media_sync':
        if (this.shelf.open && !(Array.isArray(msg['items']) && msg['items'].some((i) => (i as { id?: unknown })?.id === this.shelf.open?.id))) {
          this.clearAutoClose();
        }
        this.shelf.sync(parseMediaItems(msg['items'], now));
        this.changed();
        break;
      case 'media_remove': {
        const ids = Array.isArray(msg['ids']) ? msg['ids'].filter((i): i is string => typeof i === 'string') : [];
        if (this.shelf.open && ids.includes(this.shelf.open.id)) this.clearAutoClose();
        this.shelf.remove(ids);
        this.changed();
        break;
      }
      case 'media_control':
        this.onControl(msg);
        break;
    }
  }

  private onControl(msg: Record<string, unknown>): void {
    const id = typeof msg['media_id'] === 'string' ? msg['media_id'] : '';
    const item = this.shelf.get(id);
    if (!item) return;
    const onScreen = this.shelf.open?.id === id;
    switch (msg['action']) {
      case 'open':
        this.openMedia(id, 'agent', {
          autoplay: msg['autoplay'] === true,
          autoCloseMs: typeof msg['auto_close_ms'] === 'number' ? msg['auto_close_ms'] : null,
        });
        break;
      case 'close':
        if (onScreen) this.close();
        break;
      case 'play':
        // Playing by itself only happens on the screen: play opens it.
        if (onScreen) this.commands$.next({ id, action: 'play' });
        else this.openMedia(id, 'agent', { autoplay: true });
        break;
      case 'pause':
        if (onScreen) this.commands$.next({ id, action: 'pause' });
        else this.shelf.updateResume(id, { playing: false });
        break;
      case 'seek': {
        const positionS = typeof msg['position_s'] === 'number' ? msg['position_s'] : 0;
        if (onScreen) this.commands$.next({ id, action: 'seek', positionS });
        else this.shelf.updateResume(id, { time: positionS });
        break;
      }
      case 'live_end':
        item.live = false;
        this.changed();
        break;
    }
  }

  private changed(): void {
    this.version.update((v) => v + 1);
    this.scheduleExpiry();
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const next = this.shelf.nextExpiry();
    if (next === null) return;
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      const openId = this.shelf.open?.id;
      const dead = this.shelf.expire(Date.now());
      if (openId && dead.includes(openId)) this.clearAutoClose();
      this.changed();
    }, Math.max(0, next - Date.now()));
  }

  private clearAutoClose(): void {
    if (this.autoCloseTimer) clearTimeout(this.autoCloseTimer);
    this.autoCloseTimer = null;
  }

  private clearTimers(): void {
    this.clearAutoClose();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }
}
