import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentExecutionPackage,
  AgentLeaseRenewalPackage,
  AgentPolicyV1,
  CapabilityRequest,
  CapabilityResult,
  MosaicNetwork,
  RunnerCertificate,
  ServiceStatus,
  TransactionProposal,
  TransactionResult,
} from './contracts.js';
import { AGENT_CONTROL_PROTOCOL } from './contracts.js';

const MAX_FRAME_BYTES = 3 * 1024 * 1024;
const PAIRING_TTL_MS = 2 * 60_000;

export type GuardianControlMethod =
  | 'ping' | 'status' | 'shutdown' | 'session.attach' | 'guardian.start'
  | 'runner.approve' | 'runner.enroll'
  | 'agent.unlock' | 'agent.lock' | 'agent.stop' | 'agent.prepare'
  | 'agent.policy.get' | 'agent.policy.put' | 'agent.policy.delete'
  | 'agent.secrets.init' | 'agent.secrets.list' | 'agent.secrets.import' | 'agent.secrets.rotate' | 'agent.secrets.delete'
  | 'lease.renew' | 'capability.authorize' | 'capability.record' | 'transaction.propose';

export interface GuardianControlRequest {
  id: string;
  token: string;
  method: GuardianControlMethod;
  params?: Record<string, unknown>;
  protocol?: typeof AGENT_CONTROL_PROTOCOL;
  type?: 'request';
  requestId?: string;
  agentId?: string;
  grantId?: string;
  sequence?: number;
  deadline?: string;
  idempotencyKey?: string;
}

export interface LocalMcpSession {
  token: string;
  chain: 'evm' | 'xrpl' | 'stellar';
  address: string;
  network: MosaicNetwork;
  expiresAt: number;
}

export interface GuardianControlHandlers {
  status(): Promise<ServiceStatus> | ServiceStatus;
  shutdown(): Promise<void> | void;
  attachSession(session: LocalMcpSession): Promise<void> | void;
  startGuardian(params: { vault: string; network: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<{ guardianAddress: string }>;
  approveRunner(params: { runnerId: string }): Promise<void> | void;
  enrollRunner(params: { runnerId: string; runnerPublicKey: string; network: MosaicNetwork; environment: 'local' | 'remote' }): Promise<RunnerCertificate>;
  unlockAgent(params: { agentId: string; network: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<void>;
  lockAgent(params: { agentId: string }): Promise<void> | void;
  stopAgent(params: { agentId: string; grantId: string }): Promise<void> | void;
  prepareAgent(params: { agentId: string; certificate: RunnerCertificate; supervisorKeyLeasePublicKeyB64: string }): Promise<AgentExecutionPackage>;
  getAgentPolicy(params: { agentId: string }): Promise<AgentPolicyV1 | undefined> | AgentPolicyV1 | undefined;
  putAgentPolicy(params: { agentId: string; policy: Omit<AgentPolicyV1, 'v' | 'revision'>; expectedRevision: number }): Promise<AgentPolicyV1>;
  deleteAgentPolicy(params: { agentId: string; expectedRevision: number }): Promise<void>;
  initializeAgentSecrets(params: { agentId: string }): Promise<unknown>;
  listAgentSecrets(params: { agentId: string }): Promise<unknown> | unknown;
  importAgentSecret(params: { agentId: string; record: Record<string, unknown>; materialB64: string }): Promise<void>;
  rotateAgentSecret(params: { agentId: string; keyId: string; materialB64: string }): Promise<void>;
  deleteAgentSecret(params: { agentId: string; keyId: string }): Promise<void>;
  renewLease(params: { agentId: string; grantId: string; supervisorKeyLeasePublicKeyB64: string }): Promise<AgentLeaseRenewalPackage> | AgentLeaseRenewalPackage;
  authorizeCapability(request: CapabilityRequest): Promise<CapabilityResult | undefined> | CapabilityResult | undefined;
  recordCapability(request: CapabilityRequest, result: Omit<CapabilityResult, 'auditEventDigest'>): Promise<CapabilityResult> | CapabilityResult;
  proposeTransaction(proposal: TransactionProposal): Promise<TransactionResult> | TransactionResult;
}

export function mosaicRuntimeDirectory(): string {
  return process.env.MOSAIC_RUNTIME_DIR || join(homedir(), '.mosaic', 'run');
}

export function guardianControlAddress(): string {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME || process.env.USER || 'user';
    return `\\\\.\\pipe\\mosaic-guardian-${user.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }
  return join(mosaicRuntimeDirectory(), 'guardian.sock');
}

function tokenPath(): string { return join(mosaicRuntimeDirectory(), 'control-token'); }

async function ensureRuntimeDirectory(): Promise<void> {
  await mkdir(mosaicRuntimeDirectory(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(mosaicRuntimeDirectory(), 0o700);
}

/** Admin control token. It is not an agent, vault, XMTP, or database key. */
export async function guardianControlToken(): Promise<string> {
  await ensureRuntimeDirectory();
  try {
    const existing = (await readFile(tokenPath(), 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch { /* create below */ }
  const token = randomBytes(32).toString('hex');
  try {
    await writeFile(tokenPath(), `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return token;
  } catch {
    const winner = (await readFile(tokenPath(), 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(winner)) throw new Error('invalid Guardian control token file');
    return winner;
  }
}

function encodeFrame(body: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(body));
  if (payload.byteLength > MAX_FRAME_BYTES) throw new Error('control frame too large');
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

function writeFrame(socket: Socket, body: unknown): void {
  if (!socket.destroyed) socket.write(encodeFrame(body));
}

function consumeFrames(buffer: Buffer, receive: (value: unknown) => void): Buffer {
  let offset = 0;
  while (buffer.byteLength - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (length < 1 || length > MAX_FRAME_BYTES) throw new Error('invalid control frame length');
    if (buffer.byteLength - offset - 4 < length) break;
    receive(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString('utf8')));
    offset += 4 + length;
  }
  return buffer.subarray(offset);
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function controlSocketRefusesConnections(address: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true); else reject(error);
    });
  });
}

