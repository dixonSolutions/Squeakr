/**
 * `squeakr pipe` — stream audio straight into the voice agent.
 *
 *   arecord -f S16_LE -r 16000 -c 1 -t raw | squeakr pipe
 *   squeakr pipe --mic
 *   squeakr pipe --file question.wav
 *   squeakr pipe --mic --project my-app     # select the project first
 *
 * Audio goes to the bridge's /ws/audio-stream, which cuts it at pauses,
 * transcribes each piece and hands it to the agent as it lands. The agent's
 * spoken replies come back on the same socket and are printed, so this works
 * with no phone connected at all. Turns (the phone's wake phrase + VAD) stay
 * the recommended way to talk to the agent — see docs/41-audio-stream-pipe.md.
 *
 * The conversation goes to stdout and diagnostics to stderr, so
 * `squeakr pipe --mic > convo.txt` keeps just the dialogue; `--json` prints
 * every bridge event as NDJSON instead.
 */

import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import { UsageError, type Parsed } from '../args.js';
import {
  AudioNormalizer,
  spawnFfmpegDecoder,
  spawnMicRecorder,
  type SpawnedSource,
} from '../audioInput.js';
import { findBridge } from '../bridge.js';
import { envValue, resolveHome } from '../home.js';
import { dim, fail, note, say } from '../out.js';

export const PIPE_VALUE_FLAGS = [
  'file',
  'rate',
  'channels',
  'url',
  'token',
  'name',
  'silence',
  'max-segment',
  'threshold',
  'linger',
  'project',
];
export const PIPE_SWITCHES = ['mic', 'realtime', 'json', 'no-listen'];

export interface PipeOptions {
  mic: boolean;
  file?: string;
  rate: number;
  channels: number;
  realtime: boolean;
  json: boolean;
  listen: boolean;
  lingerMs: number;
  url?: string;
  token?: string;
  name?: string;
  /** Project to make active before the first segment — what the phone's dropdown does. */
  project?: string;
  segment: Record<string, number>;
}

