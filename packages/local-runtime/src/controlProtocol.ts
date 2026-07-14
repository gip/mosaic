import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AGENT_CONTROL_PROTOCOL,
  MAX_CONTROL_MESSAGE_BYTES,
  PAIRING_TTL_MS,
  assertActiveWindow,
  canonicalJson,
  type ControlEnvelope,
  type ControlMessageKind,
  type MosaicNetwork,
  type PairingOffer,
} from './contracts.js';
import { contractDigest } from './digest.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export interface RunnerDeviceIdentity {
  runnerId: string;
  publicKeyB64: string;
  privateKeyB64: string;
}

export interface ControlEnvelopeBindings {
  guardianId: string;
  guardianControlInboxId: string;
  runnerId: string;
  runnerDevicePublicKey: string;
  runnerControlInboxId: string;
}

export interface CreateControlEnvelope<T> extends ControlEnvelopeBindings {
  kind: ControlMessageKind;
  payload: T;
  sequence: number;
  expiresAt: string;
  requestId?: string;
  replyTo?: string;
  agentId?: string;
  grantId?: string;
  idempotencyKey?: string;
  issuedAt?: string;
}

export interface PersistedControlState {
  v: 1;
  nextOutboundSequences: Record<string, number>;
  lastInboundSequences: Record<string, number>;
  processedMessageIds: string[];
  idempotencyResults: Record<string, string>;
  pendingApprovals: Record<string, string>;
  terminationState: Record<string, string>;
  unsentCheckpoints: Record<string, string>;
}

const EMPTY_STATE = (): PersistedControlState => ({
  v: 1,
  nextOutboundSequences: {},
  lastInboundSequences: {},
  processedMessageIds: [],
  idempotencyResults: {},
  pendingApprovals: {},
  terminationState: {},
  unsentCheckpoints: {},
});

export function unsignedControlEnvelope<T>(envelope: ControlEnvelope<T>): Omit<ControlEnvelope<T>, 'signatureB64'> {
  const { signatureB64: _signature, ...unsigned } = envelope;
  return unsigned;
}

export function controlEnvelopeSignatureText<T>(envelope: ControlEnvelope<T>): string {
  return `${AGENT_CONTROL_PROTOCOL}:${envelope.kind}\n${canonicalJson(unsignedControlEnvelope(envelope))}`;
}

export function pairingOfferSignatureText(offer: PairingOffer): string {
  const { signatureB64: _signature, ...unsigned } = offer;
  return `${AGENT_CONTROL_PROTOCOL}:pairing-offer\n${canonicalJson(unsigned)}`;
}

export function createControlEnvelope<T>(
  input: CreateControlEnvelope<T>,
  signer: (text: string) => Uint8Array,
): ControlEnvelope<T> {
  const payloadDigest = contractDigest(input.payload);
  const envelope: ControlEnvelope<T> = {
    protocol: AGENT_CONTROL_PROTOCOL,
    kind: input.kind,
    requestId: input.requestId ?? randomUUID(),
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    guardianId: input.guardianId,
    guardianControlInboxId: input.guardianControlInboxId,
    runnerId: input.runnerId,
    runnerDevicePublicKey: input.runnerDevicePublicKey,
    runnerControlInboxId: input.runnerControlInboxId,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.grantId ? { grantId: input.grantId } : {}),
    sequence: input.sequence,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    expiresAt: input.expiresAt,
    idempotencyKey: input.idempotencyKey ?? input.requestId ?? randomUUID(),
    payloadDigest,
    payload: input.payload,
    signatureB64: '',
  };
  envelope.signatureB64 = Buffer.from(signer(controlEnvelopeSignatureText(envelope))).toString('base64');
  assertControlEnvelope(envelope);
  return envelope;
}

