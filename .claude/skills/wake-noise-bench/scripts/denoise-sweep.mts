/**
 * How much RNNoise helps transcription: the 12 committed commands mixed into
 * every noise at a range of SNRs, run through RNNoise at several mixes of
 * cleaned and original signal, transcribed by Whisper → word error rate. Also
 * transcribes noise with no speech in it, counting the words Whisper invents.
 * Resumes where it stopped.
 *
 *   node --import tsx .claude/skills/wake-noise-bench/scripts/denoise-sweep.mts \
 *     [--mixes 0,0.4,0.7,1] [--snrs 20,10,5,0,-5,-10,-15] [--jobs 6] [--out DIR]
 *
 * Mix 0 is unfiltered; 0.4 is what calls ship (src/channels/denoise.ts).
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DENOISE_FRAME, DENOISE_LAG, type RnnoiseModule } from '../../../../src/channels/denoise.js';
import { arg, audio, manifest, mix, noises, offsetFor, OUT, pool, R, to16k, wer, whisper, normText } from './lib.mjs';

const mixes = arg('mixes', '0,0.4,0.7,1').split(',').map(Number);
const snrs = arg('snrs', '20,10,5,0,-5,-10,-15').split(',').map(Number);
const rn = ((await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' as string)) as { default: () => RnnoiseModule }).default();

/** RNNoise with `wet` of the cleaned signal and the rest the original, aligned to its 20 ms lag. */
function denoiseMix(x: Float32Array, wet: number): Float32Array {
  if (wet === 0) return x;
  const st = rn._rnnoise_create(0), ptr = rn._malloc(DENOISE_FRAME * 4), den = new Float32Array(x.length);
  for (let o = 0; o + DENOISE_FRAME <= x.length; o += DENOISE_FRAME) {
    const heap = rn.HEAPF32, base = ptr >> 2;
    for (let i = 0; i < DENOISE_FRAME; i++) heap[base + i] = x[o + i]! * 32768;
    rn._rnnoise_process_frame(st, ptr, ptr);
    for (let i = 0; i < DENOISE_FRAME; i++) den[o + i] = rn.HEAPF32[base + i]! / 32768;
  }
  rn._rnnoise_destroy(st);
  rn._free(ptr);
  const y = new Float32Array(x.length - DENOISE_LAG);
  for (let n = 0; n < y.length; n++) y[n] = wet * den[n + DENOISE_LAG]! + (1 - wet) * x[n]!;
  return y;
}

const out = join(OUT, 'denoise-sweep.jsonl');
const done = new Set(existsSync(out) ? readFileSync(out, 'utf-8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}|${r.noise}|${r.snr}|${r.mix}`; }) : []);
const commands = manifest().filter((c) => c.set === 'commands');
const N = noises();
const PRE = Math.round(R * 0.4);
type Job = { id: string; text: string | null; k: number; noise: string; snr: number | null; mix: number };
const jobs: Job[] = [];
for (const noise of Object.keys(N)) for (const m of mixes) {
  for (const snr of snrs) commands.forEach((c, k) => jobs.push({ id: c.id, text: c.text, k: k + 300, noise, snr, mix: m }));
  for (let k = 0; k < 3; k++) jobs.push({ id: `noise-only-${k}`, text: null, k: k + 400, noise, snr: null, mix: m });
}
const todo = jobs.filter((j) => !done.has(`${j.id}|${j.noise}|${j.snr}|${j.mix}`));
console.log(`${todo.length} transcriptions to do → ${out}`);
let n = 0;
await pool(todo, Number(arg('jobs', '6')), async (j) => {
  let x: Float32Array;
  if (j.text === null) {
    // Two seconds of noise alone, at a fixed level: what Whisper makes of a segment with nobody talking.
    const src = N[j.noise]!, o = offsetFor(j.k);
    x = Float32Array.from({ length: R * 3.8 }, (_, i) => src[(o + i) % src.length]! * 0.5);
  } else x = mix(audio(commands.find((c) => c.id === j.id)!), N[j.noise]!, j.snr, offsetFor(j.k));
  const hyp = await whisper(to16k(denoiseMix(x, j.mix).subarray(R - PRE)));
  const rec = j.text === null ? { words: normText(hyp).split(' ').filter(Boolean).length } : { wer: +wer(j.text, hyp).toFixed(3) };
  appendFileSync(out, JSON.stringify({ id: j.id, noise: j.noise, snr: j.snr, mix: j.mix, hyp, ...rec }) + '\n');
  if (++n % 100 === 0) console.log(`${n}/${todo.length}`);
});

// Summary
const rows = readFileSync(out, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const cell = (x: number) => (Number.isNaN(x) ? '   -' : (100 * x).toFixed(0).padStart(4));
console.log(`\nWord error rate %, mean over all noises — mixes ${mixes.join(' | ')}`);
for (const snr of snrs) console.log(`  ${String(snr).padStart(3)} dB ${mixes.map((m) => cell(mean(rows.filter((r) => r.snr === snr && r.mix === m).map((r) => Math.min(r.wer, 1))))).join(' |')}`);
console.log(`\nWER % by noise at 0 dB — mixes ${mixes.join(' | ')}`);
for (const noise of Object.keys(N)) console.log(`  ${noise.padEnd(9)} ${mixes.map((m) => cell(mean(rows.filter((r) => r.noise === noise && r.snr === 0 && r.mix === m).map((r) => Math.min(r.wer, 1))))).join(' |')}`);
console.log(`\nWords invented from noise alone (3 segments each) — mixes ${mixes.join(' | ')}`);
for (const noise of Object.keys(N)) console.log(`  ${noise.padEnd(9)} ${mixes.map((m) => String(rows.filter((r) => r.noise === noise && r.snr === null && r.mix === m).reduce((a, r) => a + r.words, 0)).padStart(4)).join(' |')}`);
