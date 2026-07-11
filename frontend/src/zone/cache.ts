import { openDB, type IDBPDatabase } from 'idb';
import { verifyCommitment, type ZoneRef } from '@mosaic/zone-keys';

/**
 * IndexedDB session cache for the zone secret. The blob on the backend is the
 * source of truth — losing this cache is a non-event (one wallet signature
 * re-derives it). The secret is stored wrapped under a NON-EXTRACTABLE
 * WebCrypto AES-GCM key so a dump of IndexedDB alone is not enough; this is
 * hardening, not a custody boundary (it doesn't survive clear-site-data).
 */

interface CacheRecord {
  key: CryptoKey;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  commitment: string;
}

const DB_NAME = 'mosaic-zone-cache';
const STORE = 'secrets';
const DEVICE_KEYS = 'deviceKeys';

function dbPromise(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(DEVICE_KEYS)) db.createObjectStore(DEVICE_KEYS);
    },
  });
}

export async function cacheTestnetDeviceKey(ref: ZoneRef, rawKey: Uint8Array): Promise<void> {
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKey as BufferSource);
  const db = await dbPromise();
  await db.put(DEVICE_KEYS, { key: wrappingKey, iv, ciphertext }, cacheKey(ref));
}

export async function readTestnetDeviceKey(ref: ZoneRef): Promise<Uint8Array | undefined> {
  try {
    const db = await dbPromise();
    const record = await db.get(DEVICE_KEYS, cacheKey(ref)) as { key: CryptoKey; iv: Uint8Array; ciphertext: ArrayBuffer } | undefined;
    if (!record) return undefined;
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv as BufferSource }, record.key, record.ciphertext));
  } catch { return undefined; }
}

function cacheKey(ref: ZoneRef): string {
  return `${ref.rootChain}|${ref.rootAddress}|${ref.zone}|${ref.network}`;
}

export async function cacheZoneSecret(ref: ZoneRef, secret: Uint8Array, commitment: string): Promise<void> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, secret as BufferSource);
  const record: CacheRecord = { key, iv, ciphertext, commitment };
  const db = await dbPromise();
  await db.put(STORE, record, cacheKey(ref));
}

export async function readCachedZoneSecret(ref: ZoneRef, expectedCommitment: string): Promise<Uint8Array | undefined> {
  try {
    const db = await dbPromise();
    const record = (await db.get(STORE, cacheKey(ref))) as CacheRecord | undefined;
    if (!record || record.commitment !== expectedCommitment) return undefined;
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv as BufferSource }, record.key, record.ciphertext);
    const secret = new Uint8Array(plaintext);
    if (!verifyCommitment(secret, expectedCommitment)) return undefined;
    return secret;
  } catch {
    return undefined;
  }
}

export async function dropCachedZoneSecret(ref: ZoneRef): Promise<void> {
  try {
    const db = await dbPromise();
    await db.delete(STORE, cacheKey(ref));
  } catch {
    /* cache is best-effort */
  }
}

export async function clearZoneCache(): Promise<void> {
  try {
    const db = await dbPromise();
    await db.clear(STORE);
  } catch {
    /* cache is best-effort */
  }
}
