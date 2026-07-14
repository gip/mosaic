/// <reference types="vite/client" />

import type { LocalMcpSession } from '@mosaic/local-runtime';
import type {
  AgentArtifactPackage,
  AgentInstallationPolicy,
  AgentResourceLimits,
  CapabilityAllowance,
  MosaicNetwork,
  ServiceName,
  ServiceStatus,
  XmtpResourceDescriptor,
} from '@mosaic/local-runtime/contracts';

declare global {
  /** Names of the env files Vite loaded at build time (see vite.config.ts). */
  const __MOSAIC_ENV_FILES__: string[];

  interface Window {
    mosaicLocal?: {
      listServices(): Promise<ServiceStatus[]>;
      startGuardian(args: { vault?: string; network?: MosaicNetwork; session: LocalMcpSession; signatureB64?: string; passphrase?: string }): Promise<ServiceStatus>;
      startAgent(args: { agentId?: string; vault?: string; network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<unknown>;
      startSupervisor(args?: { network?: MosaicNetwork }): Promise<void>;
      agentStart(args: { agentId: string; network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<unknown>;
      agentStop(agentId: string): Promise<void>;
      agentKill(agentId: string): Promise<void>;
      agentList(): Promise<unknown[]>;
      agentStatus(agentId: string): Promise<unknown>;
      agentPackageOpen(): Promise<AgentArtifactPackage | undefined>;
      agentInstall(params: {
        agentId: string;
        artifactDigest: string;
        capabilities: CapabilityAllowance[];
        resources: XmtpResourceDescriptor[];
        limits: AgentResourceLimits;
        enabled: boolean;
        expectedRevision: number;
        network?: MosaicNetwork;
        signatureB64?: string;
        passphrase?: string;
      }): Promise<AgentInstallationPolicy>;
      agentInstallationGet(agentIdOrParams: string | { agentId: string; network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<AgentInstallationPolicy | undefined>;
      agentInstallationDelete(agentId: string, expectedRevision: number, auth?: { network?: MosaicNetwork; signatureB64?: string; passphrase?: string }): Promise<void>;
      stopService(name: ServiceName): Promise<void>;
      onStatus(listener: (statuses: ServiceStatus[]) => void): () => void;
    };
  }
}
