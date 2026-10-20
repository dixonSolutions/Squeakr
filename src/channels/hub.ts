/**
 * The shared half of every channel: access control, commands (parsed into the
 * `squeakr` CLI — commands.ts), text and voice messages as turns, reply
 * relaying, session logs into the message channel, live status. Adapters own
 * their platform's connection and call into this; this calls back out through
 * `ChannelOutbound`. Nothing here knows which platform it is talking to.
 */

import { getConfig, type ChannelsSettings } from '../config.js';
import { childLogger } from '../log.js';
import { registerVoiceSession } from '../mcp/server/voiceToolHandlers.js';
import { transcribe } from '../providers/speech/input/service.js';
import { synthesize } from '../providers/speech/output/service.js';
import { subscribeEvents } from '../state/eventBus.js';
import { decodeAudioFileTo16k, decodeOggOpusTo16k, encodeOggOpus, pcmSeconds } from './audio.js';
import { dbBindingStore, type BindingStore, type ChannelBinding } from './bindings.js';
import { formatSessions, formatStatus } from '../control/format.js';
import { applyBinding, voiceDefaultKey } from '../control/sessions.js';
import { kindOf, loadAgentFile, prepareTurn, saveAttachment, waveformOf, type AgentFile, type ChannelAttachment, type OutboundFile } from './attachments.js';
import type { BridgeOps } from '../control/types.js';
import { runChatCli, type CliRunner } from './cliRunner.js';
import { isCommand, parseCommand, renderCli, type StreamInput, type StreamRep } from './commands.js';
import { LogRelay, type LogTarget } from './logRelay.js';
import type { ChannelCapabilities, ChannelCommandInput, ChannelId, ChannelReply } from './types.js';
import { CHANNEL_IDS } from './types.js';
import { deliverStreamTurn, type StreamTurnOutcome } from '../voice/streamTurns.js';
import { prepareAgentForChannels } from './prepare.js';

const log = childLogger('channels:hub');

/** How a hub reaches back into one platform conversation. */
export interface ChannelOutbound {
  /** Post a message; resolves with its id when the platform gives one. */
  send(text: string): Promise<string | null>;
  /** Replace a message the bot posted (live status). */
  edit?(messageId: string, text: string): Promise<void>;
  /** Post an Ogg/Opus voice note (`waveform`: Discord's voice-message picture, base64). */
  sendVoice?(ogg: Buffer, seconds: number, waveform?: string): Promise<void>;
  /** Post files as attachments. */
  sendFiles?(files: OutboundFile[], caption?: string): Promise<void>;
}

/** How the agent's lines come back to a conversation. */
export type ReplyMode = 'text' | 'voice' | 'both';

/** A message the adapter decided is for Squeakr. `explicit`: tagged or prefixed (a command even in a stream). */
export interface Addressed {
  text: string;
  explicit: boolean;
}

/** `stream on` in one conversation: every message there is a turn until `stream break`. */
export interface ChatStream {
  channel: ChannelId;
  conversationId: string;
  label: string;
  userId: string;
  input: StreamInput;
  rep: StreamRep;
  since: number;
  turns: number;
}

/** A voice call an adapter is running, for `stream status` / `stream break`. */
export interface CallInfo {
  channel: ChannelId;
  label: string;
  userId: string | null;
  stop(): Promise<void>;
}

export interface HubDeps {
  ops: BridgeOps;
  bindings?: BindingStore;
  settings?: () => ChannelsSettings;
  /** Hand a turn to the agent (spawn or queue). */
  submit?: (text: string, source: string) => StreamTurnOutcome;
  registerVoiceSession?: (send: (payload: unknown) => void, name: string) => () => void;
  transcribe?: (pcm: Buffer) => Promise<string>;
  /** Text → Ogg/Opus voice note, or null if no server voice can stream PCM. */
  voiceNote?: (text: string) => Promise<VoiceNote | null>;
  /** How long a conversation keeps receiving replies after its last message. */
  listenMs?: number;
  /** Make sure the agent CLI can reach the bridge before the first turn. */
  prepare?: () => Promise<void>;
  /** Run `squeakr <argv>` for a command (cliRunner.ts). */
  cli?: CliRunner;
  /** Where an attachment for the agent is saved (default: `<data>/attachments/<day>/`). */
  saveAttachment?: (name: string, data: Buffer) => string;
  /** Pour session logs into message channels (off in tests unless given). */
  logs?: boolean;
}

