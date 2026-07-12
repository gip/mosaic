import { createRequire } from 'node:module';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron';
import type { ServiceName, ServiceStatus } from './status.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const statuses = new Map<ServiceName, ServiceStatus>();
const children = new Map<ServiceName, UtilityProcess>();
let window: BrowserWindow | null = null;
let rendererServer: Server | null = null;
let quitting = false;

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

function startService(name: ServiceName, packageName: string): void {
  publish({ name, phase: 'starting' });
  const child = utilityProcess.fork(serviceEntry(packageName), [], {
    serviceName: `Mosaic ${name}`,
    stdio: 'inherit',
  });
  children.set(name, child);

  child.on('spawn', () => publish({ name, phase: 'starting', pid: child.pid }));
  child.on('message', (message: unknown) => {
    if (isReadyMessage(message, name)) publish({ name, phase: 'running', pid: message.pid });
  });
  child.on('exit', (code) => {
    children.delete(name);
    const expected = quitting || statuses.get(name)?.phase === 'stopping';
    publish({
      name,
      phase: expected ? 'stopped' : 'failed',
      detail: `Exited with code ${code}`,
    });
  });
}

function isReadyMessage(message: unknown, name: ServiceName): message is { type: 'ready'; service: ServiceName; pid: number } {
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

app.whenReady().then(() => {
  const rendererUrl = process.env.MOSAIC_RENDERER_URL
    ? Promise.resolve(new URL('/agents', process.env.MOSAIC_RENDERER_URL).toString())
    : startRendererServer();
  void rendererUrl.then((url) => {
    createWindow(url);
    startService('signer-policy-manager', '@mosaic/local-signer');
    startService('agent-runner', '@mosaic/agent-runner');
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
