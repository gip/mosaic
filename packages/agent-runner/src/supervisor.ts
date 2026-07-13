import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  AGENT_CONTROL_PROTOCOL,
  assertActiveWindow,
  canonicalJson,
  contractDigest,
  controlSignatureText,
  sha256Hex,
  type CapabilityAllowance,
  type CapabilityOperation,
  type CapabilityRequest,
  type CapabilityResult,
  type ExecutionGrant,
  type RunnerCertificate,
  type SignedAgentControlMessage,
} from '@mosaic/local-runtime';

interface SandboxStart {
  type: 'start';
  source: string;
  limits: ExecutionGrant['limits'];
  allowedOperations: string[];
}

interface HookRequest {
  type: 'hook';
  id: string;
  operation: string;
  arguments: Record<string, unknown>;
}

interface SandboxExit {
  type: 'complete' | 'failed';
  error?: string;
}

export interface SupervisorResult {
  exitCode: number;
  logs: Array<Record<string, unknown>>;
  auditDigest: string;
}

/**
 * Guardian-side capability enforcement (Vault Core). When present, every hook
 * is authorized before execution and recorded after it, so quotas and the
 * audit chain are enforced by the Guardian rather than only by this
 * (untrusted) Runner process.
 */
export interface CapabilityAuthorizer {
  authorize(request: CapabilityRequest): Promise<void>;
  record(request: CapabilityRequest, result: Omit<CapabilityResult, 'auditEventDigest'>): Promise<void>;
}

export function verifyGuardianEnvelope(message: SignedAgentControlMessage, expectedAddress: string): void {
  if (message.protocol !== AGENT_CONTROL_PROTOCOL) throw new Error('unsupported Guardian envelope');
  const signature = new Uint8Array(Buffer.from(message.signatureB64, 'base64'));
  if (signature.length !== 65) throw new Error('invalid Guardian signature length');
  const text = controlSignatureText(message);
  const bytes = utf8ToBytes(text);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...bytes]));
  const recovered = new Uint8Array([signature[64]! - 27, ...signature.slice(0, 64)]);
  const recoveredKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const publicKey = secp256k1.Point.fromBytes(recoveredKey).toBytes(false);
  const address = `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(-20)).toString('hex')}`;
  if (address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('Guardian envelope signer mismatch');
}

export function verifyExecutionAuthorization(params: {
  certificate: RunnerCertificate;
  grant: ExecutionGrant;
  source: string;
  runnerId: string;
  runnerPublicKey: string;
  expectedGuardianAddress: string;
  now?: number;
}): void {
  const now = params.now ?? Date.now();
  if (params.certificate.guardianAddress.toLowerCase() !== params.expectedGuardianAddress.toLowerCase()) {
    throw new Error('Guardian address does not match pinned discovery');
  }
  verifyGuardianEnvelope(params.certificate, params.expectedGuardianAddress);
  verifyGuardianEnvelope(params.grant, params.expectedGuardianAddress);
  assertActiveWindow(params.certificate.issuedAt, params.certificate.expiresAt, now);
  assertActiveWindow(params.grant.issuedAt, params.grant.expiresAt, now);
  if (params.certificate.runnerId !== params.runnerId || params.grant.runnerId !== params.runnerId) throw new Error('Runner ID mismatch');
  if (params.certificate.runnerPublicKey !== params.runnerPublicKey || params.grant.runnerPublicKey !== params.runnerPublicKey) throw new Error('Runner public key mismatch');
  if (params.grant.guardianId !== params.certificate.guardianId || params.grant.network !== params.certificate.network) throw new Error('Guardian binding mismatch');
  if (params.grant.certificateDigest !== contractDigest(params.certificate)) throw new Error('certificate digest mismatch');
  if (params.grant.sourceDigest !== sha256Hex(params.source)) throw new Error('agent source digest mismatch');
}

