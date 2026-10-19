#!/usr/bin/env node
/**
 * End-to-end test of Config → Audio & devices (docs/49) in a real browser.
 *
 * Headless Chromium runs the production web build against a throwaway bridge
 * (scripts/e2e-harness.mjs) whose stand-in voice answers with a 1 s, 220 Hz
 * tone. Everything the page sends to the speakers is tapped in-page (an
 * analyser spliced in front of every AudioDestinationNode), so the checks
 * measure what would actually be heard:
 *
 *   - microphone picker: remembered in localStorage, used by getUserMedia,
 *     live level meter moves with Chrome's fake microphone
 *   - speaker picker: remembered, applied to the AudioContext (setSinkId)
 *   - loudness slider: −12 dB / default / +12 dB, limited below full scale
 *   - speed slider: 2× halves the playing time and keeps the 220 Hz pitch
 *   - speech test: live loudness change while it plays
 *   - a real voice session: streamed PCM reply honours speed and boost
 *   - wake sensitivity slider round-trips to wakeConfidenceThreshold
 *
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/live-audio-settings-test.mjs
 *
 * Build first: npm run build.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstance, makeReporter, ROOT, speechWav } from './e2e-harness.mjs';

const KEEP = process.argv.includes('--keep');
const SHOTS = process.env.SHOTS_DIR ?? null;
const CANNED = ['how loud is this', 'and how fast', 'thanks'];
const report = makeReporter();
const { say, check, fail } = report;

async function loadPlaywright() {
  const explicit = process.env.PLAYWRIGHT_MODULE;
  try {
    const mod = explicit ? await import(pathToFileURL(join(explicit, 'index.mjs')).href) : await import('playwright');
    return mod.chromium ?? mod.default?.chromium;
  } catch (err) {
    console.error(`Playwright not found — set PLAYWRIGHT_MODULE. ${err instanceof Error ? err.message : ''}`);
    process.exit(2);
  }
}

/** In-page: tap everything that reaches a speaker and sample it every 20 ms. */
function installOutputTap() {
  const connect = AudioNode.prototype.connect;
  const samples = [];
  window.__out = { samples, taps: [] };
  AudioNode.prototype.connect = function (dest, ...rest) {
    const result = connect.call(this, dest, ...rest);
    if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode) {
      const ctx = dest.context;
      if (!ctx.__tap) {
        const tap = ctx.createAnalyser();
        tap.fftSize = 4096;
        tap.smoothingTimeConstant = 0;
        const mute = ctx.createGain();
        mute.gain.value = 0;
        connect.call(tap, mute);
        connect.call(mute, ctx.destination);
        ctx.__tap = tap;
        window.__out.taps.push(tap);
        const time = new Float32Array(tap.fftSize);
        const freq = new Float32Array(tap.frequencyBinCount);
        setInterval(() => {
          tap.getFloatTimeDomainData(time);
          let sum = 0;
          let peak = 0;
          for (const s of time) {
            sum += s * s;
            peak = Math.max(peak, Math.abs(s));
          }
          tap.getFloatFrequencyData(freq);
          let best = 0;
          for (let i = 1; i < freq.length; i++) if (freq[i] > freq[best]) best = i;
          samples.push({ t: performance.now(), rms: Math.sqrt(sum / time.length), peak, hz: (best * ctx.sampleRate) / tap.fftSize });
        }, 20);
      }
      connect.call(this, ctx.__tap);
    }
    return result;
  };
  // Record which microphone getUserMedia was asked for.
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__gum = [];
  navigator.mediaDevices.getUserMedia = (c) => {
    window.__gum.push(JSON.parse(JSON.stringify(c)));
    return gum(c);
  };
}

const chromium = await loadPlaywright();
const av = await createInstance({
  bin: [process.execPath, join(ROOT, 'dist', 'cli.js')],
  canned: CANNED,
  ttsChunkDelayMs: 60,
  configure: (config) => {
    const audio = config.settings.workflow.llmIntelligence.audio;
    // Whole-file replies as WAV so the speech test can decode them.
    audio.tts = {
      provider: 'local_speech',
      fallbacks: [],
      language: 'auto',
      models: {},
      voices: {},
      scopes: { local_speech: { response_format: 'wav' } },
    };
  },
});

