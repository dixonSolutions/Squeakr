#!/usr/bin/env node
/**
 * Virtual-microphone stress test for the PWA's wake words and RNNoise.
 *
 * There is no physical microphone here: Chromium's fake capture device plays a
 * WAV built from the committed wake corpus (`docs/data/wake-bench`) mixed with
 * the bench's synthetic noises, at several SNRs, loudness settings and
 * distortions. The production PWA runs against a throwaway bridge, so the
 * page's own path is exercised: getUserMedia → browser DSP → RNNoise (or the
 * raw stream when the asset is blocked) → the Vosk wake/end spotters →
 * server STT → stub agent → re-arm for the next wake phrase.
 *
 * Each WAV has three wake → command → "cursor send" rounds. A case passes if
 * the orb reaches `listening` and the turn is delivered; negatives (noise or
 * other talk only) count false wakes.
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
 *     node --import tsx scripts/live-pwa-wake-denoise.mts [--only fan-0] [--listen 22]
 *
 * Build first: npm run build. The real Vosk model is needed at ./vosk/model.tar.gz.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { activeRms, audio, manifest, noises } from '../.claude/skills/wake-noise-bench/scripts/lib.mjs';
import { createInstance, makeReporter, ROOT } from './e2e-harness.mjs';

const RATE = 48_000;
const report = makeReporter();
const { say, check, fail } = report;
const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const ONLY = arg('only', '');
const LISTEN_MS = Number(arg('listen', '24')) * 1000;
const MODES = arg('modes', 'on,off').split(',') as Array<'on' | 'off'>;
const OUT_FILE = arg('results', '');
const ONLY_CASES = arg('cases', '').split(',').filter(Boolean);
const BROWSER_NS = arg('browser-ns', 'on') as 'on' | 'off';
const ALL_CASES = process.argv.includes('--all');
const USE_VAD = process.argv.includes('--vad');

type NoiseName = 'fan' | 'vacuum' | 'music' | 'babble' | 'blanket' | 'mouse' | 'keyboard' | 'siren' | 'traffic' | 'hammer';
type Condition = 'normal' | 'quiet' | 'loud' | 'soft' | 'hard' | 'telephone' | 'bitcrush';
type Kind = 'positive' | 'talk' | 'noise';

interface Case {
  name: string;
  kind: Kind;
  noise: NoiseName | null;
  snr: number | null;
  condition: Condition;
  /** Run this one in the raw (denoise off) comparison too. */
  ab?: boolean;
  /** Beyond the bench's harsh set: report the result, do not fail on it. */
  limit?: boolean;
}

/** The shipped-path matrix: every noise, an SNR sweep, loudness, clipping and colour. */
const CASES: Case[] = [
  { name: 'clean', kind: 'positive', noise: null, snr: null, condition: 'normal', ab: true },
  { name: 'fan-10', kind: 'positive', noise: 'fan', snr: 10, condition: 'normal' },
  { name: 'fan-0', kind: 'positive', noise: 'fan', snr: 0, condition: 'normal', ab: true },
  { name: 'fan--5', kind: 'positive', noise: 'fan', snr: -5, condition: 'normal' },
  { name: 'vacuum-0', kind: 'positive', noise: 'vacuum', snr: 0, condition: 'normal', ab: true },
  { name: 'music-0', kind: 'positive', noise: 'music', snr: 0, condition: 'normal', ab: true },
  { name: 'babble-0', kind: 'positive', noise: 'babble', snr: 0, condition: 'normal', ab: true, limit: true },
  { name: 'blanket-0', kind: 'positive', noise: 'blanket', snr: 0, condition: 'normal', ab: true },
  { name: 'fan-0-quiet', kind: 'positive', noise: 'fan', snr: 0, condition: 'quiet' },
  { name: 'fan-0-loud', kind: 'positive', noise: 'fan', snr: 0, condition: 'loud' },
  { name: 'fan-0-soft', kind: 'positive', noise: 'fan', snr: 0, condition: 'soft' },
  { name: 'fan-0-hard', kind: 'positive', noise: 'fan', snr: 0, condition: 'hard', ab: true },
  { name: 'fan-0-phone', kind: 'positive', noise: 'fan', snr: 0, condition: 'telephone' },
  { name: 'fan-0-crush', kind: 'positive', noise: 'fan', snr: 0, condition: 'bitcrush' },
  { name: 'blanket--5-hard', kind: 'positive', noise: 'blanket', snr: -5, condition: 'hard', ab: true, limit: true },
  { name: 'noise-fan', kind: 'noise', noise: 'fan', snr: 0, condition: 'normal', ab: true },
  { name: 'noise-babble', kind: 'noise', noise: 'babble', snr: 0, condition: 'normal' },
  { name: 'noise-blanket', kind: 'noise', noise: 'blanket', snr: 0, condition: 'normal', ab: true },
  { name: 'talk-fan', kind: 'talk', noise: 'fan', snr: 0, condition: 'normal', ab: true },
  { name: 'talk-babble-hard', kind: 'talk', noise: 'babble', snr: 0, condition: 'hard', ab: true },
  { name: 'talk-blanket-phone', kind: 'talk', noise: 'blanket', snr: 0, condition: 'telephone' },
];

