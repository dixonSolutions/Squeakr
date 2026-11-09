/**
 * When speech on a call becomes a request — the web app's voice session rules
 * (web/src/llm-intelligence-session.ts), driven by the same server settings
 * (`settings.voice`, the Voice tab) and applied to what the call transcribed.
 *
 *   inputMode `stream`  every segment is a request; wake words do not apply
 *                       (the phone's direct stream ignores them too).
 *   inputMode `turns`   wakeWordsEnabled:
 *                         the start phrase opens a capture; anything else is
 *                         room talk and is not sent. "hey squeaker, run the
 *                         tests" is a request; "hey squeaker" alone opens the
 *                         capture for what is said next.
 *                       wake words off: every utterance is a request (the
 *                         phone waits for a tap on Speak; a call has no screen).
 *                       The request ends —
 *                         VAD on (turnSubmit.vadEnabled): at the pause that
 *                           ended the segment (turnSubmit.silenceMs of quiet);
 *                         VAD off: at the end phrase ("send"), or with no end
 *                           phrase, after turnSubmit.silenceMs with nothing new.
 *                       The cancel phrase drops the capture (wake words on).
 *
 * The phone spots phrases with Vosk on the raw audio. A call does too, for
 * the start phrase (wakeSpotter.ts → `open()`), so the capture opens while the
 * phrase is said; the rest is matched in the server transcript with the same
 * normalisation.
 */

import { normalizeForWakeMatch } from '../realtime/wakeWordMatch.js';

export interface CallTurnSettings {
  inputMode: 'turns' | 'stream';
  wakeWordsEnabled: boolean;
  wakeWords: { start: string; end?: string; cancel?: string; wakeConfidenceThreshold?: number };
  turnSubmit: { silenceMs: number; vadEnabled?: boolean };
}

export type TurnVerdict =
  | { action: 'deliver'; text: string }
  /** The start phrase opened a capture; nothing to send yet. */
  | { action: 'armed' }
  /** Held in the capture until the end phrase or the silence timer. */
  | { action: 'buffered'; text: string }
  | { action: 'cancel' }
  /** Not addressed to the agent (wake words on, no start phrase). */
  | { action: 'ignore' };

/** A start phrase with nothing after it waits this long for the request. */
export const ARMED_MS = 10_000;

const words = (s: string) => normalizeForWakeMatch(s).split(' ').filter(Boolean);

/** Where `phrase` occurs in `original` (word indices), compared normalised. */
function find(original: string[], phrase: string[]): { start: number; end: number } | null {
  if (!phrase.length) return null;
  const norm = original.map((w) => normalizeForWakeMatch(w));
  for (let i = 0; i + phrase.length <= norm.length; i++) {
    if (phrase.every((p, j) => norm[i + j] === p)) return { start: i, end: i + phrase.length };
  }
  return null;
}

/** Edit distance, for a start phrase the transcript spelled differently than Vosk heard it. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return row[b.length]!;
}

/** How far (edits per letter) the transcript's copy of the start phrase may stray. */
export const CONFIRM_DISTANCE = 0.2;

/**
 * Whether the transcript of an utterance the audio spotter fired on really
 * holds the start phrase, and where it ends. The spotter can still be fooled
 * by a close look-alike ("he squeezed the lemon", "hey sweetie, dinner is
 * ready") that the transcript then spells right (docs/50), so a spotted
 * capture is confirmed here before anything is delivered.
 *
 * The phrase must open the utterance — after at most two lead-in words
 * ("okay, hey squeaky, …") — spelled within CONFIRM_DISTANCE and starting
 * with the phrase's first letter, however the words are split ("Hay
 * squeaky", "heysqueaky"; not "a squeaky clean kitchen"). A short utterance
 * (the phrase and up to two words more) that does not match is the phrase
 * said on its own, which transcripts mangle most ("Hell is squeaky"): the
 * speaker heard the cue and says the request next, so the capture stays
 * open — but none of its words are delivered.
 *
 * Returns how many words to cut, or null when the spotter was wrong.
 */
export function confirmSpotted(original: string[], phrase: string[], maxDistance = CONFIRM_DISTANCE): number | null {
  const n = phrase.length;
  if (!n) return null;
  const norm = original.map((w) => normalizeForWakeMatch(w));
  const target = phrase.join('');
  let best: { d: number; end: number } | null = null;
  for (let i = 0; i <= Math.min(2, norm.length - 1); i++) {
    for (let len = Math.max(1, n - 1); len <= n + 1 && i + len <= norm.length; len++) {
      const said = norm.slice(i, i + len).join('');
      if (said[0] !== target[0]) continue;
      const d = distance(said, target) / target.length;
      if (!best || d < best.d) best = { d, end: i + len };
    }
  }
  if (best && best.d <= maxDistance) return best.end;
  if (original.length <= n + 2) return original.length;
  return null;
}

