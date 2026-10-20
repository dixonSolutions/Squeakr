#!/usr/bin/env node
/**
 * Agent audio streams (docs/47) played by the real PWA in headless Chromium.
 *
 * The production web build runs against a throwaway bridge
 * (scripts/e2e-harness.mjs); an MCP client stands in for the agent and mixes
 * speak() lines (spoken by the stand-in self-hosted voice, streamed as PCM)
 * with audio streams. The page's own Web Audio code plays everything and
 * reports playback back to the bridge, which is what the stream logs show —
 * so every timing below is the browser's, not the test's.
 *
 * Asserts:
 *   - a queue stream waits for the line ahead of it, and the line after it
 *     waits for it (the next TTS request is made only once it has ended)
 *   - it plays for as long as the audio it was given
 *   - an async stream (an mp3, through ffmpeg when installed) starts at once,
 *     while speech is still playing
 *   - raw PCM packets play, and close(drain: false) stops a long stream at once
 *   - a stream left open does not hold the speech after it
 *
 * Needs Playwright, like live-pwa-stream-test.mjs:
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/live-pwa-agent-audio-test.mjs
 * (PLAYWRIGHT_CHROMIUM=/path/to/chrome picks a browser build Playwright did not download.)
 * Build first: npm run build.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createInstance, makeReporter, ROOT, speechWav } from './e2e-harness.mjs';

const KEEP = process.argv.includes('--keep');
const report = makeReporter();
const { say, check, fail } = report;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPlaywright() {
  const explicit = process.env.PLAYWRIGHT_MODULE;
  try {
    const mod = explicit ? await import(pathToFileURL(join(explicit, 'index.mjs')).href) : await import('playwright');
    return mod.chromium ?? mod.default?.chromium;
  } catch (err) {
    console.error(
      'Playwright not found — set PLAYWRIGHT_MODULE to a playwright package directory, ' +
        `or install it (npx playwright install chromium). ${err instanceof Error ? err.message : ''}`,
    );
    process.exit(2);
  }
}

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const chromium = await loadPlaywright();
const av = await createInstance({
  bin: [process.execPath, join(ROOT, 'dist', 'cli.js')],
  canned: [],
  ttsChunkDelayMs: 150,
  configure: (config) => {
    const audio = config.settings.workflow.llmIntelligence.audio;
    audio.tts = { provider: 'local_speech', fallbacks: [], language: 'auto', models: {}, voices: {}, scopes: {} };
  },
});

// A silent microphone: nothing the user "says" interferes with playback.
const micPath = join(av.tmp, 'mic.wav');
writeFileSync(micPath, speechWav([['silence', 5000]], { rate: 48_000, channels: 1 }));
const clipPath = join(av.project, 'clip.wav');
writeFileSync(clipPath, speechWav([['tone', 1500]], { rate: 44_100, channels: 2 }));
const longPath = join(av.project, 'long.wav');
writeFileSync(longPath, speechWav([['tone', 6000]], { rate: 22_050, channels: 1 }));
const FFMPEG = hasFfmpeg();
let chimePath = join(av.project, 'chime.wav');
writeFileSync(chimePath, speechWav([['tone', 500]], { rate: 48_000, channels: 1 }));
if (FFMPEG) {
  const mp3 = join(av.project, 'chime.mp3');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', chimePath, mp3]);
  chimePath = mp3;
}

let browser = null;
try {
  await av.startBridge();
  say(`bridge up at ${av.base}; ffmpeg ${FFMPEG ? 'found — the chime is an mp3' : 'missing — the chime stays WAV'}`);

  browser = await chromium.launch({
    headless: true,
    // A browser build other than the one this Playwright pins, e.g. ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome.
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${micPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone'] });
  await context.addInitScript(
    ({ token }) => {
      localStorage.setItem('cv_token', token);
      localStorage.setItem('cv_active_project', 'e2e');
    },
    { token: av.token },
  );
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  await page.goto(av.base, { waitUntil: 'networkidle' });
  await page.locator('.cv-voice-orb-btn').first().waitFor({ timeout: 20_000 });
  await page.locator('.cv-voice-orb-btn').first().click();
  say('PWA loaded, orb tapped');

  const client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${av.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${av.token}` } },
    }),
  );
  const call = async (tool, args = {}) => JSON.parse((await client.callTool({ name: tool, arguments: args })).content[0].text);

  // Wait for the page to pick its speech backends, so "one" goes to the server voice.
  for (let i = 0; i < 80 && !consoleLines.some((x) => x.includes('[audio] STT:')); i++) await sleep(250);
  // The phone's voice socket is up once speak() finds a session.
  let spoke = null;
  for (let i = 0; i < 40 && !spoke?.ok; i++) {
    await sleep(250);
    spoke = await call('speak', { text: 'one' });
  }
  check(spoke?.ok === true, 'the page joined as a voice session', JSON.stringify(spoke));

  // ── queue between two lines, async under them ──────────────────────────
  const q = await call('audio_stream_open', { label: 'clip', mode: 'queue' });
  await call('audio_stream_write', { stream_id: q.stream_id, path: clipPath });
  await call('audio_stream_close', { stream_ids: [q.stream_id] });
  await call('speak', { text: 'two' });
  const a = await call('audio_stream_open', { label: 'chime', mode: 'async', volume: 0.5 });
  const aw = await call('audio_stream_write', { stream_id: a.stream_id, path: chimePath });
  check(aw.ok && (!FFMPEG || /mp3 via ffmpeg/.test(aw.format)), `async chime decoded (${aw.format})`, JSON.stringify(aw));
  await call('audio_stream_close', { stream_ids: [a.stream_id] });

  // ── packets, then a long stream stopped early ──────────────────────────
  const p = await call('audio_stream_open', { label: 'feed', mode: 'async', format: { sample_rate: 16_000, channels: 1 } });
  const tone = speechWav([['tone', 1000]], { rate: 16_000, channels: 1 }).subarray(44);
  for (let off = 0; off < tone.length; off += 3_201) {
    await call('audio_stream_write', { stream_id: p.stream_id, packet: tone.subarray(off, off + 3_201).toString('base64') });
  }
  await call('audio_stream_close', { stream_ids: [p.stream_id] });

  const at = (log, client, state) => {
    const e = log?.find((x) => x.event === 'playback' && x.detail.startsWith(`${client}: ${state}`));
    return e ? Date.parse(e.at) : null;
  };
  const logOf = async (id) => (await call('audio_stream_log', { stream_ids: [id] })).streams?.[0]?.log;
  const waitFor = async (id, state, ms = 20_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const log = await logOf(id);
      if (at(log, 'phone', state)) return log;
      await sleep(200);
    }
    return logOf(id);
  };

  const qLog = await waitFor(q.stream_id, 'ended');
  const aLog = await waitFor(a.stream_id, 'ended');
  const pLog = await waitFor(p.stream_id, 'ended');
  for (const [name, log] of [['clip', qLog], ['chime', aLog], ['feed', pLog]]) {
    say(`${name}: ${JSON.stringify(log?.filter((e) => e.event === 'playback').map((e) => `${e.at.slice(11, 23)} ${e.detail}`))}`);
  }
  await sleep(2500); // let "two" be fetched
  const tts = av.ttsRequests.map((r) => r.startedAt);
  say(`tts requests at: ${tts.map((t) => new Date(t).toISOString().slice(11, 23)).join(', ')}`);

  const qPlay = at(qLog, 'phone', 'playing');
  const qEnd = at(qLog, 'phone', 'ended');
  check(qPlay && qEnd, 'the queued clip played to the end on the page', JSON.stringify(qLog));
  check(tts.length >= 2, 'both lines were spoken', String(tts.length));
  check(qPlay && tts[0] < qPlay, 'the clip waited for the line ahead of it');
  check(qEnd && tts[1] >= qEnd - 50, 'the line after the clip waited for it', `two fetched ${tts[1] - qEnd} ms after the clip ended`);
  check(qPlay && qEnd && Math.abs(qEnd - qPlay - 1500) < 450, 'the clip lasted as long as its audio (1.5 s)', `${qEnd - qPlay} ms`);

  const aPlay = at(aLog, 'phone', 'playing');
  check(aPlay && qEnd && aPlay < qEnd, 'the async chime played while queued audio was still going', `${aPlay && qEnd ? qEnd - aPlay : '?'} ms before`);
  check(at(aLog, 'phone', 'ended'), 'the chime ended');
  check(at(pLog, 'phone', 'playing') && at(pLog, 'phone', 'ended'), 'raw 16 kHz packets played on the page');

  // ── stop a long stream mid-way ─────────────────────────────────────────
  const l = await call('audio_stream_open', { label: 'long', mode: 'async' });
  await call('audio_stream_write', { stream_id: l.stream_id, path: longPath });
  const lPlaying = await waitFor(l.stream_id, 'playing', 10_000);
  const startedAt = at(lPlaying, 'phone', 'playing');
  await sleep(800);
  const stopAt = Date.now();
  await call('audio_stream_close', { stream_ids: [l.stream_id], drain: false });
  const lLog = await waitFor(l.stream_id, 'stopped', 5_000);
  const stoppedAt = at(lLog, 'phone', 'stopped');
  check(startedAt && stoppedAt && stoppedAt - stopAt < 1000, 'drain: false stopped a 6 s clip at once', `${stoppedAt ? stoppedAt - stopAt : '?'} ms after close`);
  check(!at(lLog, 'phone', 'ended'), 'the stopped clip never reported ended');

  // ── a queue stream left open must not hold the speech after it ─────────
  const o = await call('audio_stream_open', { label: 'forgotten', mode: 'queue' });
  await call('audio_stream_write', { stream_id: o.stream_id, path: clipPath });
  const before = av.ttsRequests.length;
  await call('speak', { text: 'three' });
  const end = Date.now() + 10_000;
  while (Date.now() < end && av.ttsRequests.length === before) await sleep(200);
  const oLog = await logOf(o.stream_id);
  const oPlay = at(oLog, 'phone', 'playing');
  check(av.ttsRequests.length > before, 'speech queued behind an unclosed stream still played');
  check(oPlay && av.ttsRequests[before].startedAt - oPlay < 1500 + 1500 + 700, 'it waited only for the audio plus the dry gap', `${oPlay ? av.ttsRequests[before].startedAt - oPlay : '?'} ms`);
  await call('audio_stream_close', { all: true });

  const errors = consoleLines.filter((x) => /^error/.test(x) && /audio|pcm|stream/i.test(x));
  check(errors.length === 0, 'no audio errors in the browser console', errors.slice(-5).join(' / '));
  const bodyText = await page.locator('body').innerText();
  check(!/Agent audio failed/.test(bodyText), 'no "Agent audio failed" in the page');

  const transcript = readFileSync(join(av.logDir('transcripts'), av.readFolder('transcripts').filter((n) => n.endsWith('.log')).pop()), 'utf-8');
  check(/audio stream "clip"/.test(transcript) && /audio stream "chime"/.test(transcript), 'the transcript records the streams');

  if (report.failures) {
    await page.screenshot({ path: join(av.tmp, 'page.png'), fullPage: true });
    say(`screenshot: ${join(av.tmp, 'page.png')}`);
    for (const line of consoleLines.slice(-30)) say(`    ${line}`);
  }
  await client.close();
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-2000));
} finally {
  await browser?.close();
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — the PWA plays agent audio streams' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
