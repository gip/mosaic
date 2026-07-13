import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { lstat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GUARDIAN_VAULT,
  AGENT_CONTROL_PROTOCOL,
  parseLocalCli,
  callGuardianControl,
  GuardianControlClient,
  startGuardianControlServer,
} from '../dist/index.js';

test('local CLI defaults and network override', () => {
  assert.deepEqual(parseLocalCli([], DEFAULT_GUARDIAN_VAULT), {
    vault: 'mosaic-agent-guardian', network: 'testnet', help: false,
  });
  assert.deepEqual(parseLocalCli(['custom', '--network=mainnet'], DEFAULT_GUARDIAN_VAULT), {
    vault: 'custom', network: 'mainnet', help: false,
  });
  assert.throws(() => parseLocalCli(['a', 'b'], DEFAULT_GUARDIAN_VAULT));
});

test('authenticated Guardian control socket serves Runner enrollment and grants', async (t) => {
  const previous = process.env.MOSAIC_RUNTIME_DIR;
  process.env.MOSAIC_RUNTIME_DIR = await mkdtemp(join(tmpdir(), 'mosaic-control-test-'));
  const status = { name: 'mosaic-guardian', phase: 'running', pid: process.pid, vault: 'guardian', network: 'testnet' };
  const approved = [];
  const authorized = [];
  let server;
  let supervisorClient;
  try {
    try {
      server = await startGuardianControlServer({
        status: () => status,
        shutdown: () => {},
        attachSession: () => {},
        startGuardian: async () => ({ guardianAddress: '0x1' }),
        approveRunner: ({ runnerId }) => { approved.push(runnerId); },
        enrollRunner: async ({ runnerId, runnerPublicKey, network, environment }) => ({
          protocol: AGENT_CONTROL_PROTOCOL, kind: 'runner-certificate', runnerId, runnerPublicKey,
          guardianId: 'guardian', guardianAddress: '0x1', network, environment,
          trustTier: 'software-local',
          issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
          revocationId: 'revoke-1', signatureB64: 'AQID',
        }),
        unlockAgent: async () => {}, lockAgent: async () => {}, stopAgent: async () => {}, prepareAgent: async () => ({}),
        getAgentPolicy: () => undefined, putAgentPolicy: async () => ({}), deleteAgentPolicy: async () => {},
        initializeAgentSecrets: async () => [], listAgentSecrets: () => [], importAgentSecret: async () => {}, rotateAgentSecret: async () => {}, deleteAgentSecret: async () => {},
        renewLease: async () => ({}), proposeTransaction: async () => ({}),
        authorizeCapability: (request) => { authorized.push(request.requestId); return undefined; },
        recordCapability: (request, result) => ({ ...result, auditEventDigest: 'a'.repeat(64) }),
      });
    } catch (error) {
      if (error?.code === 'EPERM') { t.skip('sandbox does not permit Unix-domain listeners'); return; }
      throw error;
    }
    assert.deepEqual(await callGuardianControl('status'), status);
    const pairing = await callGuardianControl('runner.approve', { runnerId: 'runner' });
    assert.deepEqual(approved, ['runner']);
    supervisorClient = new GuardianControlClient(pairing.pairingCredential);
    const enrollment = await supervisorClient.call('runner.enroll', {
      runnerId: 'runner', runnerPublicKey: 'public-key', network: 'testnet', environment: 'local',
    });
    const certificate = enrollment.certificate;
    supervisorClient.setToken(enrollment.sessionCredential);
    assert.equal(certificate.runnerId, 'runner');
    assert.equal('dbEncryptionKeyB64' in certificate, false);
    await assert.rejects(() => callGuardianControl('capability.authorize', { request: { requestId: 'admin-denied', agentId: 'agent-one', grantId: 'grant-one' } }), /unauthorized/);
    const results = await Promise.all(['req-1', 'req-2'].map((requestId) => supervisorClient.call('capability.authorize', {
      request: { requestId, agentId: 'agent-one', grantId: 'grant-one' },
    })));
    assert.deepEqual(results, [undefined, undefined]);
    assert.deepEqual(authorized.sort(), ['req-1', 'req-2']);
    const recorded = await supervisorClient.call('capability.record', {
      request: { requestId: 'req-2', agentId: 'agent-one', grantId: 'grant-one' },
      result: { agentId: 'agent-one', grantId: 'grant-one', ok: true, usage: { calls: 1, responseBytes: 2 } },
    });
    assert.equal(recorded.auditEventDigest, 'a'.repeat(64));
    await assert.rejects(() => supervisorClient.call('capability.authorize', {
      agentId: 'agent-one', grantId: 'grant-one',
      request: { requestId: 'cross-agent', agentId: 'agent-two', grantId: 'grant-two' },
    }), /cross-agent/);
  } finally {
    supervisorClient?.close();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MOSAIC_RUNTIME_DIR;
    else process.env.MOSAIC_RUNTIME_DIR = previous;
  }
});

test('Guardian control server replaces a stale Unix socket left by a crashed process', { skip: process.platform === 'win32' }, async (t) => {
  const previous = process.env.MOSAIC_RUNTIME_DIR;
  const runtimeDir = await mkdtemp(join(tmpdir(), 'mosaic-stale-control-test-'));
  process.env.MOSAIC_RUNTIME_DIR = runtimeDir;
  const address = join(runtimeDir, 'guardian.sock');
  const child = spawn(process.execPath, [
    '--input-type=module',
    '-e',
    `import { createServer } from 'node:net'; const server = createServer(); server.once('error', (error) => process.stdout.write('error:' + error.code + '\\n', () => process.exit(2))); server.listen(${JSON.stringify(address)}, () => process.stdout.write('ready\\n'));`,
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  let server;
  try {
    const startup = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stdout.once('data', (data) => resolve(String(data).trim()));
    });
    if (startup === 'error:EPERM') { t.skip('sandbox does not permit Unix-domain listeners'); return; }
    assert.equal(startup, 'ready');
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    assert.equal((await lstat(address)).isSocket(), true);

    try {
      server = await startGuardianControlServer({
        status: () => ({ name: 'mosaic-guardian', phase: 'running', pid: process.pid }),
        shutdown: () => {},
        attachSession: () => {},
        startGuardian: async () => ({ guardianAddress: '0x1' }),
        approveRunner: () => {},
        enrollRunner: async ({ runnerId, runnerPublicKey, network, environment }) => ({
          protocol: AGENT_CONTROL_PROTOCOL, kind: 'runner-certificate', runnerId, runnerPublicKey,
          guardianId: 'guardian', guardianAddress: '0x1', network, environment,
          trustTier: 'software-local',
          issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
          revocationId: 'revoke-1', signatureB64: 'AQID',
        }),
        unlockAgent: async () => {}, lockAgent: async () => {}, stopAgent: async () => {}, prepareAgent: async () => ({}),
        getAgentPolicy: () => undefined, putAgentPolicy: async () => ({}), deleteAgentPolicy: async () => {},
        initializeAgentSecrets: async () => [], listAgentSecrets: () => [], importAgentSecret: async () => {}, rotateAgentSecret: async () => {}, deleteAgentSecret: async () => {},
        renewLease: async () => ({}), authorizeCapability: async () => {}, recordCapability: async () => ({}), proposeTransaction: async () => ({}),
      });
    } catch (error) {
      if (error?.code === 'EPERM') { t.skip('sandbox does not permit Unix-domain listeners'); return; }
      throw error;
    }
    assert.equal((await callGuardianControl('status')).phase, 'running');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.MOSAIC_RUNTIME_DIR;
    else process.env.MOSAIC_RUNTIME_DIR = previous;
  }
});
