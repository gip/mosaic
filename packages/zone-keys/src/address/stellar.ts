import { concatBytes } from '@noble/hashes/utils.js';
import { base32nopad } from '@scure/base';

/**
 * Stellar strkey (SEP-23) encoding of an ed25519 public key:
 * base32(versionByte ‖ key ‖ CRC16-XModem little-endian), version 6<<3 → 'G'.
 */
export function stellarAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('stellar: expected 32-byte ed25519 public key');
  const payload = concatBytes(new Uint8Array([6 << 3]), publicKey);
  const crc = crc16xmodem(payload);
  const checksum = new Uint8Array([crc & 0xff, (crc >> 8) & 0xff]);
  return base32nopad.encode(concatBytes(payload, checksum));
}

/** Decode a G... strkey back to the 32-byte ed25519 public key. */
export function stellarPublicKeyFromAddress(address: string): Uint8Array {
  const data = base32nopad.decode(address);
  if (data.length !== 35 || data[0] !== 6 << 3) throw new Error('stellar: not an ed25519 public strkey');
  const payload = data.slice(0, 33);
  const crc = crc16xmodem(payload);
  if (data[33] !== (crc & 0xff) || data[34] !== ((crc >> 8) & 0xff)) {
    throw new Error('stellar: strkey checksum mismatch');
  }
  return payload.slice(1);
}

function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
