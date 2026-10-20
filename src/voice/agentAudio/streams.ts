/**
 * Agent audio streams (docs/47) — the agent's own audio, piped to whoever is
 * listening: a sound effect, a recording, a generated clip, a live feed of
 * PCM packets.
 *
 * An agent opens a stream, writes files or packets into it, and closes it.
 * Each stream picks how it shares the speaker:
 *
 *   queue — takes its turn in the speech queue: speech and queued streams sent
 *           after it wait until it has played, and it waits for what is
 *           already playing.
 *   async — starts at once and plays alongside everything else: speech and
 *           other streams go over it, nothing waits for it.
 *
 * Streams belong to the MCP session that opened them. An owner can hold many
 * at once, close any set of them (or all) in one call, and they are closed
 * for it when the session ends or a stream sits idle. Every stream keeps an
 * event log — opened, each write, playback reported by the listeners, notes
 * the agent adds, closed — which the agent reads back; the same events go to
 * the bridge log and the session transcript.
 *
 * Audio leaves here already decoded (decode.ts) as `agent_audio` frames on
 * the voice-session broadcast: `open`, `chunk` (base64 PCM16 24 kHz),
 * `end` (play out what you have) and `stop` (silence now).
 */

import { randomUUID } from 'node:crypto';
import { childLogger } from '../../log.js';
import {
  AGENT_AUDIO_RATE,
  PacketDecoder,
  decodeAudioFile,
  pcmDurationMs,
  type DecodeDeps,
  type DecodedAudio,
  type PacketFormat,
} from './decode.js';

const log = childLogger('voice:agent-audio');

export type AgentAudioMode = 'queue' | 'async';
export type AgentAudioCloseReason = 'agent' | 'agent_stop' | 'owner_gone' | 'idle';
export type PlaybackState = 'playing' | 'ended' | 'stopped' | 'error';

export const MAX_OPEN_STREAMS_PER_OWNER = 16;
export const MAX_OPEN_STREAMS = 48;
/** Total audio one stream may carry. */
export const MAX_STREAM_AUDIO_MS = 30 * 60_000;
/** A stream nobody has written to for this long is closed (drained). */
export const STREAM_IDLE_MS = 10 * 60_000;
/** Bytes per `chunk` frame: 250 ms of PCM16 at 24 kHz. */
export const CHUNK_BYTES = (AGENT_AUDIO_RATE / 4) * 2;
const MAX_LOG_ENTRIES = 200;
/** Closed streams kept per owner so their logs can still be read. */
const MAX_CLOSED_KEPT = 32;

export interface AudioStreamLogEntry {
  at: string;
  event: 'opened' | 'write' | 'write_failed' | 'playback' | 'note' | 'closed';
  detail: string;
}

export interface OpenOptions {
  label?: string;
  mode?: AgentAudioMode;
  /** 0–1. */
  volume?: number;
  /** Raw PCM packets this stream will take. Files never need it. */
  packetFormat?: PacketFormat;
  /** False keeps it out of the transcript and the phone's log (the bridge log still has it). */
  log?: boolean;
}

export type WriteInput =
  | { kind: 'file'; bytes: Buffer; source: string }
  | { kind: 'packet'; bytes: Buffer };

export interface AudioStreamSummary {
  stream_id: string;
  label: string;
  mode: AgentAudioMode;
  volume: number;
  state: 'open' | 'closed';
  opened_at: string;
  closed_at: string | null;
  close_reason: AgentAudioCloseReason | null;
  writes: number;
  audio_ms: number;
  packet_format: string | null;
  /** Last state each listener reported, by client name. */
  playback: Record<string, PlaybackState>;
  log?: AudioStreamLogEntry[];
}

interface StreamRecord {
  id: string;
  owner: string;
  label: string;
  mode: AgentAudioMode;
  volume: number;
  logToSession: boolean;
  state: 'open' | 'closed';
  openedAt: string;
  closedAt: string | null;
  closeReason: AgentAudioCloseReason | null;
  writes: number;
  audioMs: number;
  seq: number;
  packets: PacketDecoder | null;
  packetDesc: string | null;
  /** Writes run one at a time, in call order, whatever each decode takes. */
  chain: Promise<unknown>;
  /** Aborts in-flight decodes when the stream is stopped. */
  abort: AbortController;
  idleTimer: NodeJS.Timeout | null;
  playback: Record<string, PlaybackState>;
  log: AudioStreamLogEntry[];
}

