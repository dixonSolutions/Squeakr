/**
 * The phone (packages/client) and the bridge (src/realtime) each carry the
 * wake-spotting rule and its decoy words — the bridge cannot import the
 * client package. They must not drift: a phrase heard on a call must be
 * heard the same way on the phone.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as phoneDecoys from '../../packages/client/src/wakeDecoys.js';
import * as phone from '../../packages/client/src/wakeSpotting.js';
import * as bridgeDecoys from '../../src/realtime/wakeDecoys.js';
import * as bridge from '../../src/realtime/wakeSpotting.js';

/** The code below the header comment, with the one import that differs left out. */
const body = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf-8')
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
    .replace(/^import \{ normalizeForWakeMatch \} from '[^']+';\n/m, '');

describe('wake spotting — phone and bridge copies', () => {
  it('are the same code', () => {
    assert.equal(body('../../packages/client/src/wakeSpotting.ts'), body('../../src/realtime/wakeSpotting.ts'));
  });

  it('carry the same decoy words', () => {
    assert.deepEqual([...bridgeDecoys.WAKE_DECOYS], [...phoneDecoys.WAKE_DECOYS]);
    assert.equal(phoneDecoys.WAKE_DECOYS.length, 3000);
  });

  it('build the same grammar and rules', () => {
    for (const p of ['hey squeaky', 'Cursor, send!', 'cancel']) assert.deepEqual(bridge.spottingGrammar(p), phone.spottingGrammar(p));
    for (const role of ['start', 'end', 'cancel'] as const) {
      for (const t of [0, 0.15, 0.45, 0.55, 0.85, 1]) assert.deepEqual(bridge.spottingRule(role, t), phone.spottingRule(role, t));
    }
  });

  it('decide the same way', () => {
    const steps: Array<['p', string, number] | ['f', string]> = [
      ['p', 'hey', 100],
      ['p', 'hey squeaky', 200],
      ['p', 'hey squeaky open', 520],
      ['f', 'hey:0.9 squeaky:0.8 open:1'],
      ['p', 'the kids are hey squeaky', 900],
      ['f', 'cursor:1 send:0.95 eu:0.2'],
    ];
    for (const role of ['start', 'end'] as const) {
      for (const phrase of ['hey squeaky', 'cursor send']) {
        const a = new phone.PhraseDecision(phrase, phone.spottingRule(role));
        const b = new bridge.PhraseDecision(phrase, bridge.spottingRule(role));
        for (const s of steps) {
          if (s[0] === 'p') assert.equal(b.partial(s[1], s[2]), a.partial(s[1], s[2]), `${role} ${phrase} ${s[1]}`);
          else {
            const words = s[1].split(' ').map((w) => ({ word: w.split(':')[0]!, conf: Number(w.split(':')[1]) }));
            assert.equal(b.final(words), a.final(words), `${role} ${phrase} ${s[1]}`);
          }
        }
      }
    }
  });
});