export function assertControlEnvelope<T>(envelope: ControlEnvelope<T>, now = Date.now()): void {
  if (!envelope || envelope.protocol !== AGENT_CONTROL_PROTOCOL) throw new Error('unsupported control protocol');
  if (!CONTROL_KINDS.has(envelope.kind)) throw new Error('unsupported control message kind');
  const allowed = new Set([
    'protocol', 'kind', 'requestId', 'replyTo', 'guardianId', 'guardianControlInboxId', 'runnerId',
    'runnerDevicePublicKey', 'runnerControlInboxId', 'agentId', 'grantId', 'sequence', 'issuedAt',
    'expiresAt', 'idempotencyKey', 'payloadDigest', 'payload', 'signatureB64',
  ]);
  const unknown = Object.keys(envelope).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`control envelope contains unknown field: ${unknown}`);
  for (const [label, value] of [
    ['requestId', envelope.requestId], ['guardianId', envelope.guardianId],
    ['guardianControlInboxId', envelope.guardianControlInboxId], ['runnerId', envelope.runnerId],
    ['runnerDevicePublicKey', envelope.runnerDevicePublicKey], ['runnerControlInboxId', envelope.runnerControlInboxId],
    ['idempotencyKey', envelope.idempotencyKey], ['signatureB64', envelope.signatureB64],
  ] as const) if (typeof value !== 'string' || value.length < 1 || value.length > 2048) throw new Error(`invalid ${label}`);
  if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1) throw new Error('invalid control sequence');
  assertActiveWindow(envelope.issuedAt, envelope.expiresAt, now);
  if (envelope.payloadDigest !== contractDigest(envelope.payload)) throw new Error('control payload digest mismatch');
  if (Buffer.byteLength(canonicalJson(envelope), 'utf8') > MAX_CONTROL_MESSAGE_BYTES) throw new Error('control message exceeds maximum size');
  const enrollmentResult = envelope.kind === 'privileged-result' && (envelope.payload as { operation?: unknown } | null)?.operation === 'runner.enroll';
  const requiresAgent = envelope.kind !== 'runner-enrollment' && envelope.kind !== 'control-error' && !enrollmentResult;
  const requiresGrant = !enrollmentResult && ['privileged-request', 'privileged-result', 'agent-termination-command', 'agent-termination-result', 'runtime-audit-checkpoint'].includes(envelope.kind);
  if (requiresAgent && !envelope.agentId) throw new Error('control message requires an agent binding');
  if (requiresGrant && !envelope.grantId) throw new Error('control message requires a grant binding');
  if (envelope.kind === 'runner-enrollment' && (envelope.agentId !== undefined || envelope.grantId !== undefined)) throw new Error('Runner enrollment cannot bind an agent');
}

export function assertControlBindings<T>(envelope: ControlEnvelope<T>, expected: ControlEnvelopeBindings): void {
  if (
    envelope.guardianId !== expected.guardianId ||
    envelope.guardianControlInboxId !== expected.guardianControlInboxId ||
    envelope.runnerId !== expected.runnerId ||
    envelope.runnerDevicePublicKey !== expected.runnerDevicePublicKey ||
    envelope.runnerControlInboxId !== expected.runnerControlInboxId
  ) throw new Error('control identity binding mismatch');
}

export function signRunnerText(privateKeyB64: string, text: string): Uint8Array {
  const key = createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return signBytes(null, Buffer.from(text, 'utf8'), key);
}

export function verifyRunnerEnvelope<T>(envelope: ControlEnvelope<T>, expectedPublicKeyB64: string): void {
  assertControlEnvelope(envelope);
  if (envelope.runnerDevicePublicKey !== expectedPublicKeyB64) throw new Error('Runner envelope public key mismatch');
  const key = createPublicKey({ key: Buffer.from(expectedPublicKeyB64, 'base64'), format: 'der', type: 'spki' });
  if (!verifyBytes(null, Buffer.from(controlEnvelopeSignatureText(envelope), 'utf8'), key, Buffer.from(envelope.signatureB64, 'base64'))) {
    throw new Error('invalid Runner control signature');
  }
}

