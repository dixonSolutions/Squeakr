/**
 * Audio sources for `squeakr pipe`, normalised to what /ws/audio-stream
 * takes: PCM16LE, mono, 16 kHz.
 *
 *   stdin  — raw PCM (rate/channels from flags) or a WAV stream, auto-detected
 *   --file — a WAV file, or anything else via ffmpeg
 *   --mic  — the default microphone via pw-record / parec / arecord / sox / ffmpeg
 *
 * The converter is incremental: chunks can split a sample, a frame or the WAV
 * header anywhere, which is what real pipes do.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Readable } from 'node:stream';

export const TARGET_RATE = 16_000;

export interface PcmFormat {
  sampleRate: number;
  channels: number;
}

// ── WAV header ───────────────────────────────────────────────────────────

export interface WavInfo extends PcmFormat {
  bitsPerSample: number;
  /** 1 = integer PCM, 3 = IEEE float. */
  audioFormat: number;
  /** Offset of the first sample byte. */
  dataOffset: number;
}

/**
 * Parse a RIFF/WAVE header from the start of `buf`.
 * Returns null while more bytes are needed; throws if it is not a usable WAV.
 */
export function parseWavHeader(buf: Buffer): WavInfo | null {
  if (buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE stream');
  }
  let offset = 12;
  let fmt: Omit<WavInfo, 'dataOffset'> | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      return { ...fmt, dataOffset: body };
    }
    if (body + size > buf.length) return null;
    if (id === 'fmt ') {
      let audioFormat = buf.readUInt16LE(body);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first 2 bytes of the sub-format GUID.
      if (audioFormat === 0xfffe && size >= 26) audioFormat = buf.readUInt16LE(body + 24);
      fmt = {
        audioFormat,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
      const supported =
        (fmt.audioFormat === 1 && fmt.bitsPerSample === 16) ||
        (fmt.audioFormat === 3 && fmt.bitsPerSample === 32);
      if (!supported) {
        throw new Error(
          `unsupported WAV encoding (format ${fmt.audioFormat}, ${fmt.bitsPerSample}-bit) — use 16-bit PCM or 32-bit float, or pass the file through ffmpeg`,
        );
      }
    }
    // Chunks are word-aligned.
    offset = body + size + (size % 2);
  }
  return null;
}

// ── Converter ────────────────────────────────────────────────────────────

/**
 * Interleaved samples at any rate/channel count → mono PCM16LE at 16 kHz (or
 * `targetRate` — agent audio streams play at 24 kHz, docs/47).
 * Downmix averages channels; resampling is linear interpolation, with the
 * fractional read position carried across chunks so there are no seams.
 */
export class PcmConverter {
  private carry = Buffer.alloc(0);
  private readonly bytesPerSample: number;
  private readonly frameBytes: number;
  private readonly step: number;
  /** Fractional read position into the pending mono samples. */
  private pos = 0;
  /** Mono float samples not yet consumed by the resampler (keeps one for interpolation). */
  private pending: number[] = [];

  constructor(
    private readonly format: PcmFormat,
    private readonly encoding: 'int16' | 'float32' = 'int16',
    private readonly targetRate = TARGET_RATE,
  ) {
    if (format.sampleRate <= 0 || format.channels <= 0) throw new Error('invalid PCM format');
    this.bytesPerSample = encoding === 'int16' ? 2 : 4;
    this.frameBytes = this.bytesPerSample * format.channels;
    this.step = format.sampleRate / targetRate;
  }

  /** True when input already is mono PCM16 at the target rate — bytes pass through untouched. */
  get isPassthrough(): boolean {
    return this.encoding === 'int16' && this.format.channels === 1 && this.format.sampleRate === this.targetRate;
  }

  push(chunk: Buffer): Buffer {
    const data = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    const whole = data.length - (data.length % this.frameBytes);
    this.carry = Buffer.from(data.subarray(whole));
    if (whole === 0) return Buffer.alloc(0);
    if (this.isPassthrough) return Buffer.from(data.subarray(0, whole));

    const { channels } = this.format;
    for (let off = 0; off < whole; off += this.frameBytes) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        const at = off + c * this.bytesPerSample;
        sum += this.encoding === 'int16' ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
      }
      this.pending.push(sum / channels);
    }
    return this.resample();
  }

  private resample(): Buffer {
    let out: number[] = [];
    if (this.step === 1) {
      // Same rate (only a downmix or float→int): nothing to interpolate, so
      // nothing to hold back for the next chunk.
      out = this.pending;
      this.pending = [];
      return this.toPcm16(out);
    }
    // Need samples at floor(pos) and floor(pos)+1.
    while (this.pos + 1 < this.pending.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = this.pending[i] ?? 0;
      const b = this.pending[i + 1] ?? a;
      out.push(a + (b - a) * frac);
      this.pos += this.step;
    }
    const consumed = Math.floor(this.pos);
    if (consumed > 0) {
      this.pending = this.pending.slice(consumed);
      this.pos -= consumed;
    }
    return this.toPcm16(out);
  }

  private toPcm16(out: number[]): Buffer {
    const buf = Buffer.alloc(out.length * 2);
    for (let i = 0; i < out.length; i++) {
      const s = Math.max(-1, Math.min(1, out[i] ?? 0));
      buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), i * 2);
    }
    return buf;
  }
}

