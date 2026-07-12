#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startHttpServer } from './http.js';
import { createMosaicMcpServer } from './server.js';
import { createStderrLogger } from './logging.js';
import { openMosaicStore } from './store.js';
import { xamanServiceFromEnv } from './xaman.js';
import { envString } from './env.js';
import { parseTestnetServerKey } from './testnetVault.js';

const logger = createStderrLogger();

/**
 * MOSAIC_ENV_FILE, or the nearest `.env` walking up from cwd, stopping at
 * the workspace root so a stray ~/.env is never picked up.
 */
function findEnvFile(): string | undefined {
  const explicit = envString('MOSAIC_ENV_FILE');
  if (explicit) return resolve(explicit);
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function loadEnv(): void {
  const envFile = findEnvFile();
  if (envFile) {
    // Values already present in the process environment win over the file.
    process.loadEnvFile(envFile);
    logger.info(`env: loaded ${envFile}`);
  } else {
    logger.info('env: no .env file found, using process environment only');
  }
}

async function main(): Promise<void> {
  loadEnv();
  if (process.argv.includes('--http')) {
    const server = await startHttpServer({ logger });
    logger.info(`mosaic-mcp http listening at ${server.url}`);
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }
  const store = openMosaicStore(envString('MOSAIC_DATABASE_URL'));
  await store.init();
  const server = createMosaicMcpServer({
    store,
    xaman: xamanServiceFromEnv(),
    logger,
    testnetVaultKey: parseTestnetServerKey(envString('MOSAIC_TESTNET_VAULT_KEY')),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  logger.error(String(error));
  process.exit(1);
});