export function verifyGuardianControlEnvelope<T>(envelope: ControlEnvelope<T>, expectedAddress: string): void {
  assertControlEnvelope(envelope);
  const signature = new Uint8Array(Buffer.from(envelope.signatureB64, 'base64'));
  if (signature.length !== 65 || (signature[64] !== 27 && signature[64] !== 28)) throw new Error('invalid Guardian control signature');
  const bytes = utf8ToBytes(controlEnvelopeSignatureText(envelope));
  const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${bytes.length}`), bytes));
  const recovered = new Uint8Array([signature[64]! - 27, ...signature.slice(0, 64)]);
  const recoveredKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
  const publicKey = secp256k1.Point.fromBytes(recoveredKey).toBytes(false);
  const address = `0x${Buffer.from(keccak_256(publicKey.slice(1)).slice(-20)).toString('hex')}`;
  if (address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('Guardian control signer mismatch');
}

export function verifyPairingOffer(offer: PairingOffer, now = Date.now()): void {
  if (offer.protocol !== AGENT_CONTROL_PROTOCOL || offer.kind !== 'pairing-offer') throw new Error('invalid pairing offer protocol');
  const expected = ['protocol', 'kind', 'runnerId', 'runnerDevicePublicKey', 'runnerControlAddress', 'runnerControlInboxId', 'network', 'nonce', 'issuedAt', 'expiresAt', 'signatureB64'];
  const unknown = Object.keys(offer).find((key) => !expected.includes(key));
  if (unknown || Object.keys(offer).length !== expected.length) throw new Error('pairing offer fields are invalid');
  if (Buffer.byteLength(canonicalJson(offer), 'utf8') > MAX_CONTROL_MESSAGE_BYTES) throw new Error('pairing offer exceeds maximum size');
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(offer.runnerId) || !offer.runnerControlAddress || !offer.runnerControlInboxId) throw new Error('pairing offer identity is invalid');
  if (!/^[0-9a-f]{64}$/.test(offer.nonce) || (offer.network !== 'testnet' && offer.network !== 'mainnet')) throw new Error('pairing offer scope is invalid');
  assertActiveWindow(offer.issuedAt, offer.expiresAt, now);
  if (Date.parse(offer.expiresAt) - Date.parse(offer.issuedAt) > PAIRING_TTL_MS) throw new Error('pairing offer lifetime is too long');
  const key = createPublicKey({ key: Buffer.from(offer.runnerDevicePublicKey, 'base64'), format: 'der', type: 'spki' });
  if (!verifyBytes(null, Buffer.from(pairingOfferSignatureText(offer), 'utf8'), key, Buffer.from(offer.signatureB64, 'base64'))) {
    throw new Error('invalid pairing offer signature');
  }
}

export async function loadOrCreateRunnerDeviceIdentity(directory: string, runnerId: string): Promise<RunnerDeviceIdentity> {
  await secureDirectory(directory);
  const path = join(directory, 'runner-device.json');
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as RunnerDeviceIdentity;
    if (value.runnerId !== runnerId || !value.publicKeyB64 || !value.privateKeyB64) throw new Error('invalid Runner identity file');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const pair = generateKeyPairSync('ed25519');
  const value: RunnerDeviceIdentity = {
    runnerId,
    publicKeyB64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKeyB64: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
  await writeFile(path, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return value;
}

export function createPairingOffer(params: {
  identity: RunnerDeviceIdentity;
  runnerControlAddress: string;
  runnerControlInboxId: string;
  network: MosaicNetwork;
  now?: number;
}): PairingOffer {
  const issued = params.now ?? Date.now();
  const offer: PairingOffer = {
    protocol: AGENT_CONTROL_PROTOCOL,
    kind: 'pairing-offer',
    runnerId: params.identity.runnerId,
    runnerDevicePublicKey: params.identity.publicKeyB64,
    runnerControlAddress: params.runnerControlAddress,
    runnerControlInboxId: params.runnerControlInboxId,
    network: params.network,
    nonce: randomBytes(32).toString('hex'),
    issuedAt: new Date(issued).toISOString(),
    expiresAt: new Date(issued + PAIRING_TTL_MS).toISOString(),
    signatureB64: '',
  };
  offer.signatureB64 = Buffer.from(signRunnerText(params.identity.privateKeyB64, pairingOfferSignatureText(offer))).toString('base64');
  return offer;
}

export class ControlStateStore {
  private state: PersistedControlState = EMPTY_STATE();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    await secureDirectory(dirname(this.path));
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as PersistedControlState;
      if (parsed.v !== 1) throw new Error('unsupported control state');
      this.state = { ...EMPTY_STATE(), ...parsed, unsentCheckpoints: parsed.unsentCheckpoints ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  nextSequence(scope: string): number {
    const value = this.state.nextOutboundSequences[scope] ?? 1;
    this.state.nextOutboundSequences[scope] = value + 1;
    void this.persist();
    return value;
  }

  acceptInbound(scope: string, sequence: number): void {
    const expected = (this.state.lastInboundSequences[scope] ?? 0) + 1;
    if (sequence !== expected) throw new Error(`control sequence mismatch: expected ${expected}`);
    this.state.lastInboundSequences[scope] = sequence;
    void this.persist();
  }

  hasMessage(messageId: string): boolean { return this.state.processedMessageIds.includes(messageId); }

  markMessage(messageId: string): void {
    if (!this.state.processedMessageIds.includes(messageId)) this.state.processedMessageIds.push(messageId);
    if (this.state.processedMessageIds.length > 4096) this.state.processedMessageIds.splice(0, this.state.processedMessageIds.length - 4096);
    void this.persist();
  }

  idempotencyResult(key: string): string | undefined { return this.state.idempotencyResults[key]; }
  setIdempotencyResult(key: string, value: string): void { this.state.idempotencyResults[key] = value; void this.persist(); }
  setPendingApproval(id: string, value?: string): void {
    if (value === undefined) delete this.state.pendingApprovals[id]; else this.state.pendingApprovals[id] = value;
    void this.persist();
  }
  pendingApprovals(): Record<string, string> { return { ...this.state.pendingApprovals }; }
  setTerminationState(key: string, value: string): void { this.state.terminationState[key] = value; void this.persist(); }
  terminationState(key: string): string | undefined { return this.state.terminationState[key]; }
  setUnsentCheckpoint(id: string, value?: string): void {
    if (value === undefined) delete this.state.unsentCheckpoints[id]; else this.state.unsentCheckpoints[id] = value;
    void this.persist();
  }
  unsentCheckpoints(): Record<string, string> { return { ...this.state.unsentCheckpoints }; }

  async flush(): Promise<void> { await this.persist(); await this.writeQueue; }

  private persist(): Promise<void> {
    const snapshot = canonicalJson(this.state);
    const pending = this.writeQueue.then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.writeQueue = pending.catch(() => {});
    return pending;
  }
}

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(path, 0o700);
}

const CONTROL_KINDS = new Set<ControlMessageKind>([
  'runner-enrollment', 'agent-start-request', 'agent-start-result', 'privileged-request', 'privileged-result',
  'agent-termination-command', 'agent-termination-result', 'runtime-audit-checkpoint', 'control-error',
]);
