/**
 * Transcribes every wake clip with Whisper in each noise condition, as a call
 * would (unfiltered and denoised), so score-wake.mts can replay the call
 * path: the spotter fires, then the transcript confirms (confirmSpotted).
 * Resumes where it stopped.
 *
 *   node --import tsx .claude/skills/wake-noise-bench/scripts/transcribe-wake.mts \
 *     [--split dev|test] [--conditions harsh|moderate|all] [--jobs 6] [--out DIR]
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, audio, conditions, denoise, manifest, mix, noises, offsetFor, OUT, pool, R, to16k, whisper } from './lib.mjs';

const split = arg('split', 'dev');
const out = join(OUT, `stt-${split}-${arg('conditions', 'harsh')}.jsonl`);
const done = new Set(
  existsSync(out)
    ? readFileSync(out, 'utf-8').split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.id}|${r.cond}|${r.variant}`; })
    : [],
);
const clips = manifest().filter((c) => c.set === 'wake' && c.split === split);
const N = noises();
const PRE = Math.round(R * 0.4);
const jobs = conditions().flatMap(([cond, noise, snr], ci) =>
  (['raw', 'denoised'] as const)
    .filter((v) => !(cond === 'clean' && v === 'denoised'))
    .flatMap((variant) => clips.map((clip, k) => ({ clip, k, ci, cond, noise, snr, variant })))
    .filter((j) => !done.has(`${j.clip.id}|${j.cond}|${j.variant}`)),
);
console.log(`${jobs.length} transcriptions to do → ${out}`);
let n = 0;
await pool(jobs, Number(arg('jobs', '6')), async (j) => {
  const x = mix(audio(j.clip), j.noise ? N[j.noise]! : null, j.snr, offsetFor(j.k + j.ci * 1000));
  const hyp = await whisper(to16k((j.variant === 'denoised' ? denoise(x) : x).subarray(R - PRE)));
  appendFileSync(out, JSON.stringify({ id: j.clip.id, kind: j.clip.kind, target: j.clip.phrase, cond: j.cond, variant: j.variant, hyp }) + '\n');
  if (++n % 100 === 0) console.log(`${n}/${jobs.length}`);
});
console.log('done');
