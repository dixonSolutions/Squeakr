/**
 * Offline grammar-restricted phrase spotting via vosk-browser (WASM).
 *
 * Used for the wake (start), submit (end) and cancel phrases. Shares one
 * cached model load. What counts as hearing a phrase — the grammar with its
 * decoy words, word confidence, where the phrase sits, how long a partial
 * match must hold — is @squeakr/client's wakeSpotting.ts, the same rule calls
 * use on the bridge (docs/50).
 */

import type { Model } from 'vosk-browser';
import { getSharedAudioContext, unlockAudioContext, connectSilentSink } from './audio.js';
import { acquireMic, type MicLease } from './mic-service.js';
import { isCrossOriginIsolated, voskCoopError } from './cross-origin-isolation.js';
import { loadVoskModel } from './vosk-model-cache.js';
import {
  normalizeForWakeMatch,
  PhraseDecision,
  spottingGrammar,
  spottingRule,
  WAKE_PARTIAL_MATCH_THRESHOLD,
  type PhraseRole,
} from './wake-words.js';

export { VOSK_MODEL_URL } from './model-download.js';
export const VOSK_SAMPLE_RATE = 16000;

export interface VoskGrammarSpotterCallbacks {
  onReady?: () => void;
  /** `heard` is the raw Vosk transcript; `phrase` is the configured grammar phrase. */
  onMatch?: (phrase: string, heard: string) => void;
  onPartial?: (text: string) => void;
  onError?: (message: string) => void;
  onStatus?: (status: string) => void;
}

export function buildVoskGrammar(phrase: string): string {
  return JSON.stringify(spottingGrammar(phrase));
}

/** True when what Vosk heard holds the whole phrase, as whole words. */
export function voskPhraseMatches(heard: string, phrase: string): boolean {
  const normHeard = normalizeForWakeMatch(heard);
  const normPhrase = normalizeForWakeMatch(phrase);
  if (!normPhrase || !normHeard) return false;
  return ` ${normHeard} `.includes(` ${normPhrase} `);
}

export interface VoskSpotterStartOptions {
  mediaStream?: MediaStream;
  /** When false, only final results fire onMatch (recommended for submit/end phrase). */
  matchPartial?: boolean;
  /** The wake-sensitivity setting (0–1, lower is more sensitive) — see spottingRule. */
  minimumConfidence?: number;
  /**
   * What the phrase does, which decides where it may sit in what was said.
   * Default: `start` when partial matches are allowed, else `end` (the
   * submit and cancel spotters, which close what was said).
   */
  role?: PhraseRole;
}

export { WAKE_PARTIAL_MATCH_THRESHOLD };

/** Convert wake confidence threshold (0–1) into concrete Vosk spotter behavior. */
export function wakeSpotterOptions(
  threshold = 0.45,
): Pick<VoskSpotterStartOptions, 'matchPartial' | 'minimumConfidence' | 'role'> {
  const minimumConfidence = Math.min(1, Math.max(0, threshold));
  return {
    matchPartial: minimumConfidence < WAKE_PARTIAL_MATCH_THRESHOLD,
    minimumConfidence,
    role: 'start',
  };
}

/** @deprecated use buildVoskGrammar */
export const buildWakeGrammar = buildVoskGrammar;

export class VoskGrammarSpotter {
  private recognizer: InstanceType<Model['KaldiRecognizer']> | null = null;
  private mediaStream: MediaStream | null = null;
  private micLease: MicLease | null = null;
  private ownsStream = false;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private running = false;
  private paused = false;
  private phrase = '';
  private triggered = false;
  private decision: PhraseDecision | null = null;
  /** Audio fed to the recognizer since the last (re)start, in ms. */
  private fedMs = 0;

  constructor(private readonly cb: VoskGrammarSpotterCallbacks) {}

