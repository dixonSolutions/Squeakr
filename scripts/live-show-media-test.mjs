#!/usr/bin/env node
/**
 * End-to-end test of show_media / media_control (docs/48) in the real PWA.
 *
 * Headless Chromium runs the production web build against a throwaway bridge
 * (scripts/e2e-harness.mjs). The tools are called the way an agent's calls
 * reach dispatchTool (POST /api/tools/:name), and the page is checked for
 * what the user sees and what it reports back:
 *
 *   - fullscreen is the raw media with a close icon on its corner, no overlay
 *   - autoplay plays; the agent pauses / seeks / plays it
 *   - closing a playing video keeps its frame; reopening plays on from there
 *   - close_on_end, auto_close_ms, agent open / close
 *   - autoplay outside fullscreen is refused; tray items open nothing
 *   - self_destruct removes an item from the phone and the bridge
 *   - a live file another agent is still writing plays while it grows
 *   - "never" items go when the session ends
 *
 * Fixtures (WebM video, PNG, MP3) are made at run time with ffmpeg (libvpx,
 * libopus, libmp3lame); without ffmpeg the test is skipped, except under CI
 * where that is a failure. FFMPEG=/path/to/ffmpeg picks a binary.
 *
 * Needs Playwright (not a project dependency). Point at any install:
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/live-show-media-test.mjs
 * or run it where `import('playwright')` resolves.
 * (PLAYWRIGHT_CHROMIUM=/path/to/chrome picks a browser build Playwright did not download.)
 * Build first: npm run build.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstance, makeReporter, ROOT } from './e2e-harness.mjs';

const KEEP = process.argv.includes('--keep');
const report = makeReporter();
const { say, check, fail } = report;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
try {
  execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
} catch {
  const message = `ffmpeg not found (${FFMPEG}) — it makes this test's video and audio fixtures`;
  if (process.env.CI) {
    console.error(`FAIL — ${message}`);
    process.exit(1);
  }
  console.log(`SKIP — ${message}. Install ffmpeg or set FFMPEG=/path/to/ffmpeg.`);
  process.exit(0);
}

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

const chromium = await loadPlaywright();
const av = await createInstance({
  bin: [process.execPath, join(ROOT, 'dist', 'cli.js')],
  canned: [],
  // A short grace window so "the session ended" can be waited out.
  configure: (config) => {
    config.settings.session = { ...(config.settings.session ?? {}), graceMs: 2000 };
  },
});

// ── Fixtures ──────────────────────────────────────────────────────────────
const ff = (...args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args]);
const video = join(av.project, 'demo.webm');
const short = join(av.project, 'short.webm');
const shot = join(av.project, 'shot.png');
// The live file's source sits outside the project: only its copy is "being written".
const fullMp3 = join(av.tmp, 'full.mp3');
const liveMp3 = join(av.project, 'render.mp3');
ff('-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libvpx', '-b:v', '400k', '-c:a', 'libopus', video);
ff('-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=1.5', '-c:v', 'libvpx', short);
ff('-f', 'lavfi', '-i', 'testsrc2=size=400x300:duration=1', '-frames:v', '1', shot);
// 64 kbps: Chromium starts a live stream after ~32 KB, so the mid-write check
// below comes after piece 6 of 8 (~36 KB).
ff('-f', 'lavfi', '-i', 'sine=frequency=330:duration=6', '-c:a', 'libmp3lame', '-b:a', '64k', fullMp3);

async function tool(name, args) {
  const r = await av.api(`/api/tools/${name}`, args);
  const body = JSON.parse(r.text);
  return body.result ?? body;
}

let browser;
try {
  await av.startBridge();
  say(`bridge up at ${av.base}`);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
    // Stands in for the tap that started the voice session: the page may play sound.
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 412, height: 860 }, colorScheme: 'dark' });
  await context.addInitScript(
    ({ token }) => {
      localStorage.setItem('cv_token', token);
      localStorage.setItem('cv_active_project', 'e2e');
    },
    { token: av.token },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(av.base, { waitUntil: 'networkidle' });
  // The control socket connects on load; media frames need it.
  await sleep(1500);

  // ── 1. Fullscreen autoplay video: raw, no overlay, close icon on its corner ──
  const shown = await tool('show_media', { items: [{ path: video, caption: 'Demo' }], autoplay: true, publish: false });
  check(shown.ok === true && shown.items?.[0]?.kind === 'video', `show_media accepted the video (${JSON.stringify(shown).slice(0, 160)})`);
  const id = shown.items[0].media_id;
  await page.waitForSelector('.cv-media-full video', { timeout: 5000 });
  await sleep(2000);
  const geo = await page.evaluate(() => {
    const full = document.querySelector('.cv-media-full');
    const v = document.querySelector('.cv-media-full video');
    const b = document.querySelector('.cv-media-close');
    const fs = getComputedStyle(full);
    const bs = getComputedStyle(b);
    const vr = v.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return {
      layerBg: fs.backgroundColor, layerPointer: fs.pointerEvents, backdrop: fs.backdropFilter,
      btnBorder: bs.borderStyle, btnBg: bs.backgroundColor,
      dRight: Math.abs(vr.right - br.right), dTop: Math.abs(vr.top - br.top),
      videoW: vr.width, paused: v.paused, t: v.currentTime, controls: v.controls,
    };
  });
  check(geo.layerBg === 'rgba(0, 0, 0, 0)' && geo.layerPointer === 'none' && geo.backdrop === 'none', `no overlay (bg ${geo.layerBg}, pointer-events ${geo.layerPointer})`);
  check(geo.dRight < 1 && geo.dTop < 1, `close icon sits on the video's top-right corner (Δ ${geo.dRight}, ${geo.dTop})`);
  check(geo.btnBorder === 'none' && geo.btnBg === 'rgba(0, 0, 0, 0)', 'close icon has no border or background');
  check(!geo.controls, 'raw video — no native controls');
  check(!geo.paused && geo.t > 1, `autoplay is playing (t=${geo.t.toFixed(2)})`);
    let st = await tool('media_control', { action: 'status', media_id: id });
  check(st.playback?.state === 'playing' && st.playback?.open === true, `status reports playing & open (${st.playback?.state})`);

  // ── 2. Agent pause / seek / play while open ──
  await tool('media_control', { action: 'pause', media_id: id });
  await sleep(300);
  check(await page.evaluate(() => document.querySelector('.cv-media-full video').paused), 'agent pause pauses it');
  await tool('media_control', { action: 'seek', media_id: id, position_s: 5 });
  await sleep(300);
  const seeked = await page.evaluate(() => document.querySelector('.cv-media-full video').currentTime);
  check(Math.abs(seeked - 5) < 0.3, `agent seek moves to 5 s (${seeked.toFixed(2)})`);
  await tool('media_control', { action: 'seek', media_id: id, position_s: 2 });
  await tool('media_control', { action: 'play', media_id: id });
  await sleep(800);
  check(!(await page.evaluate(() => document.querySelector('.cv-media-full video').paused)), 'agent play resumes it');

  // ── 3. User closes a playing video: frame remembered, playback stops ──
  const beforeClose = await page.evaluate(() => document.querySelector('.cv-media-full video').currentTime);
  await page.click('.cv-media-close');
  await sleep(500);
  check((await page.$('.cv-media-full')) === null, 'close button closes fullscreen');
  st = await tool('media_control', { action: 'status', media_id: id });
  check(st.playback?.state === 'closed' && Math.abs((st.playback?.position_s ?? -9) - beforeClose) < 0.3, `status: closed at ${st.playback?.position_s?.toFixed?.(2)} s`);
  await sleep(1500);
  await page.click('.cv-media-fab');
  await page.waitForSelector('.cv-media-tile video');
  await sleep(800);
  const thumbT = await page.evaluate(() => document.querySelector('.cv-media-tile video').currentTime);
  check(Math.abs(thumbT - beforeClose) < 0.3, `tray tile shows the remembered frame (${thumbT.toFixed(2)} s)`);
  
  // ── 4. Reopen: plays on from that frame ──
  await page.click('.cv-media-tile');
  await page.waitForSelector('.cv-media-full video');
  await sleep(1000);
  const reopened = await page.evaluate(() => {
    const v = document.querySelector('.cv-media-full video');
    return { t: v.currentTime, paused: v.paused };
  });
  check(!reopened.paused && reopened.t >= beforeClose && reopened.t < beforeClose + 2, `reopened playing from the frame (t=${reopened.t.toFixed(2)}, was ${beforeClose.toFixed(2)})`);
  // A tap toggles play/pause.
  await page.click('.cv-media-full video');
  await sleep(200);
  check(await page.evaluate(() => document.querySelector('.cv-media-full video').paused), 'tapping the video pauses it');
  await page.click('.cv-media-close');

  // ── 5. Agent close after the video ends (close_on_end) ──
  const ended = await tool('show_media', { items: [{ path: short }], autoplay: true, close_on_end: true, publish: false });
  await page.waitForSelector('.cv-media-full video');
  await page.waitForSelector('.cv-media-full', { state: 'detached', timeout: 6000 });
  st = await tool('media_control', { action: 'status', media_id: ended.items[0].media_id });
  check(st.playback?.state === 'closed', 'close_on_end closed it when it finished');

  // ── 6. auto_close_ms on an image; agent open/close ──
  const img = await tool('show_media', { items: [{ path: shot }], auto_close_ms: 1500, publish: false });
  await page.waitForSelector('.cv-media-full img');
  const t0 = Date.now();
  await page.waitForSelector('.cv-media-full', { state: 'detached', timeout: 4000 });
  const took = Date.now() - t0;
  check(took > 1000 && took < 3500, `auto_close_ms closed it after ~1.5 s (${took} ms)`);
  await tool('media_control', { action: 'open', media_id: img.items[0].media_id });
  await page.waitForSelector('.cv-media-full img');
    await tool('media_control', { action: 'close', media_id: img.items[0].media_id });
  await page.waitForSelector('.cv-media-full', { state: 'detached', timeout: 2000 });
  check(true, 'agent open / close work');

  // ── 7. Rules: autoplay only fullscreen ──
  const bad = await tool('show_media', { items: [{ path: video }], display: 'tray', autoplay: true });
  check(bad.ok === false && /fullscreen/.test(bad.error), `autoplay with tray is refused: ${bad.error}`);
  const trayOnly = await tool('show_media', { items: [{ path: video }], display: 'tray', publish: false });
  await sleep(500);
  check((await page.$('.cv-media-full')) === null && trayOnly.ok, 'tray display opens nothing');

  // ── 8. Self-destruct ──
  const sd = await tool('show_media', { items: [{ path: shot, caption: 'boom' }], display: 'tray', self_destruct: 5, publish: false });
  const sdSrcCount = async () => page.evaluate(() => [...document.querySelectorAll('.cv-media-tile-label')].filter((l) => l.textContent.includes('boom')).length);
  await page.click('.cv-media-fab');
  await sleep(300);
  if (!(await page.$('.cv-media-tray'))) await page.click('.cv-media-fab');
  check((await sdSrcCount()) === 1, 'self-destructing item is in the tray');
  await sleep(5600);
  check((await sdSrcCount()) === 0, 'it vanished from the phone after 5 s');
  st = await tool('media_control', { action: 'status', media_id: sd.items[0].media_id });
  check(st.ok === false, 'and from the bridge');

  // ── 9. Live: stream a file another agent is still writing ──
  const bytes = readFileSync(fullMp3);
  const live = await tool('show_media', { items: [{ path: liveMp3, live: true, caption: 'render' }], autoplay: true, publish: false });
  check(live.ok === true, `live item accepted before the file exists (${live.error ?? 'ok'})`);
  const liveId = live.items[0].media_id;
  let liveResponseDone = false;
  page.on('requestfinished', (r) => { if (r.url().includes(`/api/display/${liveId}`)) liveResponseDone = true; });
  const pieces = 8;
  const per = Math.ceil(bytes.length / pieces);
  for (let i = 0; i < pieces; i++) {
    await sleep(i === 0 ? 400 : 500);
    (i === 0 ? writeFileSync : appendFileSync)(liveMp3, bytes.subarray(i * per, (i + 1) * per));
    if (i === 6) {
      const mid = await page.evaluate(() => {
        const a = document.querySelector('.cv-media-full audio');
        return a ? { t: a.currentTime, paused: a.paused } : null;
      });
      check(mid && !mid.paused && mid.t > 0, `live audio is playing while the file is still being written (t=${mid?.t?.toFixed(2)})`);
      check(!liveResponseDone, 'its HTTP response is still open');
    }
  }
    await tool('media_control', { action: 'finish', media_id: liveId });
  await sleep(1500);
  check(liveResponseDone, 'finish ends the live response');
  await sleep(4000);
  const liveEnd = await page.evaluate(() => {
    const a = document.querySelector('.cv-media-full audio');
    return a ? { t: a.currentTime, ended: a.ended } : null;
  });
  check(liveEnd && liveEnd.t > 5, `whole live file played (t=${liveEnd?.t?.toFixed(2)})`);

  // ── 10. "never" lasts as long as the session: hang up → gone ──
  await page.click('.cv-media-close').catch(() => {});
  await tool('show_media', { items: [{ path: shot }], display: 'tray', self_destruct: 'never', publish: false });
  st = await tool('media_control', { action: 'status' });
  check(st.items.some((i) => i.self_destruct_in_s === 'never'), 'never item is listed with self_destruct_in_s "never"');
  await page.close();
  await sleep(3500);
  st = await tool('media_control', { action: 'status' });
  check(st.items.length === 0, `session end (grace over) cleared everything (${st.items.length} left)`);

  check(errors.length === 0, 'no page errors', errors.join(' | '));

  if (report.failures) {
    await page.screenshot({ path: join(av.tmp, 'page.png'), fullPage: true }).catch(() => {});
    say(`screenshot: ${join(av.tmp, 'page.png')}`);
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

say(report.failures === 0 ? 'PASS — show_media puts media on the phone and drives it' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