const DEFAULT_LISTEN_MS = 10 * 60_000;

export interface VoiceNote {
  ogg: Buffer;
  seconds: number;
  waveform?: string;
}

interface Listener {
  out: ChannelOutbound;
  /** How replies come back: text, voice notes, or both (a voice message was the last thing said here). */
  mode: ReplyMode;
  /** A stream listens until it is broken, not until the chat goes quiet. */
  sticky: boolean;
  chain: Promise<void>;
  renew(): void;
  detach(): void;
}
const STRANGER_NOTICE_MS = 60 * 60_000;
const WATCH_DEBOUNCE_MS = 1500;
const WATCH_REFRESH_MS = 30_000;
const WATCH_MAX_MS = 2 * 60 * 60_000;

async function defaultVoiceNote(text: string): Promise<VoiceNote | null> {
  const spoken = await synthesize(text, { stream: true });
  if (!spoken.pcm) return null;
  const parts: Buffer[] = [];
  for await (const chunk of spoken.pcm.chunks) parts.push(chunk);
  const pcm = Buffer.concat(parts);
  return {
    ogg: encodeOggOpus(pcm, spoken.pcm.sampleRate),
    seconds: pcmSeconds(pcm, spoken.pcm.sampleRate),
    waveform: waveformOf(pcm),
  };
}

export class ChannelHub {
  readonly ops: BridgeOps;
  readonly bindings: BindingStore;
  private readonly settings: () => ChannelsSettings;
  private readonly submitTurn: (text: string, source: string) => StreamTurnOutcome;
  private readonly register: (send: (payload: unknown) => void, name: string) => () => void;
  private readonly stt: (pcm: Buffer) => Promise<string>;
  private readonly voiceNoteOf: (text: string) => Promise<VoiceNote | null>;
  private readonly streams = new Map<string, ChatStream>();
  private readonly calls = new Set<CallInfo>();
  private readonly stopFiles: () => void;
  private readonly save: (name: string, data: Buffer) => string;
  private readonly listenMs: number;
  private readonly listeners = new Map<string, Listener>();
  private readonly prepare: () => Promise<void>;
  private readonly strangersTold = new Map<string, number>();
  private readonly watches = new Map<string, () => void>();
  private readonly cli: CliRunner;
  /** Each running adapter's way to post into a conversation by id. */
  private readonly outbounds = new Map<ChannelId, (conversationId: string) => ChannelOutbound | null>();
  private readonly logRelay: LogRelay | null;

  constructor(deps: HubDeps) {
    this.ops = deps.ops;
    this.bindings = deps.bindings ?? dbBindingStore;
    this.settings = deps.settings ?? (() => getConfig().settings.channels);
    this.submitTurn = deps.submit ?? deliverStreamTurn;
    this.register = deps.registerVoiceSession ?? registerVoiceSession;
    this.stt = deps.transcribe ?? (async (pcm) => (await transcribe(pcm)).text);
    this.voiceNoteOf = deps.voiceNote ?? defaultVoiceNote;
    this.listenMs = deps.listenMs ?? DEFAULT_LISTEN_MS;
    this.prepare = deps.prepare ?? prepareAgentForChannels;
    this.cli = deps.cli ?? runChatCli;
    this.save = deps.saveAttachment ?? ((name, data) => saveAttachment(name, data));
    this.logRelay = deps.logs === false ? null : new LogRelay((type) => this.logTargets(type));
    this.logRelay?.start();
    this.stopFiles = subscribeEvents((e) => {
      if (e.type === 'agent_files') void this.relayFiles(e['files'] as AgentFile[], (e['caption'] as string | null) ?? undefined);
    });
  }

  /** An adapter's call, while it runs — returns the unregister. */
  registerCall(call: CallInfo): () => void {
    this.calls.add(call);
    return () => void this.calls.delete(call);
  }

  /** The stream open in a conversation, if any. */
  streamIn(channel: ChannelId, conversationId: string): ChatStream | null {
    return this.streams.get(`${channel}:${conversationId}`) ?? null;
  }

  /** An adapter that can post by conversation id registers here (null on stop). */
  setOutbound(channel: ChannelId, fn: ((conversationId: string) => ChannelOutbound | null) | null): void {
    if (fn) this.outbounds.set(channel, fn);
    else this.outbounds.delete(channel);
  }

