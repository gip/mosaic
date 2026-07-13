import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AssetTrustState, AssetWithTrust, CatalogSnapshot, ChainFamily, ChainWithEnabled, NetworkTag } from '@mosaic/catalog';
import type { AgentChain, Network, RootChain, SessionAuthMessage } from '@mosaic/zone-keys';
import type { AgentArtifactManifest } from '@mosaic/local-runtime/contracts';
import { MCP_URL } from './config';

export type SignatureEnvelope =
  | { type: 'evm'; signature: `0x${string}` }
  | { type: 'stellar'; signatureB64: string }
  | { type: 'xrpl'; payloadUuid: string };

export interface XamanRefs {
  uuid: string;
  qrPng: string;
  websocketStatus: string;
  deeplink: string;
}

export interface AuthChallengeResult {
  challengeId: string;
  message: SessionAuthMessage;
  expiresAt: string;
  evmChainId?: number;
  xaman?: XamanRefs;
}

export interface AuthVerifyResult {
  token: string;
  chain: RootChain;
  address: string;
  network: Network;
  expiresAt: number;
}

/** Per-vault chain support; copied from the account settings at creation, then independent. */
export interface ZoneChainSetting {
  chainId: string;
  chainKey: string;
  name: string;
  family: ChainFamily;
  network: NetworkTag;
  evmChainId?: number;
  enabled: boolean;
}

export interface ZoneGetResult {
  exists: boolean;
  zoneId?: string;
  commitment?: string;
  policyHash?: string;
  localSignerPublicKey?: string;
  layer1Enabled?: boolean;
  createdAt?: string;
  lastUnlockedAt?: string;
  blobs?: { kind: 'sig' | 'pass' | 'device' | 'server' | 'data'; version: number }[];
  chains?: ZoneChainSetting[];
}

export interface ZoneListItem {
  zoneId: string;
  zone: string;
  commitment: string;
  mode: 'signed' | 'testnet-device' | 'testnet-server';
  createdAt: string;
  lastUnlockedAt?: string;
  addresses: ZoneAddressItem[];
  chains: ZoneChainSetting[];
}

export interface ZoneAddressItem {
  id: string;
  zoneId: string;
  chain: AgentChain;
  index: number;
  name: string;
  createdAt: string;
}

export interface BlobGetResult {
  kind: 'sig' | 'pass' | 'device' | 'server' | 'data';
  version: number;
  header: Record<string, unknown>;
  ciphertextB64: string;
  commitment: string;
}

export interface WalletSettingsResult {
  /** 0 disables the Mainnet lock reminder. */
  lockReminderMinutes: number;
}

export interface AgentArtifactRecord {
  artifactDigest: string;
  manifest: AgentArtifactManifest;
  source?: string;
  createdAt: string;
}

export class ApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

class MosaicApi {
  private clientPromise: Promise<Client> | undefined;