const wavPath = join(av.tmp, 'mic.wav');
writeFileSync(
  wavPath,
  speechWav(
    [
      ['silence', 800],
      ['speech', 1400],
      ['silence', 1400],
      ['speech', 1100],
      ['silence', 6000],
    ],
    { rate: 48_000, channels: 1 },
  ),
);

let browser = null;
try {
  await av.startBridge();
  say(`bridge up at ${av.base}`);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'], colorScheme: 'dark' });
  await context.addInitScript(
    ({ token }) => {
      localStorage.setItem('cv_token', token);
      localStorage.setItem('cv_active_project', 'e2e');
    },
    { token: av.token },
  );
  await context.addInitScript(installOutputTap);
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
  const ttsBodies = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/intelligence/tts')) ttsBodies.push(r.postData() ?? '');
  });

  const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('sq-audio-prefs') ?? '{}'));
  /** Phone-width screenshot of the current screen (SHOTS_DIR set), then back to desktop size. */
  const shot = async (name, focus) => {
    if (!SHOTS) return;
    const size = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    if (focus) await page.locator(focus).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
    if (size) await page.setViewportSize(size);
  };
  const closeToasts = async () => {
    for (const close of await page.locator('.p-toast .p-toast-close-button').all()) {
      await close.click().catch(() => undefined);
    }
  };
  /** Drive a level slider with its keyboard: Home = 0, End = 100, then N arrow presses. */
  const setSlider = async (testId, value) => {
    const handle = page.locator(`[data-testid="${testId}"] [role="slider"]`).first();
    await handle.focus();
    await handle.press(value >= 50 ? 'End' : 'Home');
    const presses = value >= 50 ? 100 - value : value;
    for (let i = 0; i < presses; i++) await handle.press(value >= 50 ? 'ArrowLeft' : 'ArrowRight');
  };
  /** Sample the output tap for `ms`, return the loudest stretch's stats. */
  const measure = async (ms) => {
    const from = await page.evaluate(() => performance.now());
    await page.waitForTimeout(ms);
    return page.evaluate((since) => {
      const s = window.__out.samples.filter((x) => x.t >= since);
      const voiced = s.filter((x) => x.rms > 0.005);
      const rms = voiced.length ? voiced.reduce((n, x) => n + x.rms, 0) / voiced.length : 0;
      const peak = s.reduce((m, x) => Math.max(m, x.peak), 0);
      const hz = voiced.length ? voiced.map((x) => x.hz).sort((a, b) => a - b)[Math.floor(voiced.length / 2)] : 0;
      const first = voiced[0]?.t ?? 0;
      const last = voiced[voiced.length - 1]?.t ?? 0;
      return { rms, peak, hz, voicedMs: voiced.length * 20, spanMs: last - first, n: s.length };
    }, from);
  };

  await page.goto(av.base, { waitUntil: 'networkidle' });
  const tab = (label) => page.locator('nav.cv-tabnav button', { hasText: label }).first();

  // ── Open the section ──────────────────────────────────────────────────
  await tab('Config').click();
  await page.locator('input.cv-cfg-search').fill('bluetooth');
  check(
    (await page.locator('button.cv-cfg-item', { hasText: 'Audio & devices' }).count()) === 1,
    'settings search finds Audio & devices by "bluetooth"',
  );
  await page.locator('button.cv-cfg-item', { hasText: 'Audio & devices' }).click();
  await page.getByRole('heading', { name: 'Microphone' }).waitFor({ timeout: 10_000 });
  for (const heading of ['Microphone', 'Speaker', 'Agent voice']) {
    check(await page.getByRole('heading', { name: heading }).isVisible(), `card "${heading}" shown`);
  }
  await page.locator('[data-testid="aud-test"] .p-tag', { hasText: /Self-hosted|Local|Kokoro|server/i }).first()
    .waitFor({ timeout: 10_000 }).catch(() => undefined);
  const engineTag = await page.locator('[data-testid="aud-test"] .p-tag').first().innerText();
  say(`speech test engine: ${engineTag}`);
  check(!/No voice|Browser/i.test(engineTag), 'speech test picks the configured server voice', engineTag);
  await shot('01-audio-page');

  // ── Microphone ────────────────────────────────────────────────────────
  await page.getByRole('button', { name: 'Check level' }).click();
  // The fake microphone loops speech and silence — watch it for a whole loop.
  let level = 0;
  for (let i = 0; i < 40 && level < 20; i++) {
    await page.waitForTimeout(250);
    level = Math.max(level, Number(await page.locator('.cv-audio-meter').getAttribute('aria-valuenow')));
  }
  check(level >= 20, 'level meter moves with the fake microphone', `peak level ${level}`);
  await shot('01b-mic-check');
  await page.getByTestId('aud-mic-record').click();
  await page.getByText(/Recording… \d s/).first().waitFor({ timeout: 3000 });
  await page.getByText('Playing your recording back').first().waitFor({ timeout: 8000 });
  check(true, 'record & play back records, then plays the clip');
  await page.getByText('Playing your recording back').first().waitFor({ state: 'detached', timeout: 8000 });
  await page.locator('[data-testid="aud-input"]').click();
  const inputOptions = await page.locator('.p-select-overlay .p-select-option').allInnerTexts();
  say(`inputs: ${inputOptions.join(' | ')}`);
  check(inputOptions.length >= 2, 'microphones listed with names', inputOptions.join(' | '));
  await page.locator('.p-select-overlay .p-select-option').nth(inputOptions.length - 1).click();
  await page.waitForTimeout(1500);
  const chosenMic = (await prefs()).inputDeviceId;
  check(Boolean(chosenMic), 'chosen microphone remembered in localStorage', JSON.stringify(await prefs()));
  const gum = await page.evaluate(() => window.__gum);
  const lastGum = gum[gum.length - 1];
  check(lastGum?.audio?.deviceId?.ideal === chosenMic, 'getUserMedia asks for the chosen microphone', JSON.stringify(lastGum?.audio?.deviceId));
  const liveMic = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput').map((d) => d.label);
  });
  say(`devices now: ${liveMic.join(' | ')}`);
  await page.getByRole('button', { name: 'Stop check' }).click();

  // Remembered across a reload.
  await page.reload({ waitUntil: 'networkidle' });
  await tab('Config').click();
  await page.locator('button.cv-cfg-item', { hasText: 'Audio & devices' }).click();
  await page.getByRole('heading', { name: 'Microphone' }).waitFor();
  await page.waitForTimeout(800);
  const shownMic = await page.locator('[data-testid="aud-input"] .p-select-label').innerText();
  check(!/System default/.test(shownMic), 'picker shows the remembered microphone after reload', shownMic);

  // ── Speaker ───────────────────────────────────────────────────────────
  const hasPicker = (await page.locator('[data-testid="aud-output"]').count()) > 0;
  check(hasPicker, 'Chromium offers a speaker picker (setSinkId)');
  if (hasPicker) {
    await page.locator('[data-testid="aud-output"]').click();
    const outOptions = await page.locator('.p-select-overlay .p-select-option').allInnerTexts();
    say(`outputs: ${outOptions.join(' | ')}`);
    if (outOptions.length >= 2) {
      await page.locator('.p-select-overlay .p-select-option').nth(outOptions.length - 1).click();
      await page.waitForTimeout(300);
      await page.getByTestId('aud-tone').click();
      await page.waitForTimeout(600);
      const sink = await page.evaluate(() => window.__out.taps[0]?.context.sinkId ?? null);
      const remembered = (await prefs()).outputDeviceId;
      check(Boolean(remembered) && sink === remembered, 'shared AudioContext switched to the chosen speaker', `sink ${sink} pref ${remembered}`);
    } else {
      await page.keyboard.press('Escape');
      say('only the default speaker is listed here — sink switch not exercised');
    }
  }

  // ── Loudness and speed, measured at the speakers ──────────────────────
  // Repeat off for measuring a single play.
  await page.locator('#aud-loop').click();
  const playOnce = async () => {
    await page.getByTestId('aud-test-play').click();
    const m = await measure(2600);
    await page.locator('[data-testid="aud-test-play"]', { hasText: 'Play test' }).waitFor({ timeout: 5000 });
    return m;
  };

  const base = await playOnce();
  say(`default: rms ${base.rms.toFixed(3)} peak ${base.peak.toFixed(3)} ${base.hz.toFixed(0)} Hz, ${base.spanMs.toFixed(0)} ms`);
  check(base.rms > 0.05, 'speech test plays the agent voice at default level', base.rms.toFixed(3));
  check(ttsBodies.some((b) => !b.includes('"stream":true')), 'speech test fetched a whole clip to replay');
  check(Math.abs(base.spanMs - 1000) < 250, 'default speed plays the 1 s clip in about 1 s', `${base.spanMs.toFixed(0)} ms`);

  await setSlider('aud-loudness', 100);
  const showsText = (label, text) =>
    page.locator('cv-level-slider', { hasText: label }).filter({ hasText: text }).first()
      .waitFor({ timeout: 2000 }).then(() => true, () => false);
  check(await showsText('Loudness', '+12.0 dB'), 'loudness label reads +12.0 dB at the top');
  const loud = await playOnce();
  say(`boost: rms ${loud.rms.toFixed(3)} peak ${loud.peak.toFixed(3)}`);
  check(loud.rms > base.rms * 2.5, 'max loudness is much louder than default', `${(loud.rms / base.rms).toFixed(2)}×`);
  check(loud.peak <= 1.0, 'boosted output stays within full scale (limiter)', loud.peak.toFixed(3));

  await setSlider('aud-loudness', 25);
  const quiet = await playOnce();
  say(`quiet: rms ${quiet.rms.toFixed(3)}`);
  check(Math.abs(quiet.rms / base.rms - 0.25) < 0.06, 'loudness 25 is −12 dB (¼ amplitude)', `${(quiet.rms / base.rms).toFixed(3)}×`);
  await setSlider('aud-loudness', 50);

  await setSlider('aud-speed', 100);
  check(await showsText('Speech speed', '2.0×'), 'speed label reads 2.0×');
  const fast = await playOnce();
  say(`2×: ${fast.spanMs.toFixed(0)} ms at ${fast.hz.toFixed(0)} Hz`);
  check(Math.abs(fast.spanMs - 500) < 180, '2× speed plays the clip in about half the time', `${fast.spanMs.toFixed(0)} ms`);
  check(Math.abs(fast.hz - base.hz) < 20, 'pitch unchanged at 2× (time-stretched, not sped up)', `${fast.hz.toFixed(0)} vs ${base.hz.toFixed(0)} Hz`);
  await setSlider('aud-speed', 0);
  const slow = await playOnce().catch(() => null);
  await page.waitForTimeout(800);
  say(`½×: ${slow?.spanMs.toFixed(0)} ms at ${slow?.hz.toFixed(0)} Hz`);
  check(slow && slow.spanMs > 1700, '½× speed plays the clip in about twice the time', `${slow?.spanMs.toFixed(0)} ms`);
  check(slow && Math.abs(slow.hz - base.hz) < 20, 'pitch unchanged at ½×', `${slow?.hz.toFixed(0)} Hz`);
  await setSlider('aud-speed', 50);

  // Live change while it plays (repeat on).
  await page.locator('#aud-loop').click();
  await page.getByTestId('aud-test-play').click();
  await shot('02b-speech-test-playing', '[data-testid="aud-test"]');
  const before = await measure(1200);
  await setSlider('aud-loudness', 100);
  const after = await measure(1200);
  await page.getByTestId('aud-test-play').click();
  say(`live: ${before.rms.toFixed(3)} → ${after.rms.toFixed(3)}`);
  check(after.rms > before.rms * 2, 'dragging loudness during the test changes it live', `${(after.rms / before.rms).toFixed(2)}×`);
  await shot('02-audio-boosted', '[data-testid="aud-speed"]');
  const stored = await prefs();
  check(stored.loudness === 100 && stored.speed === 50, 'levels remembered in localStorage', JSON.stringify(stored));

  // ── A real session honours the levels (streamed PCM path) ─────────────
  await setSlider('aud-speed', 100);
  await page.locator('.cv-cfg-back').click();
  await page.locator('button.cv-cfg-item', { hasText: 'Listening & controls' }).click();
  await page.getByText('Direct stream', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Save input mode' }).click();
  await page.waitForTimeout(800);

  // Wake sensitivity slider → wakeConfidenceThreshold.
  const wake = page.locator('[data-testid="cfg-wake-sensitivity"] [role="slider"]').first();
  check(await wake.isVisible(), 'wake sensitivity is a slider');
  const wakeText = await page.locator('cv-level-slider', { hasText: 'Wake sensitivity' }).innerText();
  check(/Default · 45%/.test(wakeText), 'wake slider starts in the middle at the shipped 45 %', wakeText.replace(/\s+/g, ' '));
  await wake.focus();
  await wake.press('End');
  await page.getByRole('button', { name: 'Save voice settings' }).click();
  let saved = null;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(250);
    saved = JSON.parse((await av.api('/api/voice/providers')).text);
    if (saved?.wakeWords?.wakeConfidenceThreshold < 0.45) break;
  }
  check(saved?.wakeWords?.wakeConfidenceThreshold === 0.15, 'most sensitive saves threshold 0.15', JSON.stringify(saved?.wakeWords));
  await closeToasts();
  await shot('03-wake-slider', '[data-testid="cfg-wake-sensitivity"]');
  await closeToasts();
  await page.locator('.p-toast-message').first().waitFor({ state: 'detached', timeout: 10_000 }).catch(() => undefined);

  await tab('Voice').click();
  await page.locator('.cv-voice-orb-btn').first().waitFor({ timeout: 20_000 });
  const sessionFrom = await page.evaluate(() => performance.now());
  ttsBodies.length = 0;
  await page.locator('.cv-voice-orb-btn').first().click();
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    if (av.readNewest('transcripts').includes(`AGENT: ECHO stream: ${CANNED[1]}`) && ttsBodies.length >= 2) break;
  }
  await page.waitForTimeout(2500);
  const session = await page.evaluate((since) => {
    const s = window.__out.samples.filter((x) => x.t >= since && x.rms > 0.005);
    // Group voiced samples into replies separated by > 150 ms of silence.
    const runs = [];
    for (const x of s) {
      const run = runs[runs.length - 1];
      if (run && x.t - run.end < 150) {
        run.end = x.t;
        run.rms.push(x.rms);
        run.peak = Math.max(run.peak, x.peak);
      } else runs.push({ start: x.t, end: x.t, rms: [x.rms], peak: x.peak });
    }
    return runs.map((r) => ({ ms: r.end - r.start, rms: r.rms.reduce((a, b) => a + b, 0) / r.rms.length, peak: r.peak }));
  }, sessionFrom);
  await page.locator('.cv-voice-orb-btn').first().click();
  say(`session replies: ${session.map((r) => `${r.ms.toFixed(0)} ms rms ${r.rms.toFixed(2)} peak ${r.peak.toFixed(2)}`).join(' | ')}`);
  check(ttsBodies.some((b) => b.includes('"stream":true')), 'session replies were streamed');
  // Sound cues (wake / submit earcons) are short; the 1 s reply at 2× is ~0.5 s.
  const replies = session.filter((r) => r.ms > 400);
  check(replies.length >= 1, 'session played at least one reply', JSON.stringify(session));
  check(replies.every((r) => r.ms < 750), 'streamed replies honour 2× speed (1 s tone in ~0.5 s)', replies.map((r) => r.ms.toFixed(0)).join(', '));
  check(replies.every((r) => r.rms > base.rms * 2.5 && r.peak <= 1), 'streamed replies honour the boost, limited', replies.map((r) => r.rms.toFixed(2)).join(', '));

  // The harness gives the bridge a stand-in wake-word model (random bytes), which Vosk rejects.
  const errors = consoleLines.filter(
    (l) => /^(error|pageerror)/.test(l) && !/favicon|404|Unrecognized archive format/.test(l),
  );
  check(errors.length === 0, 'no errors in the browser console', errors.slice(-5).join(' / '));

  if (report.failures) {
    await page.screenshot({ path: join(av.tmp, 'page.png'), fullPage: true });
    say(`screenshot: ${join(av.tmp, 'page.png')}`);
    for (const line of consoleLines.slice(-30)) say(`    ${line}`);
  }
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-2000));
} finally {
  await browser?.close();
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — audio devices and levels work end to end' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
