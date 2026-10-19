/**
 * audio_stream_open / _write / _close / _list / _log — the agent pipes its own
 * audio to the user (docs/47). The streams themselves live in
 * voice/agentAudio/streams.ts; this file turns tool arguments into bytes and
 * owns the one registry every MCP session shares.
 */

import { readFile, stat } from 'node:fs/promises';
import { childLogger } from '../../log.js';
import { recordTranscriptEvent } from '../../logging/transcripts.js';
import { AgentAudioStreams, type AgentAudioMode, type PlaybackState } from '../../voice/agentAudio/streams.js';
import { decodeBase64Payload, type PacketEncoding } from '../../voice/agentAudio/decode.js';
import { resolveAllowedImagePath } from './imageRegistry.js';
import { broadcastToVoiceSessions, hasActiveVoiceSession } from './voiceToolHandlers.js';

const log = childLogger('mcp:server:audioStreams');

/** Largest file or packet one write takes, before decoding. */
export const MAX_WRITE_BYTES = 64 * 1024 * 1024;
const URL_TIMEOUT_MS = 30_000;

export const agentAudioStreams = new AgentAudioStreams({
  send: (payload) => broadcastToVoiceSessions(payload),
  hasListeners: hasActiveVoiceSession,
  transcript: recordTranscriptEvent,
});

/** A listener's playback report (`agent_audio_state` on /ws). */
export function reportAgentAudioPlayback(client: string, msg: Record<string, unknown>): void {
  const id = typeof msg['stream_id'] === 'string' ? msg['stream_id'] : '';
  const state = msg['state'];
  if (!id || (state !== 'playing' && state !== 'ended' && state !== 'stopped' && state !== 'error')) return;
  agentAudioStreams.reportPlayback(client, id, state as PlaybackState, typeof msg['message'] === 'string' ? msg['message'].slice(0, 200) : undefined);
}

export interface AudioStreamOpenArgs {
  label?: string;
  mode?: AgentAudioMode;
  volume?: number;
  format?: { encoding?: PacketEncoding; sample_rate: number; channels?: number };
  log?: boolean;
  /** A first file to play, so "play this" is one call. */
  path?: string;
  url?: string;
  data?: string;
  /** Close (drained) once that file is in — a one-shot. */
  close?: boolean;
}

/**
 * Open a stream — and, given a file, write it and optionally close it in the
 * same call. Model latency between tool calls is seconds; a one-shot sound
 * should not cost three of them.
 */
export async function handleAudioStreamOpen(owner: string, args: AudioStreamOpenArgs) {
  const sources = [args.path, args.url, args.data].filter((v) => v != null && v !== '').length;
  if (sources > 1) return { ok: false, error: 'BAD_ARGS', message: 'Pass at most one of path, url or data.' };
  if (args.close && sources === 0) return { ok: false, error: 'BAD_ARGS', message: 'close: true needs a path, url or data to play.' };
  // Read the file first: a bad path should not leave an empty stream behind.
  let file: { bytes: Buffer; source: string } | null = null;
  if (sources === 1) {
    try {
      file = await loadFile(args);
    } catch (err) {
      return { ok: false, error: 'BAD_INPUT', message: err instanceof Error ? err.message : String(err) };
    }
  }
  const result = agentAudioStreams.open(owner, {
    label: args.label,
    mode: args.mode,
    volume: args.volume,
    log: args.log,
    packetFormat: args.format
      ? { encoding: args.format.encoding ?? 'pcm_s16le', sampleRate: args.format.sample_rate, channels: args.format.channels ?? 1 }
      : undefined,
  });
  if (!result.ok) return result;
  const id = result.stream.stream_id;
  if (!file) return { ok: true, ...result.stream };

  const written = await agentAudioStreams.write(owner, id, { kind: 'file', ...file });
  if (!written.ok) {
    await agentAudioStreams.close(owner, { ids: [id], drain: false });
    return { ...written, stream_id: id, closed: true };
  }
  if (args.close) await agentAudioStreams.close(owner, { ids: [id] });
  const [summary] = agentAudioStreams.list(owner, { includeClosed: true }).filter((s) => s.stream_id === id);
  return { ok: true, ...(summary ?? result.stream), format: written.format, written_ms: written.audio_ms };
}

