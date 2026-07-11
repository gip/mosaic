/// <reference types="vite/client" />

import type { ServiceStatus } from '@mosaic/local-runtime';

declare global {
  /** Names of the env files Vite loaded at build time (see vite.config.ts). */
  const __MOSAIC_ENV_FILES__: string[];

  interface Window {
    mosaicLocal?: {
      listServices(): Promise<ServiceStatus[]>;
      onStatus(listener: (statuses: ServiceStatus[]) => void): () => void;
    };
  }
}
