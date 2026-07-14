import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { canonicalJson, type AgentKeyLeasePayload, type SealedAgentKeyLease } from './contracts.js';

export interface KeyLeaseRecipient {
  publicKeyB64: string;
  privateKey: Uint8Array;
}

export function generateKeyLeaseRecipient(): KeyLeaseRecipient {
  const pair = generateKeyPairSync('x25519');
  return {
    publicKeyB64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey: new Uint8Array(pair.privateKey.export({ format: 'der', type: 'pkcs8' })),
  };
}

function aad(envelope: Pick<SealedAgentKeyLease, 'protocol' | 'agentId' | 'grantId' | 'runnerId' | 'certificateDigest' | 'network' | 'expiresAt'>): Buffer {
  return Buffer.from(canonicalJson({
    protocol: envelope.protocol,
    agentId: envelope.agentId,
    grantId: envelope.grantId,
    runnerId: envelope.runnerId,
    certificateDigest: envelope.certificateDigest,
    network: envelope.network,
    expiresAt: envelope.expiresAt,
  }));
}

export function sealAgentKeyLease(
  payload: AgentKeyLeasePayload,
  recipientPublicKeyB64: string,
  deterministic?: { ephemeralPrivateKey: Uint8Array; nonce: Uint8Array },
): SealedAgentKeyLease {
  const ephemeral = deterministic
    ? (() => {
        const privateKey = createPrivateKey({ key: Buffer.from(deterministic.ephemeralPrivateKey), format: 'der', type: 'pkcs8' });
        return { privateKey, publicKey: createPublicKey(privateKey) };
      })()
    : generateKeyPairSync('x25519');
  const recipient = createPublicKey({ key: Buffer.from(recipientPublicKeyB64, 'base64'), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(payload.grantId), Buffer.from('MOSAIC_AGENT_KEY_LEASE_V1'), 32));
  const nonce = deterministic ? Buffer.from(deterministic.nonce) : randomBytes(12);
  if (nonce.byteLength !== 12) throw new Error('agent key lease nonce must be 12 bytes');
  const header = {
    protocol: payload.protocol,
    alg: 'x25519-hkdf-sha256-chacha20poly1305' as const,
    ephemeralPublicKeyB64: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    nonceB64: nonce.toString('base64'),
    ciphertextB64: '',
    tagB64: '',
    agentId: payload.agentId,
    grantId: payload.grantId,
    runnerId: payload.runnerId,
    certificateDigest: payload.certificateDigest,
    network: payload.network,
    expiresAt: payload.expiresAt,
  };
  let plaintext: Buffer | undefined;
  try {
    plaintext = Buffer.from(canonicalJson(payload));
    const cipher = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(header), { plaintextLength: plaintext.length });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { ...header, ciphertextB64: ciphertext.toString('base64'), tagB64: cipher.getAuthTag().toString('base64') };
  } finally { plaintext?.fill(0); shared.fill(0); key.fill(0); }
}

export function openAgentKeyLease(envelope: SealedAgentKeyLease, recipientPrivateKey: Uint8Array, now = Date.now()): AgentKeyLeasePayload {
  if (Date.parse(envelope.expiresAt) <= now) throw new Error('agent key lease is expired');
  const privateKey = createPrivateKey({ key: Buffer.from(recipientPrivateKey), format: 'der', type: 'pkcs8' });
  const ephemeral = createPublicKey({ key: Buffer.from(envelope.ephemeralPublicKeyB64, 'base64'), format: 'der', type: 'spki' });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.from(envelope.grantId), Buffer.from('MOSAIC_AGENT_KEY_LEASE_V1'), 32));
  let plaintext: Buffer | undefined;
  try {
    const ciphertext = Buffer.from(envelope.ciphertextB64, 'base64');
    const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(envelope.nonceB64, 'base64'), { authTagLength: 16 });
    decipher.setAAD(aad(envelope), { plaintextLength: ciphertext.length });
    decipher.setAuthTag(Buffer.from(envelope.tagB64, 'base64'));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8')) as AgentKeyLeasePayload;
    if (
      payload.protocol !== envelope.protocol || payload.agentId !== envelope.agentId || payload.grantId !== envelope.grantId ||
      payload.runnerId !== envelope.runnerId || payload.certificateDigest !== envelope.certificateDigest ||
      payload.network !== envelope.network || payload.expiresAt !== envelope.expiresAt
    ) throw new Error('agent key lease binding mismatch');
    return payload;
  } finally { plaintext?.fill(0); shared.fill(0); key.fill(0); }
}
