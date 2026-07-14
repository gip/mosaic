import { createRequire } from 'node:module';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type OpenDialogOptions, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_GUARDIAN_VAULT,
  DEFAULT_RUNNER_VAULT,
  MAX_AGENT_PACKAGE_BYTES,
  assertArtifactPackage,
  canonicalJson,
  type AgentArtifactPackage,
  type AgentInstallationPolicy,
  type AgentResourceLimits,
  type CapabilityAllowance,
  type LocalMcpSession,
  type MosaicNetwork,
  type PairingOffer,
  type ServiceName,
  type ServiceStatus,
  type XmtpResourceDescriptor,
} from '@mosaic/local-runtime';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const statuses = new Map<ServiceName, ServiceStatus>();
const children = new Map<ServiceName, UtilityProcess>();
let window: BrowserWindow | null = null;
let rendererServer: Server | null = null;
let quitting = false;
let supervisorEnrolled = false;
const supervisorPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timeout: NodeJS.Timeout }>();
const guardianPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timeout: NodeJS.Timeout }>();
const guardianApprovalEvents: Array<{ requestId: string; operation: string; agentId?: string }> = [];
const guardianApprovalWaiters = new Set<() => void>();

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function serviceEntry(packageName: string): string {
  const manifest = require.resolve(`${packageName}/package.json`);
  return join(dirname(manifest), 'dist', 'bin.js');
}

function publish(status: ServiceStatus): void {
  statuses.set(status.name, status);
  window?.webContents.send('services:status', [...statuses.values()]);
}

