import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type { PcmStream } from '../providers/speech/output/types.js';
import { VoiceCall } from './voiceCall.js';
import type { SpotterFactory } from './wakeSpotter.js';

/** 16 kHz speech-loud tone. */
function speech(ms: number): Buffer {
  const n = 16 * ms;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 16_000) * 9000), i * 2);
  return b;
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function harness() {
  let send: ((p: unknown) => void) | null = null;
  const delivered: string[] = [];
  const played: string[] = [];
  const lines: string[] = [];
  let release = 0;
  const call = new VoiceCall({
    name: 'test call',
    source: 'discord',
    cues: false,
    sink: {
      async play(pcm: PcmStream, signal: AbortSignal) {
        const parts: Buffer[] = [];
        for await (const c of pcm.chunks) {
          if (signal.aborted) break;
          parts.push(c);
        }
        played.push(`${pcm.sampleRate}:${Buffer.concat(parts).toString()}`);
        // Hold the line "playing" until the test lets go (or a barge-in aborts it).
        await new Promise<void>((resolve) => {
          const t = setInterval(() => {
            if (release > 0 || signal.aborted) {
              if (release > 0) release--;
              clearInterval(t);
              resolve();
            }
          }, 2);
        });
      },
    },
    onLine: (l) => lines.push(`${l.who}${l.speaker ? `:${l.speaker}` : ''}: ${l.text}`),
    deps: {
      transcribe: async (pcm) => ({ text: `heard ${Math.round(pcm.length / 32)} ms` }),
      deliver: (text, source) => {
        delivered.push(`${source}|${text}`);
        return { ok: true, delivery: 'spawn' };
      },
      synthesize: async (text) => ({
        sampleRate: 24_000,
        chunks: (async function* () {
          yield Buffer.from(text);
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
  return {
    call,
    delivered,
    played,
    lines,
    say: (text: string) => send?.({ type: 'speak', text }),
    letPlay: () => release++,
    get registered() {
      return send !== null;
    },
  };
}

describe('VoiceCall', () => {
  it('cuts a speaker’s segment when the platform says they paused, and hands it to the agent', async () => {
    const h = harness();
    h.call.start();
    assert.equal(h.registered, true, 'the call is a voice session (agent speak() reaches it)');
    h.call.pushAudio('u1', 'Ana', speech(800));
    await flush();
    assert.equal(h.delivered.length, 0, 'no pause heard yet — platforms send no silence');
    h.call.speakerPaused('u1');
    await flush();
    assert.equal(h.delivered.length, 1);
    assert.match(h.delivered[0]!, /^discord\|heard \d+ ms$/);
    assert.match(h.lines[0]!, /^user:Ana: heard/);
    await h.call.close();
    assert.equal(h.registered, false);
  });

  it('plays the agent’s lines in order as streamed PCM', async () => {
    const h = harness();
    h.call.start();
    h.say('first');
    h.say('second');
    await flush();
    assert.deepEqual(h.played, ['24000:first']);
    h.letPlay();
    await flush();
    assert.deepEqual(h.played, ['24000:first', '24000:second']);
    assert.deepEqual(h.lines, ['agent: first', 'agent: second']);
    h.letPlay();
    await h.call.close();
  });

  it('talking over the agent cuts it off and drops what it had queued', async () => {
    const h = harness();
    h.call.start();
    h.say('a long answer');
    h.say('more of it');
    await flush();
    assert.equal(h.call.isSpeaking, true);
    h.call.pushAudio('u1', 'Ana', speech(600));
    h.call.speakerPaused('u1');
    await flush();
    assert.equal(h.call.isSpeaking, false);
    assert.deepEqual(h.played, ['24000:a long answer'], 'the queued line never played');
    assert.equal(h.delivered.length, 1);
    await h.call.close();
  });

  it('names the speaker when more than one person is on the call', async () => {
    const h = harness();
    h.call.start();
    h.call.pushAudio('u1', 'Ana', speech(500));
    h.call.pushAudio('u2', 'Ben', speech(500));
    h.call.speakerPaused('u2');
    await flush();
    assert.match(h.delivered[0]!, /^discord\|Ben: heard/);
    await h.call.close();
    assert.equal(h.delivered.length, 2, 'what Ana said before hanging up still reached the agent');
  });
});

describe('VoiceCall — like the phone', () => {
  function rich(wake: boolean, spotter: SpotterFactory | null = null, heard?: string) {
    const played: number[] = [];
    const mirrored: Array<Record<string, unknown>> = [];
    const activity: string[] = [];
    const delivered: string[] = [];
    let send: ((p: unknown) => void) | null = null;
    const synthesized: string[] = [];
    const call = new VoiceCall({
      name: 'rich call',
      source: 'discord',
      greeting: 'Squeakr here.',
      sink: {
        async play(pcm) {
          let n = 0;
          for await (const c of pcm.chunks) n += c.length;
          played.push(pcm.sampleRate === 24_000 && n > 2000 ? n : -1);
        },
      },
      onActivity: (l) => activity.push(l),
      deps: {
        transcribe: async () => ({ text: heard ?? (wake ? 'hey squeaker run the tests' : 'run the tests') }),
        deliver: (text) => {
          delivered.push(text);
          return { ok: true, delivery: 'spawn' };
        },
        synthesize: async (text) => {
          synthesized.push(text);
          return { sampleRate: 24_000, chunks: (async function* () { yield Buffer.alloc(4800); })() };
        },
        registerVoiceSession: (s) => {
          send = s;
          return () => (send = null);
        },
        registerPresence: () => ({ release() {} }),
        prepare: async () => undefined,
        segmentSettings: () => ({ segmentSilenceMs: 700, maxSegmentMs: 15_000, minSpeechMs: 300, speechThreshold: 0.012, preRollMs: 300 }),
        // The phone's voice-session settings: wake words on or off, VAD.
        turnSettings: () => ({
          inputMode: 'turns',
          wakeWordsEnabled: wake,
          wakeWords: { start: 'hey squeaker', end: 'send', cancel: 'cancel' },
          turnSubmit: { silenceMs: 700, vadEnabled: true },
        }),
        mirror: (frame) => mirrored.push(frame),
        spotter: async () => spotter,
      },
    });
    return { call, played, activity, delivered, synthesized, mirrored, emit: (p: unknown) => send?.(p) };
  }

  it('opens with the listening cue and the spoken greeting, then cues each sent request', async () => {
    const h = rich(false);
    h.call.start();
    await flush(50);
    assert.deepEqual(h.synthesized, ['Squeakr here.']);
    assert.ok(h.played.length >= 2, 'cue + greeting');
    h.call.pushAudio('u1', 'Ana', speech(600));
    h.call.speakerPaused('u1');
    await flush(50);
    assert.deepEqual(h.delivered, ['run the tests']);
    assert.ok(h.played.length >= 3, 'sent cue');
    await h.call.close();
  });

  it('with wake words, delivers only what follows the phrase', async () => {
    const h = rich(true);
    h.call.start();
    h.call.pushAudio('u1', 'Ana', speech(600));
    h.call.speakerPaused('u1');
    await flush(50);
    assert.deepEqual(h.delivered, ['run the tests']);
    await h.call.close();
  });

  it('reports tool activity and status as log lines', async () => {
    const h = rich(false);
    h.call.start();
    h.emit({ type: 'tool_activity', phase: 'start', label: 'Reading README.md', detail: 'line 1\nline 2' });
    h.emit({ type: 'tool_activity', phase: 'error', label: 'Tool call failed' });
    h.emit({ type: 'voice_agent_status', state: 'running', provider_name: 'Claude Code' });
    assert.deepEqual(h.activity, ['🔧 Reading README.md: line 1', '❌ Tool call failed', '· Claude Code running']);
    await h.call.close();
  });

  it('mirrors the whole call to the app: start, what was heard, cues, replies, activity, end', async () => {
    const h = rich(true);
    h.call.start();
    h.call.pushAudio('u1', 'Ana', speech(600));
    h.call.speakerPaused('u1');
    await flush(50);
    h.emit({ type: 'tool_activity', phase: 'start', label: 'Running tests' });
    h.emit({ type: 'speak', text: 'All green.' });
    await flush(50);
    await h.call.close();
    for (const f of h.mirrored) {
      assert.equal(f['type'], 'channel_call');
      assert.equal(f['call'], 'rich call');
      assert.equal(f['source'], 'discord');
    }
    const summary = h.mirrored.map((f) => {
      switch (f['event']) {
        case 'cue':
          return `cue:${String(f['cue'])}`;
        case 'heard':
          return `heard:${String(f['state'])}:${String(f['speaker'])}:${String(f['text'])}`;
        case 'reply':
          return `reply:${f['own'] ? 'own' : 'agent'}:${String(f['text'])}`;
        case 'activity':
          return `activity:${String(f['line'])}`;
        default:
          return String(f['event']);
      }
    });
    assert.deepEqual(summary, [
      'started',
      'cue:listening',
      'reply:own:Squeakr here.',
      'heard:request:Ana:run the tests',
      'cue:sent',
      'activity:🔧 Running tests',
      'reply:agent:All green.',
      'ended',
    ]);
  });

  /** A spotter that "hears" the start phrase in the first audio after each reset. */
  const fakeSpotter = (): { factory: SpotterFactory; pushes: () => number } => {
    let pushes = 0;
    const factory: SpotterFactory = (opts) => {
      let fired = false;
      return {
        push() {
          pushes++;
          if (!fired) {
            fired = true;
            opts.onMatch('hey squeaker');
          }
        },
        reset() {
          fired = false;
        },
        close() {},
      };
    };
    return { factory, pushes: () => pushes };
  };

  it('cues the start phrase as soon as the audio spotter hears it, before any transcript', async () => {
    const spot = fakeSpotter();
    const h = rich(true, spot.factory);
    h.call.start();
    await flush(20);
    const cuesBefore = h.mirrored.filter((f) => f['event'] === 'cue' && f['cue'] === 'listening').length;
    h.call.pushAudio('u1', 'Ana', speech(100));
    // Heard while still talking: no pause, no transcript yet.
    const armed = h.mirrored.filter((f) => f['event'] === 'heard' && f['state'] === 'armed');
    assert.equal(armed.length, 1);
    assert.equal(h.mirrored.filter((f) => f['event'] === 'cue' && f['cue'] === 'listening').length, cuesBefore + 1);
    assert.ok(spot.pushes() > 0);

    h.call.pushAudio('u1', 'Ana', speech(500));
    h.call.speakerPaused('u1');
    await flush(50);
    assert.deepEqual(h.delivered, ['run the tests']);
    // The transcript finished the request without cueing it a second time.
    assert.equal(h.mirrored.filter((f) => f['event'] === 'cue' && f['cue'] === 'listening').length, cuesBefore + 1);
    await h.call.close();
  });

  it('a spotted phrase the transcript misspelled is still cut from the request', async () => {
    const h = rich(true, fakeSpotter().factory, 'Hey squeaking, run the tests.');
    h.call.start();
    await flush(20);
    h.call.pushAudio('u1', 'Ana', speech(600));
    h.call.speakerPaused('u1');
    await flush(50);
    assert.deepEqual(h.delivered, ['run the tests']);
    await h.call.close();
  });

  it('without a spotter, the phrase is matched in the transcript as before', async () => {
    const h = rich(true, null);
    h.call.start();
    await flush(20);
    h.call.pushAudio('u1', 'Ana', speech(600));
    h.call.speakerPaused('u1');
    await flush(50);
    assert.deepEqual(h.delivered, ['run the tests']);
    await h.call.close();
  });
});