  /**
   * Start listening for `phrase` with grammar mode.
   * Pass `mediaStream` in options to share mic with STT.
   */
  async start(phrase: string, streamOrOpts?: MediaStream | VoskSpotterStartOptions): Promise<void> {
    const opts: VoskSpotterStartOptions =
      streamOrOpts instanceof MediaStream ? { mediaStream: streamOrOpts } : (streamOrOpts ?? {});
    if (this.running) return;

    if (!isCrossOriginIsolated()) {
      const message = voskCoopError();
      this.cb.onError?.(message);
      throw new Error(message);
    }

    this.phrase = normalizeForWakeMatch(phrase) || phrase.trim().toLowerCase();
    this.triggered = false;
    this.paused = false;
    this.fedMs = 0;
    const role = opts.role ?? (opts.matchPartial === false ? 'end' : 'start');
    const rule = spottingRule(role, opts.minimumConfidence);
    this.decision = new PhraseDecision(this.phrase, { ...rule, matchPartial: rule.matchPartial && opts.matchPartial !== false });
    this.cb.onStatus?.('Loading Vosk model…');

    await unlockAudioContext();
    const model = await loadVoskModel();

    const grammar = buildVoskGrammar(this.phrase);
    this.recognizer = new model.KaldiRecognizer(VOSK_SAMPLE_RATE, grammar);
    this.recognizer.setWords(true);

    this.recognizer.on('result', (message) => {
      if (message.event !== 'result' || this.triggered || !this.decision) return;
      const words = (message.result.result ?? []).map((w) => ({ word: w.word, conf: w.conf }));
      if (this.decision.final(words)) this.fire(message.result.text);
    });
    this.recognizer.on('partialresult', (message) => {
      if (message.event !== 'partialresult') return;
      const partial = message.result.partial ?? '';
      this.cb.onPartial?.(partial);
      if (!this.triggered && this.decision?.partial(partial, this.fedMs)) this.fire(partial);
    });

    if (opts.mediaStream) {
      this.mediaStream = opts.mediaStream;
      this.ownsStream = false;
    } else {
      // Borrow the app's one microphone rather than opening a second one —
      // a second getUserMedia is a second permission prompt (docs/40 §4).
      this.micLease = await acquireMic();
      this.mediaStream = this.micLease.stream;
      this.ownsStream = true;
    }

    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    this.source = ctx.createMediaStreamSource(this.mediaStream);
    // 4096 ≈ 85 ms at 48 kHz — fewer main-thread wakeups than 1024; still fine for wake words.
    this.processor = ctx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (event) => {
      if (!this.running || this.paused || !this.recognizer) return;
      this.fedMs += event.inputBuffer.duration * 1000;
      try {
        this.recognizer.acceptWaveform(event.inputBuffer);
      } catch (err) {
        console.warn('[vosk-spotter]', err);
      }
    };
    this.source.connect(this.processor);
    connectSilentSink(ctx, this.processor);

    this.running = true;
    this.cb.onReady?.();
    this.cb.onStatus?.(`Listening for "${this.phrase}"…`);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  resetTrigger(): void {
    this.triggered = false;
    this.decision?.reset();
  }

  /** Mic stream used by this spotter (for mute registration). */
  getMediaStream(): MediaStream | null {
    return this.mediaStream;
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.triggered = false;
    this.processor?.disconnect();
    this.source?.disconnect();
    this.recognizer?.remove();
    this.recognizer = null;
    if (this.ownsStream) {
      this.micLease?.release();
    }
    this.micLease = null;
    this.mediaStream = null;
    this.ownsStream = false;
    this.processor = null;
    this.source = null;
  }

  dispose(): void {
    this.stop();
  }

  private fire(text: string): void {
    this.triggered = true;
    this.cb.onMatch?.(this.phrase, text.trim());
  }
}

/** Back-compat alias for wake-word test tab. */
export type VoskWakeWordCallbacks = VoskGrammarSpotterCallbacks & {
  onWakeWord?: (word: string) => void;
};

export class VoskWakeWordDetector extends VoskGrammarSpotter {
  constructor(cb: VoskWakeWordCallbacks) {
    super({
      onReady: cb.onReady,
      onPartial: cb.onPartial,
      onError: cb.onError,
      onStatus: cb.onStatus,
      onMatch: (word, heard) => {
        cb.onMatch?.(word, heard);
        cb.onWakeWord?.(word);
      },
    });
  }
}
