import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  AGENT_AUDIO_RATE,
  PacketDecoder,
  decodeAudioFile,
  decodeBase64Payload,
  pcmDurationMs,
  sniffContainer,
  type DecodeDeps,
} from './decode.js';
import { wav } from './testWav.js';

const noFfmpeg: DecodeDeps = {
  ffmpeg: () => null,
  runFfmpeg: () => Promise.reject(new Error('not installed')),
};

describe('decodeAudioFile', () => {
  it('converts a stereo 44.1 kHz WAV to 24 kHz mono without ffmpeg', async () => {
    const out = await decodeAudioFile(wav(1000), { deps: noFfmpeg });
    assert.match(out.format, /WAV 16-bit PCM 44100 Hz × 2/);
    assert.ok(Math.abs(pcmDurationMs(out.pcm) - 1000) <= 2, `got ${pcmDurationMs(out.pcm)} ms`);
  });

  it('hands other containers to ffmpeg, asking for 24 kHz mono', async () => {
    const calls: number[] = [];
    const deps: DecodeDeps = {
      ffmpeg: () => '/usr/bin/ffmpeg',
      runFfmpeg: async (_bin, _input, rate) => {
        calls.push(rate);
        return Buffer.alloc(AGENT_AUDIO_RATE * 2);
      },
    };
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]);
    const out = await decodeAudioFile(mp3, { deps });
    assert.deepEqual(calls, [AGENT_AUDIO_RATE]);
    assert.equal(out.format, 'mp3 via ffmpeg');
    assert.equal(pcmDurationMs(out.pcm), 1000);
  });

  it('says what to install when it cannot decode', async () => {
    await assert.rejects(decodeAudioFile(Buffer.from('fLaC0000'), { deps: noFfmpeg }), /flac without ffmpeg/);
  });

  it('rejects empty input', async () => {
    await assert.rejects(decodeAudioFile(Buffer.alloc(0), { deps: noFfmpeg }), /empty/);
  });
});

describe('PacketDecoder', () => {
  it('reassembles samples split across packets and resamples 48 kHz stereo', () => {
    const dec = new PacketDecoder({ encoding: 'pcm_s16le', sampleRate: 48_000, channels: 2 });
    const second = Buffer.alloc(48_000 * 2 * 2);
    let total = 0;
    for (let off = 0; off < second.length; off += 777) total += dec.push(second.subarray(off, off + 777)).length;
    // One second in → about one second out (the resampler holds back a sample).
    assert.ok(Math.abs(total / 2 - AGENT_AUDIO_RATE) <= 2, `got ${total / 2} samples`);
  });

  it('passes 24 kHz mono s16 straight through', () => {
    const dec = new PacketDecoder({ encoding: 'pcm_s16le', sampleRate: AGENT_AUDIO_RATE, channels: 1 });
    const pkt = Buffer.from([1, 2, 3, 4, 5]);
    assert.equal(dec.push(pkt).length, 4);
    assert.equal(dec.push(Buffer.from([6])).length, 2);
  });

  it('refuses nonsense formats', () => {
    assert.throws(() => new PacketDecoder({ encoding: 'pcm_s16le', sampleRate: 100, channels: 1 }), /sample_rate/);
    assert.throws(() => new PacketDecoder({ encoding: 'pcm_s16le', sampleRate: 16_000, channels: 0 }), /channels/);
  });
});

describe('helpers', () => {
  it('sniffs containers', () => {
    assert.equal(sniffContainer(wav(10)), 'wav');
    assert.equal(sniffContainer(Buffer.from('OggS....OpusHead')), 'ogg/opus');
    assert.equal(sniffContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'webm/mkv');
    assert.equal(sniffContainer(Buffer.from('hello')), 'unknown');
  });

  it('decodes base64 and data URIs', () => {
    assert.deepEqual(decodeBase64Payload('AQID'), Buffer.from([1, 2, 3]));
    assert.deepEqual(decodeBase64Payload('data:audio/wav;base64,AQID'), Buffer.from([1, 2, 3]));
    assert.throws(() => decodeBase64Payload(''), /base64/);
  });
});