  /** The configured message channel of every running channel that wants logs. */
  private logTargets(type: string): LogTarget[] {
    const targets: LogTarget[] = [];
    for (const id of CHANNEL_IDS) {
      const s = this.channelSettings(id);
      const outFor = this.outbounds.get(id);
      if (!s?.logs || !s.messageChannel || !outFor) continue;
      // A listening conversation already gets the agent's lines.
      if (type === 'speak' && this.listeners.has(`${id}:${s.messageChannel}`)) continue;
      const out = outFor(s.messageChannel);
      if (out) targets.push({ key: `${id}:${s.messageChannel}`, out });
    }
    return targets;
  }

  /** Run `squeakr <argv>` the way a chat command does (an adapter changing a setting). */
  runCli(argv: string[]): Promise<{ ok: boolean; output: string }> {
    return this.cli(argv);
  }

  /** The channel's own message channel (untagged messages there are for the bot). */
  isMessageChannel(channel: ChannelId, conversationId: string): boolean {
    return this.channelSettings(channel).messageChannel === conversationId;
  }

  /** Hand a turn to the agent, after making sure it can reach the bridge. */
  private async submit(text: string, source: string): Promise<StreamTurnOutcome> {
    try {
      await this.prepare();
    } catch (err) {
      return { ok: false, reason: 'ERROR', message: err instanceof Error ? err.message : String(err) };
    }
    return this.submitTurn(text, source);
  }

  channelSettings(channel: ChannelId): ChannelsSettings[ChannelId] {
    return this.settings()[channel];
  }

  get commandPrefix(): string {
    return this.settings().commandPrefix;
  }

  isAllowed(channel: ChannelId, userId: string): boolean {
    return this.channelSettings(channel).allowUsers.includes(userId);
  }

  /**
   * Is this message for Squeakr, and what is the command? DMs always are;
   * in a group it takes a mention (already detected by the adapter) or the
   * command prefix, unless `requireMention` is off.
   */
  addressed(
    channel: ChannelId,
    text: string,
    opts: { isDirect: boolean; mentioned: boolean; conversationId?: string },
  ): Addressed | null {
    const trimmed = text.trim();
    const prefix = this.commandPrefix;
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return { text: trimmed.slice(prefix.length).trim(), explicit: true };
    if (opts.mentioned) return { text: trimmed, explicit: true };
    if (opts.isDirect) return { text: trimmed, explicit: false };
    if (opts.conversationId && (this.isMessageChannel(channel, opts.conversationId) || this.streamIn(channel, opts.conversationId))) {
      return { text: trimmed, explicit: false };
    }
    return this.channelSettings(channel).requireMention ? null : { text: trimmed, explicit: false };
  }

  /** The once-an-hour answer to someone not on the allowlist, or null to stay quiet. */
  strangerNotice(channel: ChannelId, userId: string): string | null {
    const key = `${channel}:${userId}`;
    const last = this.strangersTold.get(key) ?? 0;
    if (Date.now() - last < STRANGER_NOTICE_MS) return null;
    this.strangersTold.set(key, Date.now());
    log.warn({ channel, userId }, 'channel message from a user not on the allowlist');
    return (
      `I only take commands from people on my allowlist. Your ${channel} id is \`${userId}\` — ` +
      `the owner can add it on the host with \`squeakr channel allow ${channel} ${userId}\`.`
    );
  }

  bindingFor(channel: ChannelId, conversationId: string): ChannelBinding | null {
    return this.bindings.get(channel, conversationId);
  }

  /** Make the bridge continue this conversation's default session (before a call or a turn). */
  useBinding(channel: ChannelId, conversationId: string): string | null {
    return applyBinding(this.bindingFor(channel, conversationId), this.ops);
  }

