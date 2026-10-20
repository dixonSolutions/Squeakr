import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AgentAudioPlayer, type AgentAudioDeps, type AgentAudioState } from './agent-audio.js';
import type { PcmBufferLike, PcmContextLike, PcmSourceLike } from './pcm-scheduler.js';

/** A context whose clock the test moves; sources end when the clock passes them. */
function fakeContext() {
  const live: Array<{ end: number; src: PcmSourceLike }> = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 48_000,
    createBuffer(_c: number, length: number, rate: number): PcmBufferLike {
      const data = new Float32Array(length);
      return Object.assign({ getChannelData: () => data }, { seconds: length / rate });
    },
    createBufferSource(): PcmSourceLike {
      const src: PcmSourceLike = {
        buffer: null,
        onended: null,
        connect: () => undefined,
        start(when: number) {
          live.push({ end: when + (this.buffer as { seconds: number }).seconds, src: this });
        },
        stop: () => undefined,
        disconnect: () => undefined,
      };
      return src;
    },
  };
  const advance = (sec: number) => {
    ctx.currentTime += sec;
    for (const s of live.splice(0)) {
      if (s.end <= ctx.currentTime) s.src.onended?.();
      else live.push(s);
    }
  };
  return { ctx: ctx as PcmContextLike & { currentTime: number }, advance, scheduled: () => live.length };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** 250 ms of 24 kHz PCM16, base64. */
const CHUNK = Buffer.alloc(12_000).toString('base64');

function setup(extra: Partial<AgentAudioDeps> = {}) {
  const clock = fakeContext();
  const reports: Array<[string, AgentAudioState]> = [];
  const lines: string[] = [];
  const asyncChanges: boolean[] = [];
  const player = new AgentAudioPlayer({
    context: () => clock.ctx,
    output: () => ({ node: {}, release: () => undefined }),
    enqueueLine: (l) => lines.push(l),
    report: (id, state) => reports.push([id, state]),
    onAsyncActiveChange: (a) => asyncChanges.push(a),
    // Ticks fire on the next macrotask so tests can step through the feeder.
    setTimer: (fn) => setTimeout(fn, 0),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    ...extra,
  });
  return { player, clock, reports, lines, asyncChanges };
}

const open = (id: string, mode: 'queue' | 'async') => ({ type: 'agent_audio', op: 'open', stream_id: id, label: id, mode, sample_rate: 24_000 });
const chunk = (id: string) => ({ type: 'agent_audio', op: 'chunk', stream_id: id, pcm: CHUNK });
const end = (id: string) => ({ type: 'agent_audio', op: 'end', stream_id: id });

describe('AgentAudioPlayer', () => {
  it('plays an async stream at once and reports playing then ended', async () => {
    const { player, clock, reports, asyncChanges } = setup();
    player.handle(open('a', 'async'));
    assert.equal(player.asyncActive, false, 'nothing to play yet');
    player.handle(chunk('a'));
    assert.equal(player.asyncActive, true);
    player.handle(chunk('a'));
    player.handle(end('a'));
    await flush();
    assert.deepEqual(reports, [['a', 'playing']]);
    clock.advance(1);
    await flush();
    await flush();
    assert.deepEqual(reports, [['a', 'playing'], ['a', 'ended']]);
    assert.deepEqual(asyncChanges, [true, false]);
  });

  it('only schedules about two seconds ahead of the playhead', async () => {
    const { player, clock } = setup();
    player.handle(open('a', 'async'));
    for (let i = 0; i < 40; i++) player.handle(chunk('a')); // 10 s
    await flush();
    assert.ok(clock.scheduled() <= 9, `scheduled ${clock.scheduled()} chunks`);
    player.stopAll();
    await flush();
  });

  it('puts a queued stream in the speech pile and plays it when its turn comes', async () => {
    const { player, clock, reports, lines } = setup();
    player.handle(open('q', 'queue'));
    assert.equal(lines.length, 0, 'an empty stream does not hold the speech queue');
    player.handle(chunk('q'));
    assert.equal(lines.length, 1);
    assert.ok(player.isStreamLine(lines[0]!));
    assert.equal(player.asyncActive, false);
    player.handle(end('q'));
    assert.deepEqual(reports, []);

    let started = false;
    const done = player.playQueued(lines[0]!, { signal: new AbortController().signal, baseVolume: 1, onStart: () => (started = true) });
    await flush();
    assert.ok(started);
    clock.advance(1);
    await done;
    assert.deepEqual(reports, [['q', 'playing'], ['q', 'ended']]);
    assert.equal(player.isStreamLine(lines[0]!), false);
  });

  it('keeps a queued stream across a barge-in pause and drops it when the pile discards it', async () => {
    const { player, reports, lines } = setup();
    player.handle(open('q', 'queue'));
    player.handle(chunk('q'));
    const pause = new AbortController();
    const playing = player.playQueued(lines[0]!, { signal: pause.signal, baseVolume: 1, onStart: () => undefined });
    await flush();
    pause.abort();
    await playing;
    assert.ok(player.isStreamLine(lines[0]!), 'kept for resume');
    player.discardLines(lines);
    assert.deepEqual(reports.at(-1), ['q', 'stopped']);
    assert.equal(player.isStreamLine(lines[0]!), false);
  });

  it('steps out of the speech queue when it runs dry, and rejoins when more audio comes', async () => {
    const { player, clock, reports, lines } = setup();
    player.handle(open('q', 'queue'));
    player.handle(chunk('q'));
    const first = player.playQueued(lines[0]!, { signal: new AbortController().signal, baseVolume: 1, onStart: () => undefined });
    await flush();
    clock.advance(1);
    await first; // played out, never closed: resolves instead of holding the queue
    assert.deepEqual(reports, [['q', 'playing']]);
    assert.ok(player.isStreamLine(lines[0]!), 'still open');
    player.handle(chunk('q'));
    assert.equal(lines.length, 2, 'queued again for the new audio');
    player.handle(end('q'));
    const second = player.playQueued(lines[1]!, { signal: new AbortController().signal, baseVolume: 1, onStart: () => undefined });
    await flush();
    clock.advance(1);
    await second;
    assert.deepEqual(reports, [['q', 'playing'], ['q', 'ended']]);

    // Ran dry and then closed with nothing more: over without another turn.
    player.handle(open('r', 'async'));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(player.asyncActive, false, 'an empty async stream does not keep the mic paused');
    player.handle(end('r'));
    assert.deepEqual(reports.at(-1), ['r', 'ended']);
  });

  it('stops on the bridge\'s stop, and reports streams it will not play', async () => {
    const { player, reports } = setup({ enabled: () => false });
    player.handle(open('off', 'async'));
    assert.deepEqual(reports, [['off', 'stopped']]);

    const on = setup();
    on.player.handle(open('a', 'async'));
    on.player.handle(chunk('a'));
    await flush();
    on.player.handle({ type: 'agent_audio', op: 'stop', stream_id: 'a' });
    await flush();
    assert.deepEqual(on.reports, [['a', 'playing'], ['a', 'stopped']]);
    assert.equal(on.player.asyncActive, false);
  });
});
