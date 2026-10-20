/**
 * Per-device audio preferences — which microphone and speaker to use, how
 * loud the agent is, and how fast it talks (docs/48).
 *
 * These belong to the device, not the bridge: a phone's Bluetooth headset is
 * meaningless to the laptop on the same bridge, and a speaker that needs a
 * boost on one device is deafening on another. So they live in localStorage
 * next to the browser voice profile, never in config.json.
 *
 * Every slider here is 0–100 with 50 as the default, so "middle" always means
 * "as shipped" and the mapping to real units lives in one tested place.
 */

export interface AudioPrefs {
  /** `MediaDeviceInfo.deviceId` of the chosen microphone; null = system default. */
  inputDeviceId: string | null;
  /** Label at the time it was chosen — used to find the device again if its id rotates. */
  inputLabel: string | null;
  /** `MediaDeviceInfo.deviceId` of the chosen speaker; null = system default. */
  outputDeviceId: string | null;
  outputLabel: string | null;
  /** Loudness slider, 0–100. 50 = unchanged, 0 = silent, 100 = maximum boost. */
  loudness: number;
  /** Speech speed slider, 0–100. 50 = unchanged, 0 = half speed, 100 = double. */
  speed: number;
}

export const SLIDER_DEFAULT = 50;

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  inputDeviceId: null,
  inputLabel: null,
  outputDeviceId: null,
  outputLabel: null,
  loudness: SLIDER_DEFAULT,
  speed: SLIDER_DEFAULT,
};

const STORAGE_KEY = 'sq-audio-prefs';

type Listener = (prefs: AudioPrefs) => void;
const listeners = new Set<Listener>();
let cached: AudioPrefs | null = null;

function clampSlider(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return SLIDER_DEFAULT;
  return Math.min(100, Math.max(0, n));
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Anything read back from storage is untrusted — normalize every field. */
export function normalizeAudioPrefs(raw: unknown): AudioPrefs {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    inputDeviceId: optionalString(r['inputDeviceId']),
    inputLabel: optionalString(r['inputLabel']),
    outputDeviceId: optionalString(r['outputDeviceId']),
    outputLabel: optionalString(r['outputLabel']),
    loudness: clampSlider(r['loudness'] ?? SLIDER_DEFAULT),
    speed: clampSlider(r['speed'] ?? SLIDER_DEFAULT),
  };
}

function readStore(): AudioPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return raw ? normalizeAudioPrefs(JSON.parse(raw)) : { ...DEFAULT_AUDIO_PREFS };
  } catch {
    // Private mode, blocked storage or a corrupt value — defaults still work.
    return { ...DEFAULT_AUDIO_PREFS };
  }
}

export function getAudioPrefs(): AudioPrefs {
  cached ??= readStore();
  return { ...cached };
}

export function updateAudioPrefs(patch: Partial<AudioPrefs>): AudioPrefs {
  const next = normalizeAudioPrefs({ ...getAudioPrefs(), ...patch });
  cached = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Still applies for this page load.
  }
  for (const fn of listeners) fn({ ...next });
  return { ...next };
}

/** Subscribe to changes, including ones made in another tab. Returns an unsubscribe. */
export function onAudioPrefsChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    cached = readStore();
    for (const fn of listeners) fn({ ...cached });
  });
}

/** Test hook — forget the in-memory copy so the next read hits storage. */
export function resetAudioPrefsCacheForTests(): void {
  cached = null;
  listeners.clear();
}

// ── Loudness ────────────────────────────────────────────────────────────────

/**
 * Highest boost the top of the slider reaches. Past about +12 dB the limiter
 * is doing all the work and speech turns to mush; this is the loudest that
 * still sounds like the voice.
 */
export const MAX_BOOST_DB = 12;

/**
 * Slider → linear gain. Below the middle it follows a square curve, which
 * sounds even to the ear (linear amplitude crowds all the change into the
 * last few steps). Above the middle it is linear in decibels up to
 * MAX_BOOST_DB. 0 is silent.
 */
export function loudnessToGain(slider: number): number {
  const s = clampSlider(slider);
  if (s <= 0) return 0;
  if (s < SLIDER_DEFAULT) return (s / SLIDER_DEFAULT) ** 2;
  const db = ((s - SLIDER_DEFAULT) / SLIDER_DEFAULT) * MAX_BOOST_DB;
  return 10 ** (db / 20);
}

/**
 * The same gain split by where it can be applied.
 *
 * `attenuation` (≤ 1) works everywhere, including speechSynthesis, whose
 * volume cannot go above 1. `boost` (≥ 1) needs Web Audio — a gain stage and
 * a limiter on the output bus — so only engines that play through the shared
 * AudioContext get it. Multiplying the two always gives loudnessToGain().
 */
export function splitLoudness(slider: number): { attenuation: number; boost: number } {
  const gain = loudnessToGain(slider);
  return { attenuation: Math.min(1, gain), boost: Math.max(1, gain) };
}

export function gainToDb(gain: number): number {
  return gain <= 0 ? -Infinity : 20 * Math.log10(gain);
}