function startService(name: ServiceName, packageName: string, args: string[] = []): void {
  if (children.has(name)) throw new Error(`${name} is already running`);
  publish({ name, phase: 'starting' });
  const child = utilityProcess.fork(serviceEntry(packageName), args, {
    serviceName: `Mosaic ${name}`,
    stdio: 'inherit',
  });
  children.set(name, child);

  child.on('spawn', () => publish({ name, phase: 'starting', pid: child.pid }));
  child.on('message', (message: unknown) => {
    if (isGuardianResponse(message)) {
      const pending = guardianPending.get(message.requestId);
      if (pending) {
        guardianPending.delete(message.requestId);
        clearTimeout(pending.timeout);
        if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error || 'Guardian request failed'));
      }
      return;
    }
    if (isGuardianEvent(message)) {
      if (message.event.type === 'approval-required' && typeof message.event.requestId === 'string' && typeof message.event.operation === 'string') {
        guardianApprovalEvents.push({ requestId: message.event.requestId, operation: message.event.operation, ...(typeof message.event.agentId === 'string' ? { agentId: message.event.agentId } : {}) });
        for (const wake of guardianApprovalWaiters) wake();
      }
      return;
    }
    if (isSupervisorResponse(message)) {
      const pending = supervisorPending.get(message.requestId);
      if (pending) {
        supervisorPending.delete(message.requestId);
        clearTimeout(pending.timeout);
        if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error || 'Supervisor request failed'));
      }
      return;
    }
    if (isReadyMessage(message, name)) {
      publish({
        name,
        phase: name === 'mosaic-guardian' ? 'awaiting-wallet' : 'running',
        pid: message.pid,
        ...(message.vault ? { vault: message.vault } : {}),
        ...(message.network ? { network: message.network } : {}),
      });
    }
  });
  child.on('exit', (code) => {
    children.delete(name);
    // A restarted process requires a new attended certificate pairing. There
    // is no reusable bearer/session credential.
    if (name === 'agent-runner' || name === 'mosaic-guardian') supervisorEnrolled = false;
    const pendingRequests = name === 'mosaic-guardian' ? guardianPending : supervisorPending;
    for (const [requestId, pending] of pendingRequests) {
      pendingRequests.delete(requestId);
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${name} exited`));
    }
    const expected = quitting || statuses.get(name)?.phase === 'stopping';
    publish({
      name,
      phase: expected ? 'stopped' : 'failed',
      detail: `Exited with code ${code}`,
    });
  });
}

function isSupervisorResponse(message: unknown): message is { type: 'supervisor-response'; requestId: string; ok: boolean; result?: unknown; error?: string } {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'supervisor-response' &&
    'requestId' in message && typeof message.requestId === 'string' && 'ok' in message && typeof message.ok === 'boolean';
}

function isGuardianResponse(message: unknown): message is { type: 'guardian-response'; requestId: string; ok: boolean; result?: unknown; error?: string } {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'guardian-response' &&
    'requestId' in message && typeof message.requestId === 'string' && 'ok' in message && typeof message.ok === 'boolean';
}

function isGuardianEvent(message: unknown): message is { type: 'guardian-event'; event: Record<string, unknown> } {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'guardian-event' &&
    'event' in message && typeof message.event === 'object' && message.event !== null;
}

function supervisorRequest<T>(type: 'supervisor.pairing-offer' | 'supervisor.start' | 'agent.start' | 'agent.list' | 'agent.status', params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
  const child = children.get('agent-runner');
  if (!child) throw new Error('Mosaic Supervisor is not running');
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => { supervisorPending.delete(requestId); reject(new Error(`Supervisor ${type} timed out`)); }, timeoutMs);
    supervisorPending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
    child.postMessage({ type, requestId, ...params });
  });
}

function guardianRequest<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 180_000): Promise<T> {
  const child = children.get('mosaic-guardian');
  if (!child) throw new Error('Mosaic Guardian is not running');
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => { guardianPending.delete(requestId); reject(new Error(`Guardian ${method} timed out`)); }, timeoutMs);
    guardianPending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
    child.postMessage({ type: 'guardian-request', requestId, method, params });
  });
}

async function startGuardian(args: {
  vault?: string;
  network?: MosaicNetwork;
  session: LocalMcpSession;
  signatureB64?: string;
  passphrase?: string;
}): Promise<ServiceStatus> {
  const vault = args.vault?.trim() || DEFAULT_GUARDIAN_VAULT;
  const network = args.network ?? 'testnet';
  if (!children.has('mosaic-guardian')) {
    startService('mosaic-guardian', '@mosaic/guardian', [vault, '--network', network]);
    await waitForService('mosaic-guardian');
  }
  await guardianRequest('session.attach', args.session as unknown as Record<string, unknown>);
  await guardianRequest('guardian.start', {
    vault,
    network,
    ...(args.signatureB64 ? { signatureB64: args.signatureB64 } : {}),
    ...(args.passphrase ? { passphrase: args.passphrase } : {}),
  });
  const current = await guardianRequest<ServiceStatus & { phase: ServiceStatus['phase'] }>('status');
  const nextStatus: ServiceStatus = { name: 'mosaic-guardian', phase: current.phase, pid: current.pid, detail: current.detail, vault: current.vault, network: current.network, evmAddress: current.evmAddress };
  publish(nextStatus);
  // One idle Supervisor service is shared by every agent for this Local
  // session. Enrollment remains deferred until the first explicit agent start.
  if (!children.has('agent-runner')) startService('agent-runner', '@mosaic/agent-runner', ['--network', network]);
  return nextStatus;
}

async function waitForService(name: ServiceName, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const phase = statuses.get(name)?.phase;
    if ((name === 'agent-runner' && phase === 'running') || (name === 'mosaic-guardian' && phase === 'awaiting-wallet')) return;
    if (!children.has(name) || phase === 'failed' || phase === 'stopped') throw new Error(`${name} exited during startup`);
    if (Date.now() >= deadline) throw new Error(`${name} did not become ready in time`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForRunner(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const phase = statuses.get('agent-runner')?.phase;
    if (phase === 'running') return;
    if (!children.has('agent-runner') || phase === 'failed' || phase === 'stopped') {
      throw new Error(`Agent Runner ${phase === 'failed' ? 'failed to start' : 'exited during startup'}`);
    }
    if (Date.now() >= deadline) throw new Error('Agent Runner did not become ready in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function startAgent(args: { agentId?: string; vault?: string; network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<unknown> {
  const vault = args.agentId?.trim() || args.vault?.trim() || DEFAULT_RUNNER_VAULT;
  const network = args.network ?? 'testnet';
  const guardian = await guardianRequest<ServiceStatus>('status');
  if (guardian.phase !== 'running') throw new Error('Unlock Mosaic Guardian before starting an agent');
  try {
    if (!children.has('agent-runner')) startService('agent-runner', '@mosaic/agent-runner', ['--network', network]);
    await waitForRunner();
    if (!supervisorEnrolled) {
      const offer = await supervisorRequest<PairingOffer>('supervisor.pairing-offer');
      await guardianRequest('pairing.approve', { offer: offer as unknown as Record<string, unknown> });
      await supervisorRequest('supervisor.start', {}, 15 * 60_000);
      supervisorEnrolled = true;
    }
    const start = supervisorRequest('agent.start', { agentId: vault }, 15 * 60_000);
    const approval = await waitForGuardianApproval('agent-start', vault);
    await guardianRequest('agent-start.approve', {
      requestId: approval.requestId,
      ...(args.signatureB64 ? { signatureB64: args.signatureB64 } : {}),
      ...(args.passphrase ? { passphrase: args.passphrase } : {}),
    });
    return await start;
  } catch (error) {
    await guardianRequest('agent.lock', { agentId: vault }).catch(() => {});
    throw error;
  }
}

async function waitForGuardianApproval(operation: string, agentId: string, timeoutMs = 15 * 60_000): Promise<{ requestId: string }> {
  const take = () => {
    const index = guardianApprovalEvents.findIndex((event) => event.operation === operation && event.agentId === agentId);
    return index >= 0 ? guardianApprovalEvents.splice(index, 1)[0] : undefined;
  };
  const available = take();
  if (available) return available;
  return new Promise((resolve, reject) => {
    const wake = () => { const found = take(); if (found) { clearTimeout(timeout); guardianApprovalWaiters.delete(wake); resolve(found); } };
    const timeout = setTimeout(() => { guardianApprovalWaiters.delete(wake); reject(new Error(`Guardian ${operation} approval notification timed out`)); }, timeoutMs);
    guardianApprovalWaiters.add(wake);
  });
}

async function stopAgent(agentId: string): Promise<void> { await guardianRequest('agent.stop', { agentId }); }
async function killAgent(agentId: string): Promise<void> { await guardianRequest('agent.kill', { agentId }); }

async function openAgentPackage(): Promise<AgentArtifactPackage | undefined> {
  const options: OpenDialogOptions = {
    title: 'Open Mosaic agent package',
    properties: ['openFile'],
    filters: [{ name: 'Mosaic agent packages', extensions: ['mosaic-agent'] }],
  };
  const selected = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  if (selected.canceled || selected.filePaths.length !== 1) return undefined;
  const path = selected.filePaths[0]!;
  const size = statSync(path).size;
  if (size > MAX_AGENT_PACKAGE_BYTES) throw new Error('Agent package exceeds the maximum size');
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_AGENT_PACKAGE_BYTES) throw new Error('Agent package exceeds the maximum size');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const artifact = JSON.parse(text) as AgentArtifactPackage;
  assertArtifactPackage(artifact);
  if (text !== canonicalJson(artifact)) throw new Error('Agent package envelope must be canonical JSON');
  return artifact;
}

async function installAgent(args: {
  agentId: string;
  artifactDigest: string;
  capabilities: CapabilityAllowance[];
  resources: XmtpResourceDescriptor[];
  limits: AgentResourceLimits;
  enabled: boolean;
  expectedRevision: number;
  network?: MosaicNetwork;
  signatureB64?: string;
  passphrase?: string;
}): Promise<AgentInstallationPolicy> {
  const agentId = args.agentId.trim();
  const network = args.network ?? 'testnet';
  await guardianRequest('agent.unlock', {
    agentId,
    network,
    ...(args.signatureB64 ? { signatureB64: args.signatureB64 } : {}),
    ...(args.passphrase ? { passphrase: args.passphrase } : {}),
  });
  try {
    return await guardianRequest<AgentInstallationPolicy>('agent.install', {
      agentId,
      artifactDigest: args.artifactDigest,
      capabilities: args.capabilities,
      resources: args.resources,
      limits: args.limits,
      enabled: args.enabled,
      expectedRevision: args.expectedRevision,
    });
  } finally {
    await guardianRequest('agent.lock', { agentId }).catch(() => {});
  }
}

async function getAgentInstallation(args: string | { agentId: string; network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<AgentInstallationPolicy | undefined> {
  if (typeof args === 'string') return guardianRequest('agent.installation.get', { agentId: args });
  const agentId = args.agentId.trim();
  await guardianRequest('agent.unlock', {
    agentId,
    network: args.network ?? 'testnet',
    ...(args.signatureB64 ? { signatureB64: args.signatureB64 } : {}),
    ...(args.passphrase ? { passphrase: args.passphrase } : {}),
  });
  try { return await guardianRequest('agent.installation.get', { agentId }); }
  finally { await guardianRequest('agent.lock', { agentId }).catch(() => {}); }
}

async function deleteAgentInstallation(agentId: string, expectedRevision: number, auth?: { network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<void> {
  if (!auth) return guardianRequest('agent.installation.delete', { agentId, expectedRevision });
  await guardianRequest('agent.unlock', {
    agentId,
    network: auth.network ?? 'testnet',
    ...(auth.signatureB64 ? { signatureB64: auth.signatureB64 } : {}),
    ...(auth.passphrase ? { passphrase: auth.passphrase } : {}),
  });
  try { await guardianRequest('agent.installation.delete', { agentId, expectedRevision }); }
  finally { await guardianRequest('agent.lock', { agentId }).catch(() => {}); }
}

async function stopService(name: ServiceName): Promise<void> {
  if (name === 'mosaic-guardian') {
    supervisorEnrolled = false;
    // 'stopping' (not 'stopped') so a spawned child's exit handler classifies
    // the shutdown as expected; the exit handler or status poll settles it.
    publish({ ...statuses.get(name), name, phase: 'stopping' });
    await guardianRequest('shutdown').catch(() => {});
    if (!children.has(name)) publish({ name, phase: 'stopped' });
    return;
  }
  const child = children.get(name);
  if (!child) { publish({ name, phase: 'stopped' }); return; }
  publish({ ...statuses.get(name), name, phase: 'stopping' });
  child.postMessage({ type: 'shutdown' });
}

function isReadyMessage(message: unknown, name: ServiceName): message is { type: 'ready'; service: ServiceName; pid: number; vault?: string; network?: MosaicNetwork } {
  return (
    typeof message === 'object' && message !== null &&
    'type' in message && message.type === 'ready' &&
    'service' in message && message.service === name &&
    'pid' in message && typeof message.pid === 'number'
  );
}

function startRendererServer(): Promise<string> {
  const root = resolve(here, '..', '..', 'frontend', 'dist');
  const index = join(root, 'index.html');
  if (!existsSync(index)) throw new Error('frontend/dist is missing; run pnpm --filter frontend build');

  rendererServer = createServer((request, response) => {
    if (request.headers.host !== '127.0.0.1:4174') {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1:4174').pathname);
    const relative = normalize(pathname).replace(/^[/\\]+/, '');
    const candidate = resolve(root, relative);
    const withinRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
    const file = withinRoot && existsSync(candidate) && statSync(candidate).isFile() ? candidate : index;
    response.setHeader('content-type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
    response.setHeader('x-content-type-options', 'nosniff');
    createReadStream(file).pipe(response);
  });

  return new Promise((resolveUrl, reject) => {
    rendererServer?.once('error', reject);
    rendererServer?.listen(4174, '127.0.0.1', () => resolveUrl('http://127.0.0.1:4174/agents'));
  });
}

function createWindow(rendererUrl: string): void {
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: 'Mosaic Local',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadURL(rendererUrl);
  window.on('closed', () => { window = null; });
}

async function stopChildren(): Promise<void> {
  const exits = [...children.entries()].map(([name, child]) => {
    publish({ ...statuses.get(name), name, phase: 'stopping' });
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill();
        resolve();
      }, 10_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      if (name === 'mosaic-guardian') child.postMessage({ type: 'guardian-request', requestId: randomUUID(), method: 'shutdown', params: {} });
      else child.postMessage({ type: 'shutdown' });
    });
  });
  await Promise.all(exits);
}

ipcMain.handle('services:list', () => [...statuses.values()]);
ipcMain.handle('services:start-guardian', (_event, args) => startGuardian(args));
ipcMain.handle('services:start-agent', (_event, args) => startAgent(args));
ipcMain.handle('supervisor:start', async (_event, args: { network?: MosaicNetwork } = {}) => {
  if (!children.has('agent-runner')) startService('agent-runner', '@mosaic/agent-runner', ['--network', args.network ?? 'testnet']);
});
ipcMain.handle('agent:start', (_event, args) => startAgent(args));
ipcMain.handle('agent:stop', (_event, agentId: string) => stopAgent(agentId));
ipcMain.handle('agent:kill', (_event, agentId: string) => killAgent(agentId));
ipcMain.handle('agent:list', () => supervisorRequest('agent.list'));
ipcMain.handle('agent:status', (_event, agentId: string) => supervisorRequest('agent.status', { agentId }));
ipcMain.handle('agent:package-open', () => openAgentPackage());
ipcMain.handle('agent:install', (_event, args) => installAgent(args));
ipcMain.handle('agent:installation-get', (_event, args) => getAgentInstallation(args));
ipcMain.handle('agent:installation-delete', (_event, agentId: string, expectedRevision: number, auth) => deleteAgentInstallation(agentId, expectedRevision, auth));
ipcMain.handle('services:stop', (_event, name: ServiceName) => stopService(name));

app.whenReady().then(() => {
  const rendererUrl = process.env.MOSAIC_RENDERER_URL
    ? Promise.resolve(new URL('/agents', process.env.MOSAIC_RENDERER_URL).toString())
    : startRendererServer();
  void rendererUrl.then((url) => {
    createWindow(url);
    publish({ name: 'mosaic-guardian', phase: 'stopped', vault: DEFAULT_GUARDIAN_VAULT, network: 'testnet' });
    publish({ name: 'agent-runner', phase: 'stopped', vault: DEFAULT_RUNNER_VAULT, network: 'testnet' });
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const url = process.env.MOSAIC_RENDERER_URL ?? 'http://127.0.0.1:4174';
      createWindow(new URL('/agents', url).toString());
    }
  });
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  rendererServer?.close();
  void stopChildren().finally(() => app.quit());
});