export interface AgentAudioDeps {
  /** Broadcast one frame to every voice session. */
  send(payload: Record<string, unknown>): void;
  /** Is anyone listening (phone, pipe, call)? */
  hasListeners(): boolean;
  /** Transcript line for things the user would want in the record. */
  transcript(line: string): void;
  decode?: DecodeDeps;
  now?(): Date;
  idleMs?: number;
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string; message: string };

function fail(error: string, message: string): { ok: false; error: string; message: string } {
  return { ok: false, error, message };
}

export class AgentAudioStreams {
  private readonly streams = new Map<string, StreamRecord>();
  private readonly closedByOwner = new Map<string, StreamRecord[]>();

  constructor(private readonly deps: AgentAudioDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private openFor(owner: string): StreamRecord[] {
    return [...this.streams.values()].filter((s) => s.owner === owner && s.state === 'open');
  }

  private record(s: StreamRecord, event: AudioStreamLogEntry['event'], detail: string): void {
    s.log.push({ at: this.now().toISOString(), event, detail });
    if (s.log.length > MAX_LOG_ENTRIES) s.log.splice(0, s.log.length - MAX_LOG_ENTRIES);
    log.info({ stream: s.id, owner: s.owner, label: s.label, event }, `agent audio ${event}: ${detail}`);
  }

  private touch(s: StreamRecord): void {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = setTimeout(() => {
      s.idleTimer = null;
      void this.closeOne(s, true, 'idle');
    }, this.deps.idleMs ?? STREAM_IDLE_MS);
    s.idleTimer.unref?.();
  }

  open(owner: string, opts: OpenOptions = {}): Result<{ stream: AudioStreamSummary }> {
    if (!this.deps.hasListeners()) {
      return fail('NO_VOICE_SESSION', 'Nobody is listening — open an audio stream while a voice session is connected.');
    }
    if (this.openFor(owner).length >= MAX_OPEN_STREAMS_PER_OWNER) {
      return fail('TOO_MANY_STREAMS', `You already hold ${MAX_OPEN_STREAMS_PER_OWNER} open streams — close some first.`);
    }
    if ([...this.streams.values()].filter((s) => s.state === 'open').length >= MAX_OPEN_STREAMS) {
      return fail('TOO_MANY_STREAMS', 'The bridge has too many open audio streams — close some first.');
    }
    let packets: PacketDecoder | null = null;
    if (opts.packetFormat) {
      try {
        packets = new PacketDecoder(opts.packetFormat);
      } catch (err) {
        return fail('BAD_FORMAT', err instanceof Error ? err.message : String(err));
      }
    }
    let id: string;
    do id = `aud_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
    while (this.streams.has(id));

    const mode = opts.mode ?? 'queue';
    const s: StreamRecord = {
      id,
      owner,
      label: opts.label?.trim() || `audio ${this.streams.size + 1}`,
      mode,
      volume: Math.max(0, Math.min(1, opts.volume ?? 1)),
      logToSession: opts.log !== false,
      state: 'open',
      openedAt: this.now().toISOString(),
      closedAt: null,
      closeReason: null,
      writes: 0,
      audioMs: 0,
      seq: 0,
      packets,
      packetDesc: packets?.describe() ?? null,
      chain: Promise.resolve(),
      abort: new AbortController(),
      idleTimer: null,
      playback: {},
      log: [],
    };
    this.streams.set(id, s);
    this.record(s, 'opened', `${mode}${packets ? `, packets ${packets.describe()}` : ''}, volume ${s.volume}`);
    if (s.logToSession) this.deps.transcript(`🔊 agent opened audio stream "${s.label}" (${mode})`);
    this.deps.send({
      type: 'agent_audio',
      op: 'open',
      stream_id: id,
      label: s.label,
      mode,
      volume: s.volume,
      sample_rate: AGENT_AUDIO_RATE,
      encoding: 'pcm_s16le',
      log: s.logToSession,
    });
    this.touch(s);
    return { ok: true, stream: this.summary(s) };
  }

  private find(owner: string, id: string): StreamRecord | { ok: false; error: string; message: string } {
    const s = this.streams.get(id) ?? this.closedByOwner.get(owner)?.find((c) => c.id === id);
    if (!s) return fail('NOT_FOUND', `No audio stream ${id}.`);
    if (s.owner !== owner) return fail('NOT_OWNER', `Audio stream ${id} belongs to another session.`);
    return s;
  }

  /**
   * Decode `input` and send it. Writes to one stream play in the order they
   * were called, even when an earlier one (ffmpeg) takes longer to decode.
   */
  write(owner: string, id: string, input: WriteInput): Promise<Result<{ stream_id: string; seq: number; audio_ms: number; total_audio_ms: number; format: string; listeners: boolean }>> {
    const found = this.find(owner, id);
    if ('ok' in found) return Promise.resolve(found);
    const s = found;
    if (s.state !== 'open') return Promise.resolve(fail('CLOSED', `Audio stream ${id} is closed.`));
    if (input.kind === 'packet' && !s.packets) {
      return Promise.resolve(
        fail('BAD_FORMAT', 'This stream was opened without a packet format — pass format on audio_stream_open to write packets, or write whole files.'),
      );
    }
    this.touch(s);
    const run = s.chain.then(() => this.doWrite(s, input));
    s.chain = run.catch(() => undefined);
    return run;
  }

  private async doWrite(
    s: StreamRecord,
    input: WriteInput,
  ): Promise<Result<{ stream_id: string; seq: number; audio_ms: number; total_audio_ms: number; format: string; listeners: boolean }>> {
    if (s.state !== 'open') return fail('CLOSED', `Audio stream ${s.id} closed before this write played.`);
    let decoded: DecodedAudio;
    try {
      decoded =
        input.kind === 'packet'
          ? { pcm: s.packets!.push(input.bytes), format: s.packets!.describe() }
          : await decodeAudioFile(input.bytes, { signal: s.abort.signal, deps: this.deps.decode });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.record(s, 'write_failed', `${input.kind === 'file' ? input.source : 'packet'}: ${message}`);
      return fail('DECODE_FAILED', message);
    }
    // Stopped while ffmpeg ran.
    if (s.state !== 'open') return fail('CLOSED', `Audio stream ${s.id} was closed during the write.`);

    const ms = pcmDurationMs(decoded.pcm);
    if (s.audioMs + ms > MAX_STREAM_AUDIO_MS) {
      this.record(s, 'write_failed', `would pass the ${MAX_STREAM_AUDIO_MS / 60_000} min limit`);
      return fail('TOO_LONG', `A stream carries at most ${MAX_STREAM_AUDIO_MS / 60_000} minutes — open another one.`);
    }
    s.writes += 1;
    s.audioMs += ms;
    for (let off = 0; off < decoded.pcm.length; off += CHUNK_BYTES) {
      s.seq += 1;
      this.deps.send({
        type: 'agent_audio',
        op: 'chunk',
        stream_id: s.id,
        seq: s.seq,
        pcm: decoded.pcm.subarray(off, off + CHUNK_BYTES).toString('base64'),
      });
    }
    // Packets are logged in aggregate: a live feed would drown the log.
    if (input.kind === 'file' || s.writes === 1 || s.writes % 50 === 0) {
      this.record(
        s,
        'write',
        input.kind === 'file'
          ? `${input.source} — ${decoded.format}, ${(ms / 1000).toFixed(1)} s`
          : `packet #${s.writes} — ${(s.audioMs / 1000).toFixed(1)} s so far`,
      );
    }
    return {
      ok: true,
      stream_id: s.id,
      seq: s.seq,
      audio_ms: ms,
      total_audio_ms: s.audioMs,
      format: decoded.format,
      listeners: this.deps.hasListeners(),
    };
  }

  /**
   * Close streams. `drain` lets what was written play out (writes still
   * decoding finish first); otherwise playback stops at once.
   */
  async close(
    owner: string,
    sel: { ids?: string[]; all?: boolean; drain?: boolean },
  ): Promise<{ ok: boolean; closed: AudioStreamSummary[]; errors: Array<{ stream_id: string; error: string; message: string }> }> {
    const drain = sel.drain !== false;
    const targets: StreamRecord[] = [];
    const errors: Array<{ stream_id: string; error: string; message: string }> = [];
    if (sel.all) targets.push(...this.openFor(owner));
    for (const id of sel.ids ?? []) {
      const found = this.find(owner, id);
      if ('ok' in found) errors.push({ stream_id: id, error: found.error, message: found.message });
      else if (found.state === 'open') {
        if (!targets.includes(found)) targets.push(found);
      } else errors.push({ stream_id: id, error: 'CLOSED', message: `Audio stream ${id} is already closed.` });
    }
    await Promise.all(targets.map((s) => this.closeOne(s, drain, drain ? 'agent' : 'agent_stop')));
    return { ok: errors.length === 0, closed: targets.map((s) => this.summary(s)), errors };
  }

  private async closeOne(s: StreamRecord, drain: boolean, reason: AgentAudioCloseReason): Promise<void> {
    if (s.state !== 'open') return;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
    if (drain) {
      await s.chain;
      if (s.state !== 'open') return;
    } else {
      s.abort.abort();
    }
    s.state = 'closed';
    s.closedAt = this.now().toISOString();
    s.closeReason = reason;
    s.packets = null;
    this.deps.send({ type: 'agent_audio', op: drain ? 'end' : 'stop', stream_id: s.id, reason });
    this.record(s, 'closed', `${reason}${drain ? '' : ' (stopped)'} — ${s.writes} writes, ${(s.audioMs / 1000).toFixed(1)} s`);
    if (s.logToSession) this.deps.transcript(`🔊 audio stream "${s.label}" closed (${reason}, ${(s.audioMs / 1000).toFixed(1)} s)`);

    this.streams.delete(s.id);
    const kept = this.closedByOwner.get(s.owner) ?? [];
    kept.push(s);
    if (kept.length > MAX_CLOSED_KEPT) kept.splice(0, kept.length - MAX_CLOSED_KEPT);
    this.closedByOwner.set(s.owner, kept);
  }

  /** The owner's MCP session ended: let its streams play out, then forget the logs. */
  async closeOwner(owner: string): Promise<void> {
    await Promise.all(this.openFor(owner).map((s) => this.closeOne(s, true, 'owner_gone')));
    this.closedByOwner.delete(owner);
  }

  list(owner: string, opts: { includeClosed?: boolean; includeLog?: boolean } = {}): AudioStreamSummary[] {
    const open = this.openFor(owner);
    const closed = opts.includeClosed ? (this.closedByOwner.get(owner) ?? []) : [];
    return [...open, ...closed].map((s) => this.summary(s, opts.includeLog));
  }

  /** Append the agent's own note to streams' logs, and return the logs. */
  note(owner: string, ids: string[], text?: string): Result<{ streams: AudioStreamSummary[] }> {
    const out: StreamRecord[] = [];
    for (const id of ids) {
      const found = this.find(owner, id);
      if ('ok' in found) return found;
      out.push(found);
    }
    const note = text?.trim();
    if (note) {
      for (const s of out) {
        this.record(s, 'note', note);
        if (s.logToSession) this.deps.transcript(`🔊 "${s.label}": ${note}`);
      }
      if (out.some((s) => s.logToSession)) {
        this.deps.send({
          type: 'session_log',
          subcategory: 'tts',
          level: 'info',
          summary: `Audio ${out.map((s) => `"${s.label}"`).join(', ')}: ${note}`,
        });
      }
    }
    return { ok: true, streams: out.map((s) => this.summary(s, true)) };
  }

  /** A listener reports what it is doing with a stream (PWA `agent_audio_state`). */
  reportPlayback(client: string, id: string, state: PlaybackState, message?: string): void {
    const s = this.streams.get(id) ?? [...this.closedByOwner.values()].flat().find((c) => c.id === id);
    if (!s) return;
    if (s.playback[client] === state) return;
    s.playback[client] = state;
    this.record(s, 'playback', `${client}: ${state}${message ? ` — ${message}` : ''}`);
  }

  private summary(s: StreamRecord, includeLog = false): AudioStreamSummary {
    return {
      stream_id: s.id,
      label: s.label,
      mode: s.mode,
      volume: s.volume,
      state: s.state,
      opened_at: s.openedAt,
      closed_at: s.closedAt,
      close_reason: s.closeReason,
      writes: s.writes,
      audio_ms: s.audioMs,
      packet_format: s.packetDesc,
      playback: { ...s.playback },
      ...(includeLog ? { log: [...s.log] } : {}),
    };
  }
}
