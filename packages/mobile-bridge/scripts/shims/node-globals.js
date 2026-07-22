// esbuild `inject` file: free references to Buffer/process in bundled deps
// (stellar-sdk and friends) resolve to these instead of missing JSC globals.
export { Buffer } from 'buffer';

export const process = {
  env: {},
  browser: true,
  version: 'v18.0.0',
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
};
