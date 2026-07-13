import { generateKeyPairSync } from 'node:crypto';
import {
  DEFAULT_RUNNER_VAULT,
  GuardianControlClient,
  parseLocalCli,
  runLocalService,
  type RunnerCertificate,
} from '@mosaic/local-runtime';
import { MultiAgentSupervisor } from './multiSupervisor.js';

const options = parseLocalCli(process.argv.slice(2), DEFAULT_RUNNER_VAULT);
if (options.help) {
  console.log('Usage: mosaic-agent-runner [--network testnet|mainnet]');
  process.exit(0);
}

console.log(`Mosaic Supervisor · ${options.network}`);
runLocalService('agent-runner', { network: options.network });

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
let supervisor: MultiAgentSupervisor | undefined;
let control: GuardianControlClient | undefined;

function send(message: unknown): void {
  if (parentPort) parentPort.postMessage(message); else process.send?.(message);
}

async function handle(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (typeof message.requestId !== 'string' || typeof message.type !== 'string') return;
  try {
    let result: unknown;
    switch (message.type) {
      case 'supervisor.start': {
        if (typeof message.pairingCredential !== 'string') {
          if (supervisor) { result = { running: true }; break; }
          throw new Error('missing pairing credential');
        }
        if (supervisor) {
          // A fresh pairing credential means the Guardian restarted; the old
          // session credential and certificate died with it.
          await supervisor.stopAll();
          supervisor = undefined;
          control?.close();
          control = undefined;
        }
        const pair = generateKeyPairSync('ed25519');
        const runnerId = 'local-supervisor';
        control = new GuardianControlClient(message.pairingCredential);
        const enrolled = await control.call<{ certificate: RunnerCertificate; sessionCredential: string }>('runner.enroll', {
          runnerId,
          runnerPublicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
          network: options.network,
          environment: 'local',
        }, 120_000);
        control.setToken(enrolled.sessionCredential);
        supervisor = new MultiAgentSupervisor(control, enrolled.certificate);
        result = { running: true, runnerId, expiresAt: enrolled.certificate.expiresAt };
        break;
      }
      case 'agent.start': {
        if (!supervisor) throw new Error('Supervisor is not enrolled');
        if (typeof message.agentId !== 'string') throw new Error('missing agentId');
        result = await supervisor.start(message.agentId);
        break;
      }
      case 'agent.stop': {
        if (!supervisor) throw new Error('Supervisor is not enrolled');
        if (typeof message.agentId !== 'string') throw new Error('missing agentId');
        await supervisor.stop(message.agentId);
        result = { stopped: true };
        break;
      }
      case 'agent.list': result = supervisor?.list() ?? []; break;
      case 'agent.status': {
        if (typeof message.agentId !== 'string') throw new Error('missing agentId');
        result = supervisor?.status(message.agentId) ?? null;
        break;
      }
      default: return;
    }
    send({ type: 'supervisor-response', requestId: message.requestId, ok: true, result });
  } catch (error) {
    send({ type: 'supervisor-response', requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

parentPort?.on('message', ({ data }) => void handle(data));
process.on('message', (message) => void handle(message));

if (process.env.MOSAIC_PAIRING_CREDENTIAL) {
  void handle({ type: 'supervisor.start', requestId: 'environment-start', pairingCredential: process.env.MOSAIC_PAIRING_CREDENTIAL });
}

process.once('exit', () => { control?.close(); });
