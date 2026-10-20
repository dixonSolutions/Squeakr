/**
 * Browser TTS fallback when assistant text arrives without active playback.
 * WebKit speechSynthesis first; Amazon Polly when WebKit is unavailable.
 */

import { speakServerTts, stopServerTts } from './server-tts.js';
import { resolveTtsBackend, type IntelligenceAudioConfig } from './intelligence-audio.js';
import { canUseWebkitTts } from './webkit-capabilities.js';
import { looksLikeSilentPlayback } from './browser-tts-settings.js';
import type { TtsInterruptSnapshot, TtsPlayContext, TtsPlayFn } from './tts-interrupt.js';

const SPEAK_PREFIX = /^\[Speak to user\]:\s*/i;
const MAX_TTS_CHARS = 900;
/** ~150 wpm — estimate partial-line words heard before barge-in pause. */
const MS_PER_WORD_ESTIMATE = 400;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let lastSpokenText = '';
let lastSpokenAt = 0;
let voicesPrimed = false;
let transcriptTtsConfig: {
  bridgeBase: string;
  appToken: string;
  audio: IntelligenceAudioConfig;
} | null = null;

export type { TtsPlayContext, TtsPlayFn } from './tts-interrupt.js';

export function configureTranscriptTts(opts: {
  bridgeBase: string;
  appToken: string;
  audio: IntelligenceAudioConfig;
}): void {
  transcriptTtsConfig = opts;
}

export function clearTranscriptTts(): void {
  transcriptTtsConfig = null;
}

export function stripSpeakPrefix(text: string): string {
  return text.replace(SPEAK_PREFIX, '').trim();
}

export function textForSpeech(text: string): string {
  const clean = stripSpeakPrefix(text);
  if (clean.length <= MAX_TTS_CHARS) return clean;
  const cut = clean.slice(0, MAX_TTS_CHARS);
  const lastBreak = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  const body = lastBreak > MAX_TTS_CHARS * 0.4 ? cut.slice(0, lastBreak + 1) : cut;
  return `${body.trimEnd()} …`;
}

/** Longest run of read-everything content we will queue from one action. */
const READ_EVERYTHING_MAX_CHARS = 20_000;

/**
 * Split long content into speakable lines.
 *
 * textForSpeech() truncates at MAX_TTS_CHARS, which is right for a reply but
 * wrong for read-everything: the point there is to hear all of it. Break on
 * paragraph, then sentence, then — only if a single sentence is still too long
 * — on whitespace, so the queue plays the whole thing in order.
 */
export function chunkForSpeech(text: string, maxChars = MAX_TTS_CHARS): string[] {
  const clean = stripSpeakPrefix(text);
  if (!clean) return [];

  const capped =
    clean.length > READ_EVERYTHING_MAX_CHARS
      ? `${clean.slice(0, READ_EVERYTHING_MAX_CHARS).trimEnd()} … the rest is in the log.`
      : clean;

  const chunks: string[] = [];
  let rest = capped;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const breakAt = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf('\n'),
    );
    const cut = breakAt > maxChars * 0.3 ? breakAt + 1 : window.lastIndexOf(' ');
    const end = cut > 0 ? cut : maxChars;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

