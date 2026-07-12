import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentManifest,
  CapabilityAllowance,
  ExecutionGrant,
  MosaicNetwork,
  RunnerCertificate,
  ServiceStatus,
} from './contracts.js';

const MAX_MESSAGE_BYTES = 128 * 1024;

export interface GuardianControlRequest {
  id: string;
  token: string;
  method: 'status' | 'shutdown' | 'session.attach' | 'guardian.start' | 'runner.enroll' | 'grant.issue';
  params?: Record<string, unknown>;
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
  startGuardian(params: { vault: string; network: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<{ evmAddress: string; xmtpAddress: string }>;
  enrollRunner(params: { runnerId: string; runnerPublicKey: string; network: MosaicNetwork; environment: 'local' | 'remote' }): Promise<RunnerCertificate>;
  issueGrant(params: {
    certificate: RunnerCertificate;
    manifest: AgentManifest;
    configDigest: string;
    policyDigest: string;
    capabilities: CapabilityAllowance[];
  }): Promise<ExecutionGrant>;
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

function tokenPath(): string {
  return join(mosaicRuntimeDirectory(), 'control-token');
}

async function ensureRuntimeDirectory(): Promise<void> {
  await mkdir(mosaicRuntimeDirectory(), { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(mosaicRuntimeDirectory(), 0o700);
}

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

function write(socket: Socket, body: unknown): void {
  socket.end(`${JSON.stringify(body)}\n`);
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
}

function controlSocketRefusesConnections(address: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
      else reject(error);
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

export async function startGuardianControlServer(handlers: GuardianControlHandlers): Promise<Server> {
  const expectedToken = await guardianControlToken();
  const address = guardianControlAddress();
  await ensureRuntimeDirectory();

  const server = createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) socket.destroy(new Error('control request too large'));
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      const line = input.slice(0, newline);
      socket.pause();
      void (async () => {
        let request: GuardianControlRequest;
        try { request = JSON.parse(line) as GuardianControlRequest; }
        catch { write(socket, { id: null, ok: false, error: 'invalid JSON' }); return; }
        if (request.token !== expectedToken) { write(socket, { id: request.id, ok: false, error: 'unauthorized' }); return; }
        try {
          let result: unknown;
          switch (request.method) {
            case 'status': result = await handlers.status(); break;
            case 'shutdown': result = await handlers.shutdown(); break;
            case 'session.attach': {
              const params = request.params ?? {};
              if (
                typeof params.token !== 'string' || typeof params.address !== 'string' || typeof params.expiresAt !== 'number' ||
                !['evm', 'xrpl', 'stellar'].includes(String(params.chain)) || !['testnet', 'mainnet'].includes(String(params.network))
              ) throw new Error('invalid session.attach parameters');
              result = await handlers.attachSession(params as unknown as LocalMcpSession);
              break;
            }
            case 'guardian.start': {
              const params = request.params ?? {};
              if (typeof params.vault !== 'string' || !['testnet', 'mainnet'].includes(String(params.network))) {
                throw new Error('invalid guardian.start parameters');
              }
              result = await handlers.startGuardian({
                vault: params.vault,
                network: params.network as MosaicNetwork,
                ...(typeof params.signatureB64 === 'string' ? { signatureB64: params.signatureB64 } : {}),
                ...(typeof params.passphrase === 'string' ? { passphrase: params.passphrase } : {}),
              });
              break;
            }
            case 'runner.enroll': {
              const params = request.params ?? {};
              if (
                typeof params.runnerId !== 'string' || typeof params.runnerPublicKey !== 'string' ||
                (params.network !== 'testnet' && params.network !== 'mainnet') ||
                (params.environment !== 'local' && params.environment !== 'remote')
              ) {
                throw new Error('invalid runner.enroll parameters');
              }
              result = await handlers.enrollRunner({
                runnerId: params.runnerId,
                runnerPublicKey: params.runnerPublicKey,
                network: params.network,
                environment: params.environment,
              });
              break;
            }
            case 'grant.issue': {
              const params = request.params ?? {};
              if (
                typeof params.certificate !== 'object' || params.certificate === null ||
                typeof params.manifest !== 'object' || params.manifest === null ||
                typeof params.configDigest !== 'string' || typeof params.policyDigest !== 'string' ||
                !Array.isArray(params.capabilities)
              ) throw new Error('invalid grant.issue parameters');
              result = await handlers.issueGrant({
                certificate: params.certificate as unknown as RunnerCertificate,
                manifest: params.manifest as unknown as AgentManifest,
                configDigest: params.configDigest,
                policyDigest: params.policyDigest,
                capabilities: params.capabilities as CapabilityAllowance[],
              });
              break;
            }
            default: throw new Error('unknown control method');
          }
          write(socket, { id: request.id, ok: true, result });
        } catch (error) {
          write(socket, { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });

  try {
    await listen(server, address);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' || code !== 'EADDRINUSE' || !(await controlSocketRefusesConnections(address))) throw error;
    await removeStaleControlSocket(address);
    await listen(server, address);
  }
  return server;
}

export async function callGuardianControl<T>(
  method: GuardianControlRequest['method'],
  params?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const token = await guardianControlToken();
  const id = randomUUID();
  const address = guardianControlAddress();
  return new Promise<T>((resolve, reject) => {
    const socket = createConnection(address);
    const timeout = setTimeout(() => socket.destroy(new Error('Guardian control request timed out')), timeoutMs);
    let input = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, token, method, params })}\n`));
    socket.on('data', (chunk) => {
      input += chunk;
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(input.slice(0, newline)) as { id: string; ok: boolean; result?: T; error?: string };
        if (response.id !== id) throw new Error('Guardian control response mismatch');
        if (!response.ok) throw new Error(response.error || 'Guardian control request failed');
        resolve(response.result as T);
      } catch (error) { reject(error); }
    });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
  });
}
