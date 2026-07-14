import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_* vars live in the repo-root .env, shared with @mosaic/mcp (see .env.example).
const envDir = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  const envFiles = ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`].filter((name) =>
    existsSync(join(envDir, name)),
  );
  console.info(
    envFiles.length
      ? `[mosaic] env files loaded from ${envDir}: ${envFiles.join(', ')}`
      : `[mosaic] no env files found in ${envDir}`,
  );
  return {
    envDir,
    define: {
      __MOSAIC_ENV_FILES__: JSON.stringify(envFiles),
    },
    plugins: [react()],
    server: {
      // HTTPS tunnel for Freighter mobile testing: its origin check rejects
      // http/localhost dapps, so the page must be served from a real https
      // hostname (e.g. `zrok share public localhost:5173`).
      allowedHosts: ['.shares.zrok.io'],
    },
    build: {
      rolldownOptions: {
        // ox (a viem dependency) carries misplaced /*#__PURE__*/ annotations;
        // that's upstream noise we can't fix. Keep the check for our own code.
        onLog(level, log, defaultHandler) {
          if (log.code === 'INVALID_ANNOTATION' && (log.id ?? '').includes('node_modules')) return;
          defaultHandler(level, log);
        },
      },
    },
  };
});
