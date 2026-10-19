/**
 * Server-side TTS playback — used when the device's own speechSynthesis is
 * unavailable, or cannot speak the language the reply is in.
 *
 * Which engine answers is the bridge's business (Polly, ElevenLabs, OpenAI,
 * Gemini, a self-hosted Kokoro container, …); this just posts the text and
 * plays whatever audio comes back. The response's `X-Speech-Provider` header
 * names the engine that actually spoke, so a silent fallback is still visible
 * in the voice log. See docs/30-speech-output-providers.md.
 *
 * Replies are requested as a stream: a streaming engine answers `audio/pcm`,
 * played chunk by chunk as it arrives (pcm-scheduler.ts), so the first words
 * are heard while the rest is still being synthesized. Anything else — a
 * whole-file engine, or an older bridge — is one file, played as before.
 *
 * The device's speech speed and loudness (docs/49) apply to every path here:
 * speed by pitch-preserving stretch (or the element's own playbackRate),
 * loudness as the TTS pile's base volume plus the output bus's boost stage.
 */

import { getSharedAudioContext, unlockAudioContext } from './audio.js';
import { applyElementSink, getOutputBus } from './audio-output.js';
import { currentLoudness, currentSpeechSpeed } from './audio-prefs.js';
import { PcmScheduler, streamedPcmRate, type PcmContextLike } from './pcm-scheduler.js';
import { Pcm16Stretcher, stretchSamples } from './time-stretch.js';
import type { TtsPlayContext } from './tts-interrupt.js';
import { canUseWebkitTts } from './webkit-capabilities.js';

const MAX_TTS_CHARS = 3000;
let currentAudio: HTMLAudioElement | null = null;
let currentBufferSource: AudioBufferSourceNode | null = null;
let currentGainNode: GainNode | null = null;
let currentScheduler: PcmScheduler | null = null;
/** The reply being downloaded — aborted with the line, so a barge-in stops the transfer too. */
let currentFetch: AbortController | null = null;

function cleanText(text: string): string {
  return text.replace(/^\[Speak to user\]:\s*/i, '').trim().slice(0, MAX_TTS_CHARS);
}

