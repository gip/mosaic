import process from 'node:process';

export type ServiceName = 'signer-policy-manager' | 'agent-runner';
export type ServicePhase = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

export interface ServiceStatus {
  name: ServiceName;
  phase: ServicePhase;
  pid?: number;
  detail?: string;
}

export type ServiceMessage =
  | { type: 'ready'; service: ServiceName; pid: number }
  | { type: 'stopping'; service: ServiceName };

type ParentPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

/**
 * Keep a local utility process alive and expose the same lifecycle contract
 * over Electron parentPort and Node child-process IPC.
 */
export function runLocalService(service: ServiceName): void {
  const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
  let stopping = false;

  function send(message: ServiceMessage): void {
    if (parentPort) parentPort.postMessage(message);
    else if (process.send) process.send(message);
  }

  const keepAlive = setInterval(() => undefined, 60_000);

  function stop(): void {
    if (stopping) return;
    stopping = true;
    send({ type: 'stopping', service });
    clearInterval(keepAlive);
    process.exit(0);
  }

  parentPort?.on('message', ({ data }) => {
    if (isShutdown(data)) stop();
  });
  process.on('message', (message) => {
    if (isShutdown(message)) stop();
  });
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  send({ type: 'ready', service, pid: process.pid });
}

function isShutdown(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message && message.type === 'shutdown';
}
