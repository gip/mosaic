import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Bundle the bridge into one IIFE for JavaScriptCore. platform=browser keeps
 * node: imports out; the chain SDK signers (xrpl / stellar-sdk / viem) come
 * along, so the ceiling below is a tripwire against NEW accidental weight
 * (e.g. the zone-keys verify/ subpath), not a minimal-size target.
 */

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, 'dist', 'mosaic-bridge.js');

const MAX_BYTES = 6 * 1024 * 1024;

const result = await build({
  entryPoints: [path.join(root, 'dist', 'index.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile,
  define: {
    'process.env.NODE_ENV': '"production"',
    global: 'globalThis',
  },
  inject: [path.join(root, 'scripts', 'shims', 'node-globals.js')],
  logLevel: 'silent',
  metafile: true,
});
void result;

const bundled = await readFile(outfile, 'utf8');

if (bundled.length > MAX_BYTES) {
  throw new Error(`mosaic-bridge.js is ${bundled.length} bytes (> ${MAX_BYTES}); check for accidental imports`);
}
if (/require\(["']node:/.test(bundled)) {
  throw new Error('mosaic-bridge.js references node: builtins; it would not run in JSC');
}

const digest = createHash('sha256').update(bundled).digest('hex');
await writeFile(path.join(root, 'dist', 'mosaic-bridge.sha256'), `${digest}\n`);
console.log(`mosaic-bridge.js ${(bundled.length / 1024).toFixed(0)} KiB sha256=${digest.slice(0, 16)}…`);
