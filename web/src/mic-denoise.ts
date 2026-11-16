/**
 * The main interface's microphone noise suppressor.
 *
 * Discord calls are denoised per speaker in the bridge (src/channels/denoise.ts,
 * docs/50). The PWA could not use that: its wake phrase is spotted by Vosk in
 * the browser, so the audio has to be cleaned before it leaves the page. This
 * runs the same RNNoise build through a small audio graph and hands every
 * consumer of the mic — the wake, end and cancel spotters, server STT and the
 * direct audio stream — one shared denoised stream.
 *
 * One suppressor per microphone, for the whole session: RNNoise learns the
 * room as it goes. The graph is built lazily, after a user gesture, and every
 * failure falls back to the raw microphone rather than breaking wake words.
 *
 * The browser's own `noiseSuppression` constraint stays on (audio.ts). This is
 * a 40 % mix, not full replacement, so the two do not fight; and WebKit STT
 * cannot take a processed stream, so it still needs the browser's filter.
 */

import { getSharedAudioContext } from './audio.js';
import { DENOISE_RATE, StreamDenoiser, type RnnoiseModule } from './rnnoise-dsp.js';

/** Where the build copies `@jitsi/rnnoise-wasm`'s inlined-WASM module (angular.json). */
const DENOISE_MODULE_PATH = 'rnnoise/rnnoise-sync.js';
/** 1024 frames ≈ 21 ms at 48 kHz — small enough for wake words, few wakeups. */
const PROCESSOR_FRAMES = 1024;

let loading: Promise<RnnoiseModule | null> | null = null;

/**
 * Load the RNNoise module once. It is an optional dependency: when it is not
 * installed (or the browser blocks the chunk), the caller keeps raw audio.
 */
export function loadRnnoise(): Promise<RnnoiseModule | null> {
  loading ??= (async () => {
    try {
      // Resolved at runtime: the module is copied verbatim as an asset, not
      // bundled, because it carries its WASM inline (≈1.9 MB).
      const url = new URL(DENOISE_MODULE_PATH, document.baseURI).href;
      const mod = (await import(/* webpackIgnore: true */ url)) as {
        default: () => RnnoiseModule;
      };
      const rn = mod.default();
      console.info('[denoise] microphone noise suppression ready (RNNoise)');
      return rn;
    } catch (err) {
      console.info('[denoise] RNNoise unavailable — microphone audio is unfiltered', err);
      return null;
    }
  })();
  return loading;
}

/** Start loading the suppressor without building a graph — call during idle. */
export function preloadDenoiser(): Promise<RnnoiseModule | null> {
  return loadRnnoise();
}

interface DenoisedMic {
  readonly source: MediaStream;
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly ownsContext: boolean;
  readonly node: MediaStreamAudioSourceNode;
  readonly processor: ScriptProcessorNode;
  readonly destination: MediaStreamAudioDestinationNode;
  readonly denoiser: StreamDenoiser;
  /** An exception in the callback retires the suppressor; audio passes through. */
  failed: boolean;
}

const active = new WeakMap<MediaStream, DenoisedMic>();
const starting = new WeakMap<MediaStream, Promise<MediaStream | null>>();

/**
 * A denoised copy of `mic`, or null when RNNoise is unavailable. The result is
 * cached per microphone: every wake spotter and STT session shares one
 * suppressor and one room model.
 */
export function startMicDenoise(mic: MediaStream): Promise<MediaStream | null> {
  const existing = active.get(mic);
  if (existing) return Promise.resolve(existing.stream);
  const pending = starting.get(mic);
  if (pending) return pending;

  const started = createDenoisedMic(mic)
    .then((denoised) => {
      if (denoised) active.set(mic, denoised);
      return denoised?.stream ?? null;
    })
    .finally(() => starting.delete(mic));
  starting.set(mic, started);
  return started;
}

/** Tear down a microphone's suppressor and its processed track. */
export function stopMicDenoise(mic: MediaStream): void {
  const denoised = active.get(mic);
  if (!denoised) return;
  active.delete(mic);
  try {
    denoised.processor.onaudioprocess = null;
    denoised.node.disconnect();
    denoised.processor.disconnect();
    denoised.destination.disconnect();
  } catch {
    // Already torn down.
  }
  denoised.denoiser.close();
  for (const track of denoised.stream.getAudioTracks()) track.stop();
  if (denoised.ownsContext) void denoised.context.close().catch(() => undefined);
}

async function createDenoisedMic(mic: MediaStream): Promise<DenoisedMic | null> {
  const rn = await loadRnnoise();
  if (!rn || typeof AudioContext === 'undefined') return null;

  let context = getSharedAudioContext();
  let ownsContext = false;
  if (context.sampleRate !== DENOISE_RATE) {
    // RNNoise only makes sense at 48 kHz. Most devices already run there; the
    // rest get one small graph at the rate it expects, and the browser resamples
    // the track on the way in and out.
    try {
      context = new AudioContext({ sampleRate: DENOISE_RATE });
      ownsContext = true;
    } catch {
      return null;
    }
  }
  if (context.state === 'suspended') {
    try {
      await context.resume();
    } catch {
      if (ownsContext) void context.close().catch(() => undefined);
      return null;
    }
  }
  if (context.state !== 'running') {
    if (ownsContext) void context.close().catch(() => undefined);
    return null;
  }

  let denoiser: StreamDenoiser;
  try {
    denoiser = new StreamDenoiser(rn);
  } catch {
    if (ownsContext) void context.close().catch(() => undefined);
    return null;
  }

  let node: MediaStreamAudioSourceNode;
  let processor: ScriptProcessorNode;
  let destination: MediaStreamAudioDestinationNode;
  try {
    node = context.createMediaStreamSource(mic);
    processor = context.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
    destination = context.createMediaStreamDestination();
  } catch {
    denoiser.close();
    if (ownsContext) void context.close().catch(() => undefined);
    return null;
  }

  const entry: DenoisedMic = {
    source: mic,
    stream: new MediaStream(destination.stream.getAudioTracks()),
    context,
    ownsContext,
    node,
    processor,
    destination,
    denoiser,
    failed: false,
  };

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = event.outputBuffer.getChannelData(0);
    if (entry.failed) {
      output.set(input);
      return;
    }
    try {
      entry.denoiser.process(input, output);
    } catch (err) {
      // Never silence the microphone because the suppressor broke: pass the
      // original through and stop paying for it.
      entry.failed = true;
      console.warn('[denoise] suppressor failed — passing microphone audio through', err);
      output.set(input);
    }
  };

  node.connect(processor);
  processor.connect(destination);
  return entry;
}
