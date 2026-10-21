/**
 * Scores recorded Vosk streams (record-wake.mts) with the shipped decision —
 * PhraseDecision replayed 20 ms at a time, as the live spotter sees it — or
 * with the rule from before docs/50 (`--rule old`, on `--grammar old`
 * recordings). With transcripts (transcribe-wake.mts) it also scores the
 * call path: spotter fires → confirmSpotted → delivered / armed / ignored.
 *
 *   node --import tsx .claude/skills/wake-noise-bench/scripts/score-wake.mts \
 *     [--split dev|test] [--conditions harsh|moderate|all] [--grammar new|old] [--rule new|old] [--threshold 0.45] [--out DIR]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { confirmSpotted } from '../../../../src/channels/callTurns.js';
import { PhraseDecision, spottingRule } from '../../../../src/realtime/wakeSpotting.js';
import { arg, normText, OUT, phrases } from './lib.mjs';

interface Row {
  id: string; kind: 'pos' | 'near' | 'talk'; form: string | null; target: string | null; phrase: string; cond: string; variant: string;
  ev: Array<{ t: number; f: 0 | 1; text: string; words?: Array<[string, number]> }>;
}
const split = arg('split', 'dev'), conds = arg('conditions', 'harsh'), grammar = arg('grammar', 'new');
const rule = arg('rule', grammar), threshold = Number(arg('threshold', '0.45'));
const rows: Row[] = readFileSync(join(OUT, `events-${split}-${conds}-${grammar}.jsonl`), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sttFile = join(OUT, `stt-${split}-${conds}.jsonl`);
const stt = new Map<string, string>(
  existsSync(sttFile)
    ? readFileSync(sttFile, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => [`${r.id}|${r.cond}|${r.variant}`, r.hyp])
    : [],
);

/** Before docs/50: a partial ending in the phrase fired at once; a final ending in it needed a mean confidence (start phrase only). */
function oldFires(r: Row, role: 'start' | 'end' | 'cancel'): boolean {
  // As the old phraseHeard did: normalising turns [unk] into the word "unk", so a phrase followed by [unk] did not count.
  const ends = (t: string) => { const h = normText(t.replaceAll('[unk]', ' unk ')); return h === r.phrase || h.endsWith(` ${r.phrase}`); };
  for (const e of r.ev) {
    if (!e.f && role === 'start' && threshold < 0.55 && ends(e.text)) return true;
    if (e.f && ends(e.text)) {
      if (role !== 'start') return true;
      const w = e.words ?? [];
      if (w.length && w.reduce((a, x) => a + x[1], 0) / w.length >= threshold) return true;
    }
  }
  return false;
}
function newFires(r: Row, role: 'start' | 'end' | 'cancel'): boolean {
  const d = new PhraseDecision(r.phrase, spottingRule(role, threshold));
  const end = Math.max(0, ...r.ev.map((e) => e.t)) + 20;
  let k = 0, partial = '';
  for (let t = 0; t <= end; t += 20) {
    let final: Row['ev'][number] | null = null;
    while (k < r.ev.length && r.ev[k]!.t <= t) {
      const e = r.ev[k++]!;
      if (e.f) { final = e; partial = ''; } else partial = e.text;
    }
    if (final ? d.final((final.words ?? []).map(([word, conf]) => ({ word, conf }))) : d.partial(partial, t)) return true;
  }
  return false;
}
const fires = (r: Row, role: 'start' | 'end' | 'cancel') => (rule === 'old' ? oldFires(r, role) : newFires(r, role));

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) : '  -').padStart(5);
const condsSeen = [...new Set(rows.map((r) => `${r.cond}/${r.variant}`))];
console.log(`split ${split} · conditions ${conds} · grammar ${grammar} · rule ${rule} · threshold ${threshold}`);
for (const { phrase, role } of phrases()) {
  const P = rows.filter((r) => r.phrase === phrase);
  const pos = P.filter((r) => r.kind === 'pos' && r.target === phrase);
  const near = P.filter((r) => r.kind === 'near' && r.target === phrase);
  const talk = P.filter((r) => r.kind === 'talk' || (r.kind === 'pos' && r.target !== phrase));
  console.log(`\n"${phrase}" (${role})        heard%  look-alikes fired%  other talk fired%`);
  for (const c of ['ALL', ...condsSeen]) {
    const f = (xs: Row[]) => (c === 'ALL' ? xs : xs.filter((r) => `${r.cond}/${r.variant}` === c));
    const n = (xs: Row[]) => f(xs).filter((r) => fires(r, role)).length;
    console.log(`  ${c.padEnd(18)} ${pct(n(pos), f(pos).length)}   ${pct(n(near), f(near).length)}              ${pct(n(talk), f(talk).length)}`);
  }
  if (role !== 'start' || !stt.size) continue;
  const outcome = (r: Row): string | null => {
    if (!fires(r, role)) return 'missed';
    const hyp = stt.get(`${r.id}|${r.cond}|${r.variant}`);
    if (hyp === undefined) return null;
    const ws = hyp.split(/\s+/).filter(Boolean);
    if (rule === 'old') return ws.length ? 'delivered' : 'armed'; // before docs/50 the transcript was delivered as it was
    const cut = confirmSpotted(ws, phrase.split(' '));
    return cut === null ? 'ignored' : ws.length > cut ? 'delivered' : 'armed';
  };
  const tally = (xs: Row[]) => {
    const t: Record<string, number> = {};
    let n = 0;
    for (const r of xs) { const o = outcome(r); if (o) { n++; t[o] = (t[o] ?? 0) + 1; } }
    return `${Object.entries(t).sort().map(([k, v]) => `${k} ${pct(v, n)}%`).join('  ')}  (n=${n})`;
  };
  console.log('  On a call (spotter, then the transcript):');
  console.log(`    wake + command   ${tally(pos.filter((r) => r.form !== 'alone'))}`);
  console.log(`    phrase alone     ${tally(pos.filter((r) => r.form === 'alone'))}`);
  console.log(`    look-alikes      ${tally(near)}`);
  console.log(`    other talk       ${tally(talk.filter((r) => r.kind === 'talk'))}`);
}
