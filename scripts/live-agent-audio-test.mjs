#!/usr/bin/env node
/**
 * End-to-end test of agent audio streams (docs/47).
 *
 * A fresh bridge (`squeakr run`), two real MCP sessions over Streamable HTTP
 * standing in for agents, and a socket impersonating the phone on /ws that
 * reports playback the way the PWA does.
 *
 * Asserts:
 *   - an async stream fed a 44.1 kHz stereo WAV file reaches the phone as
 *     24 kHz PCM chunks, framed by open … end
 *   - a queue stream fed raw 48 kHz PCM packets arrives in order
 *   - another MCP session can neither write to nor close those streams
 *   - one close call ends several streams; the phone's playback reports land
 *     in each stream's log, next to the agent's own note
 *   - a stream left open is closed (drained) when its MCP session ends
 *   - the bridge log and the session transcript record the streams
 *
 * Usage:
 *   npm run build:backend && node scripts/live-agent-audio-test.mjs [--bin squeakr] [--keep]
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createInstance, makeReporter, ROOT, speechWav } from './e2e-harness.mjs';

const args = process.argv.slice(2);
const binFlag = args.indexOf('--bin');
const BIN = binFlag !== -1 ? [args[binFlag + 1]] : [process.execPath, join(ROOT, 'dist', 'cli.js')];
const KEEP = args.includes('--keep');

const report = makeReporter();
const { say, check, fail } = report;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The phone: collects agent_audio frames and reports playback like web/src/agent-audio.ts. */
function phone(base, token) {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
  const streams = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth_ok') resolve();
      if (msg.type !== 'agent_audio') return;
      const state = (s) => ws.send(JSON.stringify({ type: 'agent_audio_state', stream_id: msg.stream_id, state: s }));
      if (msg.op === 'open') streams.set(msg.stream_id, { open: msg, bytes: 0, seqs: [], closed: null });
      const s = streams.get(msg.stream_id);
      if (!s) return;
      if (msg.op === 'chunk') {
        if (s.bytes === 0) state('playing');
        s.bytes += Buffer.from(msg.pcm, 'base64').length;
        s.seqs.push(msg.seq);
      }
      if (msg.op === 'end' || msg.op === 'stop') {
        s.closed = msg;
        state(msg.op === 'end' ? 'ended' : 'stopped');
      }
    });
  });
  return { ws, streams, ready };
}

async function agent(base, token, name) {
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  const call = async (tool, toolArgs = {}) => {
    const res = await client.callTool({ name: tool, arguments: toolArgs });
    return JSON.parse(res.content[0].text);
  };
  return { client, transport, call };
}

const av = await createInstance({ bin: BIN, canned: [] });

