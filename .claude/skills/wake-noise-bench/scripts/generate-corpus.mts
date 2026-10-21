/**
 * Synthesizes a corpus with Kokoro through an OpenAI-compatible speech server
 * (the bridge's speaches container) — for testing a different wake phrase,
 * more voices or new look-alikes. The spec is a manifest without `file`s:
 *
 *   { "phrases": [{ "phrase": "hey squeaky", "role": "start" }, …],
 *     "clips": [{ "id": "dev_pos_0", "set": "wake", "split": "dev", "kind": "pos",
 *                 "phrase": "hey squeaky", "form": "alone", "text": "Hey squeaky.",
 *                 "voice": "af_heart", "speed": 1 }, …] }
 *
 * docs/data/wake-bench/manifest.json is itself a valid spec. A wake corpus
 * also needs `set: "babble"` clips (background chatter) and, for
 * denoise-sweep.mts, `set: "commands"`.
 *
 *   node --import tsx .claude/skills/wake-noise-bench/scripts/generate-corpus.mts --spec spec.json --bench DIR
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { encodeOggOpus } from '../../../../src/channels/audio.js';
import { arg, pool } from './lib.mjs';

const TTS_URL = process.env.TTS_URL ?? 'http://127.0.0.1:8770';
const TTS_MODEL = process.env.TTS_MODEL ?? 'speaches-ai/Kokoro-82M-v1.0-ONNX';
const spec = JSON.parse(readFileSync(resolve(arg('spec', '')), 'utf-8')) as { phrases: unknown[]; clips: Array<Record<string, unknown> & { id: string; text: string; voice: string; speed?: number }> };
const dir = resolve(arg('bench', ''));
if (!dir || dir === resolve('')) throw new Error('--bench DIR is required (never the committed docs/data/wake-bench)');
mkdirSync(join(dir, 'audio'), { recursive: true });

/** A WAV from the server → mono PCM16 and its rate. */
function wavPcm(buf: Buffer): { pcm: Buffer; rate: number } {
  let o = 12, rate = 0, ch = 1, bits = 16;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') { ch = buf.readUInt16LE(o + 10); rate = buf.readUInt32LE(o + 12); bits = buf.readUInt16LE(o + 22); }
    if (id === 'data') {
      if (bits !== 16) throw new Error(`expected 16-bit WAV, got ${bits}`);
      const data = buf.subarray(o + 8, o + 8 + size), n = data.length / 2 / ch, pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < ch; c++) s += data.readInt16LE((i * ch + c) * 2); pcm.writeInt16LE(Math.round(s / ch), i * 2); }
      return { pcm, rate };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('no audio in the server response');
}

const clips: unknown[] = [];
let n = 0;
await pool(spec.clips, 4, async (c) => {
  const r = await fetch(`${TTS_URL}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: TTS_MODEL, voice: c.voice, input: c.text, speed: c.speed ?? 1, response_format: 'wav' }),
  });
  if (!r.ok) throw new Error(`${c.id}: ${r.status} ${await r.text()}`);
  const { pcm, rate } = wavPcm(Buffer.from(await r.arrayBuffer()));
  writeFileSync(join(dir, 'audio', `${c.id}.ogg`), encodeOggOpus(pcm, rate, 48_000));
  clips.push({ ...c, file: `audio/${c.id}.ogg` });
  if (++n % 50 === 0) console.log(`${n}/${spec.clips.length}`);
});
const order = new Map(spec.clips.map((c, i) => [c.id, i]));
clips.sort((a, b) => order.get((a as { id: string }).id)! - order.get((b as { id: string }).id)!);
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ format: 'Ogg/Opus, mono, 48 kHz, 48 kbps', voices: TTS_MODEL, phrases: spec.phrases, clips }, null, 1) + '\n');
console.log(`${clips.length} clips → ${dir}`);
