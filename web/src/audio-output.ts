/**
 * Where the agent's voice comes out, and how loud (docs/49).
 *
 * One output bus on the shared AudioContext:
 *
 *   full (attenuation) → boost (gain ≥ 1) → limiter → make-up trim → speaker
 *
 * Engines that already apply the attenuation themselves (server speech gets
 * it as the TTS pile's base volume, alongside speechSynthesis) connect to
 * `getOutputBus()`, the boost stage. Anything else — connect chimes, agent
 * audio streams — connects to `getFullLoudnessBus()` and gets the whole
 * loudness setting from the bus.
 *
 * The limiter is what makes boosting safe: a +12 dB gain on speech that is
 * already near full scale would otherwise hard-clip into crackle. Below the
 * default it is transparent (ratio 1).
 *
 * The speaker is chosen on the context itself (`AudioContext.setSinkId`,
 * Chromium) and on media elements (`HTMLMediaElement.setSinkId`, Chromium and
 * Firefox). Safari — every iOS browser — has neither: there the system routes
 * audio, and the settings page says so instead of offering a dead picker.
 */

import { getSharedAudioContext, peekSharedAudioContext } from './audio.js';
import { getAudioPrefs, onAudioPrefsChange, splitLoudness, type AudioPrefs } from './audio-prefs.js';

export interface LimiterSettings {
  threshold: number;
  knee: number;
  ratio: number;
  attack: number;
  release: number;
  /**
   * Linear trim after the compressor. Web Audio's DynamicsCompressorNode adds
   * automatic make-up gain ((1 / full-range gain) ^ 0.6, per the spec), which
   * would push the limited signal straight back over full scale; this undoes it.
   */
  makeupTrim: number;
}

/** Limiter for a given boost — transparent at or below 1, a hard brick-wall above. */
export function limiterSettingsFor(boost: number): LimiterSettings {
  if (!(boost > 1)) {
    return { threshold: 0, knee: 0, ratio: 1, attack: 0.003, release: 0.25, makeupTrim: 1 };
  }
  const threshold = -3;
  const ratio = 20;
  // Gain the compression curve applies to a full-scale (0 dBFS) input, knee 0.
  const fullRangeDb = threshold + (0 - threshold) / ratio;
  const fullRangeGain = 10 ** (fullRangeDb / 20);
  const makeup = (1 / fullRangeGain) ** 0.6;
  return { threshold, knee: 0, ratio, attack: 0.001, release: 0.15, makeupTrim: 1 / makeup };
}

interface OutputBus {
  ctx: AudioContext;
  full: GainNode;
  boost: GainNode;
  limiter: DynamicsCompressorNode;
  trim: GainNode;
}

let bus: OutputBus | null = null;
let appliedSink: string | null = null;

function buildBus(ctx: AudioContext): OutputBus {
  const full = ctx.createGain();
  const boost = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const trim = ctx.createGain();
  full.connect(boost);
  boost.connect(limiter);
  limiter.connect(trim);
  trim.connect(ctx.destination);
  const built = { ctx, full, boost, limiter, trim };
  applyLevels(built, getAudioPrefs(), true);
  return built;
}

function setParam(param: AudioParam, value: number, ctx: AudioContext, immediate: boolean): void {
  if (immediate) {
    param.value = value;
    return;
  }
  // A short glide so dragging the slider during speech does not click.
  param.cancelScheduledValues(ctx.currentTime);
  param.setTargetAtTime(value, ctx.currentTime, 0.03);
}

function applyLevels(b: OutputBus, prefs: AudioPrefs, immediate = false): void {
  const { attenuation, boost } = splitLoudness(prefs.loudness);
  const lim = limiterSettingsFor(boost);
  setParam(b.full.gain, attenuation, b.ctx, immediate);
  setParam(b.boost.gain, boost, b.ctx, immediate);
  b.limiter.threshold.value = lim.threshold;
  b.limiter.knee.value = lim.knee;
  b.limiter.ratio.value = lim.ratio;
  b.limiter.attack.value = lim.attack;
  b.limiter.release.value = lim.release;
  setParam(b.trim.gain, lim.makeupTrim, b.ctx, immediate);
}