function numberFlag(parsed: Parsed, name: string): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number (got "${raw}")`);
  return n;
}

/** Turn parsed argv into options — every usage error is raised here, before any I/O. */
export function pipeOptions(parsed: Parsed): PipeOptions {
  const mic = parsed.switches.has('mic');
  const file = parsed.values.get('file');
  if (mic && file) throw new UsageError('use either --mic or --file, not both');

  const segment: Record<string, number> = {};
  const silence = numberFlag(parsed, 'silence');
  const maxSegment = numberFlag(parsed, 'max-segment');
  const threshold = numberFlag(parsed, 'threshold');
  if (silence !== undefined) segment['segmentSilenceMs'] = silence;
  if (maxSegment !== undefined) segment['maxSegmentMs'] = maxSegment;
  if (threshold !== undefined) segment['speechThreshold'] = threshold;

  const url = parsed.values.get('url');
  const token = parsed.values.get('token');
  const name = parsed.values.get('name');
  const project = parsed.values.get('project')?.trim();
  return {
    mic,
    ...(file ? { file } : {}),
    rate: numberFlag(parsed, 'rate') ?? 16_000,
    channels: numberFlag(parsed, 'channels') ?? 1,
    realtime: parsed.switches.has('realtime'),
    json: parsed.switches.has('json'),
    listen: !parsed.switches.has('no-listen'),
    lingerMs: (numberFlag(parsed, 'linger') ?? 30) * 1000,
    ...(url ? { url } : {}),
    ...(token ? { token } : {}),
    ...(name ? { name } : {}),
    ...(project ? { project } : {}),
    segment,
  };
}

/** http(s)://host → ws(s)://host/path */
export function toWsUrl(base: string, path: string): string {
  const url = new URL(base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  url.pathname = path;
  url.search = '';
  return url.toString();
}

/** Where the audio comes from, plus a label for the status line. */
function openSource(opts: PipeOptions): { stream: Readable; label: string; child?: SpawnedSource } {
  if (opts.mic) {
    const src = spawnMicRecorder();
    return { stream: src.stream, label: `microphone (${src.name})`, child: src };
  }
  if (opts.file) {
    if (extname(opts.file).toLowerCase() === '.wav') {
      return { stream: createReadStream(opts.file), label: opts.file };
    }
    const src = spawnFfmpegDecoder(opts.file);
    return { stream: src.stream, label: `${opts.file} (ffmpeg)`, child: src };
  }
  if (process.stdin.isTTY) {
    throw new UsageError('nothing on stdin — pipe audio in, or use --mic / --file');
  }
  return { stream: process.stdin, label: 'stdin' };
}

export async function pipeCommand(opts: PipeOptions): Promise<number> {
  const home = resolveHome();
  const token = opts.token?.trim() || envValue(home, 'APP_TOKEN')?.trim();
  if (!token) {
    fail(`no APP_TOKEN — pass --token, or run where ${home}/.env has one (squeakr token --new)`);
    return 1;
  }

  let base = opts.url?.replace(/\/+$/, '');
  if (!base) {
    const bridge = await findBridge(home);
    if (!bridge.answering) {
      const where = bridge.configured?.url ?? 'the configured port';
      fail(`the bridge is not answering at ${where} — start it (squeakr run, or squeakr start), or pass --url`);
      return 1;
    }
    base = bridge.answering.endpoint.url;
  }

  // Everything opened below is torn down in finish(), so the process exits on
  // its own once the pipe is done — main() never calls process.exit.
  return new Promise<number>((resolveExit) => runPipe(opts, base!, token, resolveExit));
}

function runPipe(opts: PipeOptions, base: string, token: string, done: (code: number) => void): void {
  const wsUrl = toWsUrl(base, '/ws/audio-stream');
  const status = (line: string): void => {
    if (!opts.json) note(line);
  };
  const emitJson = (event: unknown): void => {
    if (opts.json) say(JSON.stringify(event));
  };

  const ws = new WebSocket(wsUrl);
  let source: ReturnType<typeof openSource> | null = null;
  let ready = false;
  let inputEnded = false;
  let drained = false;
  let agentBusy = false;
  let lastActivity = Date.now();
  let lingerTimer: NodeJS.Timeout | null = null;
  let endSent = false;
  let finished = false;
  let bytesSent = 0;
  const t0 = Date.now();
  const queue: Buffer[] = [];

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    if (lingerTimer) clearInterval(lingerTimer);
    process.off('SIGINT', onSigint);
    source?.child?.child.kill('SIGTERM');
    if (source?.stream === process.stdin) process.stdin.destroy();
    else source?.stream.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'pipe finished');
    }
    done(code);
  };

  /** Tell the bridge no more audio is coming (once). */
  const sendEnd = (): void => {
    if (endSent || ws.readyState !== WebSocket.OPEN) return;
    endSent = true;
    ws.send(JSON.stringify({ type: 'end' }));
  };

  /** After input ends: drain, then wait for the agent to finish replying (bounded by --linger). */
  const maybeFinish = (): void => {
    if (!inputEnded || !drained || finished) return;
    if (!opts.listen || opts.lingerMs === 0) {
      finish(0);
      return;
    }
    if (lingerTimer) return;
    const deadline = Date.now() + opts.lingerMs;
    lingerTimer = setInterval(() => {
      const quietFor = Date.now() - lastActivity;
      if (Date.now() > deadline || (!agentBusy && quietFor > 2500)) finish(0);
    }, 250);
  };

  const send = (pcm: Buffer): void => {
    if (!ready) {
      queue.push(pcm);
      return;
    }
    // Keep each frame comfortably under the bridge's per-message cap.
    for (let off = 0; off < pcm.length; off += 64 * 1024) {
      ws.send(pcm.subarray(off, off + 64 * 1024), { binary: true });
    }
    bytesSent += pcm.length;
  };

  const pace = async (): Promise<void> => {
    if (!opts.realtime) return;
    const audioMs = (bytesSent / 2 / 16_000) * 1000;
    const ahead = audioMs - (Date.now() - t0);
    if (ahead > 50) await new Promise((r) => setTimeout(r, ahead));
  };

  const startInput = (): void => {
    try {
      source = openSource(opts);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      finish(err instanceof UsageError ? 2 : 1);
      return;
    }
    const src = source;
    status(dim(`  input: ${src.label}`));
    const normalizer = new AudioNormalizer(
      { sampleRate: opts.rate, channels: opts.channels },
      (pcm) => send(pcm),
      (desc) => status(dim(`  audio: ${desc}`)),
    );
    src.child?.child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString().trim();
      if (text) status(dim(`  ${src.child!.name}: ${text}`));
    });
    src.child?.child.on('error', (err) => {
      fail(`${src.child!.name} failed: ${err.message}`);
      finish(1);
    });

    void (async () => {
      try {
        for await (const chunk of src.stream) {
          if (finished || endSent) break;
          normalizer.push(chunk as Buffer);
          await pace();
        }
      } catch (err) {
        if (!finished) status(`  input error: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (finished) return;
      inputEnded = true;
      status(dim(`  input ended — ${(bytesSent / 32_000).toFixed(1)} s of audio sent; waiting for the last transcripts…`));
      sendEnd();
    })();
  };

  /** Segments whose words are printed but whose delivery frame has not arrived. */
  const printedSegments = new Set<number>();

  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token }));
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    // Agent audio (docs/47) is not played here; keep its base64 out of --json.
    emitJson(
      msg['type'] === 'agent_audio' && typeof msg['pcm'] === 'string'
        ? { ...msg, pcm: undefined, bytes: Math.floor((msg['pcm'].length * 3) / 4) }
        : msg,
    );
    lastActivity = Date.now();

    switch (msg['type']) {
      case 'auth_ok':
        ws.send(
          JSON.stringify({
            type: 'start',
            sampleRate: 16_000,
            encoding: 'pcm_s16le',
            channels: 1,
            client: 'cli',
            listen: opts.listen,
            ...(opts.name ? { name: opts.name } : {}),
            ...(opts.project ? { project: opts.project } : {}),
            ...(Object.keys(opts.segment).length ? { segment: opts.segment } : {}),
          }),
        );
        break;
      case 'ready': {
        ready = true;
        const seg = msg['segment'] as { segmentSilenceMs?: number } | undefined;
        status(`squeakr pipe → ${wsUrl}`);
        status(
          dim(
            `  speech-to-text: ${String(msg['stt'])} · segments end after ${seg?.segmentSilenceMs ?? '?'} ms of silence` +
              (opts.listen ? '' : ' · not listening for replies'),
          ),
        );
        if (typeof msg['project'] === 'string') status(dim(`  project: ${msg['project']}`));
        for (const pcm of queue.splice(0)) send(pcm);
        startInput();
        status(dim(opts.mic ? '  listening — speak; Ctrl-C to stop' : '  streaming…'));
        break;
      }
      // `transcript` lands the moment the words exist; `segment` follows once the
      // agent has them. An older bridge sends only `segment`.
      case 'transcript':
      case 'segment': {
        const index = Number(msg['index'] ?? 0);
        if (!printedSegments.has(index)) {
          printedSegments.add(index);
          if (!opts.json) say(`you ▸ ${String(msg['text'] ?? '')}`);
          const secs = (Number(msg['audio_ms'] ?? 0) / 1000).toFixed(1);
          status(dim(`      (${secs} s audio, ${String(msg['latency_ms'] ?? '?')} ms to transcribe)`));
        }
        if (msg['type'] === 'segment') {
          printedSegments.delete(index);
          if (msg['delivered'] === false && typeof msg['message'] === 'string') {
            status(`  ! not delivered: ${msg['message']}`);
          }
        }
        break;
      }
      case 'speak':
        if (!opts.json) say(`agent ◂ ${String(msg['text'] ?? '')}`);
        break;
      case 'agent_audio':
        if (msg['op'] === 'open' && !opts.json) {
          say(`agent ◂ 🔊 "${String(msg['label'] ?? 'audio')}" (${String(msg['mode'] ?? 'queue')} — plays on the phone or a call)`);
        }
        break;
      case 'thinking':
        agentBusy = msg['value'] === true;
        break;
      case 'turn_complete':
        agentBusy = false;
        break;
      case 'voice_agent_status':
        status(dim(`  · ${String(msg['provider_name'] ?? 'agent')} ${String(msg['state'] ?? '')}`));
        if (msg['state'] === 'done' || msg['state'] === 'error' || msg['state'] === 'stopped') agentBusy = false;
        break;
      case 'drained':
        drained = true;
        break;
      case 'error':
        status(`  ! ${String(msg['message'] ?? 'error')}`);
        if (msg['fatal'] === true) finish(3);
        break;
      default:
        break;
    }
    maybeFinish();
  });

  ws.on('close', (code, reason) => {
    if (finished) return;
    if (code === 4001) {
      fail('the bridge rejected the app token (check --token / APP_TOKEN)');
      finish(4);
      return;
    }
    fail(`connection closed — ${reason.toString() || `code ${code}`}`);
    finish(5);
  });

  ws.on('error', (err) => {
    if (finished) return;
    const hint = /ECONNREFUSED/.test(err.message) ? ` — is the bridge running at ${base}?` : '';
    fail(`${err.message}${hint}`);
    finish(5);
  });

  let sigints = 0;
  function onSigint(): void {
    sigints += 1;
    if (sigints > 1 || ws.readyState !== WebSocket.OPEN) {
      finish(130);
      return;
    }
    status('\n  stopping — finishing the last segment (Ctrl-C again to quit now)');
    source?.child?.child.kill('SIGTERM');
    inputEnded = true;
    sendEnd();
  }
  process.on('SIGINT', onSigint);
}
