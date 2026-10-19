/**
 * Sending files and recordings to the agent from the phone (docs/46).
 *
 * The bridge keeps the raw file and does the work — transcripts, video
 * frames, an inline-sized copy. The phone's part is the upload itself, a
 * recorder for voice memos, and one fallback: when the bridge host has no
 * ffmpeg it cannot open WebM / MP4 audio, but the browser that recorded it
 * can, so the phone decodes to 16 kHz PCM and posts that for transcription.
 */

/** What the bridge says about one upload (routes/media.ts → viewMedia). */
export interface MediaAssetView {
  id: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  name: string;
  mime: string;
  size: number;
  duration_sec: number | null;
  transcript_status: 'none' | 'done' | 'empty' | 'needs_pcm' | 'unavailable' | 'failed';
  transcript: string | null;
  transcript_provider: string | null;
  transcript_error: string | null;
  frames: number;
  inline: boolean;
}

export interface MediaCapabilities {
  max_bytes: number;
  transcription: boolean;
  ffmpeg: boolean;
  inline: { supported: boolean; cli: string; note: string };
  attached: number;
  agent_running: boolean;
}

/** Files the phone may pick — what the bridge knows how to hand over. */
export const MEDIA_ACCEPT = 'image/*,video/*,audio/*';

export const TARGET_RATE = 16_000;

/** Float samples (−1…1) → PCM16 little-endian bytes. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return out;
}

/** Average channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const len = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) out[i]! += ch[i]! / channels.length;
  return out;
}

/**
 * A recorded or picked file → 16 kHz mono PCM16, using the browser's own
 * decoder (which reads every format that browser records). Null when it
 * cannot — the bridge then reports the transcript as unavailable.
 */
export async function decodeToPcm16k(blob: Blob): Promise<Uint8Array | null> {
  const Offline = globalThis.OfflineAudioContext;
  if (!Offline) return null;
  try {
    const bytes = await blob.arrayBuffer();
    // Decoding on a 16 kHz context resamples as part of the decode.
    const ctx = new Offline(1, 1, TARGET_RATE);
    const audio = await ctx.decodeAudioData(bytes);
    const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
    return floatToPcm16(downmix(channels));
  } catch {
    return null;
  }
}

/** Recorder formats in preference order — Opus where it exists, AAC on Safari. */
export const RECORDER_MIMES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];

export function pickRecorderMime(isSupported: (mime: string) => boolean): string | null {
  return RECORDER_MIMES.find((m) => isSupported(m)) ?? null;
}

/** `memo-2026-10-20-0807.webm` — a name the agent can tell apart. */
export function recordingName(mime: string, now = new Date()): string {
  const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const p = (n: number) => String(n).padStart(2, '0');
  return `memo-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.${ext}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** One line under a file chip: what the bridge made of it. */
export function describeAsset(a: MediaAssetView): string {
  const parts: string[] = [formatBytes(a.size)];
  if (a.duration_sec != null) {
    const s = Math.round(a.duration_sec);
    parts.push(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
  }
  if (a.frames > 0) parts.push(`${a.frames} frames`);
  switch (a.transcript_status) {
    case 'done':
      parts.push('transcribed');
      break;
    case 'empty':
      parts.push('no speech heard');
      break;
    case 'unavailable':
    case 'failed':
    case 'needs_pcm':
      parts.push('no transcript');
      break;
  }
  return parts.join(' · ');
}

/** POST the raw file, with upload progress (fetch has none). */
export function uploadMedia(
  file: Blob,
  name: string,
  token: string,
  onProgress?: (fraction: number) => void,
): { promise: Promise<MediaAssetView>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<MediaAssetView>((resolve, reject) => {
    xhr.open('POST', `/api/media?name=${encodeURIComponent(name)}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // fall through to the status error
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) resolve(body as MediaAssetView);
      else reject(new Error((body as { error?: string } | null)?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — check the connection to the bridge.'));
    xhr.onabort = () => reject(new Error('Upload cancelled'));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
