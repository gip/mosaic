import { randomUUID } from 'node:crypto';
import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSDeferredPromise, type QuickJSContext } from 'quickjs-emscripten';
import type { AgentResourceLimits } from '@mosaic/local-runtime';

interface StartMessage {
  type: 'start';
  source: string;
  limits: AgentResourceLimits;
  allowedOperations: string[];
}

interface HookResultMessage {
  type: 'hook-result';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface PendingHook {
  promise: QuickJSDeferredPromise;
  vm: QuickJSContext;
}

const pending = new Map<string, PendingHook>();

process.on('message', (message: unknown) => {
  if (!isRecord(message)) return;
  if (message.type === 'start') void run(message as unknown as StartMessage);
  if (message.type === 'hook-result') settleHook(message as unknown as HookResultMessage);
});

async function run(message: StartMessage): Promise<void> {
  try {
    if (typeof message.source !== 'string' || message.source.length > 2 * 1024 * 1024) throw new Error('agent source is invalid or too large');
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(message.limits.memoryBytes);
    runtime.setMaxStackSize(message.limits.stackBytes);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + message.limits.wallTimeMs));
    const vm = runtime.newContext();
    try {
      installHookBridge(vm, new Set(message.allowedOperations), message.limits.maxPendingJobs);
      const bootstrap = vm.evalCode(BOOTSTRAP, 'mosaic-bootstrap.js');
      vm.unwrapResult(bootstrap).dispose();
      const evaluation = vm.evalCode(`(async () => {\n${message.source}\n})()`, 'agent.mjs');
      const promiseHandle = vm.unwrapResult(evaluation);
      const settled = await vm.resolvePromise(promiseHandle);
      promiseHandle.dispose();
      vm.unwrapResult(settled).dispose();
      sendTerminal({ type: 'complete' }, 0);
    } finally {
      for (const hook of pending.values()) hook.promise.dispose();
      pending.clear();
      vm.dispose();
      runtime.dispose();
    }
  } catch (error) {
    sendTerminal({ type: 'failed', error: error instanceof Error ? error.message : String(error) }, 1);
  }
}

function installHookBridge(vm: QuickJSContext, allowed: Set<string>, maxPendingJobs: number): void {
  const hook = vm.newFunction('__mosaicHook', (operationHandle, argumentsHandle) => {
    const operation = vm.getString(operationHandle);
    if (!allowed.has(operation)) throw new Error(`hook ${operation} is not granted`);
    if (pending.size >= maxPendingJobs) throw new Error('agent pending-hook limit exceeded');
    const raw = vm.getString(argumentsHandle);
    if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('hook arguments are too large');
    const args = JSON.parse(raw) as unknown;
    if (!isRecord(args)) throw new Error('hook arguments must be an object');
    const id = randomUUID();
    const promise = vm.newPromise();
    pending.set(id, { promise, vm });
    promise.settled.then(() => vm.runtime.executePendingJobs(maxPendingJobs));
    process.send?.({ type: 'hook', id, operation, arguments: args });
    return promise.handle;
  });
  vm.setProp(vm.global, '__mosaicHook', hook);
  hook.dispose();
}

function settleHook(message: HookResultMessage): void {
  const hook = pending.get(message.id);
  if (!hook) return;
  pending.delete(message.id);
  if (message.ok) {
    const value = hook.vm.newString(JSON.stringify(message.value ?? null));
    hook.promise.resolve(value);
    value.dispose();
  } else {
    const error = hook.vm.newError(message.error ?? 'hook failed');
    hook.promise.reject(error);
    error.dispose();
  }
  hook.promise.dispose();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendTerminal(message: Record<string, unknown>, exitCode: number): void {
  process.exitCode = exitCode;
  if (process.send) process.send(message, () => process.disconnect());
}

const BOOTSTRAP = `
(() => {
  'use strict';
  const call = async (operation, args = {}) => JSON.parse(await __mosaicHook(operation, JSON.stringify(args)));
  const api = {
    log: Object.freeze({ emit: (entry) => call('log.emit', { entry }) }),
    clock: Object.freeze({ now: () => call('clock.now') }),
    random: Object.freeze({ bytes: (length) => call('random.bytes', { length }) }),
    state: Object.freeze({
      get: (key) => call('state.get', { key }),
      put: (key, value) => call('state.put', { key, value }),
      compareAndSet: (key, expectedRevision, value) => call('state.compareAndSet', { key, expectedRevision, value }),
    }),
  };
  Object.defineProperty(globalThis, 'mosaic', { value: Object.freeze(api), writable: false, configurable: false });
  Object.defineProperty(globalThis, '__mosaicHook', { value: __mosaicHook, writable: false, configurable: false });
})();
`;
