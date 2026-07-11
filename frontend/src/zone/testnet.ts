import { canonicalJson, deriveAgentAddresses, verifyCommitment, zoneRootCommitmentHex, type ZoneRef } from '@mosaic/zone-keys';
import { api, type ZoneAddressItem } from '../api';
import { browserHostId } from './ceremony';
import { cacheTestnetDeviceKey, cacheZoneSecret, readTestnetDeviceKey } from './cache';
import type { DerivedVaultAddress } from './unlock';

interface DeviceHeader { v: 1; alg: 'aes-256-gcm-device-v1'; ivB64: string }
interface PairingPayload { v: 1; ref: ZoneRef; commitment: string; keyB64: string }

function b64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}
function unb64(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function aad(ref: ZoneRef, commitment: string): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ ...ref, commitment, v: 1 }));
}
function derive(secret: Uint8Array, ref: ZoneRef, entries: ZoneAddressItem[]): DerivedVaultAddress[] {
  const byIndex = new Map<number, ReturnType<typeof deriveAgentAddresses>>();
  return entries.map((entry) => {
    let addresses = byIndex.get(entry.index);
    if (!addresses) { addresses = deriveAgentAddresses(secret, ref, entry.index); byIndex.set(entry.index, addresses); }
    return { ...entry, address: addresses[entry.chain] };
  });
}

export async function createTestnetVault(token: string, ref: ZoneRef): Promise<void> {
  if (ref.network !== 'testnet') throw new Error('device-key vault creation is Testnet-only');
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const deviceKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const commitment = zoneRootCommitmentHex(secret);
    const key = await crypto.subtle.importKey('raw', deviceKey as BufferSource, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad(ref, commitment) as BufferSource }, key, secret as BufferSource));
    await api.zoneCreateTestnet({
      token, zone: ref.zone, localSignerPublicKey: browserHostId(), zoneRootCommitment: commitment,
      ciphertextB64: b64(ciphertext), header: { v: 1, alg: 'aes-256-gcm-device-v1', ivB64: b64(iv) },
    });
    await cacheTestnetDeviceKey(ref, deviceKey);
    await cacheZoneSecret(ref, secret, commitment);
  } finally { secret.fill(0); deviceKey.fill(0); }
}

export async function unlockTestnetVault(token: string, ref: ZoneRef, commitment: string, entries: ZoneAddressItem[]): Promise<DerivedVaultAddress[]> {
  const deviceKey = await readTestnetDeviceKey(ref);
  if (!deviceKey) throw new Error('Pair this device with an already unlocked copy of the vault.');
  try {
    const blob = await api.blobGet(token, ref.zone, 'device');
    const header = blob.header as unknown as DeviceHeader;
    if (header.v !== 1 || header.alg !== 'aes-256-gcm-device-v1') throw new Error('Unsupported Testnet device blob');
    const key = await crypto.subtle.importKey('raw', deviceKey as BufferSource, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(header.ivB64) as BufferSource, additionalData: aad(ref, commitment) as BufferSource }, key, unb64(blob.ciphertextB64) as BufferSource);
    const secret = new Uint8Array(plaintext);
    try {
      if (!verifyCommitment(secret, commitment)) throw new Error('Testnet vault commitment mismatch');
      await cacheZoneSecret(ref, secret, commitment);
      return derive(secret, ref, entries);
    } finally { secret.fill(0); }
  } finally { deviceKey.fill(0); }
}

export async function exportTestnetPairingCode(ref: ZoneRef, commitment: string): Promise<string> {
  const key = await readTestnetDeviceKey(ref);
  if (!key) throw new Error('This device does not hold the pairing key.');
  try {
    const payload: PairingPayload = { v: 1, ref, commitment, keyB64: b64(key) };
    return btoa(JSON.stringify(payload)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  } finally { key.fill(0); }
}

export async function importTestnetPairingCode(ref: ZoneRef, commitment: string, code: string): Promise<void> {
  const normalized = code.trim().replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const payload = JSON.parse(atob(padded)) as PairingPayload;
  if (payload.v !== 1 || canonicalJson(payload.ref) !== canonicalJson(ref) || payload.commitment !== commitment) {
    throw new Error('Pairing code belongs to a different vault, wallet, or network.');
  }
  const key = unb64(payload.keyB64);
  try {
    if (key.length !== 32) throw new Error('Invalid pairing key');
    await cacheTestnetDeviceKey(ref, key);
  } finally { key.fill(0); }
}