/**
 * Wrap a byte stream that may or may not start with a WAV header.
 * `onFormat` reports what was detected; `onPcm` receives normalised audio.
 */
export class AudioNormalizer {
  private head = Buffer.alloc(0);
  private converter: PcmConverter | null = null;
  private decided = false;

  constructor(
    private readonly rawFormat: PcmFormat,
    private readonly onPcm: (pcm: Buffer) => void,
    private readonly onFormat?: (desc: string) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.decided) {
      this.emit(this.converter!.push(chunk));
      return;
    }
    this.head = Buffer.concat([this.head, chunk]);
    if (this.head.length < 4) return;
    if (this.head.toString('ascii', 0, 4) !== 'RIFF') {
      this.decide(new PcmConverter(this.rawFormat), `raw PCM16LE ${this.rawFormat.sampleRate} Hz × ${this.rawFormat.channels}`);
      return;
    }
    const info = parseWavHeader(this.head);
    if (!info) {
      if (this.head.length > 1024 * 1024) throw new Error('WAV header larger than 1 MB — not a WAV stream?');
      return;
    }
    this.head = this.head.subarray(info.dataOffset);
    this.decide(
      new PcmConverter(info, info.audioFormat === 3 ? 'float32' : 'int16'),
      `WAV ${info.bitsPerSample}-bit ${info.audioFormat === 3 ? 'float' : 'PCM'} ${info.sampleRate} Hz × ${info.channels}`,
    );
  }

  private decide(converter: PcmConverter, desc: string): void {
    this.converter = converter;
    this.decided = true;
    this.onFormat?.(converter.isPassthrough ? `${desc} (sent as-is)` : `${desc} → 16 kHz mono`);
    const rest = this.head;
    this.head = Buffer.alloc(0);
    this.emit(converter.push(rest));
  }

  private emit(pcm: Buffer): void {
    if (pcm.length > 0) this.onPcm(pcm);
  }
}

// ── External recorders / decoders ────────────────────────────────────────

/** First executable named `cmd` on PATH, or null. */
export function findOnPath(cmd: string, pathEnv = process.env['PATH'] ?? ''): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface RecorderCommand {
  name: string;
  command: string;
  args: string[];
}

/** Recorders that can emit 16 kHz mono PCM16 on stdout, in preference order. */
export function micRecorderCandidates(platform = process.platform): RecorderCommand[] {
  const list: RecorderCommand[] = [];
  if (platform === 'linux') {
    list.push(
      { name: 'pw-record', command: 'pw-record', args: ['--rate', '16000', '--channels', '1', '--format', 's16', '-'] },
      { name: 'parec', command: 'parec', args: ['--rate=16000', '--channels=1', '--format=s16le', '--raw'] },
      { name: 'arecord', command: 'arecord', args: ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'raw'] },
    );
  }
  list.push({
    name: 'sox',
    command: 'sox',
    args: ['-q', '-d', '-t', 'raw', '-r', '16000', '-e', 'signed', '-b', '16', '-c', '1', '-'],
  });
  const ffmpegInput =
    platform === 'darwin'
      ? ['-f', 'avfoundation', '-i', ':0']
      : platform === 'win32'
        ? ['-f', 'dshow', '-i', 'audio=default']
        : ['-f', 'pulse', '-i', 'default'];
  list.push({
    name: 'ffmpeg',
    command: 'ffmpeg',
    args: ['-hide_banner', '-loglevel', 'error', ...ffmpegInput, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
  });
  return list;
}

export interface SpawnedSource {
  name: string;
  stream: Readable;
  child: ChildProcess;
}

/** Start the first available microphone recorder. */
export function spawnMicRecorder(): SpawnedSource {
  for (const candidate of micRecorderCandidates()) {
    const bin = findOnPath(candidate.command);
    if (!bin) continue;
    const child = spawn(bin, candidate.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    return { name: candidate.name, stream: child.stdout!, child };
  }
  throw new Error(
    'No microphone recorder found — install one of: pw-record (PipeWire), parec (PulseAudio), ' +
      'arecord (ALSA), sox, or ffmpeg. Or pipe audio in: arecord -f S16_LE -r 16000 -c 1 -t raw | squeakr pipe',
  );
}

/** Decode any audio file ffmpeg understands to 16 kHz mono PCM16 on stdout. */
export function spawnFfmpegDecoder(file: string): SpawnedSource {
  const bin = findOnPath('ffmpeg');
  if (!bin) {
    throw new Error(`ffmpeg is needed to read ${file} — install it, or convert the file to WAV first.`);
  }
  const child = spawn(
    bin,
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { name: 'ffmpeg', stream: child.stdout!, child };
}