try {
  say(`scratch: ${av.tmp}`);
  await av.startBridge();
  say('bridge up');

  const ph = phone(av.base, av.token);
  await ph.ready;
  say('phone connected');

  const a = await agent(av.base, av.token, 'agent-a');
  const b = await agent(av.base, av.token, 'agent-b');
  const tools = (await a.client.listTools()).tools.map((t) => t.name);
  check(
    ['audio_stream_open', 'audio_stream_write', 'audio_stream_close', 'audio_stream_list', 'audio_stream_log'].every((t) => tools.includes(t)),
    'the five audio_stream tools are on the MCP server',
  );

  // ── async stream, a WAV file from the project ───────────────────────────
  const wavPath = join(av.project, 'chime.wav');
  writeFileSync(wavPath, speechWav([['tone', 1000]], { rate: 44_100, channels: 2 }));
  const chime = await a.call('audio_stream_open', { label: 'chime', mode: 'async', volume: 0.4 });
  check(chime.ok && /^aud_/.test(chime.stream_id), 'opened an async stream', JSON.stringify(chime));
  const w1 = await a.call('audio_stream_write', { stream_id: chime.stream_id, path: wavPath });
  check(w1.ok && Math.abs(w1.audio_ms - 1000) <= 2 && /WAV 16-bit PCM 44100 Hz × 2/.test(w1.format), 'wrote a 44.1 kHz stereo WAV', JSON.stringify(w1));

  // ── queue stream, raw packets ───────────────────────────────────────────
  const feed = await a.call('audio_stream_open', { label: 'feed', format: { sample_rate: 48_000, channels: 1 } });
  check(feed.ok && feed.mode === 'queue', 'opened a queue stream for 48 kHz packets', JSON.stringify(feed));
  for (let i = 0; i < 4; i++) {
    const pkt = Buffer.alloc(9_601 + i); // odd sizes: samples split across packets
    const w = await a.call('audio_stream_write', { stream_id: feed.stream_id, packet: pkt.toString('base64') });
    if (!w.ok) fail(`packet ${i} refused: ${JSON.stringify(w)}`);
  }

  // ── ownership ───────────────────────────────────────────────────────────
  const stolen = await b.call('audio_stream_write', { stream_id: chime.stream_id, data: 'AQID' });
  check(stolen.ok === false && stolen.error === 'NOT_OWNER', "another session cannot write to it", JSON.stringify(stolen));
  const stolenClose = await b.call('audio_stream_close', { stream_ids: [chime.stream_id] });
  check(stolenClose.errors?.[0]?.error === 'NOT_OWNER', "…nor close it", JSON.stringify(stolenClose));
  check((await b.call('audio_stream_list')).streams.length === 0, "and does not see it in its list");

  // ── one more left open, then close the two in one call ──────────────────
  const leftover = await a.call('audio_stream_open', { label: 'leftover', log: false });
  const closed = await a.call('audio_stream_close', { stream_ids: [chime.stream_id, feed.stream_id] });
  check(closed.ok && closed.closed.length === 2, 'closed two streams in one call', JSON.stringify(closed));
  await sleep(300);

  const pc = ph.streams.get(chime.stream_id);
  check(pc?.open.mode === 'async' && pc.open.sample_rate === 24_000, 'phone got the async open at 24 kHz', JSON.stringify(pc?.open));
  check(pc && Math.abs(pc.bytes / 2 - 24_000) <= 2 && pc.closed?.op === 'end', 'phone got 1 s of audio, then end', JSON.stringify({ bytes: pc?.bytes, closed: pc?.closed }));
  const pf = ph.streams.get(feed.stream_id);
  check(pf && pf.seqs.every((s, i) => s === i + 1), 'packet chunks arrived in order', JSON.stringify(pf?.seqs));
  check(pf && Math.abs(pf.bytes / 2 - 24_000 * 0.4) <= 4, '0.4 s of 48 kHz packets arrived as 24 kHz', String(pf?.bytes));

  await a.call('audio_stream_log', { stream_ids: [chime.stream_id], note: 'played because the build finished' });
  const listed = await a.call('audio_stream_list', { include_closed: true, include_log: true });
  const chimeLog = listed.streams.find((s) => s.stream_id === chime.stream_id);
  const events = chimeLog?.log.map((e) => `${e.event}:${e.detail}`) ?? [];
  say(`chime log: ${JSON.stringify(events)}`);
  check(chimeLog?.playback.phone === 'ended', 'the phone reported the chime ended', JSON.stringify(chimeLog?.playback));
  check(
    ['opened', 'write', 'playback', 'closed', 'note'].every((e) => events.some((x) => x.startsWith(`${e}:`))),
    'the stream log has open, write, playback, close and the note',
  );
  check(listed.open === 1, 'one stream still open', JSON.stringify(listed.open));

  // ── one call: open + write + close ──────────────────────────────────────
  const shot = await a.call('audio_stream_open', { label: 'one-shot', mode: 'async', path: wavPath, close: true });
  check(shot.ok && shot.state === 'closed' && Math.abs(shot.written_ms - 1000) <= 2, 'one call opens, writes and closes a stream', JSON.stringify(shot));
  await sleep(300);
  const ps = ph.streams.get(shot.stream_id);
  check(ps && Math.abs(ps.bytes / 2 - 24_000) <= 2 && ps.closed?.op === 'end', 'the one-shot reached the phone and ended', JSON.stringify({ bytes: ps?.bytes, closed: ps?.closed }));
  const badPath = await a.call('audio_stream_open', { path: '/etc/passwd', close: true });
  check(badPath.ok === false && badPath.error === 'BAD_INPUT' && !badPath.stream_id, 'a path outside projects/temp is refused before any stream opens', JSON.stringify(badPath));
  const notAudio = join(av.project, 'notes.txt');
  writeFileSync(notAudio, 'not audio at all');
  const bad = await a.call('audio_stream_open', { path: notAudio });
  check(bad.ok === false && bad.closed === true, 'undecodable audio closes the stream it opened', JSON.stringify(bad));

  // ── the session ends with a stream open ─────────────────────────────────
  await a.transport.terminateSession();
  await a.client.close();
  await sleep(500);
  const pl = ph.streams.get(leftover.stream_id);
  check(pl?.closed?.op === 'end' && pl.closed.reason === 'owner_gone', 'a stream left open is drained when its session ends', JSON.stringify(pl?.closed));
  await b.client.close();
  ph.ws.close();
  await sleep(300);

  const bridgeLog = av.readNewest('bridge');
  check(/agent audio opened/.test(bridgeLog) && /agent audio closed/.test(bridgeLog), 'the bridge log records the streams');
  const transcript = av.readNewest('transcripts');
  check(/audio stream "chime"/.test(transcript), 'the transcript records the chime', transcript.slice(-600));
  check(!/leftover/.test(transcript), 'log: false keeps a stream out of the transcript');
} catch (err) {
  fail(err);
  say(av.bridgeOutput().slice(-3000));
} finally {
  const keep = KEEP || report.failures > 0;
  await av.cleanup(keep);
  if (keep) say(`kept scratch dir: ${av.tmp}`);
}

say(report.failures === 0 ? 'PASS — agent audio streams work end to end' : `FAIL — ${report.failures} check(s) failed`);
process.exit(report.failures === 0 ? 0 : 1);
