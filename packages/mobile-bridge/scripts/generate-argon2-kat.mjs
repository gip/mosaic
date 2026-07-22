import { argon2id } from 'hash-wasm';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Known-answer vectors for Argon2id, generated with the SAME library the web
 * client uses (hash-wasm). The iOS app derives keks with libsodium; its
 * XCTest asserts these exact outputs, making cross-library equivalence a hard
 * test instead of an assumption. `full` uses the frozen ARGON2_PARAMS_V1
 * (m=256 MiB); `reduced` cases keep CI fast.
 */

const V1 = { m: 262144, t: 3, p: 1 };
const REDUCED = { m: 8192, t: 2, p: 1 };

function saltBytes(seed) {
  // Deterministic 16-byte salts so regeneration is reproducible.
  return Uint8Array.from({ length: 16 }, (_, i) => (seed * 31 + i * 7) & 0xff);
}

async function kat(passphrase, salt, params) {
  const kek = await argon2id({
    password: passphrase,
    salt,
    iterations: params.t,
    memorySize: params.m,
    parallelism: params.p,
    hashLength: 32,
    outputType: 'binary',
  });
  return {
    passphrase,
    saltHex: Buffer.from(salt).toString('hex'),
    ...params,
    kekHex: Buffer.from(kek).toString('hex'),
  };
}

const cases = {
  reduced: [
    await kat('correct horse battery staple', saltBytes(1), REDUCED),
    await kat('a'.repeat(128), saltBytes(2), REDUCED),
    await kat('päss-phrasé \u{1F511}', saltBytes(3), REDUCED),
  ],
  full: [await kat('mosaic zone passphrase', saltBytes(4), V1)],
};

const outPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'vectors', 'argon2-kat.json');
await writeFile(outPath, `${JSON.stringify(cases, null, 2)}\n`);
console.log(`wrote ${outPath}`);
