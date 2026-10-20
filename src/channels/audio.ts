/**
 * Audio plumbing between chat platforms and the bridge's speech pipeline.
 *
 * The bridge speaks 16 kHz mono PCM16 into speech-to-text and gets PCM16 mono
 * at the voice's own rate out of text-to-speech (output/pcmStream.ts). Chat
 * platforms speak Opus: Discord voice is 48 kHz stereo Opus packets, Telegram
 * and WhatsApp voice notes are Ogg/Opus files. This module converts between
 * the two without ffmpeg — Opus through `opusscript` (WASM, an optional
 * dependency loaded on first use), Ogg framing and resampling in plain code.
 * Audio files people attach (FLAC, MP3, M4A…) go through `audio-decode`,
 * JS/WASM and optional in the same way.
 */

import { createRequire } from 'node:module';

// ── PCM ─────────────────────────────────────────────────────────────────────

/** Interleaved PCM16LE → mono, averaging channels. A trailing partial frame is dropped. */
export function downmixPcm16(pcm: Buffer, channels: number): Buffer {
  if (channels === 1) return pcm;
  const frames = Math.floor(pcm.length / (channels * 2));
  const out = Buffer.alloc(frames * 2);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((f * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), f * 2);
  }
  return out;
}

/** Mono PCM16LE → interleaved stereo (the same sample on both channels). */
export function monoToStereoPcm16(pcm: Buffer): Buffer {
  const samples = pcm.length >> 1;
  const out = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

/**
 * Mono PCM16LE from one rate to another. Linear interpolation, with a box
 * average when shrinking so 48 → 16 kHz does not alias speech into mush.
 * Stateless per call — callers stream in chunks of whole tens of ms, where
 * the seam is inaudible.
 */
export function resamplePcm16(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm;
  const inLen = pcm.length >> 1;
  if (inLen === 0) return Buffer.alloc(0);
  const outLen = Math.max(1, Math.round((inLen * to) / from));
  const out = Buffer.alloc(outLen * 2);
  const step = from / to;
  const at = (i: number) => pcm.readInt16LE(Math.min(i, inLen - 1) * 2);
  for (let o = 0; o < outLen; o++) {
    const pos = o * step;
    let v: number;
    if (step > 1) {
      const start = Math.floor(pos);
      const end = Math.min(inLen, Math.max(start + 1, Math.floor(pos + step)));
      let sum = 0;
      for (let i = start; i < end; i++) sum += at(i);
      v = sum / (end - start);
    } else {
      const i = Math.floor(pos);
      const frac = pos - i;
      v = at(i) + (at(i + 1) - at(i)) * frac;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), o * 2);
  }
  return out;
}

/** Accumulates PCM and hands it out in fixed-size frames (Opus wants exactly 20 ms). */
export class PcmFramer {
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly frameBytes: number) {}

  push(pcm: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
    const frames: Buffer[] = [];
    while (this.pending.length >= this.frameBytes) {
      frames.push(this.pending.subarray(0, this.frameBytes));
      this.pending = this.pending.subarray(this.frameBytes);
    }
    return frames;
  }

  /** What is left, zero-padded to a whole frame (or nothing). */
  flush(): Buffer | null {
    if (!this.pending.length) return null;
    const last = Buffer.alloc(this.frameBytes);
    this.pending.copy(last);
    this.pending = Buffer.alloc(0);
    return last;
  }
}

// ── Opus (opusscript) ─────────────────────────────────────────────────────────

interface OpusScriptInstance {
  encode(pcm: Buffer, frameSize: number): Buffer;
  decode(packet: Buffer): Buffer;
  setBitrate(bitrate: number): void;
  delete(): void;
}
interface OpusScriptCtor {
  new (rate: number, channels: number, application?: number): OpusScriptInstance;
  Application: { VOIP: number; AUDIO: number };
}

let opusCtor: OpusScriptCtor | null = null;

/** The Opus codec, or a clear error naming the package to install. */
export function loadOpus(): OpusScriptCtor {
  if (opusCtor) return opusCtor;
  try {
    opusCtor = createRequire(import.meta.url)('opusscript') as OpusScriptCtor;
    return opusCtor;
  } catch {
    throw new Error('Voice on channels needs the opusscript package — run: npm install opusscript');
  }
}

export const OPUS_RATE = 48_000;
/** 20 ms at 48 kHz. */
export const OPUS_FRAME_SAMPLES = 960;

export class OpusDecoder {
  private readonly codec: OpusScriptInstance;
  constructor(readonly channels: 1 | 2) {
    const Opus = loadOpus();
    this.codec = new Opus(OPUS_RATE, channels, Opus.Application.VOIP);
  }
  /** One Opus packet → interleaved PCM16LE at 48 kHz. */
  decode(packet: Buffer): Buffer {
    return Buffer.from(this.codec.decode(packet));
  }
  close(): void {
    this.codec.delete();
  }
}

export class OpusEncoder {
  private readonly codec: OpusScriptInstance;
  constructor(readonly channels: 1 | 2, bitrate = 32_000) {
    const Opus = loadOpus();
    this.codec = new Opus(OPUS_RATE, channels, Opus.Application.VOIP);
    this.codec.setBitrate(bitrate);
  }
  /** Exactly 20 ms of interleaved PCM16LE at 48 kHz → one Opus packet. */
  encode(frame: Buffer): Buffer {
    return Buffer.from(this.codec.encode(frame, OPUS_FRAME_SAMPLES));
  }
  close(): void {
    this.codec.delete();
  }
}

// ── Ogg ─────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(page: Buffer): number {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

