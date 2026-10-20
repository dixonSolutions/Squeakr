/**
 * Everything an agent pipes into an audio stream (docs/47) is normalised here
 * to one format — headerless PCM16LE, mono, 24 kHz — so every listener (the
 * phone's PcmScheduler, a Discord call) plays it the same way it plays
 * streamed TTS.
 *
 *   files   — WAV (16-bit / float) decoded in plain code; Ogg/Opus through
 *             opusscript; anything else (mp3, flac, m4a, webm, ogg/vorbis…)
 *             through ffmpeg when it is installed.
 *   packets — raw PCM in the format the stream was opened with. Stateful, so
 *             a packet may split a sample or a frame anywhere.
 */

import { spawn } from 'node:child_process';
import { PcmConverter, findOnPath, parseWavHeader } from '../../cli/audioInput.js';
import { decodeOggOpusTo16k, resamplePcm16 } from '../../channels/audio.js';

export const AGENT_AUDIO_RATE = 24_000;

export type PacketEncoding = 'pcm_s16le' | 'pcm_f32le';

export interface PacketFormat {
  encoding: PacketEncoding;
  sampleRate: number;
  channels: number;
}

export interface DecodedAudio {
  /** PCM16LE mono at AGENT_AUDIO_RATE. */
  pcm: Buffer;
  /** What it was, for the stream's log: "WAV 16-bit PCM 44100 Hz × 2", "mp3 via ffmpeg". */
  format: string;
}

export function pcmDurationMs(pcm: Buffer, rate = AGENT_AUDIO_RATE): number {
  return Math.round(((pcm.length >> 1) / rate) * 1000);
}

/** Best guess at a container from its first bytes — only used to name it. */
export function sniffContainer(bytes: Buffer): string {
  const ascii = (from: number, to: number) => bytes.toString('ascii', from, to);
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return bytes.includes('OpusHead') ? 'ogg/opus' : 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') return 'mp4/m4a';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'webm/mkv';
  return 'unknown';
}

export interface DecodeDeps {
  /** Path to ffmpeg, or null when it is not installed. */
  ffmpeg(): string | null;
  /** Run ffmpeg on `input`, returning s16le mono at `rate`. */
  runFfmpeg(bin: string, input: Buffer, rate: number, signal?: AbortSignal): Promise<Buffer>;
}

export const defaultDecodeDeps: DecodeDeps = {
  ffmpeg: () => findOnPath('ffmpeg'),
  runFfmpeg,
};

function runFfmpeg(bin: string, input: Buffer, rate: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(rate), '-f', 's16le', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], signal },
    );
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 2000) err += b.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg could not decode it${err.trim() ? `: ${err.trim().split('\n')[0]}` : ` (exit ${code})`}`));
    });
    // ffmpeg may stop reading early (bad input); EPIPE is reported through `close`.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** A whole audio file → PCM16 mono 24 kHz. */
export async function decodeAudioFile(
  bytes: Buffer,
  opts: { signal?: AbortSignal; deps?: DecodeDeps } = {},
): Promise<DecodedAudio> {
  const deps = opts.deps ?? defaultDecodeDeps;
  if (bytes.length === 0) throw new Error('the audio is empty');
  const container = sniffContainer(bytes);

  if (container === 'wav') {
    try {
      const info = parseWavHeader(bytes);
      if (!info) throw new Error('truncated WAV header');
      const encoding = info.audioFormat === 3 ? 'float32' : 'int16';
      const converter = new PcmConverter(info, encoding, AGENT_AUDIO_RATE);
      return {
        pcm: converter.push(bytes.subarray(info.dataOffset)),
        format: `WAV ${info.bitsPerSample}-bit ${encoding === 'float32' ? 'float' : 'PCM'} ${info.sampleRate} Hz × ${info.channels}`,
      };
    } catch (err) {
      // An encoding we do not read in code (8-bit, 24-bit, µ-law…) — ffmpeg may.
      if (!deps.ffmpeg()) throw err;
    }
  }

  const ffmpeg = deps.ffmpeg();
  if (ffmpeg) {
    const pcm = await deps.runFfmpeg(ffmpeg, bytes, AGENT_AUDIO_RATE, opts.signal);
    return { pcm, format: `${container === 'unknown' ? 'audio' : container} via ffmpeg` };
  }

  if (container === 'ogg/opus') {
    const pcm16k = decodeOggOpusTo16k(bytes);
    return { pcm: resamplePcm16(pcm16k, 16_000, AGENT_AUDIO_RATE), format: 'Ogg/Opus' };
  }

  throw new Error(
    `cannot decode ${container === 'unknown' ? 'this audio' : container} without ffmpeg — install ffmpeg, ` +
      'or send WAV, Ogg/Opus, or raw PCM packets',
  );
}

/** Raw packets in the stream's declared format → PCM16 mono 24 kHz, across calls. */
export class PacketDecoder {
  private readonly converter: PcmConverter;

  constructor(readonly format: PacketFormat) {
    if (!Number.isInteger(format.sampleRate) || format.sampleRate < 8000 || format.sampleRate > 192_000) {
      throw new Error('sample_rate must be 8000–192000');
    }
    if (!Number.isInteger(format.channels) || format.channels < 1 || format.channels > 8) {
      throw new Error('channels must be 1–8');
    }
    this.converter = new PcmConverter(
      { sampleRate: format.sampleRate, channels: format.channels },
      format.encoding === 'pcm_f32le' ? 'float32' : 'int16',
      AGENT_AUDIO_RATE,
    );
  }

  push(bytes: Buffer): Buffer {
    return this.converter.push(bytes);
  }

  describe(): string {
    return `${this.format.encoding} ${this.format.sampleRate} Hz × ${this.format.channels}`;
  }
}

/** base64 or a data: URI → bytes. */
export function decodeBase64Payload(data: string): Buffer {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1;
  const body = comma >= 0 ? data.slice(comma + 1) : data;
  const bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (bytes.length === 0) throw new Error('data is not valid base64');
  return bytes;
}
