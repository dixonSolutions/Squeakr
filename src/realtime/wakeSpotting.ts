/**
 * How a Vosk grammar spotter decides it heard a phrase — the bridge's copy of
 * packages/client/src/wakeSpotting.ts (the phone's), for calls
 * (src/channels/wakeSpotter.ts). The bridge cannot import the client package,
 * so the two are kept identical by web/src/wake-spotting-parity.test.ts:
 * change both. Measured in docs/50.
 *
 * The grammar used to be the phrase and `[unk]`. Vosk then had only two
 * choices for every sound, so anything near the phrase became the phrase:
 * "he squeezed the lemon", "hey sweetie", "the kids are sneaky today" all
 * woke the agent — half the look-alike sentences tested. Giving it a few
 * thousand ordinary words to choose from instead (WAKE_DECOYS) lets it hear
 * what was actually said; the phrase stays one grammar entry, so said in
 * full it still wins.
 *
 * On top of that, a match must:
 * - have every word of the phrase heard with confidence (finals carry it);
 * - sit where the phrase belongs: the start phrase near the start of what
 *   was said, the end and cancel phrases with nothing confidently heard
 *   after them ("the cursor sent me somewhere else" is not "cursor send");
 * - for a partial result (start phrase only — it has no confidence), stay in
 *   the partial for SPOT_HOLD_MS of audio, since a look-alike usually turns
 *   into other words as more of it is heard.
 */

import { WAKE_DECOYS } from './wakeDecoys.js';
import { normalizeForWakeMatch } from './wakeWordMatch.js';

export type PhraseRole = 'start' | 'end' | 'cancel';

/** Partial results lack per-word confidence — enable them only at lower thresholds. */
export const WAKE_PARTIAL_MATCH_THRESHOLD = 0.55;
/** A partial match fires once it has held for this much audio. */
export const SPOT_HOLD_MS = 300;
/** Words heard at least this confidently count for "where the phrase sits"; below it they are breath and noise. */
export const SPOT_HEARD_CONFIDENCE = 0.7;
/** At most this many words may come before the start phrase ("okay so, hey squeaky"). */
export const SPOT_START_LEAD_WORDS = 3;

/** The grammar for one phrase: the phrase, its words, the decoys, and everything else unknown. */
export function spottingGrammar(phrase: string): string[] {
  const p = normalizeForWakeMatch(phrase) || phrase.trim().toLowerCase();
  const words = p.split(' ').filter(Boolean);
  return [p, ...new Set([...words, ...WAKE_DECOYS])].concat('[unk]');
}

export interface SpottingRule {
  role: PhraseRole;
  /** Every phrase word of a final result must be heard at least this confidently. */
  minConfidence: number;
  /** Also fire on partial results (start phrase only). */
  matchPartial: boolean;
  holdMs: number;
}

/**
 * The rule for a phrase. `threshold` is the wake-sensitivity setting
 * (settings.voice.wakeWords.wakeConfidenceThreshold, 0.15–0.85, shipped at
 * 0.45): lower is more sensitive. It moves the confidence needed around the
 * measured 0.7 and, below WAKE_PARTIAL_MATCH_THRESHOLD, lets the start phrase
 * fire on partial results for an instant cue.
 */
export function spottingRule(role: PhraseRole, threshold = 0.45): SpottingRule {
  const t = Math.min(1, Math.max(0, threshold));
  return {
    role,
    minConfidence: Math.min(0.95, Math.max(0.5, t + 0.25)),
    matchPartial: role === 'start' && t < WAKE_PARTIAL_MATCH_THRESHOLD,
    holdMs: SPOT_HOLD_MS,
  };
}

/** A word of a final Vosk result. */
export interface HeardWord {
  word: string;
  conf: number;
}

const UNKNOWN = '[unk]';

function findPhrase(words: readonly string[], phrase: readonly string[]): number {
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phrase.every((p, k) => words[i + k] === p)) return i;
  }
  return -1;
}

/**
 * Follows one recognizer's results and says when the phrase was heard.
 * Feed every partial and final result with how much audio had been fed by
 * then; `reset()` starts over (a new utterance, or after a match).
 */
export class PhraseDecision {
  readonly phrase: string;
  private readonly words: string[];
  /** Audio time the phrase first appeared in the running partial. */
  private since: number | null = null;

  constructor(phrase: string, readonly rule: SpottingRule) {
    this.phrase = normalizeForWakeMatch(phrase) || phrase.trim().toLowerCase();
    this.words = this.phrase.split(' ').filter(Boolean);
  }

  /** A partial result. True when the phrase has held in it for `holdMs`. */
  partial(text: string, audioMs: number): boolean {
    if (!this.rule.matchPartial || !this.words.length) return false;
    const heard = normalizeForWakeMatch(text.replaceAll(UNKNOWN, ' ')).split(' ').filter(Boolean);
    const i = findPhrase(heard, this.words);
    if (i < 0 || i > SPOT_START_LEAD_WORDS) {
      this.since = null;
      return false;
    }
    this.since ??= audioMs;
    return audioMs - this.since >= this.rule.holdMs;
  }

  /** A final result (with per-word confidence). True when it holds the phrase as the rule asks. */
  final(result: readonly HeardWord[]): boolean {
    this.since = null;
    if (!this.words.length) return false;
    const heard = result.map((w) => ({ word: w.word === UNKNOWN ? UNKNOWN : normalizeForWakeMatch(w.word), conf: w.conf }));
    const i = findPhrase(
      heard.map((w) => w.word),
      this.words,
    );
    if (i < 0) return false;
    const end = i + this.words.length;
    if (Math.min(...heard.slice(i, end).map((w) => w.conf)) < this.rule.minConfidence) return false;
    const confident = (ws: typeof heard) => ws.filter((w) => w.word !== UNKNOWN && w.conf >= SPOT_HEARD_CONFIDENCE).length;
    if (this.rule.role === 'start') return confident(heard.slice(0, i)) <= SPOT_START_LEAD_WORDS;
    // The end and cancel phrases close what was said.
    return confident(heard.slice(end)) === 0;
  }

  reset(): void {
    this.since = null;
  }
}