function ensureBus(): OutputBus {
  const ctx = getSharedAudioContext();
  if (!bus || bus.ctx !== ctx) {
    bus = buildBus(ctx);
    void applyContextSink(ctx, getAudioPrefs().outputDeviceId);
  }
  return bus;
}

/** Boost stage — for engines that already applied the attenuation (server speech). */
export function getOutputBus(): AudioNode {
  return ensureBus().boost;
}

/** Whole loudness setting — for sounds that have no volume of their own. */
export function getFullLoudnessBus(): AudioNode {
  return ensureBus().full;
}

// ── Speaker selection ──────────────────────────────────────────────────────

type SinkCapable = { setSinkId?: (id: string | { type: 'none' }) => Promise<void> };

export interface OutputSelectionSupport {
  /** Web Audio can be pointed at a device (Chromium 110+). */
  context: boolean;
  /** <audio> elements can (Chromium, Firefox 116+). */
  element: boolean;
  /** Firefox lists speakers only through its own chooser prompt. */
  chooser: boolean;
}

export function outputSelectionSupport(): OutputSelectionSupport {
  const ctxProto = typeof AudioContext === 'undefined' ? null : (AudioContext.prototype as SinkCapable);
  const elProto =
    typeof HTMLMediaElement === 'undefined' ? null : (HTMLMediaElement.prototype as SinkCapable);
  const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  return {
    context: typeof ctxProto?.setSinkId === 'function',
    element: typeof elProto?.setSinkId === 'function',
    chooser: typeof (md as { selectAudioOutput?: unknown } | undefined)?.selectAudioOutput === 'function',
  };
}

async function applyContextSink(ctx: AudioContext, deviceId: string | null): Promise<void> {
  const target = deviceId ?? '';
  if (appliedSink === target) return;
  const sinkCtx = ctx as unknown as SinkCapable;
  if (typeof sinkCtx.setSinkId !== 'function') return;
  try {
    await sinkCtx.setSinkId(target);
    appliedSink = target;
  } catch (err) {
    // A device that disappeared: fall back to the default, not to silence.
    console.warn('[audio-output] could not switch speaker', err);
    if (target) {
      try {
        await sinkCtx.setSinkId('');
        appliedSink = '';
      } catch {
        // leave as is
      }
    }
  }
}

/** Point an <audio> element at the chosen speaker (no-op where unsupported). */
export function applyElementSink(el: HTMLMediaElement): void {
  const id = getAudioPrefs().outputDeviceId;
  const sinkEl = el as unknown as SinkCapable;
  if (!id || typeof sinkEl.setSinkId !== 'function') return;
  sinkEl.setSinkId(id).catch(() => undefined);
}

/** Firefox: ask the browser's own speaker chooser. Resolves to the picked device or null. */
export async function chooseOutputWithBrowserPrompt(): Promise<MediaDeviceInfo | null> {
  const md = navigator.mediaDevices as MediaDevices & {
    selectAudioOutput?: (opts?: { deviceId?: string }) => Promise<MediaDeviceInfo>;
  };
  if (typeof md.selectAudioOutput !== 'function') return null;
  try {
    return await md.selectAudioOutput();
  } catch {
    return null;
  }
}

// Follow the settings page live: levels glide, the speaker switches.
onAudioPrefsChange((prefs) => {
  if (bus) applyLevels(bus, prefs);
  // The sink is context-wide, so it also moves audio that bypasses the bus.
  const ctx = bus?.ctx ?? peekSharedAudioContext();
  if (ctx) void applyContextSink(ctx, prefs.outputDeviceId);
});

// ── Device lists ───────────────────────────────────────────────────────────

export interface AudioDeviceLists {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  /** False until the site has microphone permission — labels are blank before that. */
  labelled: boolean;
}

export async function listAudioDevices(): Promise<AudioDeviceLists> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [], labelled: false };
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === 'audioinput');
  const outputs = all.filter((d) => d.kind === 'audiooutput');
  return { inputs, outputs, labelled: inputs.some((d) => d.label.length > 0) };
}

/** Plug-in / unplug / Bluetooth connect. Returns an unsubscribe. */
export function onAudioDevicesChange(fn: () => void): () => void {
  const md = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
  if (!md?.addEventListener) return () => undefined;
  md.addEventListener('devicechange', fn);
  return () => md.removeEventListener('devicechange', fn);
}
