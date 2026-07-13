import { createRequire } from 'node:module';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_GUARDIAN_VAULT,
  DEFAULT_RUNNER_VAULT,
  callGuardianControl,
  type LocalMcpSession,
  type MosaicNetwork,
  type ServiceName,
  type ServiceStatus,
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
    if (name === 'agent-runner') supervisorEnrolled = false;
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

function supervisorRequest<T>(type: 'supervisor.start' | 'agent.start' | 'agent.stop' | 'agent.list' | 'agent.status', params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<T> {
  const child = children.get('agent-runner');
  if (!child) throw new Error('Mosaic Supervisor is not running');
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => { supervisorPending.delete(requestId); reject(new Error(`Supervisor ${type} timed out`)); }, timeoutMs);
    supervisorPending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout });
    child.postMessage({ type, requestId, ...params });
  });
}

async function waitForGuardianControl(): Promise<void> {
  // Generous budget: a cold Guardian start loads the WalletConnect/MCP module
  // graph before its control socket opens.
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { await callGuardianControl<ServiceStatus>('status', undefined, 1_000); return; }
    catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw lastError instanceof Error ? lastError : new Error('Mosaic Guardian control endpoint did not start');
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
  try {
    await callGuardianControl<ServiceStatus>('status', undefined, 500);
  } catch {
    startService('mosaic-guardian', '@mosaic/guardian', [vault, '--network', network]);
    try {
      await waitForGuardianControl();
    } catch (error) {
      // Kill the half-started child so a retry is not wedged on "already running".
      children.get('mosaic-guardian')?.kill();
      throw error;
    }
  }
  await callGuardianControl('session.attach', args.session as unknown as Record<string, unknown>);
  await callGuardianControl('guardian.start', {
    vault,
    network,
    ...(args.signatureB64 ? { signatureB64: args.signatureB64 } : {}),
    ...(args.passphrase ? { passphrase: args.passphrase } : {}),
  }, 180_000);
  const status = await callGuardianControl<ServiceStatus>('status');
  publish(status);
  // One idle Supervisor service is shared by every agent for this Local
  // session. Enrollment remains deferred until the first explicit agent start.
  if (!children.has('agent-runner')) startService('agent-runner', '@mosaic/agent-runner', ['--network', network]);
  return status;
}

async function startAgent(args: { agentId?: string; vault?: string; network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<unknown> {
  const vault = args.agentId?.trim() || args.vault?.trim() || DEFAULT_RUNNER_VAULT;
  const network = args.network ?? 'testnet';
  const guardian = await callGuardianControl<ServiceStatus>('status');
  if (guardian.phase !== 'running') throw new Error('Unlock Mosaic Guardian before starting an agent');
  await callGuardianControl('agent.unlock', {
    agentId: vault, network,
    ...(args.signatureB64 ? { signatureB64: args.signatureB64 } : {}),
    ...(args.passphrase ? { passphrase: args.passphrase } : {}),
  }, 180_000);
  if (!children.has('agent-runner')) startService('agent-runner', '@mosaic/agent-runner', ['--network', network]);
  while (statuses.get('agent-runner')?.phase !== 'running') await new Promise((resolve) => setTimeout(resolve, 25));
  if (!supervisorEnrolled) {
    const approved = await callGuardianControl<{ pairingCredential: string }>('runner.approve', { runnerId: 'local-supervisor' });
    await supervisorRequest('supervisor.start', { pairingCredential: approved.pairingCredential });
    supervisorEnrolled = true;
  }
  try { return await supervisorRequest('agent.start', { agentId: vault }); }
  catch (error) {
    await callGuardianControl('agent.lock', { agentId: vault }).catch(() => {});
    throw error;
  }
}

async function stopAgent(agentId: string): Promise<void> { await supervisorRequest('agent.stop', { agentId }); }

async function stopService(name: ServiceName): Promise<void> {
  if (name === 'mosaic-guardian') {
    await callGuardianControl('shutdown').catch(() => {});
    publish({ name, phase: 'stopped' });
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
      }, 2_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.postMessage({ type: 'shutdown' });
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
ipcMain.handle('agent:list', () => supervisorRequest('agent.list'));
ipcMain.handle('agent:status', (_event, agentId: string) => supervisorRequest('agent.status', { agentId }));
ipcMain.handle('services:stop', (_event, name: ServiceName) => stopService(name));

app.whenReady().then(() => {
  const rendererUrl = process.env.MOSAIC_RENDERER_URL
    ? Promise.resolve(new URL('/agents', process.env.MOSAIC_RENDERER_URL).toString())
    : startRendererServer();
  void rendererUrl.then((url) => {
    createWindow(url);
    publish({ name: 'mosaic-guardian', phase: 'stopped', vault: DEFAULT_GUARDIAN_VAULT, network: 'testnet' });
    publish({ name: 'agent-runner', phase: 'stopped', vault: DEFAULT_RUNNER_VAULT, network: 'testnet' });
    setInterval(() => {
      void callGuardianControl<ServiceStatus>('status', undefined, 500).then(publish).catch(() => {
        if (!children.has('mosaic-guardian') && statuses.get('mosaic-guardian')?.phase !== 'stopped') {
          publish({ name: 'mosaic-guardian', phase: 'stopped', vault: DEFAULT_GUARDIAN_VAULT, network: 'testnet' });
        }
      });
    }, 1_000).unref();
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
