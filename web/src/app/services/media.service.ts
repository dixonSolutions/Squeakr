import { Injectable, computed, inject, signal } from '@angular/core';

import { BridgeService } from './bridge.service';
import { ToastService } from './toast.service';
import { VoiceSessionService } from './voice-session.service';
import { acquireMic, type MicLease } from '../../mic-service.js';
import {
  decodeToPcm16k,
  describeAsset,
  pickRecorderMime,
  recordingName,
  uploadMedia,
  type MediaAssetView,
  type MediaCapabilities,
} from '../../media-upload.js';

/**
 * Files and voice memos the user hands the agent (docs/46).
 *
 *   mode     turn   — send them as (part of) a new turn, with any typed text
 *            attach — add them to the conversation in flight; the agent gets
 *                     them on its next Squeakr tool call, or with the next turn
 *   delivery path   — the agent is told where each file is
 *            inline — the pictures also go straight into the agent's chat
 *
 * Uploads start the moment a file is picked, so by the time the user taps
 * Send the bridge has usually finished the transcript.
 */
export type MediaMode = 'turn' | 'attach';
export type MediaDelivery = 'path' | 'inline';

export interface PendingMedia {
  key: number;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  previewUrl: string | null;
  state: 'uploading' | 'processing' | 'ready' | 'failed';
  progress: number;
  asset: MediaAssetView | null;
  error: string | null;
  abort: (() => void) | null;
}

const PREFS_KEY = 'cv_media_prefs';

