import { argon2id } from 'hash-wasm';

/**
 * Argon2id in a worker: m=256 MiB keeps the main thread saturated for seconds
 * if run inline. Params arrive with the request and were asserted against
 * ARGON2_PARAMS_V1 by the caller.
 */

export interface Argon2Request {
  passphrase: string;
  salt: Uint8Array;
  m: number; // KiB
  t: number;
  p: number;
}

self.onmessage = async (event: MessageEvent<Argon2Request>) => {
  const { passphrase, salt, m, t, p } = event.data;
  try {
    const kek = await argon2id({
      password: passphrase,
      salt,
      memorySize: m,
      iterations: t,
      parallelism: p,
      hashLength: 32,
      outputType: 'binary',
    });
    (self as unknown as Worker).postMessage({ kek }, [kek.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ error: String(error) });
  }
};