/** Every packet of the first logical stream in an Ogg file, in order. */
export function readOggPackets(file: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let partial: Buffer[] = [];
  let offset = 0;
  let serial: number | null = null;
  while (offset + 27 <= file.length) {
    if (file.toString('ascii', offset, offset + 4) !== 'OggS') throw new Error('Not an Ogg file');
    const pageSerial = file.readUInt32LE(offset + 14);
    const segments = file[offset + 26]!;
    const lacing = file.subarray(offset + 27, offset + 27 + segments);
    let body = offset + 27 + segments;
    const mine = serial === null || serial === pageSerial;
    if (serial === null) serial = pageSerial;
    for (const len of lacing) {
      if (mine) partial.push(file.subarray(body, body + len));
      body += len;
      if (len < 255 && mine) {
        packets.push(Buffer.concat(partial));
        partial = [];
      }
    }
    offset = body;
  }
  return packets;
}

export interface OpusHead {
  channels: number;
  preSkip: number;
  inputRate: number;
}

export function parseOpusHead(packet: Buffer): OpusHead {
  if (packet.toString('ascii', 0, 8) !== 'OpusHead') throw new Error('Not an Ogg/Opus file');
  return { channels: packet[9]!, preSkip: packet.readUInt16LE(10), inputRate: packet.readUInt32LE(12) };
}

/**
 * An audio file someone attached — FLAC, MP3, M4A/AAC, WAV, Ogg, WebM… — as
 * 16 kHz mono PCM16 for speech-to-text.
 */
export async function decodeAudioFileTo16k(file: Buffer): Promise<Buffer> {
  type Decoded = { channelData: Float32Array[]; sampleRate: number };
  let decode: (data: Uint8Array) => Promise<Decoded>;
  try {
    decode = ((await import('audio-decode')) as unknown as { default: typeof decode }).default;
  } catch {
    throw new Error('reading audio files needs the optional audio-decode package — reinstall Squeakr');
  }
  const { channelData, sampleRate } = await decode(new Uint8Array(file.buffer, file.byteOffset, file.byteLength));
  const frames = channelData[0]?.length ?? 0;
  if (!frames || !sampleRate) throw new Error('no audio in it');
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (const ch of channelData) sum += ch[i] ?? 0;
    const v = Math.round((sum / channelData.length) * 32767);
    mono.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return resamplePcm16(mono, sampleRate, 16_000);
}

/** An Ogg/Opus voice note → 16 kHz mono PCM16 for speech-to-text. */
export function decodeOggOpusTo16k(file: Buffer): Buffer {
  const packets = readOggPackets(file);
  const head = parseOpusHead(packets[0] ?? Buffer.alloc(0));
  const channels = head.channels >= 2 ? 2 : 1;
  const decoder = new OpusDecoder(channels);
  try {
    const pcm48: Buffer[] = [];
    for (const packet of packets.slice(2)) {
      if (packet.length) pcm48.push(decoder.decode(packet));
    }
    let all = Buffer.concat(pcm48);
    const skip = head.preSkip * channels * 2;
    if (skip < all.length) all = all.subarray(skip);
    return resamplePcm16(downmixPcm16(all, channels), OPUS_RATE, 16_000);
  } finally {
    decoder.close();
  }
}

function oggPage(opts: {
  serial: number;
  sequence: number;
  granule: bigint;
  headerType: number;
  packets: Buffer[];
}): Buffer {
  const lacing: number[] = [];
  for (const p of opts.packets) {
    let len = p.length;
    while (len >= 255) {
      lacing.push(255);
      len -= 255;
    }
    lacing.push(len);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header[4] = 0;
  header[5] = opts.headerType;
  header.writeBigInt64LE(opts.granule, 6);
  header.writeUInt32LE(opts.serial, 14);
  header.writeUInt32LE(opts.sequence, 18);
  header.writeUInt32LE(0, 22);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  const page = Buffer.concat([header, ...opts.packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/**
 * Mono PCM16 at `rate` → an Ogg/Opus voice note (48 kHz, mono, 20 ms
 * frames) — what Telegram's sendVoice and WhatsApp voice messages want.
 */
export function encodeOggOpus(pcm: Buffer, rate: number, bitrate = 32_000): Buffer {
  const pcm48 = resamplePcm16(pcm, rate, OPUS_RATE);
  const encoder = new OpusEncoder(1, bitrate);
  const serial = (Math.random() * 0xffffffff) >>> 0;
  const preSkip = 312;
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(rate, 12);
  head.writeInt16LE(0, 16);
  head[18] = 0;
  const vendor = Buffer.from('Squeakr');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages: Buffer[] = [
    oggPage({ serial, sequence: 0, granule: 0n, headerType: 0x02, packets: [head] }),
    oggPage({ serial, sequence: 1, granule: 0n, headerType: 0, packets: [tags] }),
  ];
  try {
    const framer = new PcmFramer(OPUS_FRAME_SAMPLES * 2);
    const frames = framer.push(pcm48);
    const last = framer.flush();
    if (last) frames.push(last);
    if (!frames.length) frames.push(Buffer.alloc(OPUS_FRAME_SAMPLES * 2));
    let granule = BigInt(preSkip);
    let sequence = 2;
    const PER_PAGE = 50; // one second per page
    for (let i = 0; i < frames.length; i += PER_PAGE) {
      const batch = frames.slice(i, i + PER_PAGE).map((f) => encoder.encode(f));
      granule += BigInt(batch.length * OPUS_FRAME_SAMPLES);
      const isLast = i + PER_PAGE >= frames.length;
      pages.push(oggPage({ serial, sequence: sequence++, granule, headerType: isLast ? 0x04 : 0, packets: batch }));
    }
  } finally {
    encoder.close();
  }
  return Buffer.concat(pages);
}

/** Seconds of audio in mono PCM16 at `rate`. */
export function pcmSeconds(pcm: Buffer, rate: number): number {
  return pcm.length / 2 / rate;
}