export function loudnessLabel(slider: number): string {
  const s = clampSlider(slider);
  if (s <= 0) return 'Muted';
  if (Math.abs(s - SLIDER_DEFAULT) < 0.5) return 'Default';
  const db = gainToDb(loudnessToGain(s));
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`;
}

// ── Speech speed ────────────────────────────────────────────────────────────

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;

/** Slider → playback speed. Exponential so each side of the middle feels the same (½× … 1× … 2×). */
export function sliderToSpeed(slider: number): number {
  const s = clampSlider(slider);
  const speed = 2 ** ((s - SLIDER_DEFAULT) / SLIDER_DEFAULT);
  // Snap to exactly 1 near the middle so "default" really bypasses the stretcher.
  return Math.abs(speed - 1) < 0.005 ? 1 : speed;
}

export function speedToSlider(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return SLIDER_DEFAULT;
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  return clampSlider(SLIDER_DEFAULT + Math.log2(clamped) * SLIDER_DEFAULT);
}

export function speedLabel(slider: number): string {
  const speed = sliderToSpeed(slider);
  if (speed === 1) return 'Default (1×)';
  return `${speed.toFixed(2).replace(/0$/, '')}×`;
}

// ── Current values, for the playback paths ─────────────────────────────────

export function currentSpeechSpeed(): number {
  return sliderToSpeed(getAudioPrefs().speed);
}

export function currentLoudness(): { attenuation: number; boost: number } {
  return splitLoudness(getAudioPrefs().loudness);
}

// ── Wake word sensitivity ──────────────────────────────────────────────────

/**
 * The wake threshold is a minimum Vosk confidence; a slider reads better the
 * other way round — right is "hears me more easily". The middle is the
 * shipped 0.45; the ends stop short of 0 and 1, where Vosk either fires on
 * any noise or never fires at all.
 */
export const WAKE_DEFAULT_THRESHOLD = 0.45;
export const WAKE_MOST_SENSITIVE_THRESHOLD = 0.15;
export const WAKE_STRICTEST_THRESHOLD = 0.85;

export function wakeSensitivityToThreshold(slider: number): number {
  const s = clampSlider(slider);
  const t =
    s >= SLIDER_DEFAULT
      ? WAKE_DEFAULT_THRESHOLD -
        ((s - SLIDER_DEFAULT) / SLIDER_DEFAULT) * (WAKE_DEFAULT_THRESHOLD - WAKE_MOST_SENSITIVE_THRESHOLD)
      : WAKE_DEFAULT_THRESHOLD +
        ((SLIDER_DEFAULT - s) / SLIDER_DEFAULT) * (WAKE_STRICTEST_THRESHOLD - WAKE_DEFAULT_THRESHOLD);
  return Math.round(t * 1000) / 1000;
}

export function wakeThresholdToSensitivity(threshold: number): number {
  if (!Number.isFinite(threshold)) return SLIDER_DEFAULT;
  const t = Math.min(WAKE_STRICTEST_THRESHOLD, Math.max(WAKE_MOST_SENSITIVE_THRESHOLD, threshold));
  const s =
    t <= WAKE_DEFAULT_THRESHOLD
      ? SLIDER_DEFAULT +
        ((WAKE_DEFAULT_THRESHOLD - t) / (WAKE_DEFAULT_THRESHOLD - WAKE_MOST_SENSITIVE_THRESHOLD)) * SLIDER_DEFAULT
      : SLIDER_DEFAULT -
        ((t - WAKE_DEFAULT_THRESHOLD) / (WAKE_STRICTEST_THRESHOLD - WAKE_DEFAULT_THRESHOLD)) * SLIDER_DEFAULT;
  return Math.round(s);
}

export function wakeSensitivityLabel(slider: number): string {
  const s = clampSlider(slider);
  if (Math.abs(s - SLIDER_DEFAULT) < 0.5) return 'Default';
  if (s >= 85) return 'Very sensitive';
  if (s > SLIDER_DEFAULT) return 'Sensitive';
  if (s <= 15) return 'Very strict';
  return 'Strict';
}

// ── Devices ────────────────────────────────────────────────────────────────

export type AudioDeviceKind = 'bluetooth' | 'built-in' | 'headset' | 'usb' | 'external' | 'default';

/**
 * Best-effort guess at what a device is, from its label. Browsers expose no
 * transport type, but every platform puts it in the name ("AirPods",
 * "Bluetooth", "iPhone Microphone", "Built-in", "USB").
 */
export function classifyAudioDevice(label: string, deviceId = ''): AudioDeviceKind {
  if (deviceId === 'default' || deviceId === 'communications') return 'default';
  const l = label.toLowerCase();
  if (/bluetooth|airpods|beats|\bbt\b|hands-?free|a2dp|hfp|buds|galaxy buds|wh-1000|jabra|bose/.test(l)) {
    return 'bluetooth';
  }
  if (/usb/.test(l)) return 'usb';
  if (/headset|headphone|earpods|wired|3\.5|jack/.test(l)) return 'headset';
  if (/built-?in|internal|iphone|ipad|phone|speakerphone|macbook|laptop|integrated|front|bottom|back|earpiece/.test(l)) {
    return 'built-in';
  }
  return 'external';
}

export interface DeviceLike {
  deviceId: string;
  label: string;
}

/**
 * Find the remembered device in a fresh list. Ids are stable per origin in
 * Chrome but Safari rotates them, so fall back to the label, then give up
 * (null = use the system default) rather than pinning a device that is gone.
 */
export function matchRememberedDevice<T extends DeviceLike>(
  devices: readonly T[],
  id: string | null,
  label: string | null,
): T | null {
  if (id) {
    const byId = devices.find((d) => d.deviceId === id);
    if (byId) return byId;
  }
  if (label) {
    const byLabel = devices.find((d) => d.label === label);
    if (byLabel) return byLabel;
  }
  return null;
}