  /**
   * A message from an allowlisted user that is addressed to Squeakr. In a
   * stream everything is a turn — except a tagged / prefixed command and
   * `stream …` itself. Otherwise a command word runs the command; a voice
   * message is a turn; other text gets a pointer to `chat` (in a DM — group
   * chatter in the message channel is left alone).
   */
  async handle(
    input: ChannelCommandInput & { attachments?: readonly ChannelAttachment[] },
    out: ChannelOutbound,
    capabilities: ChannelCapabilities,
    opts: { howToAddress?: string; explicit?: boolean } = {},
  ): Promise<ChannelReply> {
    const stream = this.streamIn(input.channel, input.conversation.id);
    if (stream && !opts.explicit && !/^stream\b/i.test(input.text.trim())) {
      stream.turns++;
      await this.turn(input, out, input.text, stream.rep === 'voice' ? 'voice' : 'text');
      return { text: '' };
    }
    if (isCommand(input.text) && (input.text.trim() || !input.attachments?.length)) return this.command(input, out, capabilities, opts);
    // Something to listen to — a voice message or an audio file — is a turn, typed words or not.
    if (input.attachments?.some((a) => ['voice', 'audio'].includes(kindOf(a)))) {
      await this.turn(input, out, input.text, out.sendVoice ? 'both' : 'text');
      return { text: '' };
    }
    if (input.conversation.isDirect || opts.explicit) {
      const text = 'Not a command — `chat <message>` sends it to the agent (attachments too), `stream on` keeps this conversation open to it. `help` lists everything.';
      await out.send(text);
      return { text };
    }
    return { text: '' };
  }

  /** Run one command and post the answer; a call action is handed back to the adapter. */
  async command(
    input: ChannelCommandInput & { attachments?: readonly ChannelAttachment[] },
    out: ChannelOutbound,
    capabilities: ChannelCapabilities,
    opts: { howToAddress?: string } = {},
  ): Promise<ChannelReply> {
    const action = parseCommand({
      input,
      voice: capabilities.voiceCalls,
      ...(opts.howToAddress ? { howToAddress: opts.howToAddress } : {}),
    });
    let text = '';
    switch (action.kind) {
      case 'reply':
        text = action.text;
        break;
      case 'voice':
        return { text: '', voice: { action: action.action } };
      case 'watch':
        if (capabilities.liveStatus.supported && out.edit) {
          await this.toggleWatch(input.channel, input.conversation.id, out, (t) => (text = t));
        } else {
          text = `Live status is not available here: ${capabilities.liveStatus.note}`;
        }
        break;
      case 'cli':
        text = renderCli(action, await this.cli(action.argv));
        break;
      case 'chat':
        if (!action.text && !input.attachments?.length) {
          text = 'Chat what? `chat <message>` — attach images, video or a voice message if you like.';
          break;
        }
        await this.turn(input, out, action.text, 'text');
        break;
      case 'stream':
        text = await this.streamCommand(input, out, action);
        break;
    }
    if (text) await out.send(text);
    return { text };
  }

  /**
   * One turn for the agent from a chat: the text, what its voice messages
   * said, and where its files were saved (attachments.ts) — the agent gets a
   * turn like a spoken one. It continues this conversation's `default`, else
   * the person's `voice default`. Replies come back here in `mode`.
   */
  async turn(
    input: Omit<ChannelCommandInput, 'text'> & { attachments?: readonly ChannelAttachment[] },
    out: ChannelOutbound,
    typed: string,
    mode: ReplyMode,
  ): Promise<void> {
    const prepared = await prepareTurn(
      typed,
      input.attachments ?? [],
      async (data, kind) => this.stt(kind === 'voice' ? decodeOggOpusTo16k(data) : await decodeAudioFileTo16k(data)),
      this.save,
    );
    for (const p of prepared.problems) await out.send(`⚠️ ${p}`);
    if (!prepared.text) {
      if (!prepared.problems.length) await out.send("🎙️ I didn't catch any words in that.");
      return;
    }
    const pinned =
      this.useBinding(input.channel, input.conversation.id) ?? this.useBinding(input.channel, voiceDefaultKey(input.user.id));
    if (prepared.heard.length) await out.send(`🎙️ _${prepared.heard.join(' ')}_${pinned ? `  → ${pinned}` : ''}`);
    const stream = this.streamIn(input.channel, input.conversation.id);
    this.attach(input, out, { mode, sticky: Boolean(stream) });
    const outcome = await this.submit(prepared.text, input.channel);
    if (!outcome.ok) await out.send(`⚠️ ${outcome.message}`);
  }

  /** A voice message (Telegram, WhatsApp): a turn, answered in voice — or as the stream here says. */
  async voiceNote(input: Omit<ChannelCommandInput, 'text'>, ogg: Buffer, out: ChannelOutbound): Promise<void> {
    const stream = this.streamIn(input.channel, input.conversation.id);
    if (stream) stream.turns++;
    const mode: ReplyMode = stream ? (stream.rep === 'voice' ? 'voice' : 'text') : out.sendVoice ? 'both' : 'text';
    const voice: ChannelAttachment = { name: 'voice.ogg', contentType: 'audio/ogg', size: ogg.length, voice: true, fetch: async () => ogg };
    await this.turn({ ...input, attachments: [voice] }, out, '', mode);
  }

