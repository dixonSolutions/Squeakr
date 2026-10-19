import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentAudioStreams, CHUNK_BYTES, MAX_OPEN_STREAMS_PER_OWNER } from './streams.js';
import { AGENT_AUDIO_RATE, type DecodeDeps } from './decode.js';
import { wav } from './testWav.js';

type Frame = Record<string, unknown>;

/** ffmpeg stand-in: "decodes" anything to `ms` of silence after `delay` ms. */
function slowFfmpeg(ms: number, delay: number): DecodeDeps {
  return {
    ffmpeg: () => '/usr/bin/ffmpeg',
    runFfmpeg: (_bin, _input, _rate, signal) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(Buffer.alloc(Math.round((AGENT_AUDIO_RATE * ms) / 1000) * 2)), delay);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      }),
  };
}

function setup(opts: { listeners?: boolean; decode?: DecodeDeps; idleMs?: number } = {}) {
  const frames: Frame[] = [];
  const transcript: string[] = [];
  const streams = new AgentAudioStreams({
    send: (p) => frames.push(p),
    hasListeners: () => opts.listeners !== false,
    transcript: (l) => transcript.push(l),
    decode: opts.decode,
    idleMs: opts.idleMs,
  });
  return { streams, frames, transcript };
}

const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);

describe('AgentAudioStreams', () => {
  it('opens, sends decoded audio in 250 ms chunks, and drains on close', async () => {
    const { streams, frames, transcript } = setup();
    const opened = streams.open('mcp-1', { label: 'chime', mode: 'async', volume: 0.4 });
    assert.ok(opened.ok);
    const id = opened.stream.stream_id;
    assert.deepEqual(frames[0], {
      type: 'agent_audio',
      op: 'open',
      stream_id: id,
      label: 'chime',
      mode: 'async',
      volume: 0.4,
      sample_rate: AGENT_AUDIO_RATE,
      encoding: 'pcm_s16le',
      log: true,
    });

    const w = await streams.write('mcp-1', id, { kind: 'file', bytes: wav(1000, 24_000, 1), source: 'chime.wav' });
    assert.ok(w.ok);
    assert.equal(w.audio_ms, 1000);
    const chunks = frames.filter((f) => f['op'] === 'chunk');
    assert.equal(chunks.length, 4);
    assert.equal(Buffer.from(String(chunks[0]!['pcm']), 'base64').length, CHUNK_BYTES);
    assert.deepEqual(chunks.map((c) => c['seq']), [1, 2, 3, 4]);

    const closed = await streams.close('mcp-1', { ids: [id] });
    assert.ok(closed.ok);
    assert.equal(frames.at(-1)!['op'], 'end');
    assert.equal(closed.closed[0]!.close_reason, 'agent');
    assert.equal(transcript.length, 2);
  });

  it('plays writes in call order even when an earlier decode is slower', async () => {
    const { streams, frames } = setup({ decode: slowFfmpeg(250, 40) });
    const opened = streams.open('o', {});
    assert.ok(opened.ok);
    const id = opened.stream.stream_id;
    const slow = streams.write('o', id, { kind: 'file', bytes: mp3, source: 'slow.mp3' });
    const fast = streams.write('o', id, { kind: 'file', bytes: wav(250, 24_000, 1), source: 'fast.wav' });
    const [a, b] = await Promise.all([slow, fast]);
    assert.ok(a.ok && b.ok);
    assert.ok(a.seq < b.seq, 'the slow file was sent first');
    const sources = streams.list('o', { includeLog: true })[0]!.log!.filter((e) => e.event === 'write').map((e) => e.detail);
    assert.match(sources[0]!, /^slow\.mp3/);
    assert.match(sources[1]!, /^fast\.wav/);
    assert.equal(frames.filter((f) => f['op'] === 'chunk').length, 2);
  });

  it('closes many at once, and stop cuts a decode in flight', async () => {
    const { streams, frames } = setup({ decode: slowFfmpeg(1000, 200) });
    const ids = [0, 1, 2].map(() => {
      const r = streams.open('o', { mode: 'queue' });
      assert.ok(r.ok);
      return r.stream.stream_id;
    });
    const pending = streams.write('o', ids[0]!, { kind: 'file', bytes: mp3, source: 'long.mp3' });
    const closed = await streams.close('o', { all: true, drain: false });
    assert.equal(closed.closed.length, 3);
    assert.ok(closed.closed.every((s) => s.close_reason === 'agent_stop'));
    const w = await pending;
    assert.equal(w.ok, false);
    assert.equal(frames.filter((f) => f['op'] === 'chunk').length, 0);
    assert.equal(frames.filter((f) => f['op'] === 'stop').length, 3);
    assert.equal(streams.list('o').length, 0);
    assert.equal(streams.list('o', { includeClosed: true }).length, 3);
  });

  it('keeps streams to their owner', async () => {
    const { streams } = setup();
    const r = streams.open('alice', {});
    assert.ok(r.ok);
    const w = await streams.write('bob', r.stream.stream_id, { kind: 'file', bytes: wav(100), source: 'x.wav' });
    assert.equal(w.ok, false);
    assert.equal(!w.ok && w.error, 'NOT_OWNER');
    const c = await streams.close('bob', { ids: [r.stream.stream_id] });
    assert.equal(c.errors[0]!.error, 'NOT_OWNER');
    assert.equal(streams.list('alice').length, 1);
    assert.equal(streams.list('bob').length, 0);
  });

  it('takes raw packets only on a stream opened with a format', async () => {
    const { streams, frames } = setup();
    const plain = streams.open('o', {});
    assert.ok(plain.ok);
    const refused = await streams.write('o', plain.stream.stream_id, { kind: 'packet', bytes: Buffer.alloc(10) });
    assert.equal(!refused.ok && refused.error, 'BAD_FORMAT');

    const live = streams.open('o', { packetFormat: { encoding: 'pcm_s16le', sampleRate: 48_000, channels: 1 } });
    assert.ok(live.ok);
    assert.equal(live.stream.packet_format, 'pcm_s16le 48000 Hz × 1');
    let total = 0;
    for (let i = 0; i < 10; i++) {
      const w = await streams.write('o', live.stream.stream_id, { kind: 'packet', bytes: Buffer.alloc(9_601) });
      assert.ok(w.ok);
      total = w.total_audio_ms;
    }
    assert.ok(Math.abs(total - 1000) <= 2, `got ${total}`);
    assert.ok(frames.filter((f) => f['op'] === 'chunk').length >= 10);
  });

  it('refuses to open with nobody listening, and caps streams per owner', () => {
    assert.equal(setup({ listeners: false }).streams.open('o', {}).ok, false);
    const { streams } = setup();
    for (let i = 0; i < MAX_OPEN_STREAMS_PER_OWNER; i++) assert.ok(streams.open('o', {}).ok);
    const over = streams.open('o', {});
    assert.equal(!over.ok && over.error, 'TOO_MANY_STREAMS');
    assert.ok(streams.open('someone-else', {}).ok);
  });

  it('logs playback reports and agent notes, and keeps quiet streams out of the transcript', () => {
    const { streams, frames, transcript } = setup();
    const r = streams.open('o', { label: 'feed', log: false });
    assert.ok(r.ok);
    const id = r.stream.stream_id;
    streams.reportPlayback('phone', id, 'playing');
    streams.reportPlayback('phone', id, 'playing');
    const noted = streams.note('o', [id], 'weather radio, user asked for it');
    assert.ok(noted.ok);
    const entries = noted.streams[0]!.log!;
    assert.deepEqual(entries.map((e) => e.event), ['opened', 'playback', 'note']);
    assert.equal(noted.streams[0]!.playback['phone'], 'playing');
    assert.equal(transcript.length, 0);
    assert.equal(frames.filter((f) => f['type'] === 'session_log').length, 0);
  });

  it('closes an idle stream, and an owner that goes away', async () => {
    const { streams, frames } = setup({ idleMs: 20 });
    const r = streams.open('o', {});
    assert.ok(r.ok);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(streams.list('o').length, 0);
    assert.equal(frames.at(-1)!['reason'], 'idle');

    const again = setup();
    again.streams.open('gone', {});
    again.streams.open('gone', {});
    await again.streams.closeOwner('gone');
    assert.equal(again.frames.filter((f) => f['reason'] === 'owner_gone').length, 2);
  });
});
