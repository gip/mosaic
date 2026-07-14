import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXmtpControlTransport } from '../dist/xmtpControl.js';

test('XMTP dev network catches up delayed control delivery and continues on the live stream', {
  skip: process.env.MOSAIC_XMTP_INTEGRATION !== '1',
  timeout: 120_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mosaic-xmtp-control-'));
  const guardian = await createXmtpControlTransport({ role: 'guardian', network: 'testnet', directory: join(root, 'guardian') });
  const runner = await createXmtpControlTransport({ role: 'runner', network: 'testnet', directory: join(root, 'runner') });
  try {
    const received = [];
    let resolveNext;
    const nextMessage = () => withTimeout(new Promise((resolve) => { resolveNext = resolve; }));
    await guardian.start(async () => {});
    await guardian.send(runner.inboxId, 'delayed-before-runner-stream');
    const delayed = nextMessage();
    await runner.start(async (message) => { received.push(message.content); resolveNext?.(); resolveNext = undefined; });
    await delayed;
    const live = nextMessage();
    await guardian.send(runner.inboxId, 'live-after-sync');
    await live;
    assert.deepEqual(received, ['delayed-before-runner-stream', 'live-after-sync']);
  } finally {
    await Promise.allSettled([guardian.close(), runner.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

async function withTimeout(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out waiting for XMTP dev-network delivery')), 30_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