@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly bridge = inject(BridgeService);
  private readonly toast = inject(ToastService);
  private readonly voiceSession = inject(VoiceSessionService);

  private nextKey = 1;
  private recorder: MediaRecorder | null = null;
  private recorderLease: MicLease | null = null;
  private recorderStream: MediaStream | null = null;
  private recordTimer: ReturnType<typeof setInterval> | null = null;

  readonly items = signal<PendingMedia[]>([]);
  readonly mode = signal<MediaMode>('turn');
  readonly delivery = signal<MediaDelivery>('path');
  readonly capabilities = signal<MediaCapabilities | null>(null);
  readonly recording = signal(false);
  readonly recordSeconds = signal(0);
  readonly sending = signal(false);

  readonly busy = computed(() => this.items().some((i) => i.state === 'uploading' || i.state === 'processing'));
  readonly readyIds = computed(() =>
    this.items()
      .filter((i) => i.state === 'ready' && i.asset)
      .map((i) => i.asset!.id),
  );
  readonly hasItems = computed(() => this.items().length > 0);
  /** Inline needs a CLI that shows tool-result images; the bridge says which. */
  readonly inlineNote = computed(() => {
    const caps = this.capabilities();
    if (!caps) return '';
    return caps.inline.supported ? caps.inline.note : `${caps.inline.cli}: ${caps.inline.note}`;
  });

  constructor() {
    try {
      const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { mode?: MediaMode; delivery?: MediaDelivery };
      if (prefs.mode === 'turn' || prefs.mode === 'attach') this.mode.set(prefs.mode);
      if (prefs.delivery === 'path' || prefs.delivery === 'inline') this.delivery.set(prefs.delivery);
    } catch {
      // first run
    }
  }

  setMode(mode: MediaMode): void {
    this.mode.set(mode);
    this.savePrefs();
  }

  setDelivery(delivery: MediaDelivery): void {
    this.delivery.set(delivery);
    this.savePrefs();
  }

  private savePrefs(): void {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ mode: this.mode(), delivery: this.delivery() }));
  }

  async refreshCapabilities(): Promise<void> {
    try {
      this.capabilities.set(await this.bridge.apiGet<MediaCapabilities>('/api/media/capabilities'));
    } catch {
      // older bridge or offline — the picker still works, the notes just stay empty
    }
  }

  describe(item: PendingMedia): string {
    if (item.state === 'uploading') return `Uploading ${Math.round(item.progress * 100)}%`;
    if (item.state === 'processing') return item.kind === 'image' ? 'Processing…' : 'Transcribing…';
    if (item.state === 'failed') return item.error ?? 'Failed';
    return item.asset ? describeAsset(item.asset) : '';
  }

  addFiles(files: FileList | File[] | null): void {
    for (const file of Array.from(files ?? [])) this.addBlob(file, file.name);
  }

  remove(key: number): void {
    const item = this.items().find((i) => i.key === key);
    item?.abort?.();
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.items.update((list) => list.filter((i) => i.key !== key));
  }

  clear(): void {
    for (const item of this.items()) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    this.items.set([]);
  }

  private patch(key: number, change: Partial<PendingMedia>): void {
    this.items.update((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));
  }

  private addBlob(blob: Blob, name: string): void {
    const key = this.nextKey++;
    const type = blob.type || '';
    const kind = type.startsWith('image/') ? 'image' : type.startsWith('video/') ? 'video' : type.startsWith('audio/') ? 'audio' : 'file';
    const max = this.capabilities()?.max_bytes;
    if (max && blob.size > max) {
      this.toast.warn('File too large', `${name} is over ${Math.round(max / 1024 / 1024)} MB.`);
      return;
    }
    const { promise, abort } = uploadMedia(blob, name, this.bridge.appToken, (fraction) => {
      this.patch(key, fraction >= 1 ? { progress: 1, state: 'processing' } : { progress: fraction });
    });
    this.items.update((list) => [
      ...list,
      {
        key,
        name,
        kind,
        previewUrl: kind === 'image' ? URL.createObjectURL(blob) : null,
        state: 'uploading',
        progress: 0,
        asset: null,
        error: null,
        abort,
      },
    ]);
    void promise
      .then(async (asset) => {
        // The bridge could not open this format: the browser can, so send it PCM.
        if (asset.transcript_status === 'needs_pcm') asset = await this.transcribeLocally(asset, blob);
        // The bridge's verdict wins (an audio-only .webm arrives as video/webm).
        this.patch(key, { state: 'ready', asset, kind: asset.kind, abort: null, progress: 1 });
      })
      .catch((err: unknown) => {
        if (!this.items().some((i) => i.key === key)) return; // removed while uploading
        const message = err instanceof Error ? err.message : String(err);
        this.patch(key, { state: 'failed', error: message, abort: null });
        this.toast.warn('Upload failed', `${name}: ${message}`);
      });
  }

  private async transcribeLocally(asset: MediaAssetView, blob: Blob): Promise<MediaAssetView> {
    const pcm = await decodeToPcm16k(blob);
    if (!pcm) return asset;
    try {
      return await this.bridge.apiFetch<MediaAssetView>(`/api/media/${asset.id}/pcm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm as unknown as BodyInit,
      });
    } catch {
      return asset;
    }
  }

  // ── Voice memo ─────────────────────────────────────────────────────────

  async startRecording(): Promise<void> {
    if (this.recording()) return;
    const mime = typeof MediaRecorder === 'undefined' ? null : pickRecorderMime((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      this.toast.warn('Recording not supported', 'This browser cannot record audio — pick a file instead.');
      return;
    }
    try {
      // The shared mic (one permission prompt for the app), cloned so the
      // voice session can be paused without silencing the memo.
      this.recorderLease = await acquireMic();
      this.recorderStream = new MediaStream(this.recorderLease.stream.getAudioTracks().map((t) => t.clone()));
    } catch (err) {
      this.recorderLease?.release();
      this.recorderLease = null;
      this.toast.warn('Microphone unavailable', err instanceof Error ? err.message : String(err));
      return;
    }
    this.voiceSession.holdMicForRecording(true);
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(this.recorderStream, { mimeType: mime });
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime.split(';')[0] });
      this.releaseRecorder();
      if (blob.size > 0) this.addBlob(blob, recordingName(mime));
    };
    recorder.start(1000);
    this.recorder = recorder;
    this.recording.set(true);
    this.recordSeconds.set(0);
    this.recordTimer = setInterval(() => this.recordSeconds.update((s) => s + 1), 1000);
  }

  stopRecording(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else this.releaseRecorder();
  }

  private releaseRecorder(): void {
    if (this.recordTimer) clearInterval(this.recordTimer);
    this.recordTimer = null;
    for (const t of this.recorderStream?.getTracks() ?? []) t.stop();
    this.recorderStream = null;
    this.recorderLease?.release();
    this.recorderLease = null;
    this.recorder = null;
    this.recording.set(false);
    this.voiceSession.holdMicForRecording(false);
  }

  // ── Sending ────────────────────────────────────────────────────────────

  /**
   * Send what is ready. `turn` goes out as a user turn (with `text`);
   * `attach` stages it for the conversation in flight. Returns true when
   * something was sent and the tray was cleared.
   */
  async send(text: string): Promise<boolean> {
    const ids = this.readyIds();
    if (ids.length === 0 && !text.trim()) return false;
    if (this.busy()) {
      this.toast.info('Still uploading', 'Wait for the files to finish, then send.');
      return false;
    }
    this.sending.set(true);
    try {
      if (this.mode() === 'attach' && ids.length > 0) {
        const res = await this.bridge.apiPost<{ attached: number; when: 'next_tool_call' | 'next_turn' }>(
          '/api/media/attach',
          { ids, delivery: this.delivery() },
        );
        this.toast.success(
          'Attached',
          res.when === 'next_tool_call'
            ? 'The agent gets them with its next step.'
            : 'They go with your next message.',
        );
        // Typed text in attach mode is still a turn of its own.
        if (text.trim()) await this.voiceSession.sendTextMessage(text);
        this.clear();
        return true;
      }
      const sent = await this.voiceSession.sendTextMessage(
        text,
        ids.length > 0 ? { ids, delivery: this.delivery() } : undefined,
      );
      if (sent) this.clear();
      return sent;
    } catch (err) {
      this.toast.error('Could not send', err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      this.sending.set(false);
    }
  }
}
