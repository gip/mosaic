import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import test from 'node:test';

test('signer/policy process starts and shuts down over IPC', async () => {
  const child = fork(new URL('../dist/bin.js', import.meta.url), [], { silent: true });
  const ready = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('message', resolve);
  });

  assert.deepEqual(ready, { type: 'ready', service: 'signer-policy-manager', pid: child.pid });
  child.send({ type: 'shutdown' });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0);
});
