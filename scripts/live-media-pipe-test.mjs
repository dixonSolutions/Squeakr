#!/usr/bin/env node
/**
 * End-to-end: the media pipe (docs/46) against a real bridge.
 *
 * `squeakr run` with the harness's stand-in Whisper and the stub agent as
 * "Claude Code". This script plays the phone: it uploads over HTTP, sends
 * turns on /ws, and connects to /mcp as an agent would to look at uploads.
 *
 * Asserts:
 *   - /api/media/capabilities answers; uploads need the app token
 *   - a PNG is stored, a WAV memo comes back transcribed through the STT chain,
 *     and a `../` file name cannot leave the media directory
 *   - view_media returns the files with the transcript, an image block, and
 *     the listener envelope; an unknown id is a clean MEDIA_NOT_FOUND
 *   - view_media is registered once, and the startup log's tool count is real
 *   - attach with no agent running waits for the next turn, and goes with it
 *   - a turn with media spawns the agent and carries paths, transcript and the
 *     view_media hint
 *   - a follow-up turn "into chat" reaches the running agent's
 *     next_voice_turn with its media ids and the picture as an image block
 *   - attach while the agent is busy rides out on its next Squeakr tool call,
 *     picture included — without being a new turn
 *
 * Usage:
 *   npm run build:backend && node scripts/live-media-pipe-test.mjs [--keep]
 */

import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebSocket } from 'ws';
import { createInstance, makeReporter, ROOT, speechWav } from './e2e-harness.mjs';

const KEEP = process.argv.includes('--keep');
const BIN = [process.execPath, join(ROOT, 'dist', 'cli.js')];
const MEMO = 'remember to buy more cheese';

// The stub holds a STUB_PAUSE reply this long — the window for an attach.
process.env.STUB_PAUSE_MS = '3000';

const report = makeReporter();
const { say, check, fail } = report;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 20_000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// 1×1 red PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const av = await createInstance({ bin: BIN, canned: [MEMO] });