  /** `stream on|status|break`. */
  private async streamCommand(
    input: ChannelCommandInput,
    out: ChannelOutbound,
    action: { op: 'on'; input: StreamInput; rep: StreamRep } | { op: 'status' | 'break' },
  ): Promise<string> {
    const key = `${input.channel}:${input.conversation.id}`;
    const existing = this.streams.get(key);
    const calls = [...this.calls].filter((c) => c.channel === input.channel && (!c.userId || c.userId === input.user.id));
    if (action.op === 'on') {
      const stream: ChatStream = {
        channel: input.channel,
        conversationId: input.conversation.id,
        label: input.conversation.label,
        userId: input.user.id,
        input: action.input,
        rep: action.rep,
        since: existing?.since ?? Date.now(),
        turns: existing?.turns ?? 0,
      };
      this.streams.set(key, stream);
      this.attach(input, out, { mode: stream.rep === 'voice' ? 'voice' : 'text', sticky: true });
      const pinned = this.bindingFor(input.channel, input.conversation.id) ?? this.bindingFor(input.channel, voiceDefaultKey(input.user.id));
      return [
        `🟢 **Stream on** — ${stream.input === 'voice' ? 'send voice notes (text works too)' : 'write to me (voice notes work too)'}; every message here goes to the agent.`,
        `Replies: **${stream.rep === 'voice' ? 'voice notes' : 'text'}**, plus any files the agent sends.${pinned ? ` Continuing **${pinned.label ?? pinned.project}**.` : ''}`,
        '`stream status` · `stream break` · tag me (or `!av`) for a command meanwhile.',
      ].join('\n');
    }
    if (action.op === 'status') {
      const lines: string[] = [];
      if (existing) {
        const mins = Math.round((Date.now() - existing.since) / 60_000);
        lines.push(
          `🟢 **Stream on** here for ${mins < 1 ? 'under a minute' : `${mins} min`} — in: ${existing.input === 'voice' ? 'voice notes' : 'text'}, replies: ${existing.rep === 'voice' ? 'voice notes' : 'text'} · ${existing.turns} turn(s)`,
        );
      } else {
        lines.push('⚪ No stream here — `stream on [--voice|--text] [--rep=voice|text]` opens one.');
      }
      for (const c of calls) lines.push(`📞 Call in progress: **${c.label}**`);
      const binding = this.bindingFor(input.channel, input.conversation.id) ?? this.bindingFor(input.channel, voiceDefaultKey(input.user.id));
      lines.push(`Session: **${binding ? binding.label ?? binding.project : 'whatever is active'}**`);
      return lines.join('\n');
    }
    // break: the stream here, and this person's call.
    const ended: string[] = [];
    if (existing) {
      this.streams.delete(key);
      this.listeners.get(key)?.detach();
      ended.push(`the stream (${existing.turns} turn(s))`);
    }
    for (const c of calls) {
      await c.stop().catch(() => undefined);
      ended.push(`the call in ${c.label}`);
    }
    return ended.length ? `🔴 Ended ${ended.join(' and ')}.` : 'Nothing to end — no stream or call here.';
  }

  /** Files the agent sent: posted wherever someone is listening, and to the message channels. */
  private async relayFiles(files: AgentFile[] | undefined, caption?: string): Promise<void> {
    if (!Array.isArray(files) || !files.length) return;
    const loaded = files.map((f) => loadAgentFile(f)).filter((f): f is OutboundFile => f !== null);
    const links = files.filter((f) => f.url).map((f) => `📎 ${f.caption ?? f.name ?? 'link'}: ${f.url}`);
    const targets = new Map<string, ChannelOutbound>();
    for (const [key, l] of this.listeners) targets.set(key, l.out);
    for (const t of this.logTargets('agent_files')) if (!targets.has(t.key)) targets.set(t.key, t.out);
    for (const [key, out] of targets) {
      try {
        if (loaded.length) {
          if (out.sendFiles) await out.sendFiles(loaded, caption);
          else await out.send(`📎 ${caption ? `${caption}: ` : ''}${loaded.map((f) => f.name).join(', ')}`);
        }
        if (links.length) await out.send(links.join('\n'));
      } catch (err) {
        log.warn({ err, key }, 'posting the agent\'s files failed');
      }
    }
  }

