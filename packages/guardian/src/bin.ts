import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  DEFAULT_GUARDIAN_VAULT,
  parseLocalCli,
  runLocalService,
  startGuardianControlServer,
  type ServiceStatus,
} from '@mosaic/local-runtime';
import { loginFromCli, promptSecret } from './login.js';
import { GuardianService, McpGuardianApi, type GuardianSession, type UnlockCredential } from './service.js';

const options = parseLocalCli(process.argv.slice(2), DEFAULT_GUARDIAN_VAULT);
if (options.help) {
  console.log('Usage: mosaic-guardian [vault] [--network testnet|mainnet]');
  process.exit(0);
}
console.log(`Mosaic Guardian · vault ${options.vault} · ${options.network}`);
let status: ServiceStatus = {
  name: 'mosaic-guardian', phase: 'awaiting-wallet', pid: process.pid,
  vault: options.vault, network: options.network,
  detail: 'Create a root-wallet MCP session to unlock this vault.',
};
const api = new McpGuardianApi();
const guardian = new GuardianService(api);
if (process.env.MOSAIC_CONTROL_DISABLED !== '1') {
  await startGuardianControlServer({
    status: () => status,
    shutdown: () => { guardian.lockAll(); process.kill(process.pid, 'SIGTERM'); },
    attachSession: (session) => {
      guardian.attachSession(session);
      status = { ...status, phase: 'unlocking', detail: `MCP session attached for ${session.address}` };
    },
    startGuardian: async (params) => {
      status = { ...status, phase: 'unlocking', vault: params.vault, network: params.network, detail: 'Unlocking Guardian vault…' };
      let credential: UnlockCredential | undefined;
      if (params.signatureB64) credential = { type: 'signature', signature: new Uint8Array(Buffer.from(params.signatureB64, 'base64')) };
      else if (params.passphrase) credential = { type: 'passphrase', passphrase: params.passphrase };
      try {
        const identity = await guardian.startGuardian(params.vault, params.network, credential);
        status = {
          ...status, phase: 'running', detail: 'Mosaic Guardian is ready.',
          evmAddress: identity.address,
        };
        return { guardianAddress: identity.address };
      } catch (error) {
        status = { ...status, phase: 'failed', detail: error instanceof Error ? error.message : String(error) };
        throw error;
      }
    },
    approveRunner: ({ runnerId }) => guardian.approveRunner(runnerId),
    enrollRunner: async (params) => {
      // The Electron UI approves via runner.approve before spawning; a
      // CLI-started Guardian asks on its own terminal instead.
      if (!guardian.isRunnerApproved(params.runnerId) && stdin.isTTY) {
        const prompt = createInterface({ input: stdin, output: stdout });
        try {
          const answer = (await prompt.question(
            `Approve agent runner "${params.runnerId}" (${params.environment}, ${params.network})? [y/N]: `,
          )).trim().toLowerCase();
          if (answer === 'y' || answer === 'yes') guardian.approveRunner(params.runnerId);
        } finally { prompt.close(); }
      }
      return guardian.enrollRunner(params);
    },
    unlockAgent: async (params) => {
      const credential = params.signatureB64
        ? { type: 'signature' as const, signature: new Uint8Array(Buffer.from(params.signatureB64, 'base64')) }
        : params.passphrase ? { type: 'passphrase' as const, passphrase: params.passphrase } : undefined;
      await guardian.unlockVault(params.agentId, params.network, credential);
    },
    lockAgent: ({ agentId }) => guardian.lockAgent(agentId),
    stopAgent: ({ agentId, grantId }) => guardian.lockAgent(agentId, grantId),
    prepareAgent: (params) => guardian.prepareAgent(params),
    getAgentPolicy: ({ agentId }) => guardian.getAgentPolicy(agentId),
    putAgentPolicy: ({ agentId, policy, expectedRevision }) => guardian.putAgentPolicy(agentId, policy, expectedRevision),
    deleteAgentPolicy: ({ agentId, expectedRevision }) => guardian.deleteAgentPolicy(agentId, expectedRevision),
    initializeAgentSecrets: ({ agentId }) => guardian.initializeAgentCommunicationKeys(agentId),
    listAgentSecrets: ({ agentId }) => guardian.listAgentSecretMetadata(agentId),
    importAgentSecret: async ({ agentId, record, materialB64 }) => {
      const material = new Uint8Array(Buffer.from(materialB64, 'base64'));
      try { await guardian.importAgentSecret(agentId, record as never, material); } finally { material.fill(0); }
    },
    rotateAgentSecret: async ({ agentId, keyId, materialB64 }) => {
      const material = new Uint8Array(Buffer.from(materialB64, 'base64'));
      try { await guardian.rotateAgentSecret(agentId, keyId, material); } finally { material.fill(0); }
    },
    deleteAgentSecret: ({ agentId, keyId }) => guardian.deleteAgentSecret(agentId, keyId),
    renewLease: ({ agentId, grantId, supervisorKeyLeasePublicKeyB64 }) => guardian.renewLease(agentId, grantId, supervisorKeyLeasePublicKeyB64),
    authorizeCapability: (request) => guardian.authorizeCapability(request),
    recordCapability: (request, result) => guardian.recordCapability(request, result),
    proposeTransaction: (proposal) => guardian.proposeTransaction(proposal),
  });
}
if (process.env.MOSAIC_SESSION_JSON) {
  const session = JSON.parse(process.env.MOSAIC_SESSION_JSON) as GuardianSession;
  guardian.attachSession(session);
  const identity = await guardian.startGuardian(options.vault, options.network);
  status = { ...status, phase: 'running', evmAddress: identity.address, detail: 'Mosaic Guardian is ready.' };
} else if (process.stdin.isTTY && !(process as NodeJS.Process & { parentPort?: unknown }).parentPort) {
  status = { ...status, phase: 'authenticating', detail: 'Waiting for root-wallet login…' };
  const login = await loginFromCli(api, options.network);
  guardian.attachSession(login.session);
  const item = (await api.zoneList(login.session.token)).find(({ zone }) => zone === options.vault);
  if (!item) throw new Error(`vault not found: ${options.vault} (${options.network})`);
  let credential: UnlockCredential | undefined;
  if (item.mode !== 'testnet-server') {
    const ref = {
      rootChain: login.session.chain,
      rootAddress: login.session.address,
      zone: options.vault,
      network: options.network,
    } as const;
    if (login.signBackupWrap) credential = { type: 'signature', signature: await login.signBackupWrap(ref) };
    else credential = { type: 'passphrase', passphrase: await promptSecret('Backup passphrase') };
  }
  status = { ...status, phase: 'unlocking', detail: `Unlocking ${options.vault}…` };
  const identity = await guardian.startGuardian(options.vault, options.network, credential);
  status = { ...status, phase: 'running', evmAddress: identity.address, detail: 'Mosaic Guardian is ready.' };
  console.log(`Guardian signing address: ${identity.address}`);
}
runLocalService('mosaic-guardian', { vault: options.vault, network: options.network });
