import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { join } from 'node:path';
import {
  DEFAULT_GUARDIAN_VAULT,
  mosaicRuntimeDirectory,
  parseLocalCli,
  runLocalService,
  type LocalMcpSession,
  type PairingOffer,
  type ServiceStatus,
} from '@mosaic/local-runtime';
import { createXmtpControlTransport } from '@mosaic/local-runtime/control';
import { GuardianCompanionControl } from './companion.js';
import { GuardianXmtpControl } from './control.js';
import { loginFromCli, promptSecret, type CliLogin } from './login.js';
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

type ParentPort = { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void };
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const send = (message: unknown): void => { if (parentPort) parentPort.postMessage(message); else process.send?.(message); };

let control: GuardianXmtpControl | undefined;
let companion: GuardianCompanionControl | undefined;
let cliLogin: CliLogin | undefined;
if (process.env.MOSAIC_CONTROL_DISABLED !== '1') {
  const transport = await createXmtpControlTransport({
    role: 'guardian', network: options.network,
    directory: join(mosaicRuntimeDirectory(), 'control', `guardian-${options.network}`),
  });
  control = new GuardianXmtpControl(guardian, transport, options.network, (event) => send({ type: 'guardian-event', event }));
  companion = new GuardianCompanionControl(
    guardian, control, transport, options.network,
    (event) => send({ type: 'guardian-event', event }),
    (category) => guardian.notifyCompanionPush(options.network, category),
  );
  control.attachCompanion(companion);
  await control.start();
}

function credential(params: Record<string, unknown>): UnlockCredential | undefined {
  if (typeof params.signatureB64 === 'string') return { type: 'signature', signature: new Uint8Array(Buffer.from(params.signatureB64, 'base64')) };
  if (typeof params.passphrase === 'string') return { type: 'passphrase', passphrase: params.passphrase };
  return undefined;
}

