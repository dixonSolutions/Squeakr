/**
 * Stress the PWA's RNNoise stream (web/src/rnnoise-dsp.ts) with the committed
 * corpus and the same synthetic noises as the wake bench. Reports real-time
 * factor, noise reduction and output validity, then runs a long stream to
 * catch drift or a leak in the callback path.
 *
 *   node --import tsx .claude/skills/wake-noise-bench/scripts/web-denoise-stress.mts \
 *     [--seconds 300] [--out DIR]
 *
 * This is the browser's DSP, not the bridge's CallDenoiser: it must emit as
 * many samples as it takes in, and it is what the main interface's wake words,
 * server STT and direct audio stream all hear.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DENOISE_LAG, StreamDenoiser, type RnnoiseModule } from '../../../../web/src/rnnoise-dsp.js';
import { arg, audio, manifest, mix, noises, OUT, R } from './lib.mjs';

const seconds = Number(arg('seconds', '300'));
const CHUNK = 1024;

const rn = ((await import('@jitsi/rnnoise-wasm/dist/rnnoise-sync.js' as string)) as {
  default: () => RnnoiseModule;
}).default();

const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / Math.max(x.length, 1));
const db = (before: number, after: number) => (after <= 0 ? Infinity : 20 * Math.log10(before / after));

interface Result {
  case: string;
  noise: string;
  snr: number | null;
  ms: number;
  audioMs: number;
  rtf: number;
  reductionDb: number | null;
  finite: boolean;
  lengthOk: boolean;
}

function run(caseName: string, noiseName: string, snr: number | null, x: Float32Array, measureFrom = DENOISE_LAG): Result {
  const d = new StreamDenoiser(rn);
  const out = new Float32Array(CHUNK);
  const started = performance.now();
  let finite = true;
  const result = new Float32Array(x.length);
  for (let at = 0; at < x.length; at += CHUNK) {
    const n = Math.min(CHUNK, x.length - at);
    d.process(x.subarray(at, at + n), out.subarray(0, n));
    for (let i = 0; i < n; i++) {
      const v = out[i]!;
      if (!Number.isFinite(v)) finite = false;
      result[at + i] = v;
    }
  }
  const ms = performance.now() - started;
  d.close();
  const before = rms(x.subarray(measureFrom));
  const after = rms(result.subarray(measureFrom));
  return {
    case: caseName,
    noise: noiseName,
    snr,
    ms,
    audioMs: (x.length / R) * 1000,
    rtf: ms / ((x.length / R) * 1000),
    reductionDb: snr === null ? db(before, after) : null,
    finite,
    lengthOk: result.length === x.length,
  };
}

const N = noises();
const commands = manifest().filter((c) => c.set === 'commands');
const rows: Result[] = [];

// 1. Noise reduction, with nobody talking: each noise at a fixed level.
for (const name of Object.keys(N)) {
  const x = Float32Array.from({ length: R * 10 }, (_, i) => N[name]![(i * 7) % N[name]!.length]! * 0.5);
  rows.push(run('noise-only', name, null, x, R));
}

// 2. Commands in noise at realistic SNRs: the path wake words and STT take.
for (const name of ['fan', 'vacuum', 'music', 'babble', 'blanket']) {
  for (const snr of [10, 5, 0, -5]) {
    const clip = audio(commands[(snr + 20) % commands.length]!);
    const x = mix(clip, N[name]!, snr, 0);
    rows.push(run('command', name, snr, x, R));
  }
}

// 3. Long run: repeat the blanket noise for `seconds` and watch for drift.
const blanket = N['blanket']!;
const long = new Float32Array(R * seconds);
for (let i = 0; i < long.length; i++) long[i] = blanket[i % blanket.length]! * 0.5;
rows.push(run('long-run', 'blanket', null, long, R));

const failed = rows.filter((r) => !r.finite || !r.lengthOk);
const maxRtf = Math.max(...rows.map((r) => r.rtf));
const totalAudio = rows.reduce((s, r) => s + r.audioMs, 0);
const totalMs = rows.reduce((s, r) => s + r.ms, 0);

const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
console.log(`\nPWA RNNoise stress — ${(totalAudio / 1000).toFixed(0)} s of audio in ${(totalMs / 1000).toFixed(1)} s`);
console.log(`  max real-time factor ${maxRtf.toFixed(3)} (${(1 / maxRtf).toFixed(1)}x real time)`);
console.log(`  ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length} bad rows)`}: finite samples, no drift`);
console.log('\nNoise-only reduction (dB):');
for (const r of rows.filter((r) => r.case === 'noise-only')) {
  const value = r.reductionDb === Infinity ? 'inf' : r.reductionDb!.toFixed(1);
  console.log(`  ${r.noise.padEnd(9)} ${value.padStart(5)} dB   ${pct(r.rtf)} RTF`);
}
console.log('\nCommands in noise (RTF):');
console.log(`  ${['noise', '10 dB', '5 dB', '0 dB', '-5 dB'].map((s) => s.padStart(9)).join(' ')}`);
for (const name of ['fan', 'vacuum', 'music', 'babble', 'blanket']) {
  const cells = [name.padStart(9)];
  for (const snr of [10, 5, 0, -5]) {
    const r = rows.find((x) => x.case === 'command' && x.noise === name && x.snr === snr)!;
    cells.push(pct(r.rtf).padStart(9));
  }
  console.log(`  ${cells.join(' ')}`);
}

const longRow = rows.find((r) => r.case === 'long-run')!;
console.log(
  `\nLong run: ${seconds} s of blanket noise, ${longRow.ms.toFixed(0)} ms processing, ` +
    `${longRow.lengthOk ? 'no drift' : 'DRIFT'}, ${longRow.finite ? 'finite' : 'NON-FINITE'}`,
);

const outFile = join(OUT, 'web-denoise-stress.json');
writeFileSync(outFile, JSON.stringify({ rows, maxRtf, totalAudio, totalMs, failed }, null, 2));
console.log(`\nResults: ${outFile}`);
if (failed.length) process.exitCode = 1;