function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export function stopServerTts(): void {
  currentFetch?.abort();
  currentFetch = null;
  if (currentScheduler) {
    currentScheduler.stop();
    currentScheduler = null;
  }
  if (currentBufferSource) {
    try {
      currentBufferSource.stop();
    } catch {
      // already stopped
    }
    currentBufferSource.disconnect();
    currentBufferSource = null;
  }
  if (currentGainNode) {
    currentGainNode.disconnect();
    currentGainNode = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

/** @deprecated use canUseWebkitTts — kept for existing imports */
export function isWebkitTtsSupported(): boolean {
  return canUseWebkitTts();
}

export interface SpeakServerTtsOptions {
  /** Override the configured language for this line (e.g. a quoted phrase). */
  language?: string;
}

/** Which engine spoke the last line — surfaced in the voice log. */
let lastProvider: string | null = null;

export function lastServerTtsProvider(): string | null {
  return lastProvider;
}

/** Fetch synthesized audio from the bridge and play it; resolves when done. */
export async function speakServerTts(
  text: string,
  bridgeBase: string,
  appToken: string,
  ctx?: TtsPlayContext,
  options?: SpeakServerTtsOptions,
): Promise<void> {
  const clean = cleanText(text);
  if (!clean) return;
  if (ctx?.signal.aborted) return;

  stopServerTts();

  const download = new AbortController();
  currentFetch = download;
  const onLineAbort = () => download.abort();
  ctx?.signal.addEventListener('abort', onLineAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(`${bridgeBase}/api/intelligence/tts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: clean,
        ...(options?.language ? { language: options.language } : {}),
        stream: true,
      }),
      signal: download.signal,
    });
  } catch (err) {
    ctx?.signal.removeEventListener('abort', onLineAbort);
    if (download.signal.aborted) return;
    throw err;
  }

  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // ignore
    }
    throw new Error(`Text-to-speech failed: ${detail}`);
  }

  lastProvider = res.headers.get('X-Speech-Provider');

  const pcmRate = streamedPcmRate(res.headers.get('Content-Type'), res.headers.get('X-Audio-Sample-Rate'));
  if (pcmRate && res.body) {
    try {
      await playPcmStream(res.body, pcmRate, download, ctx);
    } finally {
      ctx?.signal.removeEventListener('abort', onLineAbort);
      if (currentFetch === download) currentFetch = null;
    }
    return;
  }

  let blob: Blob;
  try {
    blob = await res.blob();
  } catch (err) {
    if (download.signal.aborted) return;
    throw err;
  } finally {
    ctx?.signal.removeEventListener('abort', onLineAbort);
    if (currentFetch === download) currentFetch = null;
  }

  // iOS needs Web Audio for playback after an await; a boost needs it anywhere.
  if (isIosDevice() || currentLoudness().boost > 1) {
    try {
      await playBlobViaAudioContext(blob, ctx);
      return;
    } catch (err) {
      if (isIosDevice() || ctx?.signal.aborted) throw err;
      // A format this engine cannot decode — the element can still play it, unboosted.
      console.warn('[server-tts] decode failed, playing without boost', err);
    }
  }

  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.setAttribute('webkit-playsinline', 'true');
  const baseVol = ctx?.baseVolume ?? 1;
  audio.volume = baseVol;
  // The element keeps the pitch while changing speed — better than any stretch.
  audio.playbackRate = currentSpeechSpeed();
  audio.preservesPitch = true;
  applyElementSink(audio);
  currentAudio = audio;

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      ctx?.signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const onAbort = () => {
      audio.pause();
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      finish();
    };

    ctx?.signal.addEventListener('abort', onAbort, { once: true });

    audio.onplay = () => ctx?.onStart();
    audio.onended = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      finish();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      reject(new Error('Server text-to-speech playback failed'));
    };
    void audio.play().catch(reject);
  });
}

/**
 * Play a streamed `audio/pcm` reply while it downloads. Resolves when the
 * last chunk has finished playing, or at once on abort. A connection that
 * drops mid-line plays what arrived and ends the line there.
 */
async function playPcmStream(
  body: ReadableStream<Uint8Array>,
  sampleRate: number,
  download: AbortController,
  ctx?: TtsPlayContext,
): Promise<void> {
  await unlockAudioContext();
  const audioCtx = getSharedAudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const gain = audioCtx.createGain();
  gain.gain.value = ctx?.baseVolume ?? 1;
  gain.connect(getOutputBus());
  const stretcher = new Pcm16Stretcher(sampleRate, currentSpeechSpeed());
  const scheduler = new PcmScheduler(audioCtx as unknown as PcmContextLike, gain, sampleRate, {
    onStart: () => ctx?.onStart(),
  });
  currentScheduler = scheduler;
  const onAbort = () => scheduler.stop();
  download.signal.addEventListener('abort', onAbort, { once: true });

  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) scheduler.push(stretcher.push(value));
    }
  } catch (err) {
    if (!download.signal.aborted) {
      console.warn('[server-tts] stream ended early', err);
    }
  }
  if (!download.signal.aborted) scheduler.push(stretcher.flush());

  try {
    await scheduler.finish();
  } finally {
    download.signal.removeEventListener('abort', onAbort);
    if (currentScheduler === scheduler) currentScheduler = null;
    gain.disconnect();
  }
}

async function playBlobViaAudioContext(blob: Blob, ctx?: TtsPlayContext): Promise<void> {
  await unlockAudioContext();
  const audioCtx = getSharedAudioContext();
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const buffer = stretchAudioBuffer(audioCtx, await audioCtx.decodeAudioData(await blob.arrayBuffer()), currentSpeechSpeed());
  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  const baseVol = ctx?.baseVolume ?? 1;
  gain.gain.value = baseVol;
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(getOutputBus());
  currentBufferSource = source;
  currentGainNode = gain;

  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      ctx?.signal.removeEventListener('abort', onAbort);
      if (currentBufferSource === source) currentBufferSource = null;
      if (currentGainNode === gain) currentGainNode = null;
      resolve();
    };

    const onAbort = () => {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
      gain.disconnect();
      finish();
    };

    ctx?.signal.addEventListener('abort', onAbort, { once: true });

    source.onended = finish;
    try {
      source.start(0);
      ctx?.onStart();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

/** Pitch-preserving speed change of a decoded file — every channel, same length. */
export function stretchAudioBuffer(audioCtx: BaseAudioContext, buffer: AudioBuffer, speed: number): AudioBuffer {
  if (speed === 1) return buffer;
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(stretchSamples(buffer.getChannelData(c), buffer.sampleRate, speed));
  }
  const length = Math.max(1, ...channels.map((ch) => ch.length));
  const out = audioCtx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
  channels.forEach((ch, c) => out.getChannelData(c).set(ch));
  return out;
}