export class AgentSupervisor {
  private readonly state = new Map<string, { revision: number; value: unknown }>();
  private readonly logs: Array<Record<string, unknown>> = [];
  private auditHead = '0'.repeat(64);
  private sequence = 0;
  private authorizeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly authorizer?: CapabilityAuthorizer) {}

  async run(source: string, grant: ExecutionGrant): Promise<SupervisorResult> {
    if (sha256Hex(source) !== grant.sourceDigest) throw new Error('refusing source that does not match grant');
    const workdir = await mkdtemp(join(tmpdir(), 'mosaic-agent-'));
    const sandboxPath = fileURLToPath(new URL('./sandbox.js', import.meta.url));
    const child = spawn(process.execPath, [sandboxPath], {
      cwd: workdir,
      env: { NODE_NO_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      detached: false,
    });
    const killChild = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    // The runner may be stopped (shutdown IPC → process.exit) mid-run; the
    // sandbox must never outlive its supervisor.
    process.once('exit', killChild);
    const deadline = Math.min(Date.parse(grant.expiresAt) + grant.maxOfflineMs, Date.now() + grant.limits.wallTimeMs);
    const timeout = setTimeout(killChild, Math.max(1, deadline - Date.now()));
    try {
      const completion = this.monitor(child, grant);
      child.send({
        type: 'start',
        source,
        limits: grant.limits,
        allowedOperations: grant.capabilities.map(({ operation }) => operation),
      } satisfies SandboxStart);
      const exitCode = await completion;
      return { exitCode, logs: structuredClone(this.logs), auditDigest: this.auditHead };
    } finally {
      clearTimeout(timeout);
      process.off('exit', killChild);
      killChild();
      await rm(workdir, { recursive: true, force: true });
    }
  }

  private monitor(child: ChildProcess, grant: ExecutionGrant): Promise<number> {
    const allowances = new Map(grant.capabilities.map((item) => [item.operation, { ...item, calls: 0 }]));
    const maxConcurrency = grant.limits.maxHookConcurrency;
    let concurrent = 0;
    const reply = (message: Record<string, unknown>): void => {
      if (!child.connected) return;
      try { child.send(message); } catch { /* sandbox exited between check and send */ }
    };
    return new Promise((resolve, reject) => {
      let terminal: SandboxExit | undefined;
      child.stderr?.on('data', (chunk) => this.appendAudit('sandbox.stderr', { bytes: Buffer.byteLength(chunk) }));
      child.on('error', reject);
      child.on('message', (message: unknown) => {
        if (!isRecord(message) || typeof message.type !== 'string') return;
        if (message.type === 'complete' || message.type === 'failed') {
          terminal = message as unknown as SandboxExit;
          return;
        }
        if (message.type !== 'hook') return;
        if (concurrent >= maxConcurrency) {
          reply({ type: 'hook-result', id: message.id, ok: false, error: 'hook concurrency limit exceeded' });
          return;
        }
        concurrent += 1;
        void this.handleHook(message as unknown as HookRequest, allowances, grant)
          .then((value) => reply({ type: 'hook-result', id: message.id, ok: true, value }))
          .catch((error) => reply({ type: 'hook-result', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) }))
          .finally(() => { concurrent -= 1; });
      });
      child.on('exit', (code, signal) => {
        if (terminal?.type === 'complete' && code === 0) resolve(0);
        else reject(new Error(terminal?.error ?? `agent sandbox exited with ${signal ?? code ?? 'unknown status'}`));
      });
    });
  }

  /**
   * Authorizations are serialized because Vault Core enforces a strict
   * sequence; the local counter only advances once the Guardian accepts.
   */
  private authorizeSequenced(request: HookRequest, grant: ExecutionGrant): Promise<CapabilityRequest> {
    const run = async (): Promise<CapabilityRequest> => {
      const capabilityRequest: CapabilityRequest = {
        protocol: AGENT_CONTROL_PROTOCOL,
        kind: 'capability-request',
        grantId: grant.grantId,
        runnerId: grant.runnerId,
        sequence: this.sequence + 1,
        requestId: request.id,
        operation: request.operation as CapabilityOperation,
        arguments: request.arguments,
        deadline: new Date(Date.now() + 10_000).toISOString(),
        idempotencyKey: request.id,
      };
      await this.authorizer!.authorize(capabilityRequest);
      this.sequence = capabilityRequest.sequence;
      return capabilityRequest;
    };
    const result = this.authorizeQueue.then(run);
    this.authorizeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private recordSafe(capabilityRequest: CapabilityRequest, ok: boolean, responseBytes: number): Promise<void> {
    return this.authorizer!.record(capabilityRequest, {
      protocol: AGENT_CONTROL_PROTOCOL,
      kind: 'capability-result',
      grantId: capabilityRequest.grantId,
      requestId: capabilityRequest.requestId,
      sequence: capabilityRequest.sequence,
      ok,
      usage: { calls: 1, responseBytes },
    }).catch((error) => {
      this.appendAudit('capability.record-failed', {
        requestId: capabilityRequest.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleHook(
    request: HookRequest,
    allowances: Map<string, CapabilityAllowance & { calls: number }>,
    grant: ExecutionGrant,
  ): Promise<unknown> {
    const allowance = allowances.get(request.operation);
    if (!allowance) throw new Error(`hook ${request.operation} is not granted`);
    allowance.calls += 1;
    if (allowance.calls > allowance.maxCalls) throw new Error(`hook ${request.operation} quota exceeded`);
    let capabilityRequest: CapabilityRequest | undefined;
    if (this.authorizer) capabilityRequest = await this.authorizeSequenced(request, grant);
    else this.sequence += 1;
    let value: unknown;
    let bytes: number;
    try {
      value = this.executeHook(request);
      bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > allowance.maxResponseBytes) throw new Error(`hook ${request.operation} response too large`);
    } catch (error) {
      if (capabilityRequest) await this.recordSafe(capabilityRequest, false, 0);
      throw error;
    }
    this.appendAudit('hook.result', { sequence: this.sequence, requestId: request.id, operation: request.operation, responseBytes: bytes });
    if (capabilityRequest) await this.recordSafe(capabilityRequest, true, bytes);
    return value;
  }

  private executeHook(request: HookRequest): unknown {
    let value: unknown;
    switch (request.operation) {
      case 'log.emit': {
        const entry = requireRecord(request.arguments.entry, 'log entry');
        const safe = JSON.parse(canonicalJson(entry)) as Record<string, unknown>;
        this.logs.push(safe);
        value = { accepted: true };
        break;
      }
      case 'clock.now': value = new Date().toISOString(); break;
      case 'random.bytes': {
        const length = Number(request.arguments.length);
        if (!Number.isSafeInteger(length) || length < 1 || length > 256) throw new Error('random byte length must be 1..256');
        value = Buffer.from(randomBytes(length)).toString('base64');
        break;
      }
      case 'state.get': {
        const key = stateKey(request.arguments.key);
        value = this.state.get(key) ?? { revision: 0, value: null };
        break;
      }
      case 'state.put': {
        const key = stateKey(request.arguments.key);
        const previous = this.state.get(key);
        const next = { revision: (previous?.revision ?? 0) + 1, value: request.arguments.value ?? null };
        this.state.set(key, next);
        value = next;
        break;
      }
      case 'state.compareAndSet': {
        const key = stateKey(request.arguments.key);
        const expected = Number(request.arguments.expectedRevision);
        const previous = this.state.get(key) ?? { revision: 0, value: null };
        if (previous.revision !== expected) value = { updated: false, ...previous };
        else {
          const next = { revision: expected + 1, value: request.arguments.value ?? null };
          this.state.set(key, next);
          value = { updated: true, ...next };
        }
        break;
      }
      default: throw new Error(`hook broker ${request.operation} is not implemented`);
    }
    return value;
  }

  private appendAudit(type: string, body: Record<string, unknown>): void {
    this.auditHead = contractDigest({ previous: this.auditHead, type, at: new Date().toISOString(), body });
  }
}

function stateKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new Error('invalid state key');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
