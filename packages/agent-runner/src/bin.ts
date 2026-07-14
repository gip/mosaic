import { join } from 'node:path';
import {
  DEFAULT_RUNNER_VAULT,
  mosaicRuntimeDirectory,
  parseLocalCli,
  runLocalService,
  type AgentTerminationCommandPayload,
  type AgentTerminationResultPayload,
  type ControlEnvelope,
} from '@mosaic/local-runtime';
import { createXmtpControlTransport } from '@mosaic/local-runtime/control';
import { McpArtifactDownloader } from './artifacts.js';
import { RunnerControlClient } from './control.js';
import { MultiAgentSupervisor } from './multiSupervisor.js';

const options = parseLocalCli(process.argv.slice(2), DEFAULT_RUNNER_VAULT);
if (options.help) {
  console.log('Usage: mosaic-agent-runner [--network testnet|mainnet]');
  process.exit(0);
}
console.log(`Mosaic Supervisor · ${options.network}`);

type ParentPort = { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void };
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const send = (message: unknown): void => { if (parentPort) parentPort.postMessage(message); else process.send?.(message); };

let control: RunnerControlClient | undefined;
let supervisor: MultiAgentSupervisor | undefined;
if (process.env.MOSAIC_CONTROL_DISABLED !== '1') {
  const transport = await createXmtpControlTransport({
    role: 'runner', network: options.network,
    directory: join(mosaicRuntimeDirectory(), 'control', `runner-${options.network}`),
  });
  control = new RunnerControlClient(transport, options.network);
  await control.start();
  if (!parentPort && !process.send) console.log(`Pairing offer: ${JSON.stringify(control.pairingOffer())}`);
  control.onTermination(async (envelope: ControlEnvelope<AgentTerminationCommandPayload>): Promise<AgentTerminationResultPayload> => {
    if (!envelope.agentId || !envelope.grantId) throw new Error('termination command lacks agent binding');
    const current = supervisor?.status(envelope.agentId);
    if (current && current.grantId !== envelope.grantId) throw new Error('termination command grant binding mismatch');
    const result = await supervisor?.stop(envelope.agentId, envelope.payload.mode) ?? {
      outcome: 'already-stopped' as const, auditDigest: '0'.repeat(64), forced: envelope.payload.mode === 'immediate',
    };
    return {
      commandId: envelope.payload.commandId,
      mode: envelope.payload.mode,
      outcome: result.outcome,
      stoppedAt: new Date().toISOString(),
      finalAuditDigest: result.auditDigest,
      forced: result.forced,
    };
  });
}

async function ensureSupervisor(): Promise<MultiAgentSupervisor> {
  if (supervisor) return supervisor;
  if (!control) throw new Error('Runner XMTP control is disabled');
  const certificate = await control.waitForEnrollment();
  supervisor = new MultiAgentSupervisor(control, certificate, new McpArtifactDownloader());
  return supervisor;
}

async function handle(raw: unknown): Promise<void> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const message = raw as Record<string, unknown>;
  if (typeof message.requestId !== 'string' || typeof message.type !== 'string') return;
  try {
    let result: unknown;
    switch (message.type) {
      case 'supervisor.pairing-offer': {
        await supervisor?.stopAll();
        supervisor = undefined;
        result = control?.beginPairing();
        break;
      }
      case 'supervisor.start': {
        const running = await ensureSupervisor();
        const certificate = control!.enrolledCertificate()!;
        result = { running: true, runnerId: certificate.runnerId, expiresAt: certificate.expiresAt, agents: running.list() };
        break;
      }
      case 'agent.start': {
        if (typeof message.agentId !== 'string') throw new Error('missing agentId');
        result = await (await ensureSupervisor()).start(message.agentId);
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
process.once('exit', () => { void supervisor?.stopAll(); void control?.close(); });

runLocalService('agent-runner', { network: options.network }, async () => {
  await supervisor?.stopAll();
  await control?.close();
});