  /**
   * Make this conversation a listener — what a connected phone is. Every line
   * the agent speaks is posted here (and as a voice message when the last
   * thing said here was one) until the conversation has been quiet for
   * `listenMs`; each new message renews it. While it listens, the agent's
   * speak() and next_voice_turn() see someone there, exactly as with the phone.
   */
  private attach(input: Omit<ChannelCommandInput, 'text'>, out: ChannelOutbound, opts: { mode: ReplyMode; sticky?: boolean }): void {
    const key = `${input.channel}:${input.conversation.id}`;
    const existing = this.listeners.get(key);
    if (existing) {
      existing.out = out;
      existing.mode = opts.mode;
      existing.sticky = Boolean(opts.sticky);
      existing.renew();
      return;
    }
    const listener: Listener = {
      out,
      mode: opts.mode,
      sticky: Boolean(opts.sticky),
      chain: Promise.resolve(),
      renew: () => undefined,
      detach: () => undefined,
    };
    let timer: NodeJS.Timeout | null = null;
    const unregister = this.register((payload) => {
      const msg = payload as { type?: string; text?: unknown };
      if (msg.type !== 'speak' || typeof msg.text !== 'string' || !msg.text.trim()) return;
      const line = msg.text;
      listener.chain = listener.chain.then(async () => {
        try {
          const wantsVoice = listener.mode !== 'text' && listener.out.sendVoice;
          const note = wantsVoice ? await this.voiceNoteOf(line) : null;
          if (note && listener.out.sendVoice) await listener.out.sendVoice(note.ogg, note.seconds, note.waveform);
          // Voice-only replies still fall back to text when no voice could be made.
          if (listener.mode !== 'voice' || !note) await listener.out.send(line);
        } catch (err) {
          log.warn({ err, channel: input.channel }, 'relaying an agent reply failed');
        }
      });
      listener.renew();
    }, `${input.channel} ${input.conversation.label}`);
    listener.detach = () => {
      if (timer) clearTimeout(timer);
      unregister();
      this.listeners.delete(key);
    };
    listener.renew = () => {
      if (timer) clearTimeout(timer);
      if (listener.sticky) return;
      timer = setTimeout(() => void listener.chain.then(listener.detach), this.listenMs);
      timer.unref?.();
    };
    listener.renew();
    this.listeners.set(key, listener);
  }

  /** Conversations currently receiving the agent's replies. */
  get listening(): number {
    return this.listeners.size;
  }

  private async toggleWatch(
    channel: ChannelId,
    conversationId: string,
    out: ChannelOutbound,
    say: (text: string) => void,
  ): Promise<void> {
    const key = `${channel}:${conversationId}`;
    const existing = this.watches.get(key);
    if (existing) {
      existing();
      say('Stopped the live status here.');
      return;
    }
    const render = () =>
      `📡 **Live status** — updated ${new Date().toLocaleTimeString()}\n` +
      `${formatStatus(this.ops.status(), this.bindingFor(channel, conversationId))}\n\n` +
      formatSessions(this.ops.sessions().slice(0, 5), this.bindingFor(channel, conversationId));
    const messageId = await out.send(render());
    say('');
    if (!messageId || !out.edit) return;
    let pending: NodeJS.Timeout | null = null;
    const update = () => {
      pending = null;
      out.edit!(messageId, render()).catch((err: unknown) => log.debug({ err, channel }, 'live status edit failed'));
    };
    const unsubscribe = subscribeEvents((event) => {
      if (!['voice_agent_status', 'user_turn', 'agent_event', 'job_status'].includes(event.type)) return;
      pending ??= setTimeout(update, WATCH_DEBOUNCE_MS);
    });
    const refresh = setInterval(update, WATCH_REFRESH_MS);
    const stop = () => {
      unsubscribe();
      clearInterval(refresh);
      if (pending) clearTimeout(pending);
      clearTimeout(expiry);
      this.watches.delete(key);
    };
    const expiry = setTimeout(stop, WATCH_MAX_MS);
    refresh.unref?.();
    expiry.unref?.();
    this.watches.set(key, stop);
  }

  close(): void {
    this.logRelay?.stop();
    this.stopFiles();
    for (const stop of this.watches.values()) stop();
    for (const l of [...this.listeners.values()]) l.detach();
  }
}
