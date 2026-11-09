import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import { monoToStereoPcm16, OpusEncoder } from '../audio.js';
import type { CallDenoiser, DenoiserFactory } from '../denoise.js';
import { DiscordCall } from './discordVoice.js';

/**
 * A stand-in for @discordjs/voice: the receiver emits Opus packets per user
 * the way the library does after decrypting them, and the player collects
 * the raw 48 kHz stereo PCM it would encode and send.
 */
function fakeVoice() {
  const speaking = new EventEmitter();
  const streams = new Map<string, EventEmitter>();
  const subscribed: Array<{ userId: string; end: unknown }> = [];
  const player = Object.assign(new EventEmitter(), {
    played: [] as Buffer[],
    stopped: 0,
    play(resource: { stream: Readable }) {
      const parts: Buffer[] = [];
      resource.stream.on('data', (c: Buffer) => parts.push(c));
      resource.stream.on('end', () => {
        player.played.push(Buffer.concat(parts));
        setImmediate(() => player.emit('idle'));
      });
    },
    stop() {
      player.stopped++;
    },
  });
  const connection = Object.assign(new EventEmitter(), {
    destroyed: false,
    receiver: {
      speaking,
      subscribe(userId: string, opts: { end: unknown }) {
        subscribed.push({ userId, end: opts.end });
        const s = new EventEmitter();
        streams.set(userId, s);
        return s;
      },
    },
    subscribe() {},
    destroy() {
      connection.destroyed = true;
    },
  });
  const module = {
    joinVoiceChannel: () => connection,
    entersState: async () => connection,
    createAudioPlayer: () => player,
    createAudioResource: (stream: Readable) => ({ stream }),
    VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed', Signalling: 'signalling', Connecting: 'connecting' },
    AudioPlayerStatus: { Idle: 'idle' },
    NoSubscriberBehavior: { Pause: 'pause' },
    StreamType: { Raw: 'raw' },
    EndBehaviorType: { AfterSilence: 1 },
  };
  return { module, speaking, streams, subscribed, player, connection };
}

/** 20 ms Opus packets of a tone, as a Discord client sends them. */
function opusPackets(ms: number): Buffer[] {
  const enc = new OpusEncoder(2, 64_000);
  const packets: Buffer[] = [];
  for (let f = 0; f < ms / 20; f++) {
    const frame = Buffer.alloc(960 * 2);
    for (let i = 0; i < 960; i++) frame.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * (f * 960 + i)) / 48_000) * 12000), i * 2);
    packets.push(enc.encode(monoToStereoPcm16(frame)));
  }
  enc.close();
  return packets;
}

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeCall(allowed: string[], denoiser: DenoiserFactory | null = null) {
  const v = fakeVoice();
  const heard: Array<{ seconds: number }> = [];
  const delivered: string[] = [];
  let send: ((p: unknown) => void) | null = null;
  const call = new DiscordCall({
    voice: v.module as never,
    guildId: 'g1',
    channelId: 'vc1',
    channelName: 'Dev',
    adapterCreator: (() => ({})) as never,
    isAllowed: (id) => allowed.includes(id),
    nameOf: (id) => (id === 'u1' ? 'Ana' : id),
    silenceMs: 700,
    denoiser: async () => denoiser,
    callDeps: {
      transcribe: async (pcm) => {
        heard.push({ seconds: pcm.length / 2 / 16_000 });
        return { text: 'fix the build' };
      },
      deliver: (text, source) => {
        delivered.push(`${source}|${text}`);
        return { ok: true, delivery: 'spawn' };
      },
      synthesize: async () => ({
        sampleRate: 24_000,
        chunks: (async function* () {
          yield Buffer.alloc(24_000 * 2 * 0.1, 1); // 100 ms
          yield Buffer.alloc(24_000 * 2 * 0.1, 1);
        })(),
      }),
      registerVoiceSession: (s) => {
        send = s;
        return () => (send = null);
      },
      registerPresence: () => ({ release() {} }),
      prepare: async () => undefined,
      segmentSettings: () => ({ segmentSilenceMs: 700, maxSegmentMs: 15_000, minSpeechMs: 300, speechThreshold: 0.012, preRollMs: 300 }),
      turnSettings: () => ({ inputMode: 'turns', wakeWordsEnabled: false, wakeWords: { start: 'hey squeaker' }, turnSubmit: { silenceMs: 700, vadEnabled: true } }),
    },
  });
  return { v, call, heard, delivered, speak: (text: string) => send?.({ type: 'speak', text }) };
}

describe('DiscordCall', () => {
  it('decodes an allowlisted member’s Opus, cuts it when Discord ends their stream, and hands it to the agent', async () => {
    const { v, call, heard, delivered } = makeCall(['u1']);
    await call.join();
    v.speaking.emit('start', 'u1');
    assert.deepEqual(v.subscribed, [{ userId: 'u1', end: { behavior: 1, duration: 700 } }]);
    const stream = v.streams.get('u1')!;
    for (const p of opusPackets(1000)) stream.emit('data', p);
    await flush();
    assert.equal(delivered.length, 0, 'still talking');
    stream.emit('end');
    await flush();
    assert.deepEqual(delivered, ['discord|fix the build']);
    assert.ok(Math.abs(heard[0]!.seconds - 1) < 0.05, `16 kHz audio the length of what was said: ${heard[0]!.seconds}s`);
    await call.leave();
    assert.equal(v.connection.destroyed, true);
  });

  it('denoises each member with their own suppressor, kept for the whole call', async () => {
    const made: Array<{ samples: number; closed: number }> = [];
    const factory: DenoiserFactory = () => {
      const d = { samples: 0, closed: 0 };
      made.push(d);
      return {
        process(pcm: Buffer) {
          d.samples += pcm.length >> 1;
          return pcm;
        },
        close() {
          d.closed++;
        },
      } as unknown as CallDenoiser;
    };
    const { v, call, delivered } = makeCall(['u1'], factory);
    await call.join();
    await flush();
    for (let turn = 0; turn < 2; turn++) {
      v.speaking.emit('start', 'u1');
      const stream = v.streams.get('u1')!;
      for (const p of opusPackets(400)) stream.emit('data', p);
      stream.emit('end');
      await flush();
    }
    assert.equal(made.length, 1, 'one suppressor across both utterances');
    assert.equal(made[0]!.samples, 2 * 0.4 * 48_000, 'every 48 kHz mono sample went through it');
    assert.equal(delivered.length, 2);
    await call.leave();
    assert.equal(made[0]!.closed, 1);
  });

  it('ignores members who are not on the allowlist', async () => {
    const { v, call } = makeCall(['u1']);
    await call.join();
    v.speaking.emit('start', 'stranger');
    assert.equal(v.subscribed.length, 0);
    await call.leave();
  });

  it('plays the agent’s reply as 48 kHz stereo while it streams', async () => {
    const { v, call, speak } = makeCall(['u1']);
    await call.join();
    speak('Build is green.');
    await flush(100);
    assert.equal(v.player.played.length, 2, 'the listening cue, then the reply');
    assert.ok(v.player.played[0]!.length > 0 && v.player.played[0]!.length % 4 === 0, 'cue as 48 kHz stereo frames');
    // 200 ms at 24 kHz mono → 200 ms at 48 kHz stereo = 38 400 bytes.
    assert.equal(v.player.played[1]!.length, 48_000 * 2 * 2 * 0.2);
    await call.leave();
  });
});