/** The opening of a longer body — roughly what you would skim before deciding. */
export function openingForSpeech(text: string, maxChars = 240): string {
  const clean = stripSpeakPrefix(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const window = clean.slice(0, maxChars);
  const sentenceEnd = window.lastIndexOf('. ');
  if (sentenceEnd > maxChars * 0.4) return window.slice(0, sentenceEnd + 1);
  const wordEnd = window.lastIndexOf(' ');
  return `${window.slice(0, wordEnd > 0 ? wordEnd : maxChars).trimEnd()} …`;
}

/**
 * Sequential TTS queue — rapid speak() calls pile up and play one after another
 * without canceling in-flight audio. Tracks what was heard for barge-in interrupts.
 */
export class TtsPile {
  private readonly queue: string[] = [];
  private draining = false;
  private active = false;
  private hardStop = false;
  private onActiveChange: ((active: boolean) => void) | null = null;
  private readonly completedLines: string[] = [];
  private currentLine: string | null = null;
  private lineStarted = false;
  private lineAbort: AbortController | null = null;
  /** When true, wake barge-in paused playback — queue saved for cancel-resume. */
  private bargeInPaused = false;
  private bargeInResumeQueue: string[] = [];
  private lineStartedAt = 0;
  private partialWordsEstimate: string | null = null;
  private baseVolume = 1;
  private onDiscard: ((lines: string[]) => void) | null = null;

  constructor(private readonly playLine: TtsPlayFn) {}

  /** Lines dropped without being played to the end — agent audio streams use it to report and free themselves. */
  setOnDiscard(fn: (lines: string[]) => void): void {
    this.onDiscard = fn;
  }

  private discard(lines: string[]): void {
    if (lines.length) this.onDiscard?.(lines);
  }

  setBaseVolume(volume: number): void {
    this.baseVolume = Math.max(0, Math.min(1, volume));
  }

  setOnActiveChange(fn: (active: boolean) => void): void {
    this.onActiveChange = fn;
  }

  get pending(): number {
    return this.queue.length + (this.draining ? 1 : 0);
  }

  isActive(): boolean {
    return this.active || this.draining || this.queue.length > 0 || this.bargeInPaused;
  }

  isBargeInPaused(): boolean {
    return this.bargeInPaused;
  }

  getPartialWordsEstimate(): string | null {
    return this.partialWordsEstimate;
  }
  getCurrentLine(): string | null {
    return this.currentLine;
  }

  resetHeard(): void {
    this.completedLines.length = 0;
    this.currentLine = null;
    this.lineStarted = false;
    this.lineStartedAt = 0;
    this.partialWordsEstimate = null;
    this.bargeInPaused = false;
    this.bargeInResumeQueue = [];
  }

  enqueue(text: string): void {
    const clean = textForSpeech(text);
    if (!clean) return;
    this.queue.push(clean);
    void this.drain();
  }

  /** Queue a line exactly as given — an agent audio stream's marker (docs/47), not text to clean up. */
  enqueueRaw(line: string): void {
    if (!line) return;
    this.queue.push(line);
    void this.drain();
  }

  /**
   * Wake barge-in — stop reading aloud but keep the queue for cancel-resume.
   * Does not clear completed lines (used for last-heard-word context on submit).
   */
  pauseForBargeIn(): TtsInterruptSnapshot {
    this.hardStop = true;
    this.lineAbort?.abort();

    const partialEstimate = this.estimatePartialWordsHeard();
    this.partialWordsEstimate = partialEstimate;

    const resumeQueue: string[] = [...this.queue];
    if (this.currentLine) {
      resumeQueue.unshift(this.currentLine);
    }

    const heardPartial =
      this.lineStarted && this.currentLine ? this.currentLine : null;

    const snapshot: TtsInterruptSnapshot = {
      heard_complete: [...this.completedLines],
      heard_partial: heardPartial,
      not_spoken: [...resumeQueue],
      partial_words_estimate: partialEstimate,
    };

    this.bargeInPaused = true;
    this.bargeInResumeQueue = resumeQueue;
    this.queue.length = 0;
    this.draining = false;
    this.currentLine = null;
    this.lineStarted = false;
    this.lineStartedAt = 0;
    this.lineAbort = null;
    this.setActive(false);

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    stopServerTts();

    return snapshot;
  }

  /** User said cancel during capture — resume assistant speech from the pause point. */
  resumeAfterBargeInCancel(): void {
    if (!this.bargeInPaused) return;
    this.bargeInPaused = false;
    this.hardStop = false;
    this.partialWordsEstimate = null;
    this.bargeInResumeQueue.forEach((line) => this.queue.push(line));
    this.bargeInResumeQueue = [];
    void this.drain();
  }

  /** User submitted a new turn — discard unsplayed queue and return heard snapshot. */
  finalizeBargeInOnSubmit(): TtsInterruptSnapshot {
    const snap = this.buildInterruptSnapshot();
    this.discard([...this.bargeInResumeQueue, ...this.queue]);
    this.bargeInPaused = false;
    this.bargeInResumeQueue = [];
    this.queue.length = 0;
    this.draining = false;
    this.hardStop = false;
    this.currentLine = null;
    this.lineStarted = false;
    this.lineStartedAt = 0;
    this.lineAbort = null;
    this.completedLines.length = 0;
    this.partialWordsEstimate = null;
    this.setActive(false);
    return snap;
  }

  private buildInterruptSnapshot(): TtsInterruptSnapshot {
    return {
      heard_complete: [...this.completedLines],
      heard_partial:
        this.lineStarted && this.currentLine ? this.currentLine : null,
      not_spoken: [...this.bargeInResumeQueue],
      partial_words_estimate: this.partialWordsEstimate,
    };
  }

  private estimatePartialWordsHeard(): string | null {
    if (!this.lineStarted || !this.currentLine) return null;
    const elapsed = Math.max(0, Date.now() - this.lineStartedAt);
    const words = this.currentLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) return null;
    const count = Math.min(words.length, Math.max(1, Math.floor(elapsed / MS_PER_WORD_ESTIMATE)));
    return words.slice(0, count).join(' ');
  }

  /** Line currently playing — used to ignore wake-word echo from assistant TTS. */
  interruptWithSnapshot(): TtsInterruptSnapshot {
    this.hardStop = true;
    this.lineAbort?.abort();

    const heardPartial =
      this.lineStarted && this.currentLine ? this.currentLine : null;
    const notSpoken = [...this.queue];
    if (this.currentLine && !this.lineStarted) {
      notSpoken.unshift(this.currentLine);
    }

    const snapshot: TtsInterruptSnapshot = {
      heard_complete: [...this.completedLines],
      heard_partial: heardPartial,
      not_spoken: notSpoken,
    };

    this.discard([...(this.currentLine ? [this.currentLine] : []), ...this.queue, ...this.bargeInResumeQueue]);
    this.queue.length = 0;
    this.draining = false;
    this.currentLine = null;
    this.lineStarted = false;
    this.lineAbort = null;
    this.bargeInPaused = false;
    this.bargeInResumeQueue = [];
    this.setActive(false);

    if (typeof window !== 'undefined' && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    stopServerTts();

    return snapshot;
  }

  interrupt(): void {
    this.interruptWithSnapshot();
    this.resetHeard();
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.onActiveChange?.(active);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.hardStop = false;
    this.setActive(true);

    try {
      while (this.queue.length > 0 && !this.hardStop) {
        const line = this.queue.shift()!;
        await this.playLineTracked(line);
      }
    } finally {
      this.draining = false;
      if (!this.hardStop && this.queue.length === 0) {
        this.setActive(false);
      } else if (!this.hardStop && this.queue.length > 0) {
        void this.drain();
      }
    }
  }

  private async playLineTracked(line: string): Promise<void> {
    this.currentLine = line;
    this.lineStarted = false;
    this.lineAbort = new AbortController();
    const signal = this.lineAbort.signal;

    try {
      await this.playLine(line, {
        onStart: () => {
          this.lineStarted = true;
          this.lineStartedAt = Date.now();
        },
        signal,
        baseVolume: this.baseVolume,
      });
      if (!signal.aborted && !this.hardStop) {
        this.completedLines.push(line);
      }
    } catch (err) {
      if (!signal.aborted && !this.hardStop) {
        console.warn('[tts pile]', err);
      }
    } finally {
      this.currentLine = null;
      this.lineStarted = false;
      this.lineAbort = null;
    }
  }
}

function playWebkitLine(
  text: string,
  ctx?: TtsPlayContext,
  opts?: { rate?: number; pitch?: number; lang?: string; voiceURI?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!canUseWebkitTts()) {
      reject(new Error('Browser TTS unavailable'));
      return;
    }
    if (ctx?.signal.aborted) {
      resolve();
      return;
    }
    const startedAt = Date.now();

    prepareSpeechSynthesis();
    const utter = new SpeechSynthesisUtterance(text);
    const rate = opts?.rate ?? 1.02;
    const pitch = opts?.pitch ?? 1;
    utter.rate = rate;
    utter.pitch = pitch;
    utter.lang = opts?.lang ?? 'en-US';
    if (opts?.voiceURI) {
      const voice = window.speechSynthesis
        .getVoices()
        .find((v) => v.voiceURI === opts.voiceURI);
      if (voice) utter.voice = voice;
    }
    utter.volume = ctx?.baseVolume ?? 1;

    const finish = () => {
      ctx?.signal.removeEventListener('abort', onAbort);
      resolve();
    };

    const onAbort = () => {
      window.speechSynthesis.cancel();
      finish();
    };

    ctx?.signal.addEventListener('abort', onAbort, { once: true });

    utter.onstart = () => {
      lastSpokenAt = Date.now();
      lastSpokenText = text;
      ctx?.onStart();
    };
    utter.onend = () => {
      window.speechSynthesis.cancel();
      // Completed instantly => no voice actually spoke it; let the caller
      // fall through to a server voice rather than losing the line.
      if (!ctx?.signal.aborted && looksLikeSilentPlayback(text, Date.now() - startedAt, rate)) {
        ctx?.signal.removeEventListener('abort', onAbort);
        reject(new Error('Browser speech finished instantly — nothing was audible'));
        return;
      }
      finish();
    };
    utter.onerror = (ev) => {
      const reason = ev.error ?? 'error';
      ctx?.signal.removeEventListener('abort', onAbort);
      if (reason === 'interrupted' || reason === 'canceled') {
        resolve();
        return;
      }
      reject(new Error(`Browser speech failed: ${reason}`));
    };
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

async function playTranscriptLine(text: string, ctx?: TtsPlayContext): Promise<void> {
  const cfg = transcriptTtsConfig;
  const backend = cfg ? resolveTtsBackend(cfg.audio) : canUseWebkitTts() ? 'webkit' : 'none';

  const speakOnServer = async (): Promise<void> => {
    if (!cfg) throw new Error('No server TTS configured');
    await speakServerTts(text, cfg.bridgeBase, cfg.appToken, ctx);
    lastSpokenAt = Date.now();
    lastSpokenText = text;
  };

  if (backend === 'server' && cfg) {
    await speakOnServer();
    return;
  }

  if (backend === 'webkit' || canUseWebkitTts()) {
    try {
      await playWebkitLine(text, ctx);
      return;
    } catch (err) {
      if (ctx?.signal.aborted) return;
      // The browser voice failed or played nothing — the bridge already walked
      // its own chain, so a server voice is the only fallback left.
      if (!cfg?.audio.ttsAvailable) throw err;
      console.warn('[tts fallback] browser voice failed, using server TTS', err);
      await speakOnServer();
      return;
    }
  }

  if (cfg?.audio.ttsAvailable) {
    await speakOnServer();
  }
}

const transcriptPile = new TtsPile((text, ctx) => playTranscriptLine(text, ctx));

function prepareSpeechSynthesis(): void {
  if (typeof window === 'undefined' || !window.speechSynthesis) return;
  window.speechSynthesis.resume();
  if (!voicesPrimed) {
    window.speechSynthesis.getVoices();
    voicesPrimed = true;
  }
}

/** Resume speechSynthesis and load voices — required on iOS before speak(). */
export function prepareSpeechSynthesisForPlayback(): void {
  prepareSpeechSynthesis();
}

function canPlayTranscriptTts(): boolean {
  if (canUseWebkitTts()) return true;
  return Boolean(transcriptTtsConfig?.audio.ttsAvailable);
}

/** Enqueue browser TTS — lines pile and play sequentially. */
export function speakTtsNow(text: string): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  const clean = textForSpeech(text);
  if (!clean || !canPlayTranscriptTts()) return;
  if (clean === lastSpokenText && Date.now() - lastSpokenAt < 10_000) return;

  transcriptPile.enqueue(clean);
}

/**
 * Fallback when assistant text arrives without active TTS playback.
 */
export function scheduleTtsFallback(text: string, isSpeaking: () => boolean): void {
  const trimmed = text.trim();
  if (!trimmed || !canPlayTranscriptTts()) return;

  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (isSpeaking()) return;
    if (Date.now() - lastSpokenAt < 400) return;
    speakTtsNow(trimmed);
  }, SPEAK_PREFIX.test(trimmed) ? 200 : 800);
}

export function cancelTtsFallback(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

export function stopAllTts(): void {
  cancelTtsFallback();
  transcriptPile.interrupt();
}
