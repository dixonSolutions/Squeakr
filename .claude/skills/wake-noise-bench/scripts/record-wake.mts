/**
 * Records what Vosk reports for every wake clip, in every noise condition,
 * unfiltered and through the shipped call denoiser — partials and finals with
 * per-word confidence — so score-wake.mts can replay any decision rule.
 *
 *   node --import tsx .claude/skills/wake-noise-bench/scripts/record-wake.mts \
 *     [--split dev|test] [--grammar new|old] [--conditions harsh|moderate|all] [--out DIR]
 *
 * `new` is the shipped grammar (spottingGrammar: phrase + decoys + [unk]);
 * `old` is the phrase and [unk] alone, as before docs/50.
 */

import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { spottingGrammar } from '../../../../src/realtime/wakeSpotting.js';
import { arg, audio, conditions, denoise, manifest, mix, noises, offsetFor, OUT, phrases, R, to16k, vosk } from './lib.mjs';

const split = arg('split', 'dev');
const grammar = arg('grammar', 'new');
const conds = conditions();
const PHRASES = phrases().map((p) => p.phrase);
const clips = manifest().filter((c) => c.set === 'wake' && c.split === split);
const N = noises();
const recs = new Map<string, Awaited<ReturnType<typeof vosk>>>();
for (const p of PHRASES) recs.set(p, await vosk(grammar === 'old' ? [p, '[unk]'] : spottingGrammar(p)));

const out = join(OUT, `events-${split}-${arg('conditions', 'harsh')}-${grammar}.jsonl`);
writeFileSync(out, '');
const PRE = Math.round(R * 0.4); // noise kept before the speech; the rest of the 1 s lead-in only warms the denoiser
const t0 = Date.now();
for (const [ci, [cond, noise, snr]] of conds.entries()) {
  for (const variant of ['raw', 'denoised'] as const) {
    if (cond === 'clean' && variant === 'denoised') continue;
    for (const [k, clip] of clips.entries()) {
      const sp = audio(clip);
      const x = mix(sp, noise ? N[noise]! : null, snr, offsetFor(k + ci * 1000));
      const y = (variant === 'denoised' ? denoise(x) : x).subarray(R - PRE);
      const pcm = to16k(y);
      for (const phrase of PHRASES) {
        const rec = recs.get(phrase)!;
        rec.reset();
        const ev: Array<{ t: number; f: 0 | 1; text: string; words?: Array<[string, number]> }> = [];
        const words = (r: { result?: Array<{ word: string; conf: number }> }) => (r.result ?? []).map((w) => [w.word, +w.conf.toFixed(3)] as [string, number]);
        for (let o = 0; o < pcm.length; o += 640) {
          const t = Math.round(o / 32);
          if (rec.acceptWaveform(pcm.subarray(o, o + 640))) {
            const r = JSON.parse(rec.resultString() || '{}');
            if (r.text) ev.push({ t, f: 1, text: r.text, words: words(r) });
          } else {
            const p = rec.partialResult()?.partial ?? '';
            const last = ev.at(-1);
            if (p && (!last || last.f || last.text !== p)) ev.push({ t, f: 0, text: p });
          }
        }
        const fin = rec.finalResult();
        const r = typeof fin === 'string' ? JSON.parse(fin || '{}') : (fin ?? {});
        if (r.text) ev.push({ t: Math.round(pcm.length / 32), f: 1, text: r.text, words: words(r) });
        appendFileSync(out, JSON.stringify({ id: clip.id, kind: clip.kind, form: clip.form, target: clip.phrase, phrase, cond, variant, ev }) + '\n');
      }
    }
    console.log(`${cond}/${variant} done (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
}
console.log('wrote', out);