const tidy = (ws: string[]) => ws.join(' ').replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/g, '');

/** How to talk to a call with these settings, in one spoken sentence (empty when anything goes). */
export function howToTalk(t: CallTurnSettings): string {
  if (t.inputMode === 'stream') return '';
  const wake = t.wakeWordsEnabled && t.wakeWords.start.trim();
  const end = t.turnSubmit.vadEnabled === false && wake ? (t.wakeWords.end ?? '').trim() : '';
  if (!wake) return '';
  return `Say ${t.wakeWords.start.trim()} before each request${end ? `, and ${end} when you are done` : ''}.`;
}

export class CallTurns {
  private openedAt: number | null = null;
  private readonly held: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  /** The spotter heard the start phrase; the next transcript is the utterance it was in. */
  private spotted = false;

  constructor(
    readonly settings: CallTurnSettings,
    /** A capture the silence timer ended (VAD off, no end phrase). */
    private readonly onTimedSubmit: (text: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  get wakeWords(): boolean {
    return this.settings.inputMode === 'turns' && this.settings.wakeWordsEnabled && words(this.settings.wakeWords.start).length > 0;
  }

  get vad(): boolean {
    return this.settings.turnSubmit.vadEnabled !== false;
  }

  /** The end phrase submits only with VAD off and wake words on — as on the phone. */
  private get endPhrase(): string[] {
    return !this.vad && this.wakeWords ? words(this.settings.wakeWords.end ?? '') : [];
  }

  private get capturing(): boolean {
    if (!this.wakeWords) return true;
    if (this.openedAt === null) return false;
    // An opened capture with nothing in it lapses; one that holds words waits for its end.
    if (!this.held.length && this.now() - this.openedAt > ARMED_MS) this.openedAt = null;
    return this.openedAt !== null;
  }

  /**
   * The start phrase was heard on the audio itself (wakeSpotter.ts), before
   * any transcript: open the capture now. The transcript that follows is the
   * same utterance — its copy of the phrase is cut, even misspelled.
   */
  open(): void {
    if (!this.wakeWords) return;
    this.reset();
    this.openedAt = this.now();
    this.spotted = true;
  }

  feed(text: string): TurnVerdict {
    if (this.settings.inputMode === 'stream') return text.trim() ? { action: 'deliver', text: text.trim() } : { action: 'ignore' };
    let ws = text.split(/\s+/).filter(Boolean);
    const spotted = this.spotted;
    this.spotted = false;

    if (this.wakeWords) {
      const phrase = words(this.settings.wakeWords.start);
      const start = find(ws, phrase);
      if (start) {
        this.reset();
        this.openedAt = this.now();
        ws = ws.slice(start.end);
      } else if (spotted && this.capturing) {
        const cut = confirmSpotted(ws, phrase);
        if (cut === null) {
          // The spotter heard a look-alike: this was not addressed to the agent.
          this.reset();
          return { action: 'ignore' };
        }
        ws = ws.slice(cut);
      } else if (!this.capturing) {
        return { action: 'ignore' };
      }
      const cancel = words(this.settings.wakeWords.cancel ?? '');
      if (cancel.length && find(ws, cancel)) {
        this.reset();
        return { action: 'cancel' };
      }
    }

    const end = this.endPhrase;
    if (end.length) {
      const hit = find(ws, end);
      if (hit) return this.submit(tidy(ws.slice(0, hit.start)));
      return this.hold(ws, false);
    }
    if (this.vad) return this.submit(tidy(ws));
    return this.hold(ws, true);
  }

  dispose(): void {
    this.reset();
  }

  private hold(ws: string[], timed: boolean): TurnVerdict {
    const piece = tidy(ws);
    if (piece) this.held.push(piece);
    if (timed && this.held.length) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const out = this.held.join(' ');
        this.reset();
        if (out) this.onTimedSubmit(out);
      }, this.settings.turnSubmit.silenceMs);
    }
    if (!this.held.length) return { action: 'armed' };
    return { action: 'buffered', text: this.held.join(' ') };
  }

  private submit(last: string): TurnVerdict {
    const out = [...this.held, last].filter(Boolean).join(' ');
    const wasOpen = this.openedAt !== null;
    this.reset();
    if (out) return { action: 'deliver', text: out };
    // The start phrase alone: keep the capture open for what comes next.
    if (this.wakeWords && wasOpen) {
      this.openedAt = this.now();
      return { action: 'armed' };
    }
    return { action: 'ignore' };
  }

  private reset(): void {
    this.spotted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.held.length = 0;
    this.openedAt = null;
  }
}
