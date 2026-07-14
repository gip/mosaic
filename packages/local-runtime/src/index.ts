import process from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MosaicNetwork, ServiceMessage, ServiceName } from './contracts.js';

export * from './contracts.js';
export * from './capabilityCatalog.js';
export * from './digest.js';
export * from './keyLease.js';
export * from './operationArguments.js';
export * from './controlProtocol.js';

export function mosaicRuntimeDirectory(): string {
  return process.env.MOSAIC_RUNTIME_DIR || join(homedir(), '.mosaic', 'run');
}

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

/**
 * Keep a local utility process alive and expose the same lifecycle contract
 * over Electron parentPort and Node child-process IPC.
 */
export function runLocalService(
  service: ServiceName,
  details: { vault?: string; network?: MosaicNetwork } = {},
  beforeStop?: () => Promise<void> | void,
): void {
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
  let stopping = false;

  function send(message: ServiceMessage): void {
    if (parentPort) parentPort.postMessage(message);
    else if (process.send) process.send(message);
  }

  const keepAlive = setInterval(() => undefined, 60_000);

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    send({ type: 'stopping', service });
    clearInterval(keepAlive);
    try { await beforeStop?.(); } catch { /* shutdown remains fail-closed */ }
    process.exit(0);
  }

  parentPort?.on('message', ({ data }) => {
    if (isShutdown(data)) void stop();
  });
  process.on('message', (message) => {
    if (isShutdown(message)) void stop();
  });
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  send({ type: 'ready', service, pid: process.pid, ...details });
}

function isShutdown(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'shutdown';
}

export interface LocalMcpSession {
  token: string;
  chain: 'evm' | 'xrpl' | 'stellar';
  address: string;
  network: MosaicNetwork;
  expiresAt: number;
}
