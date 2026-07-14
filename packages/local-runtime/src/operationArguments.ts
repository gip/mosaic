import {
  MAX_HOOK_ARGUMENT_BYTES,
  canonicalJson,
  type AgentResourceLimits,
  type AgentResourceDescriptor,
  type CapabilityAllowance,
  type CapabilityOperation,
} from './contracts.js';

export function validateOperationArguments(
  operation: CapabilityOperation,
  args: Record<string, unknown>,
  allowance: CapabilityAllowance,
  limits: AgentResourceLimits,
  resources: AgentResourceDescriptor[],
): void {
  if (operation !== allowance.operation) throw new Error('capability allowance operation mismatch');
  if (byteLength(canonicalJson(args)) > MAX_HOOK_ARGUMENT_BYTES) throw new Error('hook arguments are too large');
  switch (operation) {
    case 'state.get': {
      const key = stateKey(args.key);
      assertPrefix(key, allowanceFor(allowance, operation).constraints.keyPrefixes);
      assertOnlyKeys(args, ['key']);
      return;
    }
    case 'state.put': {
      const key = stateKey(args.key);
      const typed = allowanceFor(allowance, operation);
      assertPrefix(key, typed.constraints.keyPrefixes);
      assertJsonSize(args.value ?? null, typed.constraints.maxValueBytes, 'state value');
      assertOnlyKeys(args, ['key', 'value']);
      return;
    }
    case 'state.compareAndSet': {
      const key = stateKey(args.key);
      const expected = Number(args.expectedRevision);
      if (!Number.isSafeInteger(expected) || expected < 0) throw new Error('expectedRevision must be a non-negative integer');
      const typed = allowanceFor(allowance, operation);
      assertPrefix(key, typed.constraints.keyPrefixes);
      assertJsonSize(args.value ?? null, typed.constraints.maxValueBytes, 'state value');
      assertOnlyKeys(args, ['key', 'expectedRevision', 'value']);
      return;
    }
    case 'log.emit': {
      const entry = requireRecord(args.entry, 'log entry');
      assertJsonSize(entry, allowanceFor(allowance, operation).constraints.maxEntryBytes, 'log entry');
      assertOnlyKeys(args, ['entry']);
      return;
    }
    case 'clock.now':
      assertOnlyKeys(args, []);
      return;
    case 'random.bytes': {
      const length = Number(args.length);
      if (!Number.isSafeInteger(length) || length < 1 || length > allowanceFor(allowance, operation).constraints.maxBytes) {
        throw new Error('random byte length exceeds its allowance');
      }
      assertOnlyKeys(args, ['length']);
      return;
    }
    case 'xmtp.send': {
      const resourceId = stateKey(args.resourceId);
      const text = args.text;
      const typed = allowanceFor(allowance, operation);
      if (!typed.constraints.resourceSlots.includes(resourceId)) throw new Error(`XMTP resource is not permitted: ${resourceId}`);
      if (!resources.some((resource) => resource.kind === 'xmtp-contact' && resource.resourceId === resourceId)) throw new Error(`XMTP resource is not bound: ${resourceId}`);
      if (typeof text !== 'string' || byteLength(text) > typed.constraints.maxMessageBytes || byteLength(text) > (limits.maxEventBytes ?? 64 * 1024)) {
        throw new Error('XMTP text is invalid or too large');
      }
      assertOnlyKeys(args, ['resourceId', 'text']);
      return;
    }
    case 'xmtp.receive':
      assertOnlyKeys(args, []);
      return;
    default:
      throw new Error(`${operation} policy broker is not implemented`);
  }
}

type AllowanceFor<Operation extends CapabilityOperation> = Extract<CapabilityAllowance, { operation: Operation }>;

function allowanceFor<Operation extends CapabilityOperation>(
  allowance: CapabilityAllowance,
  operation: Operation,
): AllowanceFor<Operation> {
  if (allowance.operation !== operation) throw new Error('capability allowance operation mismatch');
  return allowance as AllowanceFor<Operation>;
}

function assertPrefix(key: string, prefixes: string[]): void {
  if (!prefixes.some((prefix) => key.startsWith(prefix))) throw new Error(`state key is outside its allowed prefixes: ${key}`);
}

function stateKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new Error('invalid state or resource key');
  return value;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  const permitted = new Set(allowed);
  if (Object.keys(value).some((key) => !permitted.has(key))) throw new Error('hook arguments contain unexpected fields');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertJsonSize(value: unknown, maximum: number, label: string): void {
  if (byteLength(canonicalJson(value)) > maximum) throw new Error(`${label} exceeds its allowance`);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
