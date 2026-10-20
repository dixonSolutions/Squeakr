import type { ElementRef } from '@angular/core';
import { Component, DestroyRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';

import type { MediaItem } from '../../../media-display';
import { DisplayService } from '../../services/display.service';

/** How often a playing item reports its position to the bridge. */
const POSITION_REPORT_MS = 5000;

/**
 * MediaViewerComponent — images, video and audio the agent shows (docs/48).
 *
 * Fullscreen is the raw media with a close icon on its top-right corner and
 * nothing else. Tapping a video plays / pauses it (or unmutes it, when the
 * browser only allowed a muted autoplay). Closing a video pauses it on its
 * frame; opening it again carries on, playing if it was playing.
 *
 * Everything shown also waits under the media button, until it self-destructs
 * or the session ends.
 */
@Component({
  selector: 'cv-media-viewer',
  standalone: true,
  templateUrl: './media-viewer.component.html',
})
export class MediaViewerComponent {
  protected readonly display = inject(DisplayService);

  protected readonly items = this.display.items;
  /** The open item as a 0/1 list, so `@for … track id` gives each item its own element. */
  protected readonly openList = computed(() => {
    const item = this.display.openItem();
    return item ? [item] : [];
  });
  protected readonly trayOpen = signal(false);

  private readonly player = viewChild<ElementRef<HTMLMediaElement>>('player');
  /** The browser refused sound without a tap, so autoplay fell back to muted. */
  private mutedByPolicy = false;
  private lastPositionReport = 0;
  private touchStart: { x: number; y: number } | null = null;

  constructor() {
    this.display.frameSaver = () => {
      const el = this.player()?.nativeElement;
      if (!el) return null;
      const frame = { time: el.currentTime, playing: !el.paused && !el.ended };
      el.pause();
      return frame;
    };

    const sub = this.display.commands$.subscribe((cmd) => {
      const el = this.player()?.nativeElement;
      if (!el || this.display.open()?.id !== cmd.id) return;
      if (cmd.action === 'play') this.play(el);
      else if (cmd.action === 'pause') el.pause();
      else if (cmd.action === 'seek') this.seek(el, cmd.positionS);
    });

    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      this.display.frameSaver = null;
    });

    // An image has no playback events: say it is on screen when it opens.
    effect(() => {
      const item = this.display.openItem();
      this.mutedByPolicy = false;
      if (item?.kind === 'image') this.display.report(item.id, { state: 'shown', open: true });
    });

    // The tray steps aside for fullscreen media, and goes when it is empty.
    effect(() => {
      if (this.items().length === 0 || this.display.open()) this.trayOpen.set(false);
    });
  }

  protected close(): void {
    this.display.close();
  }

  protected step(dir: 1 | -1): void {
    this.display.step(dir);
  }

  protected openFromTray(id: string): void {
    this.trayOpen.set(false);
    this.display.openMedia(id, 'user');
  }

  @HostListener('document:keydown', ['$event'])
  protected onKey(event: KeyboardEvent): void {
    if (!this.display.open()) return;
    if (event.key === 'Escape') this.close();
    else if (event.key === 'ArrowLeft') this.step(-1);
    else if (event.key === 'ArrowRight') this.step(1);
  }

  protected onTouchStart(event: TouchEvent): void {
    const t = event.touches[0];
    this.touchStart = t ? { x: t.clientX, y: t.clientY } : null;
  }

  protected onTouchEnd(event: TouchEvent): void {
    const t = event.changedTouches[0];
    const start = this.touchStart;
    this.touchStart = null;
    if (!t || !start) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) this.step(dx < 0 ? 1 : -1);
  }

  /** Metadata is in: restore the remembered frame, then play if this open says so. */
  protected onLoaded(item: MediaItem): void {
    const el = this.player()?.nativeElement;
    if (!el) return;
    el.muted = item.muted;
    const resume = this.display.resumeFor(item.id);
    if (resume && resume.time > 0) this.seek(el, resume.time);
    if (this.display.open()?.autoplay) this.play(el);
    else this.report(item, el.ended ? 'ended' : 'paused');
  }

  protected onTap(): void {
    const el = this.player()?.nativeElement;
    if (!el) return;
    if (this.mutedByPolicy) {
      this.mutedByPolicy = false;
      el.muted = false;
      if (el.paused) this.play(el);
      return;
    }
    if (el.paused || el.ended) this.play(el);
    else el.pause();
  }

  protected onPlayback(item: MediaItem, state: 'playing' | 'paused' | 'error'): void {
    const el = this.player()?.nativeElement;
    // A pause from closing arrives after the item left the screen: `closed` already said it.
    if (this.display.open()?.id !== item.id) return;
    if (state === 'paused' && el?.ended) return;
    this.report(item, state, state === 'error' ? (el?.error?.message ?? 'cannot play this media') : undefined);
  }

  protected onEnded(item: MediaItem): void {
    if (this.display.open()?.id !== item.id) return;
    this.report(item, 'ended');
    if (item.closeOnEnd) this.display.close();
  }

  protected onTimeUpdate(item: MediaItem): void {
    const now = Date.now();
    if (now - this.lastPositionReport < POSITION_REPORT_MS) return;
    const el = this.player()?.nativeElement;
    if (!el || el.paused) return;
    this.report(item, 'playing');
  }

  /** A video tile in the tray shows the frame it was closed on (or its first frame). */
  protected showFrame(event: Event, id: string): void {
    const el = event.target as HTMLVideoElement;
    const at = this.display.resumeFor(id)?.time ?? 0;
    // 0 shows a blank tile on some browsers; a hair past it shows the first frame.
    el.currentTime = Math.min(Math.max(at, 0.1), Number.isFinite(el.duration) ? el.duration : at);
  }

  private play(el: HTMLMediaElement): void {
    el.play().catch((err: unknown) => {
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' && !el.muted) {
        // No tap since the page loaded: the browser allows muted autoplay only.
        el.muted = true;
        this.mutedByPolicy = true;
        el.play().catch(() => {});
      }
    });
  }

  private seek(el: HTMLMediaElement, time: number): void {
    try {
      el.currentTime = Number.isFinite(el.duration) ? Math.min(time, el.duration) : time;
    } catch {
      // A live stream is not seekable — it plays from where it is.
    }
  }

  private report(item: MediaItem, state: string, message?: string): void {
    const el = this.player()?.nativeElement;
    this.lastPositionReport = Date.now();
    this.display.report(item.id, {
      state,
      open: this.display.open()?.id === item.id,
      position_s: el ? el.currentTime : null,
      duration_s: el && Number.isFinite(el.duration) ? el.duration : null,
      muted: el ? el.muted : null,
      ...(message ? { message } : {}),
    });
  }
}