export interface AudioStreamWriteArgs {
  stream_id: string;
  path?: string;
  url?: string;
  data?: string;
  packet?: string;
}

async function loadFile(args: { path?: string; url?: string; data?: string }): Promise<{ bytes: Buffer; source: string }> {
  if (args.path) {
    const resolved = resolveAllowedImagePath(args.path);
    if (!resolved) throw new Error(`${args.path} is not a readable file under a project or the temp directory`);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error(`${args.path} is not a file`);
    if (info.size > MAX_WRITE_BYTES) throw new Error(`${args.path} is larger than ${MAX_WRITE_BYTES >> 20} MB`);
    return { bytes: await readFile(resolved), source: resolved.split(/[\\/]/).pop() ?? resolved };
  }
  if (args.url) {
    if (!/^https?:\/\//i.test(args.url)) throw new Error('url must be http(s)');
    const res = await fetch(args.url, { signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${args.url} answered ${res.status}`);
    const length = Number(res.headers.get('content-length') ?? 0);
    if (length > MAX_WRITE_BYTES) throw new Error(`${args.url} is larger than ${MAX_WRITE_BYTES >> 20} MB`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_WRITE_BYTES) throw new Error(`${args.url} is larger than ${MAX_WRITE_BYTES >> 20} MB`);
    return { bytes, source: args.url };
  }
  const bytes = decodeBase64Payload(args.data ?? '');
  if (bytes.length > MAX_WRITE_BYTES) throw new Error(`data is larger than ${MAX_WRITE_BYTES >> 20} MB`);
  return { bytes, source: `data (${(bytes.length / 1024).toFixed(0)} KB)` };
}

export async function handleAudioStreamWrite(owner: string, args: AudioStreamWriteArgs) {
  const given = [args.path, args.url, args.data, args.packet].filter((v) => v != null && v !== '').length;
  if (given !== 1) {
    return { ok: false, error: 'BAD_ARGS', message: 'Pass exactly one of path, url, data (a whole file) or packet (raw PCM).' };
  }
  try {
    if (args.packet) {
      const bytes = decodeBase64Payload(args.packet);
      if (bytes.length > MAX_WRITE_BYTES) throw new Error(`packet is larger than ${MAX_WRITE_BYTES >> 20} MB`);
      return await agentAudioStreams.write(owner, args.stream_id, { kind: 'packet', bytes });
    }
    const file = await loadFile(args);
    return await agentAudioStreams.write(owner, args.stream_id, { kind: 'file', ...file });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ stream: args.stream_id, err: message }, 'audio_stream_write failed');
    return { ok: false, error: 'BAD_INPUT', message };
  }
}

export function handleAudioStreamClose(owner: string, args: { stream_ids?: string[]; all?: boolean; drain?: boolean }) {
  if (!args.all && !args.stream_ids?.length) {
    return Promise.resolve({ ok: false, error: 'BAD_ARGS', message: 'Pass stream_ids, or all: true.' });
  }
  return agentAudioStreams.close(owner, { ids: args.stream_ids, all: args.all, drain: args.drain });
}

export function handleAudioStreamList(owner: string, args: { include_closed?: boolean; include_log?: boolean }) {
  const streams = agentAudioStreams.list(owner, { includeClosed: args.include_closed, includeLog: args.include_log });
  return { ok: true, open: streams.filter((s) => s.state === 'open').length, streams };
}

export function handleAudioStreamLog(owner: string, args: { stream_ids: string[]; note?: string }) {
  const result = agentAudioStreams.note(owner, args.stream_ids, args.note);
  return result.ok ? { ok: true, streams: result.streams } : result;
}

/** The MCP session ended — its open streams play out and are closed. */
export function closeAgentAudioOwner(owner: string): void {
  void agentAudioStreams.closeOwner(owner).catch((err) => log.warn({ err, owner }, 'closing audio streams failed'));
}
