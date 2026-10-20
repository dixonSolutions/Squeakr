import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { ChannelsSettingsSchema } from '../config.js';
import { encodeOggOpus } from './audio.js';
import { memoryBindingStore } from './bindings.js';
import type { BridgeOps } from '../control/types.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveAttachment } from './attachments.js';
import { broadcastSessionLog } from '../mcp/server/sessionLog.js';
import { publishEvent } from '../state/eventBus.js';
import { ChannelHub, type ChannelOutbound } from './hub.js';
import type { ChannelCapabilities } from './types.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'av-hub-'));

const CAPS: ChannelCapabilities = {
  mentions: { supported: true, note: '' },
  directMessages: { supported: true, note: '' },
  voiceCalls: { supported: false, note: 'no calls' },
  voiceNotes: { supported: true, note: '' },
  liveStatus: { supported: true, note: '' },
};

const ops: BridgeOps = {
  status: () => ({ workflow: 'agent_native', agentName: 'Claude Code', activeProject: 'site', agentRunning: true, agentSessionId: 'abc', listener: 'connected', stt: 'Groq', tts: 'OpenAI' }),
  projects: () => [{ name: 'site', active: true }],
  setProject: (n) => n,
  sessions: () => [],
  selectSession: () => 'ok',
  newSession: async () => 'fresh',
  stopAgent: () => false,
  configKeys: () => [],
  getConfig: () => '',
  setConfig: async () => '',
};

function setup(over: { allow?: string[]; requireMention?: boolean; listenMs?: number; messageChannel?: string; logs?: boolean } = {}) {
  const sessions = new Set<(p: unknown) => void>();
  const submitted: string[] = [];
  const ran: string[][] = [];
  const settings = ChannelsSettingsSchema.parse({
    telegram: {
      enabled: true,
      allowUsers: over.allow ?? ['42'],
      requireMention: over.requireMention ?? true,
      messageChannel: over.messageChannel ?? null,
    },
  });
  const hub = new ChannelHub({
    ops,
    bindings: memoryBindingStore(),
    settings: () => settings,
    submit: (text, source) => {
      submitted.push(`${source}: ${text}`);
      return { ok: true, delivery: 'spawn' };
    },
    registerVoiceSession: (send) => {
      sessions.add(send);
      return () => sessions.delete(send);
    },
    transcribe: async (pcm) => (pcm.length > 16_000 ? 'open the readme' : ''),
    voiceNote: async (text) => ({ ogg: Buffer.from(`ogg:${text}`), seconds: 1 }),
    prepare: async () => undefined,
    saveAttachment: (name, data) => saveAttachment(name, data, join(SCRATCH, 'attachments')),
    // The CLI as the bridge runs it: `say` reaches the agent through /api/control/say.
    cli: async (argv) => {
      ran.push(argv);
      if (argv[0] === 'say') {
        submitted.push(`${argv[argv.indexOf('--channel') + 1]}: ${argv.at(-1)}`);
        return { ok: true, output: '💬 Sent — replies will appear here.' };
      }
      if (argv[0] === 'use') return { ok: false, output: 'No session matches "9".' };
      return { ok: true, output: `ran ${argv.join(' ')}` };
    },
    logs: over.logs ?? false,
    ...(over.listenMs ? { listenMs: over.listenMs } : {}),
  });
  const sent: string[] = [];
  const voices: string[] = [];
  const out: ChannelOutbound = {
    send: async (t) => {
      sent.push(t);
      return String(sent.length);
    },
    edit: async () => undefined,
    sendVoice: async (ogg) => {
      voices.push(ogg.toString());
    },
  };
  const broadcast = (p: unknown) => {
    for (const s of [...sessions]) s(p);
  };
  return { hub, out, sent, voices, submitted, broadcast, sessions, ran };
}

const user = { id: '42', name: 'Ana' };
const conversation = { id: 'chat-1', label: 'DM with Ana', isDirect: true };
const flush = () => new Promise((r) => setTimeout(r, 10));

