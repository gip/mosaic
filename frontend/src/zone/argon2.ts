import { ARGON2_PARAMS_V1 } from '@mosaic/zone-keys';

/** Derive the layer-2 kek in a worker. Rejects params other than V1. */
export function deriveKek(
  passphrase: string,
  salt: Uint8Array,
  params: { m: number; t: number; p: number } = ARGON2_PARAMS_V1,
): Promise<Uint8Array> {
  if (params.m !== ARGON2_PARAMS_V1.m || params.t !== ARGON2_PARAMS_V1.t || params.p !== ARGON2_PARAMS_V1.p) {
    return Promise.reject(new Error('unexpected Argon2id parameters'));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../workers/argon2.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ kek?: Uint8Array; error?: string }>) => {
      worker.terminate();
      if (event.data.kek) resolve(new Uint8Array(event.data.kek));
      else reject(new Error(event.data.error ?? 'argon2 worker failed'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'argon2 worker crashed'));
    };
    worker.postMessage({ passphrase, salt, ...params });
  });
}
