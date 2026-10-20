/**
 * Short UI cues for the voice pipeline.
 *
 * Assets: web/public/sounds/*.mp3 (Kenney UI Audio, CC0 — see sounds/README.md).
 * Regenerate: bash scripts/prepare-voice-cues.sh
 *
 * Use playVoiceCueNow() at recognition time (Vosk / VAD) — must not await STT.
 */
import { CUE_FILENAME, VOICE_CUES, shouldPlayCue, type VoiceCue } from '@squeakr/client';
import { getSharedAudioContext, unlockAudioContext } from './audio.js';
import { applyElementSink, getFullLoudnessBus } from './audio-output.js';
import { currentLoudness } from './audio-prefs.js';

export type { VoiceCue };

/** Which cues exist and what they are called is shared — see cues.ts. */
const CUE_FILES: Record<VoiceCue, string> = Object.fromEntries(
  VOICE_CUES.map((cue) => [cue, `/sounds/${CUE_FILENAME[cue]}`]),
) as Record<VoiceCue, string>;

/** HTMLAudio volume cap (files are already boosted in prepare-voice-cues.sh). */
const PLAYBACK_VOLUME = 1;

const lastPlayedAt: Partial<Record<VoiceCue, number>> = {};
const audioEls = new Map<VoiceCue, HTMLAudioElement>();

function getOrCreateAudio(cue: VoiceCue): HTMLAudioElement {
  let el = audioEls.get(cue);
  if (!el) {
    el = new Audio(CUE_FILES[cue]);
    el.preload = 'auto';
    audioEls.set(cue, el);
  }
  return el;
}

function primeAudioElement(el: HTMLAudioElement): Promise<void> {
  return new Promise((resolve) => {
    if (el.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      resolve();
      return;
    }
    const done = () => resolve();
    el.addEventListener('canplaythrough', done, { once: true });
    el.addEventListener('error', done, { once: true });
    el.load();
  });
}

/** Preload after orb tap (user gesture). Keeps playVoiceCueNow() synchronous later. */
export async function preloadVoiceCues(): Promise<void> {
  try {
    await unlockAudioContext();
    await Promise.all(
      VOICE_CUES.map(async (cue) => {
        await primeAudioElement(getOrCreateAudio(cue));
      }),
    );
  } catch {
    // Best-effort — lazy load on first play.
  }
}

/**
 * Play immediately on recognition — no fetch/decode await.
 * Call from Vosk match / VAD speech-end handlers before STT flush.
 */
export function playVoiceCueNow(cue: VoiceCue, opts?: { force?: boolean }): void {
  try {
    const now = Date.now();
    if (!shouldPlayCue(lastPlayedAt[cue], now, opts)) return;
    lastPlayedAt[cue] = now;

    const el = getOrCreateAudio(cue);
    // Cues follow the loudness slider down, never up — the files are already loud.
    el.volume = PLAYBACK_VOLUME * currentLoudness().attenuation;
    applyElementSink(el);
    el.currentTime = 0;
    void el.play().catch(() => {
      // iOS may reject if context locked — retry after unlock.
      void unlockAudioContext().then(() => {
        el.currentTime = 0;
        void el.play().catch(() => undefined);
      });
    });
  } catch {
    // Never block voice pipeline.
  }
}

/** @deprecated Prefer playVoiceCueNow at recognition sites. */
export function playVoiceCue(cue: VoiceCue, opts?: { force?: boolean }): void {
  playVoiceCueNow(cue, opts);
}

/**
 * A short synthesized "ding" — the successful-connection indicator.
 *
 * Deliberately not a VoiceCue: it needs no mp3 asset and no shared-package
 * entry, just a two-note sine chime built on the shared AudioContext (already
 * unlocked by the orb-tap gesture before a session connects). Best-effort:
 * any audio failure is swallowed so it can never break the connect path.
 */
export function playConnectDing(): void {
  try {
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    // Bright upward chime: A5 -> E6.
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1318.5, now + 0.09);
    // Quick attack, gentle exponential decay (~0.35s).
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(gain).connect(getFullLoudnessBus());
    osc.start(now);
    osc.stop(now + 0.4);
  } catch {
    // Best-effort — a missing/blocked AudioContext must not break connecting.
  }
}

/**
 * A soft low blip when a session starts (orb pressed) — the counterpart to
 * playConnectDing(), which fires only once everything is connected and ready.
 * Best-effort, same as the ding.
 */
export function playStartBeep(): void {
  try {
    const ctx = getSharedAudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(392, now); // G4 — lower and softer than the ding
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
    osc.connect(gain).connect(getFullLoudnessBus());
    osc.start(now);
    osc.stop(now + 0.26);
  } catch {
    // Best-effort.
  }
}