async function handleAdmin(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (message.type !== 'guardian-request' || typeof message.requestId !== 'string' || typeof message.method !== 'string') return;
  const params = (message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {}) as Record<string, unknown>;
  try {
    let result: unknown;
    switch (message.method) {
      case 'status': result = { ...status, control: control?.identity(), pendingApprovals: control?.pendingApprovals() ?? [] }; break;
      case 'session.attach': guardian.attachSession(params as unknown as LocalMcpSession); status = { ...status, phase: 'unlocking' }; result = { attached: true }; break;
      case 'guardian.start': {
        status = { ...status, phase: 'unlocking', detail: 'Unlocking Guardian vault…' };
        const identity = await guardian.startGuardian(String(params.vault ?? options.vault), (params.network ?? options.network) as 'testnet' | 'mainnet', credential(params));
        status = { ...status, phase: 'running', detail: 'Mosaic Guardian is ready.', evmAddress: identity.address };
        result = { guardianAddress: identity.address, control: control?.identity() };
        break;
      }
      case 'pairing.approve': await controlRequired().approvePairing(params.offer as unknown as PairingOffer); result = { approved: true }; break;
      case 'companion.offer': {
        if (!companion) throw new Error('Guardian XMTP control is disabled');
        result = { offer: companion.createOffer() };
        break;
      }
      case 'companion.status': result = { companion: companion?.companion() ?? {} }; break;
      case 'agent-start.approve': await controlRequired().approveAgentStart(String(params.requestId), credential(params)); result = { approved: true }; break;
      case 'approval.reject': await controlRequired().rejectApproval(String(params.requestId), typeof params.reason === 'string' ? params.reason : undefined); result = { rejected: true }; break;
      case 'privileged.approve': await controlRequired().resolvePrivileged(String(params.requestId)); result = { approved: true }; break;
      case 'agent.stop': result = { commandId: await controlRequired().terminateAgent(String(params.agentId), 'graceful', String(params.reason ?? 'User requested stop')) }; break;
      case 'agent.kill': result = { commandId: await controlRequired().terminateAgent(String(params.agentId), 'immediate', String(params.reason ?? 'User requested kill')) }; break;
      case 'agent.unlock': await guardian.unlockVault(String(params.agentId), (params.network ?? options.network) as 'testnet' | 'mainnet', credential(params)); result = { unlocked: true }; break;
      case 'agent.lock': guardian.lockAgent(String(params.agentId)); result = { locked: true }; break;
      case 'agent.install': result = await guardian.installAgent(params as never); break;
      case 'agent.installation.get': result = guardian.getAgentInstallation(String(params.agentId)); break;
      case 'agent.installation.delete': await guardian.deleteAgentInstallation(String(params.agentId), Number(params.expectedRevision)); result = { deleted: true }; break;
      case 'agent.secrets.init': result = await guardian.initializeAgentCommunicationKeys(String(params.agentId)); break;
      case 'agent.secrets.list': result = guardian.listAgentSecretMetadata(String(params.agentId)); break;
      case 'agent.secrets.import': {
        const material = new Uint8Array(Buffer.from(String(params.materialB64), 'base64'));
        try { await guardian.importAgentSecret(String(params.agentId), params.record as never, material); } finally { material.fill(0); }
        result = { imported: true }; break;
      }
      case 'agent.secrets.rotate': {
        const material = new Uint8Array(Buffer.from(String(params.materialB64), 'base64'));
        try { await guardian.rotateAgentSecret(String(params.agentId), String(params.keyId), material); } finally { material.fill(0); }
        result = { rotated: true }; break;
      }
      case 'agent.secrets.delete': await guardian.deleteAgentSecret(String(params.agentId), String(params.keyId)); result = { deleted: true }; break;
      case 'shutdown': await shutdown(); result = { stopping: true }; break;
      default: return;
    }
    send({ type: 'guardian-response', requestId: message.requestId, ok: true, result });
  } catch (error) {
    if (status.phase === 'unlocking') status = { ...status, phase: 'failed', detail: error instanceof Error ? error.message : String(error) };
    send({ type: 'guardian-response', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function controlRequired(): GuardianXmtpControl {
  if (!control) throw new Error('Guardian XMTP control is disabled');
  return control;
}

async function shutdown(): Promise<void> {
  status = { ...status, phase: 'stopping' };
  await control?.terminateAll('immediate', 'Guardian shutdown');
  await control?.close().catch(() => {});
  guardian.lockAll();
  setImmediate(() => process.kill(process.pid, 'SIGTERM'));
}

parentPort?.on('message', ({ data }) => void handleAdmin(data));
process.on('message', (message) => void handleAdmin(message));
process.once('exit', () => guardian.lockAll());

if (process.env.MOSAIC_SESSION_JSON) {
  const session = JSON.parse(process.env.MOSAIC_SESSION_JSON) as GuardianSession;
  guardian.attachSession(session);
  const identity = await guardian.startGuardian(options.vault, options.network);
  status = { ...status, phase: 'running', evmAddress: identity.address, detail: 'Mosaic Guardian is ready.' };
} else if (process.stdin.isTTY && !parentPort) {
  status = { ...status, phase: 'authenticating', detail: 'Waiting for root-wallet login…' };
  const login = await loginFromCli(api, options.network);
  cliLogin = login;
  guardian.attachSession(login.session);
  const item = (await api.zoneList(login.session.token)).find(({ zone }) => zone === options.vault);
  if (!item) throw new Error(`vault not found: ${options.vault} (${options.network})`);
  let unlock: UnlockCredential | undefined;
  if (item.mode !== 'testnet-server') {
    const ref = { rootChain: login.session.chain, rootAddress: login.session.address, zone: options.vault, network: options.network } as const;
    if (login.signBackupWrap) unlock = { type: 'signature', signature: await login.signBackupWrap(ref) };
    else unlock = { type: 'passphrase', passphrase: await promptSecret('Backup passphrase') };
  }
  const identity = await guardian.startGuardian(options.vault, options.network, unlock);
  status = { ...status, phase: 'running', evmAddress: identity.address, detail: 'Mosaic Guardian is ready.' };
  console.log(`Guardian signing address: ${identity.address}`);
}

runLocalService('mosaic-guardian', { vault: options.vault, network: options.network }, async () => {
  await control?.terminateAll('immediate', 'Guardian shutdown');
  await control?.close().catch(() => {});
  guardian.lockAll();
});
if (cliLogin && control) void runCliAdmin(cliLogin, control);

async function runCliAdmin(login: CliLogin, xmtp: GuardianXmtpControl): Promise<void> {
  console.log('Guardian commands: pair <offer-json>, approvals, approve <request-id>, reject <request-id>, stop <agent-id>, kill <agent-id>, status');
  let prompt = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const line = (await prompt.question('guardian> ')).trim();
      if (!line) continue;
      const separator = line.indexOf(' ');
      const command = separator < 0 ? line : line.slice(0, separator);
      const argument = separator < 0 ? '' : line.slice(separator + 1).trim();
      try {
        if (command === 'pair') await xmtp.approvePairing(JSON.parse(argument) as PairingOffer);
        else if (command === 'approvals') console.log(JSON.stringify(xmtp.pendingApprovals(), null, 2));
        else if (command === 'approve') {
          const pending = xmtp.pendingApprovals().find(({ requestId }) => requestId === argument);
          if (!pending) throw new Error('unknown pending approval');
          if (pending.operation === 'transaction.propose') await xmtp.resolvePrivileged(argument);
          else {
            const agentId = pending.agentId!;
            const item = (await api.zoneList(login.session.token)).find(({ zone }) => zone === agentId);
            if (!item) throw new Error(`vault not found: ${agentId}`);
            let unlock: UnlockCredential | undefined;
            if (item.mode !== 'testnet-server') {
              const ref = { rootChain: login.session.chain, rootAddress: login.session.address, zone: agentId, network: options.network } as const;
              if (login.signBackupWrap) unlock = { type: 'signature', signature: await login.signBackupWrap(ref) };
              else {
                prompt.close();
                unlock = { type: 'passphrase', passphrase: await promptSecret('Backup passphrase') };
                prompt = createInterface({ input: stdin, output: stdout });
              }
            }
            await xmtp.approveAgentStart(argument, unlock);
          }
        } else if (command === 'reject') await xmtp.rejectApproval(argument);
        else if (command === 'stop') await xmtp.terminateAgent(argument, 'graceful', 'Guardian CLI stop');
        else if (command === 'kill') await xmtp.terminateAgent(argument, 'immediate', 'Guardian CLI kill');
        else if (command === 'status') console.log(JSON.stringify({ status, control: xmtp.identity(), pending: xmtp.pendingApprovals() }, null, 2));
        else console.log('Unknown command');
      } catch (error) { console.error(error instanceof Error ? error.message : String(error)); }
    }
  } finally { prompt.close(); }
}