interface Clip {
  id: string;
  text: string;
  form?: string | null;
  phrase?: string | null;
  kind?: string | null;
  split?: string | null;
  voice: string;
}

const clips = manifest() as Clip[];
const wakeClips = clips.filter((c) => c.kind === 'pos' && c.form === 'alone' && c.phrase === 'hey squeaky' && c.split === 'dev');
const endClips = clips.filter((c) => c.kind === 'pos' && c.form === 'alone' && c.phrase === 'cursor send' && c.split === 'dev');
const commandClips = clips.filter((c) => (c as { set?: string }).set === 'commands');
if (wakeClips.length < 3 || endClips.length < 3 || commandClips.length < 3) {
  throw new Error('wake-bench corpus is missing the clips this test needs');
}

const N = noises();

const clamp = (v: number, lo = -0.98, hi = 0.98) => Math.max(lo, Math.min(hi, v));

function biquad(x: Float32Array, type: 'lp' | 'hp', f0: number, Q = 0.707): Float32Array {
  const w = (2 * Math.PI * f0) / RATE;
  const a = Math.sin(w) / (2 * Q);
  const c = Math.cos(w);
  const [b0, b1, b2] = type === 'lp' ? [(1 - c) / 2, 1 - c, (1 - c) / 2] : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  const a0 = 1 + a;
  const a1 = -2 * c;
  const a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i]! + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** Loudness and distortion after the speech/noise mix, before the 16-bit write. */
function condition(x: Float32Array, kind: Condition): Float32Array {
  const y = new Float32Array(x.length);
  let gain = 1;
  if (kind === 'quiet') gain = 10 ** (-18 / 20);
  if (kind === 'loud') gain = 10 ** (12 / 20);
  for (let i = 0; i < x.length; i++) {
    let v = x[i]!;
    if (kind === 'soft') v = Math.tanh(v * 3) / Math.tanh(3);
    else if (kind === 'hard') v = clamp(v * 4, -0.4, 0.4) * 2.2;
    else if (kind === 'bitcrush') {
      v = Math.round(v * 16) / 16; // 5-bit
    }
    y[i] = v * gain;
  }
  if (kind === 'telephone') {
    const hp = biquad(y, 'hp', 300);
    const lp = biquad(hp, 'lp', 3400);
    for (let i = 0; i < lp.length; i++) y[i] = Math.tanh(lp[i]! * 1.6) / Math.tanh(1.6);
  } else if (kind === 'hard' || kind === 'loud') {
    for (let i = 0; i < y.length; i++) y[i] = clamp(y[i]!, -0.95, 0.95);
  }
  return y;
}