  private connect(): Promise<Client> {
    this.clientPromise ??= (async () => {
      // Lazy: the MCP SDK is a large dependency and nothing needs it before
      // the first server call.
      const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      ]);
      const client = new Client({ name: 'mosaic-frontend', version: '0.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
      return client;
    })().catch((error: unknown) => {
      this.clientPromise = undefined;
      throw error;
    });
    return this.clientPromise;
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const client = await this.connect();
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string }[] | undefined;
    const text = content?.[0]?.text ?? '{}';
    const data = JSON.parse(text) as T & { error?: { code?: string; message?: string } };
    if (result.isError) throw new ApiError(data.error?.message ?? `tool ${name} failed`, data.error?.code);
    return data;
  }

  authChallenge(args: { chain: RootChain; network: Network; address?: string }): Promise<AuthChallengeResult> {
    return this.call('auth_challenge', args);
  }

  authVerify(args: { challengeId: string; signature?: SignatureEnvelope }): Promise<AuthVerifyResult> {
    return this.call('auth_verify', args);
  }

  authLogout(token: string): Promise<{ ok: boolean }> {
    return this.call('auth_logout', { token });
  }

  authNetworkSwitch(token: string, network: Network): Promise<AuthVerifyResult> {
    return this.call('auth_network_switch', { token, network });
  }

  catalogList(token: string): Promise<CatalogSnapshot> {
    return this.call('catalog_list', { token });
  }

  /** Toggles every network variant of the logical chain; returns the updated variants. */
  chainEnabledSet(token: string, chainKey: string, enabled: boolean): Promise<ChainWithEnabled[]> {
    return this.call('chain_enabled_set', { token, chainKey, enabled });
  }

  assetTrustSet(token: string, assetId: string, state: AssetTrustState): Promise<AssetWithTrust> {
    return this.call('asset_trust_set', { token, assetId, state });
  }

  settingsGet(token: string): Promise<WalletSettingsResult> {
    return this.call('settings_get', { token });
  }

  settingsSet(token: string, patch: Partial<WalletSettingsResult>): Promise<WalletSettingsResult> {
    return this.call('settings_set', { token, ...patch });
  }

  zoneBegin(token: string, zone: string): Promise<{ challengeId: string; nonce: string; issuedAt: string; expiresAt: string }> {
    return this.call('zone_begin', { token, zone });
  }

  zoneCreate(args: {
    token: string;
    challengeId: string;
    zone: string;
    localSignerPublicKey: string;
    policyHash: string;
    zoneRootCommitment: string;
    signature: SignatureEnvelope;
  }): Promise<{ zoneId: string; createdAt: string }> {
    return this.call('zone_create', args);
  }

  zoneCreateTestnet(args: {
    token: string; zone: string; zoneRootCommitment: string; zoneRootSecretB64: string;
  }): Promise<{ zoneId: string; createdAt: string }> {
    return this.call('zone_create_testnet', args);
  }

  zoneTestnetUnlock(token: string, zone: string): Promise<{ commitment: string; zoneRootSecretB64: string }> {
    return this.call('zone_testnet_unlock', { token, zone });
  }

  zoneGet(token: string, zone: string): Promise<ZoneGetResult> {
    return this.call('zone_get', { token, zone });
  }

  zoneList(token: string): Promise<ZoneListItem[]> {
    return this.call('zone_list', { token });
  }

  zoneUnlocked(token: string, zone: string): Promise<{ lastUnlockedAt: string }> {
    return this.call('zone_unlocked', { token, zone });
  }

  zoneAddressCreate(token: string, zone: string, chain: AgentChain, name?: string): Promise<ZoneAddressItem> {
    return this.call('zone_address_create', { token, zone, chain, ...(name ? { name } : {}) });
  }

  /** Returns the vault's full chain list after the toggle. */
  zoneChainSet(token: string, zone: string, chainKey: string, enabled: boolean): Promise<ZoneChainSetting[]> {
    return this.call('zone_chain_set', { token, zone, chainKey, enabled });
  }

  blobPut(args: {
    token: string;
    zone: string;
    kind: 'sig' | 'pass' | 'device' | 'data';
    ciphertextB64: string;
    header: Record<string, unknown>;
    expectedVersion?: number;
  }): Promise<{ version: number }> {
    return this.call('blob_put', args);
  }

  blobGet(token: string, zone: string, kind: 'sig' | 'pass' | 'device' | 'server' | 'data'): Promise<BlobGetResult> {
    return this.call('blob_get', { token, zone, kind });
  }

  agentArtifactPut(token: string, manifest: AgentArtifactManifest, source: string): Promise<{ artifactDigest: string; created: boolean }> {
    return this.call('agent_artifact_put', { token, manifest, source });
  }

  agentArtifactGet(token: string, artifactDigest: string): Promise<AgentArtifactRecord & { source: string }> {
    return this.call('agent_artifact_get', { token, artifactDigest });
  }

  async agentArtifactList(token: string, packageName?: string): Promise<AgentArtifactRecord[]> {
    const result = await this.call<{ artifacts: AgentArtifactRecord[] }>('agent_artifact_list', { token, ...(packageName ? { packageName } : {}) });
    return result.artifacts;
  }

  xamanSignCreate(args: {
    token: string;
    purpose: 'backup-wrap' | 'authorize-zone';
    zone: string;
    challengeId?: string;
    localSignerPublicKey?: string;
    policyHash?: string;
    zoneRootCommitment?: string;
  }): Promise<XamanRefs> {
    return this.call('xaman_sign_create', args);
  }

  xamanPayloadResult(token: string, uuid: string): Promise<{ signed: boolean; resolved: boolean; hex?: string; account?: string }> {
    return this.call('xaman_payload_result', { token, uuid });
  }
}

export const api = new MosaicApi();