describe('ChannelHub', () => {
  it('only takes messages addressed to it', () => {
    const { hub } = setup();
    const at = (text: string, o: { isDirect: boolean; mentioned: boolean; conversationId?: string }, h = hub) => h.addressed('telegram', text, o);
    assert.deepEqual(at('status', { isDirect: true, mentioned: false }), { text: 'status', explicit: false });
    assert.equal(at('status', { isDirect: false, mentioned: false }), null);
    assert.deepEqual(at('status', { isDirect: false, mentioned: true }), { text: 'status', explicit: true });
    assert.deepEqual(at('!av sessions', { isDirect: false, mentioned: false }), { text: 'sessions', explicit: true });
    assert.deepEqual(at('status', { isDirect: false, mentioned: false }, setup({ requireMention: false }).hub), { text: 'status', explicit: false });
    const own = setup({ messageChannel: 'group-9' }).hub;
    assert.deepEqual(at('hello there', { isDirect: false, mentioned: false, conversationId: 'group-9' }, own), { text: 'hello there', explicit: false }, 'the message channel needs no tag');
    assert.equal(at('hello there', { isDirect: false, mentioned: false, conversationId: 'group-1' }, own), null);
  });

  it('commands run the squeakr CLI and post its answer', async () => {
    const { hub, out, sent, ran } = setup();
    await hub.handle({ channel: 'telegram', user, conversation, text: 'sessions' }, out, CAPS);
    assert.deepEqual(ran[0], ['sessions', '--channel', 'telegram', '--conversation', 'chat-1', '--user', '42']);
    assert.equal(sent[0], 'ran sessions --channel telegram --conversation chat-1 --user 42');
    await hub.handle({ channel: 'telegram', user, conversation, text: 'use 9' }, out, CAPS);
    assert.equal(sent[1], '⚠️ No session matches "9".');
  });

  it('text that is not a command is not sent on its own — chat <message> is', async () => {
    const { hub, out, sent, submitted, sessions } = setup();
    await hub.handle({ channel: 'telegram', user, conversation, text: 'what does the login page do?' }, out, CAPS);
    assert.deepEqual(submitted, []);
    assert.match(sent[0]!, /`chat <message>`/);
    await hub.handle({ channel: 'telegram', user, conversation, text: 'chat what does the login page do?' }, out, CAPS);
    assert.deepEqual(submitted, ['telegram: what does the login page do?']);
    assert.equal(sent.length, 1, 'no confirmation — the reply is the answer');
    assert.equal(sessions.size, 1, 'and the chat listens for the reply');
  });

  it('chat with attachments: files are saved and handed over by path, voice messages transcribed', async () => {
    const { hub, out, submitted } = setup();
    const ogg = encodeOggOpus(Buffer.alloc(16_000 * 2 * 2, 0x10), 16_000);
    const attachments = [
      { name: 'shot.png', contentType: 'image/png', size: 4, fetch: async () => Buffer.from('png!') },
      { name: 'voice.ogg', contentType: 'audio/ogg', size: ogg.length, voice: true, fetch: async () => ogg },
    ];
    await hub.handle({ channel: 'telegram', user, conversation, text: 'chat look at this', attachments }, out, CAPS);
    assert.equal(submitted.length, 1);
    assert.match(submitted[0]!, /^telegram: look at this\n\nopen the readme\n\nAttached image: .*shot\.png$/);
    const path = /Attached image: (.*)$/.exec(submitted[0]!)![1]!;
    assert.equal(readFileSync(path, 'utf8'), 'png!');
  });

  /** A one-second 44.1 kHz stereo WAV — any audio file someone records and attaches. */
  const wavFile = (): Buffer => {
    const rate = 44_100;
    const frames = rate;
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000);
      data.writeInt16LE(v, i * 4);
      data.writeInt16LE(v, i * 4 + 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + data.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(2, 22);
    h.writeUInt32LE(rate, 24);
    h.writeUInt32LE(rate * 4, 28);
    h.writeUInt16LE(4, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(data.length, 40);
    return Buffer.concat([h, data]);
  };

  it('an attached recording is transcribed into the turn, after what was typed, and kept as a file', async () => {
    const { hub, out, sent, submitted } = setup();
    await hub.handle({ channel: 'telegram', user, conversation, text: 'stream on' }, out, CAPS);
    const wav = wavFile();
    const attachments = [{ name: 'Recording 8.wav', contentType: 'audio/wav', size: wav.length, fetch: async () => wav }];
    await hub.handle({ channel: 'telegram', user, conversation, text: 'here', attachments }, out, CAPS);
    assert.equal(submitted.length, 1);
    assert.match(submitted[0]!, /^telegram: here\n\nRecording 8\.wav \(transcribed\): open the readme\n\nAttached audio: .*Recording_8\.wav$/);
    assert.ok(sent.some((m) => m.includes('Recording 8.wav (transcribed): open the readme')), 'what it said is echoed back');
  });

  it('a recording on its own is a turn too, outside a stream', async () => {
    const { hub, out, submitted } = setup();
    const wav = wavFile();
    const attachments = [{ name: 'memo.wav', contentType: 'audio/wav', size: wav.length, fetch: async () => wav }];
    await hub.handle({ channel: 'telegram', user, conversation: { ...conversation, isDirect: true }, text: '', attachments }, out, CAPS);
    assert.equal(submitted.length, 1);
    assert.match(submitted[0]!, /^telegram: memo\.wav \(transcribed\): open the readme/);
  });

  it('stream on --voice --rep=voice: every message is a turn and replies are voice notes only; break ends it', async () => {
    const { hub, out, sent, voices, submitted, broadcast, sessions } = setup({ listenMs: 30 });
    await hub.handle({ channel: 'telegram', user, conversation, text: 'stream on —voice —rep=voice' }, out, CAPS);
    assert.match(sent.at(-1)!, /Stream on.*\n.*Replies: \*\*voice notes\*\*/s);
    await hub.handle({ channel: 'telegram', user, conversation, text: 'status of the build please' }, out, CAPS);
    assert.deepEqual(submitted, ['telegram: status of the build please'], 'in a stream even a command word is a turn');
    broadcast({ type: 'speak', text: 'All green.' });
    await flush();
    assert.deepEqual(voices, ['ogg:All green.']);
    assert.ok(!sent.includes('All green.'), 'voice only');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sessions.size, 1, 'a stream keeps listening while quiet');
    await hub.handle({ channel: 'telegram', user, conversation, text: 'stream status' }, out, CAPS);
    assert.match(sent.at(-1)!, /Stream on.*1 turn/);
    await hub.handle({ channel: 'telegram', user, conversation, text: 'stream break' }, out, CAPS);
    assert.match(sent.at(-1)!, /Ended the stream/);
    assert.equal(sessions.size, 0);
    await hub.handle({ channel: 'telegram', user, conversation, text: 'hello' }, out, CAPS);
    assert.equal(submitted.length, 1, 'after the break, text is not a turn');
  });

  it('stream break also ends this person\'s call', async () => {
    const { hub, out, sent } = setup();
    let stopped = false;
    hub.registerCall({ channel: 'telegram', label: 'General', userId: '42', stop: async () => void (stopped = true) });
    await hub.handle({ channel: 'telegram', user, conversation, text: 'stream status' }, out, CAPS);
    assert.match(sent.at(-1)!, /Call in progress: \*\*General\*\*/);
    await hub.handle({ channel: 'telegram', user, conversation, text: 'stream break' }, out, CAPS);
    assert.equal(stopped, true);
  });

  it('files the agent sends are posted where someone is listening', async () => {
    const { hub, out, submitted } = setup();
    const files: Array<{ names: string[]; caption?: string }> = [];
    const withFiles = { ...out, sendFiles: async (f: { name: string }[], caption?: string) => void files.push({ names: f.map((x) => x.name), ...(caption ? { caption } : {}) }) };
    await hub.handle({ channel: 'telegram', user, conversation, text: 'chat record the demo' }, withFiles, CAPS);
    assert.equal(submitted.length, 1);
    publishEvent({ type: 'agent_files', files: [{ data: Buffer.from('mp4').toString('base64'), mime: 'video/mp4', name: 'demo.mp4' }], caption: 'The demo' });
    await flush();
    assert.deepEqual(files, [{ names: ['demo.mp4'], caption: 'The demo' }]);
    hub.close();
  });

  it('only obeys allowlisted users, and tells a stranger their id once', () => {
    const { hub } = setup();
    assert.equal(hub.isAllowed('telegram', '42'), true);
    assert.equal(hub.isAllowed('telegram', '7'), false);
    assert.match(hub.strangerNotice('telegram', '7') ?? '', /id is `7`.*squeakr channel allow telegram 7/);
    assert.equal(hub.strangerNotice('telegram', '7'), null, 'not every message');
  });

  it('chat: hands the text to the agent and keeps relaying its replies while the chat is active', async () => {
    const { hub, out, sent, submitted, broadcast, sessions } = setup({ listenMs: 60 });
    await hub.handle({ channel: 'telegram', user, conversation, text: 'say open the readme' }, out, CAPS);
    assert.deepEqual(submitted, ['telegram: open the readme']);
    assert.equal(sessions.size, 1, 'the chat counts as someone listening');
    broadcast({ type: 'speak', text: 'Opening it now.' });
    broadcast({ type: 'turn_complete' });
    broadcast({ type: 'speak', text: 'It has three sections.' });
    await flush();
    assert.deepEqual(sent, ['Opening it now.', 'It has three sections.']);
    await hub.handle({ channel: 'telegram', user, conversation, text: 'chat and the next one' }, out, CAPS);
    assert.equal(sessions.size, 1, 'one listener per conversation');
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(sessions.size, 0, 'it stops listening once the chat goes quiet');
    broadcast({ type: 'speak', text: 'later' });
    await flush();
    assert.ok(!sent.includes('later'));
  });

  it('voice note: transcribes, submits, and answers with a voice note plus the text', async () => {
    const { hub, out, sent, voices, submitted, broadcast } = setup();
    const ogg = encodeOggOpus(Buffer.alloc(16_000 * 2 * 2, 0x10), 16_000);
    await hub.voiceNote({ channel: 'telegram', user, conversation }, ogg, out);
    assert.deepEqual(submitted, ['telegram: open the readme']);
    assert.equal(sent[0], '🎙️ _open the readme_');
    broadcast({ type: 'speak', text: 'Done.' });
    await flush();
    assert.deepEqual(voices, ['ogg:Done.']);
    assert.equal(sent.at(-1), 'Done.');
  });

  it('voice note with no words says so and submits nothing', async () => {
    const { hub, out, sent, submitted } = setup();
    await hub.voiceNote({ channel: 'telegram', user, conversation }, encodeOggOpus(Buffer.alloc(3200), 16_000), out);
    assert.equal(submitted.length, 0);
    assert.match(sent[0]!, /didn't catch any words/);
  });

  it('pours every session log line into the message channel', async () => {
    const { hub } = setup({ messageChannel: 'group-9', logs: true });
    const posted: string[] = [];
    hub.setOutbound('telegram', (id) => (id === 'group-9' ? { send: async (t) => (posted.push(t), '1') } : null));
    broadcastSessionLog({ subcategory: 'stt', level: 'info', summary: 'Transcribed 1.2 s', detail: 'open the readme' });
    broadcastSessionLog({ subcategory: 'tool', level: 'error', summary: 'git failed' });
    await new Promise((r) => setTimeout(r, 2_200));
    hub.close();
    assert.equal(posted.length, 1, 'batched into one post');
    assert.match(posted[0]!, /📝 `stt` Transcribed 1\.2 s — open the readme/);
    assert.match(posted[0]!, /❌ `tool` git failed/);
  });
});
