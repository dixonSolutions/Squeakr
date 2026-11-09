/**
 * Instant wake-phrase spotting on a call — the web app's Vosk spotter
 * (web/src/vosk-wake-word.ts), run in the bridge on each speaker's audio.
 *
 * Without it a call matches the start phrase in the server transcript
 * (callTurns.ts), which exists only once the speaker has paused and Whisper
 * has finished: the listening cue came seconds after "hey squeaker". Vosk,
 * restricted to a grammar of the start phrase, hears it while it is being
 * said — a partial result about half a second in — so the cue plays as it does
 * on the phone. Same model the PWA downloads (serve/voskPaths.ts), same
 * grammar and the same rule for what counts as hearing the phrase
 * (realtime/wakeSpotting.ts, the phone's rules), same sensitivity setting
 * (settings.voice.wakeWords).
 *
 * Optional all the way: vosk-koffi (native libvosk) is an optional
 * dependency and the model may not be prepared yet. Without either, calls
 * match the transcript as before.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { childLogger } from '../log.js';
import { PhraseDecision, spottingGrammar, spottingRule, type HeardWord } from '../realtime/wakeSpotting.js';
import { squeakrHome, voskPaths } from '../serve/voskPaths.js';

const log = childLogger('channels:wake-spotter');
const execFileAsync = promisify(execFile);

/** Vosk models are trained at 16 kHz — the rate calls already deliver (channels/audio.ts). */
export const SPOTTER_SAMPLE_RATE = 16_000;


export interface PhraseSpotter {
  /** 16 kHz mono PCM16. */
  push(pcm: Buffer): void;
  /** A new utterance: forget what was heard, and trigger again. */
  reset(): void;
  close(): void;
}

export interface SpotterOptions {
  phrase: string;
  /** settings.voice.wakeWords.wakeConfidenceThreshold (0–1). */
  threshold: number;
  onMatch(heard: string): void;
}

export type SpotterFactory = (opts: SpotterOptions) => PhraseSpotter;

/** The slice of vosk-koffi used here. */
interface VoskRecognizer {
  setWords(on: boolean): unknown;
  acceptWaveform(pcm: Buffer): boolean;
  resultString(): string | null;
  partialResult(): { partial: string };
  reset(): unknown;
  free(): void;
}
interface VoskModule {
  Model: new (path: string) => object;
  Recognizer: new (param: { model: object; sampleRate: number; grammar: string[] }) => VoskRecognizer;
  setLogLevel(level: number): void;
}

class VoskPhraseSpotter implements PhraseSpotter {
  private readonly rec: VoskRecognizer;
  private readonly decision: PhraseDecision;
  /** Audio fed since the last reset, in ms — what a partial match must hold for. */
  private fedMs = 0;
  private triggered = false;
  private closed = false;

  constructor(vosk: VoskModule, model: object, private readonly opts: SpotterOptions) {
    this.decision = new PhraseDecision(opts.phrase, spottingRule('start', opts.threshold));
    this.rec = new vosk.Recognizer({ model, sampleRate: SPOTTER_SAMPLE_RATE, grammar: spottingGrammar(opts.phrase) });
    this.rec.setWords(true);
  }

  push(pcm: Buffer): void {
    if (this.closed || this.triggered) return;
    this.fedMs += (pcm.length / 2 / SPOTTER_SAMPLE_RATE) * 1000;
    if (this.rec.acceptWaveform(pcm)) {
      const final = parseFinal(this.rec.resultString());
      if (final && this.decision.final(final.words)) this.fire(final.text);
    } else {
      const partial = this.rec.partialResult().partial;
      if (this.decision.partial(partial, this.fedMs)) this.fire(partial);
    }
  }

  reset(): void {
    if (this.closed) return;
    this.rec.reset();
    this.decision.reset();
    this.fedMs = 0;
    this.triggered = false;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rec.free();
  }

  private fire(heard: string): void {
    this.triggered = true;
    this.opts.onMatch(heard);
  }
}

/** A final Vosk result: its text and its words with their confidence. */
export function parseFinal(json: string | null): { text: string; words: HeardWord[] } | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as { text?: string; result?: Array<{ word?: string; conf?: number }> };
    const words = (r.result ?? [])
      .filter((w) => typeof w.word === 'string' && typeof w.conf === 'number')
      .map((w) => ({ word: w.word!, conf: w.conf! }));
    return { text: r.text ?? '', words };
  } catch {
    return null;
  }
}

/**
 * Unpack the PWA's model.tar.gz once for the native library (it reads a
 * directory), next to where the PWA's copy is served from. Re-unpacked when
 * the archive changes.
 */
async function modelDir(): Promise<string | null> {
  const archive = voskPaths()
    .serveFrom.map((dir) => join(dir, 'model.tar.gz'))
    .find((p) => existsSync(p));
  if (!archive) return null;
  const st = statSync(archive);
  const stamp = `${archive} ${st.size} ${st.mtimeMs}`;
  const dir = join(squeakrHome(), 'vosk', 'server-model');
  const stampFile = join(dir, '.source');
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf-8') === stamp) return dir;
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  await execFileAsync('tar', ['-xzf', archive, '-C', tmp], { timeout: 120_000 });
  writeFileSync(join(tmp, '.source'), stamp, 'utf-8');
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  log.info({ archive, dir }, 'wake-word model unpacked for calls');
  return dir;
}

let loading: Promise<SpotterFactory | null> | null = null;

/** The spotter, loaded once; null when vosk-koffi or the model is missing (calls then match the transcript). */
export function loadSpotter(): Promise<SpotterFactory | null> {
  loading ??= (async () => {
    let vosk: VoskModule;
    try {
      const mod = (await import('vosk-koffi')) as unknown as VoskModule & { default?: VoskModule };
      vosk = mod.Model ? mod : mod.default!;
    } catch (err) {
      log.info({ err: String(err) }, 'vosk-koffi not available — calls match the wake phrase in the transcript');
      return null;
    }
    try {
      const dir = await modelDir();
      if (!dir) {
        log.info('no wake-word model prepared yet — calls match the wake phrase in the transcript');
        return null;
      }
      vosk.setLogLevel(-1);
      const started = Date.now();
      const model = new vosk.Model(dir);
      log.info({ ms: Date.now() - started }, 'wake-word spotter ready for calls');
      return (opts: SpotterOptions) => new VoskPhraseSpotter(vosk, model, opts);
    } catch (err) {
      log.warn({ err }, 'wake-word spotter could not load — calls match the wake phrase in the transcript');
      return null;
    }
  })();
  return loading;
}