function writeWav(path: string, x: Float32Array): void {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    data.writeInt16LE(Math.round(clamp(x[i]!) * 32_767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

/**
 * Three rounds of wake → command → end phrase, at fixed starts. The fake
 * device loops the file, so the PWA catches rounds whatever moment it starts
 * listening. Negatives keep the same timing but omit the wake phrase (talk) or
 * all speech (noise).
 */
function buildCase(c: Case, wavPath: string): void {
  const starts = [1.5, 9.0, 16.5];
  const segments: Array<{ at: number; x: Float32Array }> = [];
  starts.forEach((start, k) => {
    const wake = wakeClips[k % wakeClips.length]!;
    const cmd = commandClips[k % commandClips.length]!;
    const end = endClips[k % endClips.length]!;
    let at = start;
    if (c.kind === 'positive') {
      const x = audio(wake as never);
      segments.push({ at, x });
      at += x.length / RATE + 0.35;
    }
    if (c.kind !== 'noise') {
      const x = audio(cmd as never);
      segments.push({ at, x });
      at += x.length / RATE + 0.35;
      const e = audio(end as never);
      segments.push({ at, x: e });
    }
  });

  const last = segments.reduce((m, s) => Math.max(m, s.at + s.x.length / RATE), 4);
  const total = Math.ceil((last + 2.5) * RATE);
  const out = new Float32Array(total);
  const speechRms = activeRms(Float32Array.from(segments.flatMap((s) => Array.from(s.x)))) || 0.05;

  if (c.noise) {
    const noise = N[c.noise]!;
    const gain = c.snr === null ? 0.5 : speechRms / 10 ** (c.snr / 20) / 0.1;
    for (let i = 0; i < total; i++) out[i] = noise[i % noise.length]! * gain;
  }
  for (const s of segments) {
    const at = Math.round(s.at * RATE);
    for (let i = 0; i < s.x.length && at + i < total; i++) out[at + i] = out[at + i]! + s.x[i]!;
  }
  // A limiter keeps the mix below clipping before the deliberate distortions.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0.95) for (let i = 0; i < out.length; i++) out[i] = out[i]! * (0.95 / peak);
  writeWav(wavPath, condition(out, c.condition));
}

async function loadPlaywright() {
  const explicit = process.env.PLAYWRIGHT_MODULE;
  try {
    const mod = explicit ? await import(pathToFileURL(join(explicit, 'index.mjs')).href) : await import('playwright');
    return (mod as { chromium?: unknown; default?: { chromium?: unknown } }).chromium ??
      (mod as { default?: { chromium?: unknown } }).default?.chromium;
  } catch (err) {
    console.error(
      'Playwright not found — set PLAYWRIGHT_MODULE to a playwright package directory, or install it. ' +
        (err instanceof Error ? err.message : ''),
    );
    process.exit(2);
  }
}

interface Result {
  case: string;
  mode: 'on' | 'off';
  kind: Kind;
  noise: string;
  snr: number | null;
  condition: Condition;
  limit: boolean;
  wakes: number;
  turns: number;
  expected: number;
  denoise: 'ready' | 'unavailable' | 'unknown';
  errors: number;
  seconds: number;
}

const chromium = (await loadPlaywright()) as typeof import('playwright').chromium;
const av = await createInstance({
  bin: [process.execPath, join(ROOT, 'dist', 'cli.js')],
  canned: Array.from({ length: 400 }, (_, i) => `virtual mic command ${i + 1}`),
  extraEnv: { STUB_ECHO_TURNS: '400' },
  configure: (config) => {
    const voice = config.settings.voice;
    voice.wakeWords.start = 'hey squeaky';
    voice.wakeWords.end = 'cursor send';
    voice.wakeWords.cancel = 'cancel';
    voice.wakeWordsEnabled = true;
    voice.defaultMicMuted = false;
    voice.inputMode = 'turns';
    // The end phrase closes each capture even if the noise keeps Silero VAD
    // active — this test is about what the spotter heard, not when VAD gives up.
    voice.turnSubmit.vadEnabled = USE_VAD;
    voice.turnSubmit.silenceMs = 700;
    voice.tts.agentSpeechEnabled = false;
    voice.tts.errorSoundEnabled = false;
    voice.tts.errorSpeakEnabled = false;
  },
});

const realModel = join(ROOT, 'vosk', 'model.tar.gz');
if (!existsSync(realModel)) {
  throw new Error('missing ./vosk/model.tar.gz — run npm run prepare:vosk or point at a model');
}
// The e2e harness seeds a fake archive so tests that do not use wake words are
// fast. This one needs the real model the PWA will unpack.
copyFileSync(realModel, join(av.instance, 'vosk', 'model.tar.gz'));

const results: Result[] = [];

async function runCase(c: Case, mode: 'on' | 'off', profile: string, seq: number): Promise<Result> {
  const wavPath = join(av.tmp, `mic-${mode}-${seq}.wav`);
  buildCase(c, wavPath);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
    permissions: ['microphone'],
    // page.route() cannot intercept a service worker's own fetch. Blocking the
    // SW also makes the denoise-off run a true raw path instead of a cache hit.
    serviceWorkers: 'block',
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  await context.addInitScript(
    ({ token, browserNs }) => {
      localStorage.setItem('cv_token', token);
      localStorage.setItem('cv_active_project', 'e2e');
      if (browserNs === 'off') {
        // Compare RNNoise alone with the browser's own suppressor still on.
        // The page's getUserMedia constraints are production code; this only
        // overrides the device request for the test.
        const md = navigator.mediaDevices;
        const original = md.getUserMedia.bind(md);
        md.getUserMedia = (c: MediaStreamConstraints) => {
          if (!c?.audio) return original(c);
          const audio = typeof c.audio === 'object' ? { ...c.audio } : {};
          audio.noiseSuppression = false;
          (audio as Record<string, unknown>)['googNoiseSuppression'] = false;
          return original({ ...c, audio });
        };
      }
    },
    { token: av.token, browserNs: BROWSER_NS },
  );
  const page = await context.newPage();
  const consoleLines: string[] = [];
  const errors: string[] = [];
  page.on('console', (m) => {
    consoleLines.push(`${m.type()}: ${m.text()}`);
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  if (mode === 'off') {
    // Denoise off = the pre-change path: the optional asset never loads, so
    // mic-denoise falls back to the raw microphone.
    await page.route('**/rnnoise/rnnoise-sync.js', (r) => r.abort());
  }

  const before = av.sttRequests.length;
  const started = Date.now();
  await page.goto(av.base, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.evaluate(() => {
    const w = window as unknown as { __wake?: { transitions: number; was: boolean; timer: number } };
    w.__wake = { transitions: 0, was: false, timer: 0 };
    w.__wake.timer = window.setInterval(() => {
      const listening = Boolean(document.querySelector('.cv-voice-orb--listening'));
      if (listening && !w.__wake!.was) w.__wake!.transitions++;
      w.__wake!.was = listening;
    }, 40);
  });

  await page.locator('.cv-voice-orb-btn').first().click();
  await page
    .locator('.cv-voice-orb--ready, .cv-voice-orb--listening')
    .first()
    .waitFor({ timeout: 90_000 });
  await page.waitForTimeout(LISTEN_MS);

  const wakes = await page.evaluate(() => {
    const w = window as unknown as { __wake?: { transitions: number; timer: number } };
    window.clearInterval(w.__wake?.timer);
    return w.__wake?.transitions ?? 0;
  });
  const turns = av.sttRequests.length - before;
  await context.close();

  const denoise: Result['denoise'] = consoleLines.some((l) => l.includes('noise suppression ready'))
    ? 'ready'
    : consoleLines.some((l) => l.includes('RNNoise unavailable'))
      ? 'unavailable'
      : 'unknown';
  if (process.argv.includes('--debug')) {
    for (const line of consoleLines.filter((l) => /denoise/i.test(l))) say(`      ${line}`);
  }
  return {
    case: c.name,
    mode,
    kind: c.kind,
    noise: c.noise ?? 'none',
    snr: c.snr,
    condition: c.condition,
    limit: Boolean(c.limit),
    wakes,
    turns,
    expected: c.kind === 'positive' ? 3 : 0,
    denoise,
    errors: errors.length,
    seconds: (Date.now() - started) / 1000,
  };
}

try {
  await av.startBridge();
  say(`bridge up at ${av.base}`);
  const profiles = {
    on: join(av.tmp, 'profile-on'),
    off: join(av.tmp, 'profile-off'),
  };
  mkdirSync(profiles.on, { recursive: true });
  mkdirSync(profiles.off, { recursive: true });

  let seq = 0;
  for (const mode of MODES) {
    const cases = CASES.filter(
      (c) =>
        (ONLY ? c.name.includes(ONLY) : true) &&
        (ONLY_CASES.length ? ONLY_CASES.includes(c.name) : true) &&
        (mode === 'on' || ALL_CASES || c.ab),
    );
    for (const c of cases) {
      const r = await runCase(c, mode, profiles[mode], seq++);
      results.push(r);
      say(
        `${mode.padEnd(3)} ${r.case.padEnd(20)} wakes ${String(r.wakes).padStart(2)}/${r.expected} ` +
          `turns ${String(r.turns).padStart(2)}  denoise ${r.denoise}  ${r.seconds.toFixed(1)}s`,
      );
    }
  }

  const on = results.filter((r) => r.mode === 'on');
  const off = results.filter((r) => r.mode === 'off');
  const posOn = on.filter((r) => r.kind === 'positive');
  const posOff = off.filter((r) => r.kind === 'positive');
  const negOn = on.filter((r) => r.kind !== 'positive');
  const negOff = off.filter((r) => r.kind !== 'positive');
  const rate = (rows: Result[]) => {
    const wakes = rows.reduce((s, r) => s + r.wakes, 0);
    const expected = rows.reduce((s, r) => s + r.expected, 0);
    return expected ? wakes / expected : 0;
  };
  const falseWakes = (rows: Result[]) => rows.reduce((s, r) => s + r.wakes, 0);
  const turns = (rows: Result[]) => rows.reduce((s, r) => s + r.turns, 0);
  const bad = posOn.filter((r) => r.errors > 0 && r.wakes === 0);

  console.log('\nVirtual microphone — wake detection (three rounds per positive case)');
  console.log(`  denoise on   ${(rate(posOn) * 100).toFixed(1)}% woke (${posOn.length} cases, ${turns(posOn)} turns)`);
  console.log(`  denoise off  ${(rate(posOff) * 100).toFixed(1)}% woke (${posOff.length} cases, ${turns(posOff)} turns)`);
  console.log(`  false wakes, on  ${falseWakes(negOn)} over ${negOn.length} negative cases`);
  console.log(`  false wakes, off ${falseWakes(negOff)} over ${negOff.length} negative cases`);
  const worst = [...posOn].sort((a, b) => a.wakes - b.wakes || a.case.localeCompare(b.case)).slice(0, 6);
  console.log('\n  lowest positive cases (denoise on):');
  for (const r of worst) console.log(`    ${r.case.padEnd(20)} ${r.wakes}/3`);

  if (posOn.length) {
    check(on.some((r) => r.denoise === 'ready'), 'RNNoise loaded in the denoise-on runs');
    check(posOn.filter((r) => !r.limit).every((r) => r.wakes > 0), 'every in-bench denoise-on positive case woke at least once', JSON.stringify(posOn.filter((r) => !r.limit && r.wakes === 0).map((r) => r.case)));
    check(bad.length === 0, 'no positive case was killed by page errors', JSON.stringify(bad.map((r) => r.case)));
    check(falseWakes(negOn) <= Math.max(2, negOn.length), 'noise/talk false wakes stayed low with denoise on', String(falseWakes(negOn)));
  }
  if (posOff.length) {
    check(off.every((r) => r.denoise !== 'ready'), 'denoise-off runs really used the raw path');
  }
  if (posOn.length && posOff.length) {
    check(rate(posOn) >= rate(posOff), 'denoise did not reduce wake detection overall', `${rate(posOn)} vs ${rate(posOff)}`);
  }

  const out = OUT_FILE || join(av.tmp, 'wake-denoise-results.json');
  writeFileSync(out, JSON.stringify(results, null, 2));
  say(`results: ${out}`);
  if (report.failures) say(av.bridgeOutput().slice(-2000));
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-2000));
} finally {
  const keep = report.failures > 0 || process.argv.includes('--keep');
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — virtual mic through the PWA wake + denoise path' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