async function upload(name, mime, body, token = av.token) {
  const res = await fetch(`${av.base}/api/media?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': mime },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const json = (res) => JSON.parse(res.text);

let client = null;
let transport = null;
let ws = null;

try {
  await av.startBridge();
  say(`bridge up at ${av.base}`);

  // ── Uploads ──────────────────────────────────────────────────────────────
  const caps = json(await av.api('/api/media/capabilities'));
  say(`capabilities: ${JSON.stringify(caps)}`);
  check(typeof caps.max_bytes === 'number' && caps.transcription === true, 'capabilities answer, transcription ready');
  check(caps.inline?.supported === true && caps.inline.cli === 'Claude Code', 'Claude Code declares inline pictures');

  const unauth = await upload('x.png', 'image/png', PNG, null);
  check(unauth.status === 401, 'upload without the app token is refused', String(unauth.status));

  const img = await upload('shot.png', 'image/png', PNG);
  check(img.status === 200 && img.json?.kind === 'image' && img.json.inline === true, 'a PNG is stored with an inline copy', JSON.stringify(img.json));

  const memo = await upload('memo.wav', 'audio/wav', speechWav([['speech', 1200]], { rate: 16_000, channels: 1 }));
  check(
    memo.status === 200 && memo.json?.transcript_status === 'done' && memo.json.transcript === MEMO,
    'a WAV memo comes back transcribed through the STT chain',
    JSON.stringify(memo.json),
  );
  check(av.sttRequests.length === 1, 'the memo went to the speech engine once', String(av.sttRequests.length));

  const evil = await upload('../../etc/evil.png', 'image/png', PNG);
  check(evil.status === 200 && evil.json?.name === 'evil.png', 'a ../ file name is reduced to its base name', JSON.stringify(evil.json));

  // ── MCP: what an agent sees ───────────────────────────────────────────────
  client = new Client({ name: 'e2e-agent', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(new URL(`${av.base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${av.token}` } },
  });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check(tools.filter((t) => t === 'view_media').length === 1, 'view_media is registered once');
  check(new Set(tools).size === tools.length, 'no tool registered twice');
  const logged = Number(av.bridgeOutput().match(/registered at \/mcp \((\d+) tools\)/)?.[1]);
  check(logged === tools.length, `startup log tool count is real (${logged} vs ${tools.length})`);

  const view = await client.callTool({ name: 'view_media', arguments: { ids: [img.json.id, memo.json.id, evil.json.id] } });
  const summary = JSON.parse(view.content[0].text);
  check(!view.isError && summary.found.length === 3, 'view_media finds all three uploads');
  check(summary.files.includes(`> ${MEMO}`), 'view_media carries the memo transcript');
  check(view.content.filter((c) => c.type === 'image').length === 2, 'view_media returns the pictures as image blocks');
  check('listener' in summary, 'view_media still gets the listener envelope');
  const mediaDir = join(av.instance, 'data', 'media');
  const evilPath = summary.files.split('\n').find((l) => l.includes('"evil.png"'))?.split('): ')[1] ?? '';
  check(evilPath.startsWith(mediaDir), 'the ../ upload stays inside the media directory', evilPath);

  const missing = await client.callTool({ name: 'view_media', arguments: { ids: ['nope'] } });
  check(missing.isError === true && missing.content[0].text.includes('MEDIA_NOT_FOUND'), 'an unknown id is a clean MEDIA_NOT_FOUND');
  await transport.terminateSession();
  await client.close();
  client = null;

  const staged = json(await av.api('/api/media/attach', { ids: [memo.json.id], delivery: 'path' }));
  check(staged.ok && staged.when === 'next_turn', 'attach with no agent running waits for the next turn', JSON.stringify(staged));

  // ── Turns from the phone, to the stub agent ──────────────────────────────
  check((await av.api('/api/active-project', { project: 'e2e' })).status === 200, 'project selected');
  // What the phone does before its first turn: register the MCP server with the CLI.
  const prep = await av.api('/api/voice-session/prepare', { project: 'e2e' });
  check(prep.text.includes('"ok":true'), 'voice session prepared', prep.text.slice(-300));
  const spoken = [];
  ws = new WebSocket(`${av.base.replace(/^http/, 'ws')}/ws`);
  await new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: av.token })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'speak') spoken.push(m.text);
      if (m.type === 'auth_ok') resolve();
    });
  });
  const turn = (text, media) =>
    ws.send(JSON.stringify({ type: 'user_turn', text, ...(media ? { media_ids: media.ids, media_delivery: media.delivery } : {}) }));
  const heard = (re, what) => until(() => spoken.some((t) => re.test(t)), 20_000, what);

  // 1. Opening turn with a picture: the agent is spawned with it.
  turn('what is in this picture', { ids: [img.json.id], delivery: 'inline' });
  await heard(/^ECHO boot:/, 'the agent to start');
  say(`agent said: ${spoken.at(-1)}`);
  const stored = json(await av.api('/api/turns?project=e2e')).turns.filter((t) => t.role === 'user');
  const opening = stored.at(-1)?.text ?? '';
  check(opening.startsWith('what is in this picture'), 'the opening turn keeps what was typed first');
  check(opening.includes(join(mediaDir, '')) && opening.includes('"shot.png"'), 'the opening turn lists the picture by path');
  check(opening.includes(`view_media(ids=["${img.json.id}"])`), 'the opening turn names view_media for the picture');
  check(opening.includes('attached a file to the conversation') && opening.includes(`> ${MEMO}`), 'the earlier attach went with it, transcript included');
  check(json(await av.api('/api/media/capabilities')).attached === 0, 'the staged attach was consumed');

  // 2. Follow-up "into chat" while the agent waits in next_voice_turn.
  await sleep(500);
  turn('and this one?', { ids: [img.json.id], delivery: 'inline' });
  await heard(/^ECHO phone: and this one\?/, 'the follow-up echo');
  const echoed = spoken.find((t) => t.startsWith('ECHO phone: and this one?')) ?? '';
  say(`agent said: ${echoed}`);
  check(/\[media 1 inline images=1\]/.test(echoed), 'next_voice_turn carried the media id and the picture as an image block', echoed);

  // 3. Attach while the agent is busy (not polling): rides its next tool call.
  await sleep(500);
  const userTurns = async () => json(await av.api('/api/turns?project=e2e')).turns.filter((t) => t.role === 'user').length;
  const usersBefore = await userTurns();
  turn('hold on STUB_PAUSE');
  await sleep(800); // the agent has the turn and is "working" (STUB_PAUSE_MS)
  const busy = json(await av.api('/api/media/attach', { ids: [img.json.id], delivery: 'inline' }));
  check(busy.ok && busy.when === 'next_tool_call', 'attach while the agent runs targets its next tool call', JSON.stringify(busy));
  await heard(/^ATTACHED /, 'the attach to reach the agent');
  const got = spoken.find((t) => t.startsWith('ATTACHED ')) ?? '';
  say(`agent said: ${got}`);
  check(/^ATTACHED 1 images=1 via speak$/.test(got), 'the attach arrived on the agent\'s next Squeakr result, with the picture', got);
  check((await userTurns()) === usersBefore + 1, 'the attach did not become a turn of its own (only "hold on" was added)');
  check(json(await av.api('/api/media/capabilities')).attached === 0, 'nothing left staged');
} catch (err) {
  fail(err);
} finally {
  ws?.close();
  await client?.close().catch(() => {});
  const keep = KEEP || report.failures > 0;
  if (report.failures > 0) say(av.bridgeOutput().split('\n').filter((l) => /"level":(40|50)|\[stub/.test(l)).slice(-15).join('\n'));
  await av.cleanup(keep);
  say(report.failures ? `FAIL — ${report.failures} check(s) failed (kept ${av.tmp})` : `PASS — media pipe${keep ? ` (kept ${av.tmp})` : ''}`);
  process.exit(report.failures ? 1 : 0);
}