async function removeStaleControlSocket(address: string): Promise<void> {
  try {
    const entry = await lstat(address);
    if (!entry.isSocket()) throw new Error(`refusing to replace non-socket Guardian control path: ${address}`);
    await unlink(address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

interface ScopedCredential { runnerId: string; expiresAt: number }

export async function startGuardianControlServer(handlers: GuardianControlHandlers): Promise<Server> {
  const adminToken = await guardianControlToken();
  const address = guardianControlAddress();
  const pairing = new Map<string, ScopedCredential>();
  const supervisors = new Map<string, ScopedCredential>();
  const authoritySequences = new Map<string, number>();
  const authorityRequests = new Set<string>();
  await ensureRuntimeDirectory();

  const server = createServer((socket) => {
    let input: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const responseMeta = new Map<string, Partial<GuardianControlRequest>>();
    const respond = (id: string | null, ok: boolean, result?: unknown, error?: unknown) => {
      const meta = id ? responseMeta.get(id) : undefined;
      writeFrame(socket, {
      id, ok,
      ...(meta ? {
        protocol: AGENT_CONTROL_PROTOCOL, type: 'response', requestId: id,
        ...(meta.agentId ? { agentId: meta.agentId } : {}),
        ...(meta.grantId ? { grantId: meta.grantId } : {}),
        ...(meta.sequence ? { sequence: meta.sequence } : {}),
      } : {}),
      ...(ok ? { result } : { error: error instanceof Error ? error.message : String(error) }),
      });
      if (id) responseMeta.delete(id);
    };
    const handle = async (request: GuardianControlRequest): Promise<void> => {
      if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') throw new Error('invalid control request');
      if (typeof request.agentId === 'string') responseMeta.set(request.id, request);
      const now = Date.now();
      const supervisor = supervisors.get(request.token);
      const isAdmin = request.token === adminToken;
      const isSupervisor = supervisor !== undefined && supervisor.expiresAt > now;
      const adminMethods: GuardianControlMethod[] = [
        'status', 'shutdown', 'session.attach', 'guardian.start', 'runner.approve',
        'agent.unlock', 'agent.lock', 'agent.policy.get', 'agent.policy.put', 'agent.policy.delete',
        'agent.secrets.init', 'agent.secrets.list', 'agent.secrets.import', 'agent.secrets.rotate', 'agent.secrets.delete',
      ];
      const supervisorMethods: GuardianControlMethod[] = [
        'ping', 'status', 'agent.prepare', 'agent.stop', 'lease.renew', 'capability.authorize', 'capability.record', 'transaction.propose',
      ];
      if (request.method !== 'runner.enroll' && !((isAdmin && adminMethods.includes(request.method)) || (isSupervisor && supervisorMethods.includes(request.method)))) {
        throw new Error('unauthorized control scope');
      }
      const params = request.params ?? {};
      if (isSupervisor && !['ping', 'status', 'runner.enroll'].includes(request.method)) {
        responseMeta.set(request.id, request);
        const nested = (params.request ?? params.proposal) as Record<string, unknown> | undefined;
        if (typeof params.agentId === 'string' && typeof nested?.agentId === 'string' && params.agentId !== nested.agentId) {
          throw new Error('cross-agent operational binding mismatch');
        }
        if (typeof params.grantId === 'string' && typeof nested?.grantId === 'string' && params.grantId !== nested.grantId) {
          throw new Error('cross-grant operational binding mismatch');
        }
        const paramAgentId = typeof params.agentId === 'string' ? params.agentId : nested?.agentId;
        const paramGrantId = typeof params.grantId === 'string' ? params.grantId : nested?.grantId;
        if (
          request.protocol !== AGENT_CONTROL_PROTOCOL || request.type !== 'request' || request.requestId !== request.id ||
          typeof request.agentId !== 'string' || request.agentId !== paramAgentId ||
          !Number.isSafeInteger(request.sequence) || request.sequence! < 1 ||
          typeof request.deadline !== 'string' || Date.parse(request.deadline) <= now ||
          typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 1
        ) throw new Error('invalid operational control envelope');
        const postPreparation = request.method !== 'agent.prepare';
        if (postPreparation && (typeof request.grantId !== 'string' || request.grantId !== paramGrantId)) throw new Error('operational grant binding mismatch');
        if (!postPreparation && request.grantId !== undefined) throw new Error('prepare frame must not carry a grant');
        const authorityKey = `${request.token}|${request.agentId}|${request.grantId ?? 'prepare'}`;
        const expected = (authoritySequences.get(authorityKey) ?? 0) + 1;
        if (request.sequence !== expected) throw new Error('operational control sequence mismatch');
        const requestKey = `${authorityKey}|${request.idempotencyKey}`;
        if (authorityRequests.has(requestKey)) throw new Error('duplicate operational idempotency key');
        authoritySequences.set(authorityKey, request.sequence);
        authorityRequests.add(requestKey);
      }
      switch (request.method) {
        case 'ping': return respond(request.id, true, { pong: true, at: new Date().toISOString() });
        case 'status': return respond(request.id, true, await handlers.status());
        case 'shutdown': return respond(request.id, true, await handlers.shutdown());
        case 'session.attach': return respond(request.id, true, await handlers.attachSession(params as unknown as LocalMcpSession));
        case 'guardian.start': return respond(request.id, true, await handlers.startGuardian(params as never));
        case 'runner.approve': {
          if (typeof params.runnerId !== 'string') throw new Error('invalid runner.approve parameters');
          await handlers.approveRunner({ runnerId: params.runnerId });
          const pairingCredential = randomBytes(32).toString('hex');
          pairing.set(pairingCredential, { runnerId: params.runnerId, expiresAt: now + PAIRING_TTL_MS });
          return respond(request.id, true, { pairingCredential, expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() });
        }
        case 'runner.enroll': {
          const credential = pairing.get(request.token);
          if (!credential || credential.expiresAt <= now || credential.runnerId !== params.runnerId) throw new Error('invalid or expired pairing credential');
          pairing.delete(request.token);
          const certificate = await handlers.enrollRunner(params as never);
          const sessionCredential = randomBytes(32).toString('hex');
          supervisors.set(sessionCredential, { runnerId: certificate.runnerId, expiresAt: Date.parse(certificate.expiresAt) });
          return respond(request.id, true, { certificate, sessionCredential });
        }
        case 'agent.unlock': return respond(request.id, true, await handlers.unlockAgent(params as never));
        case 'agent.lock': return respond(request.id, true, await handlers.lockAgent(params as never));
        case 'agent.stop': return respond(request.id, true, await handlers.stopAgent(params as never));
        case 'agent.prepare': {
          if (supervisor?.runnerId !== (params.certificate as RunnerCertificate | undefined)?.runnerId) throw new Error('Supervisor certificate binding mismatch');
          return respond(request.id, true, await handlers.prepareAgent(params as never));
        }
        case 'agent.policy.get': return respond(request.id, true, await handlers.getAgentPolicy(params as never));
        case 'agent.policy.put': return respond(request.id, true, await handlers.putAgentPolicy(params as never));
        case 'agent.policy.delete': return respond(request.id, true, await handlers.deleteAgentPolicy(params as never));
        case 'agent.secrets.init': return respond(request.id, true, await handlers.initializeAgentSecrets(params as never));
        case 'agent.secrets.list': return respond(request.id, true, await handlers.listAgentSecrets(params as never));
        case 'agent.secrets.import': return respond(request.id, true, await handlers.importAgentSecret(params as never));
        case 'agent.secrets.rotate': return respond(request.id, true, await handlers.rotateAgentSecret(params as never));
        case 'agent.secrets.delete': return respond(request.id, true, await handlers.deleteAgentSecret(params as never));
        case 'lease.renew': return respond(request.id, true, await handlers.renewLease(params as never));
        case 'capability.authorize': return respond(request.id, true, await handlers.authorizeCapability(params.request as unknown as CapabilityRequest));
        case 'capability.record': return respond(request.id, true, await handlers.recordCapability(
          params.request as unknown as CapabilityRequest,
          params.result as unknown as Omit<CapabilityResult, 'auditEventDigest'>,
        ));
        case 'transaction.propose': return respond(request.id, true, await handlers.proposeTransaction(params.proposal as unknown as TransactionProposal));
      }
    };
    socket.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      try {
        input = consumeFrames(input, (value) => {
          const request = value as GuardianControlRequest;
          void handle(request).catch((error) => respond(typeof request?.id === 'string' ? request.id : null, false, undefined, error));
        });
      } catch (error) { respond(null, false, undefined, error); socket.destroy(); }
    });
  });

  try { await listen(server, address); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' || code !== 'EADDRINUSE' || !(await controlSocketRefusesConnections(address))) throw error;
    await removeStaleControlSocket(address);
    await listen(server, address);
  }
  return server;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timeout: NodeJS.Timeout;
  agentId?: string;
  grantId?: string;
  sequence?: number;
}

export class GuardianControlClient {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private input: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private readonly pending = new Map<string, PendingCall>();
  private readonly sequences = new Map<string, number>();
  private readonly disconnectListeners = new Set<() => void>();

  constructor(private token: string, private readonly address = guardianControlAddress()) {}

  setToken(token: string): void { this.token = token; }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.address);
      const fail = (error: Error) => { this.rejectAll(error); reject(error); };
      socket.once('connect', () => { socket.off('error', fail); this.socket = socket; this.install(socket); resolve(); });
      socket.once('error', fail);
    }).finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async call<T>(method: GuardianControlMethod, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    await this.connect();
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Guardian ${method} request timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout });
      try {
        const nested = (params?.request ?? params?.proposal) as Record<string, unknown> | undefined;
        const agentId = typeof params?.agentId === 'string' ? params.agentId : nested?.agentId;
        const grantId = typeof params?.grantId === 'string' ? params.grantId : nested?.grantId;
        const operational = typeof agentId === 'string' && !['ping', 'status', 'runner.enroll'].includes(method);
        let authority: Record<string, unknown> = {};
        if (operational) {
          const key = `${agentId}|${grantId ?? 'prepare'}`;
          const sequence = (this.sequences.get(key) ?? 0) + 1;
          this.sequences.set(key, sequence);
          authority = {
            protocol: AGENT_CONTROL_PROTOCOL, type: 'request', requestId: id, agentId,
            ...(typeof grantId === 'string' ? { grantId } : {}), sequence,
            deadline: new Date(Date.now() + timeoutMs).toISOString(), idempotencyKey: randomUUID(),
          };
          const pending = this.pending.get(id)!;
          pending.agentId = agentId;
          if (typeof grantId === 'string') pending.grantId = grantId;
          pending.sequence = sequence;
        }
        writeFrame(this.socket!, { id, token: this.token, method, params, ...authority });
      }
      catch (error) { clearTimeout(timeout); this.pending.delete(id); reject(error); }
    });
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
    this.rejectAll(new Error('Guardian control connection closed'));
  }

  private install(socket: Socket): void {
    socket.on('data', (chunk: Buffer) => {
      this.input = Buffer.concat([this.input, chunk]);
      try { this.input = consumeFrames(this.input, (value) => this.receive(value)); }
      catch (error) { socket.destroy(error as Error); }
    });
    socket.once('error', (error) => this.rejectAll(error));
    socket.once('close', () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectAll(new Error('Guardian control connection closed'));
      for (const listener of this.disconnectListeners) listener();
    });
  }

  private receive(value: unknown): void {
    const response = value as { id?: string; ok?: boolean; result?: unknown; error?: string; protocol?: string; type?: string; requestId?: string; agentId?: string; grantId?: string; sequence?: number };
    if (typeof response.id !== 'string') return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timeout);
    if (pending.agentId && (
      response.protocol !== AGENT_CONTROL_PROTOCOL || response.type !== 'response' || response.requestId !== response.id ||
      response.agentId !== pending.agentId || response.grantId !== pending.grantId || response.sequence !== pending.sequence
    )) {
      pending.reject(new Error('Guardian operational response binding mismatch'));
      return;
    }
    if (response.ok) pending.resolve(response.result); else pending.reject(new Error(response.error || 'Guardian control request failed'));
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }
}

export async function callGuardianControl<T>(method: GuardianControlMethod, params?: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const client = new GuardianControlClient(await guardianControlToken());
  try { return await client.call<T>(method, params, timeoutMs); }
  finally { client.close(); }
}
