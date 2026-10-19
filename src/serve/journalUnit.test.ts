import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { journalctlUnitArgs } from './index.js';

const ID = '0fa8453148114edea752890d701e8db3';

/** A fake journalctl: entries exist only for `unit` + `invocation`. */
function journal(unit: 'user' | 'system', invocation: string) {
  const calls: string[][] = [];
  const run = async (_cwd: string, _cmd: string, args: readonly string[]) => {
    calls.push([...args]);
    const isUser = args.includes('--user');
    const hit = (unit === 'user') === isUser && args.includes(`_SYSTEMD_INVOCATION_ID=${invocation}`);
    return { code: 0, stdout: hit ? 'mcp server registered\n' : '', stderr: '' };
  };
  return { run, calls };
}

test('no INVOCATION_ID: not a systemd service, journalctl is never asked', async () => {
  const j = journal('user', ID);
  assert.equal(await journalctlUnitArgs({}, j.run), null);
  assert.equal(j.calls.length, 0);
});

test('a malformed INVOCATION_ID is ignored, not passed to journalctl', async () => {
  const j = journal('user', ID);
  assert.equal(await journalctlUnitArgs({ INVOCATION_ID: 'x _PID=1' }, j.run), null);
  assert.equal(j.calls.length, 0);
});

test('this process is the user unit run: the user unit is used', async () => {
  const j = journal('user', ID);
  assert.deepEqual(await journalctlUnitArgs({ INVOCATION_ID: ID }, j.run), ['--user', '-u', 'squeakr.service']);
});

test('this process is the system unit run: the system unit is used', async () => {
  const j = journal('system', ID);
  assert.deepEqual(await journalctlUnitArgs({ INVOCATION_ID: ID }, j.run), ['-u', 'squeakr.service']);
});

test('INVOCATION_ID inherited from some other unit: the unit journal belongs to another bridge', async () => {
  const j = journal('user', ID);
  assert.equal(await journalctlUnitArgs({ INVOCATION_ID: 'eb021b1fa4ac45b8ba05727758cbe54b' }, j.run), null);
  assert.equal(j.calls.length, 2);
});
