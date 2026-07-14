import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import test from 'node:test';

test('agent runner starts and shuts down over IPC', async () => {
  const child = fork(new URL('../dist/bin.js', import.meta.url), [], { silent: true, execArgv: [], env: { ...process.env, MOSAIC_CONTROL_DISABLED: '1' } });
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', resolve);
  });

  assert.deepEqual(ready, { type: 'ready', service: 'agent-runner', pid: child.pid, network: 'testnet' });
  child.send({ type: 'shutdown' });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
});
