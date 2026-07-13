import { randomBytes } from 'node:crypto';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { argon2id } from 'hash-wasm';
import {
  decodeBackupBlob,
  deriveEvmAgentKey,
  evmAddressFromPrivateKey,
  openPassphraseBlob,
  openAgentSecretStore,
  openSignatureBlob,
  openVaultData,
  passphraseKdfParams,
  sealVaultData,
  sealAgentSecretStore,
  zoneSeed,
  type BlobHeader,
  type Network,
  type RootChain,
  type VaultDataBlobHeader,
  type VaultDataV1,
  type AgentSecretRecordV1,
  type AgentSecretStoreHeaderV1,
  type AgentSecretStoreV1,
  type ZoneRef,
} from '@mosaic/zone-keys';
import {
  artifactDigest,
  assertArtifactManifest,
  assertCapabilityAllowance,
  assertCanonicalAgentSource,
  assertInstallationPolicy,
  assertResourceLimits,
  canonicalJson,
  contractDigest,
  DEFAULT_GRANT_TTL_MS,
  DEFAULT_OFFLINE_GRACE_MS,
  sealAgentKeyLease,
  sha256Hex,
  type AgentArtifactManifest,
  type AgentExecutionPackage,
  type AgentLeaseRenewalPackage,
  type AgentInstallationPolicy,
  type AgentResourceLimits,
  type CapabilityAllowance,
  type CapabilityRequest,
  type CapabilityResult,
  type ExecutionGrant,
  type MosaicNetwork,
  type RunnerCertificate,
  type TransactionProposal,
  type TransactionResult,
  type XmtpResourceDescriptor,
} from '@mosaic/local-runtime';
import { VaultCore } from './vault.js';

interface ZoneAddress {
  id: string;
  chain: 'evm' | 'xrpl' | 'stellar';
  index: number;
  name: string;
}

interface ZoneItem {
  zoneId: string;
  zone: string;
  commitment: string;
  mode: 'signed' | 'testnet-device' | 'testnet-server';
  addresses: ZoneAddress[];
}

interface BlobResult {
  kind: string;
  version: number;
  header: Record<string, unknown>;
  ciphertextB64: string;
  commitment: string;
}

export interface GuardianSession {
  token: string;
  chain: RootChain;
  address: string;
  network: Network;
  expiresAt: number;
}

export type UnlockCredential =
  | { type: 'signature'; signature: Uint8Array }
  | { type: 'passphrase'; passphrase: string };

export interface GuardianApi {
  zoneList(token: string): Promise<ZoneItem[]>;
  zoneGet?(token: string, zone: string): Promise<{ blobs?: { kind: string; version: number }[] }>;
  zoneAddressCreate(token: string, zone: string, chain: 'evm', name: string): Promise<ZoneAddress>;
  zoneTestnetUnlock(token: string, zone: string): Promise<{ commitment: string; zoneRootSecretB64: string }>;
  zoneUnlocked(token: string, zone: string): Promise<void>;
  blobGet(token: string, zone: string, kind: 'sig' | 'pass' | 'data' | 'agent-secrets'): Promise<BlobResult>;
  blobPut(args: { token: string; zone: string; kind: 'data' | 'agent-secrets'; ciphertextB64: string; header: Record<string, unknown>; expectedVersion: number }): Promise<{ version: number }>;
  agentArtifactGet(token: string, artifactDigest: string): Promise<{ artifactDigest: string; manifest: AgentArtifactManifest; source: string }>;
}

export class McpGuardianApi implements GuardianApi {
  private clientPromise?: Promise<McpClient>;

  constructor(
    private readonly url = process.env.MOSAIC_MCP_URL ?? 'http://127.0.0.1:8788/mcp',
    private readonly clientFactory?: (url: URL) => Promise<McpClient>,
  ) {}

  private connect(): Promise<McpClient> {
    if (!this.clientPromise) {
      const pending = this.clientFactory
        ? this.clientFactory(new URL(this.url))
        : (async () => {
            const client = new McpClient({ name: 'mosaic-guardian', version: '0.0.0' });
            await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
            return client;
          })();
      this.clientPromise = pending;
      void pending.catch(() => {
        if (this.clientPromise === pending) this.clientPromise = undefined;
      });
    }
    return this.clientPromise;
  }

  private async call<T>(name: string, args: Record<string, unknown>, retryStaleSession = true): Promise<T> {
    const pending = this.connect();
    let client: McpClient;
    let result: Awaited<ReturnType<McpClient['callTool']>>;
    try {
      client = await pending;
      result = await client.callTool({ name, arguments: args });
    } catch (error) {
      if (retryStaleSession && error instanceof Error && /initialize first/i.test(error.message)) {
        if (this.clientPromise === pending) this.clientPromise = undefined;
        void pending.then((stale) => stale.close()).catch(() => {});
        return this.call<T>(name, args, false);
      }
      throw error;
    }
    const text = (result.content as { type: string; text?: string }[] | undefined)?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text) as T & { error?: { code?: string; message?: string } };
    if (result.isError) {
      const error = new Error(parsed.error?.message ?? `tool ${name} failed`) as Error & { code?: string };
      error.code = parsed.error?.code;
      throw error;
    }
    return parsed;
  }

  zoneList(token: string): Promise<ZoneItem[]> { return this.call('zone_list', { token }); }
  zoneGet(token: string, zone: string): Promise<{ blobs?: { kind: string; version: number }[] }> {
    return this.call('zone_get', { token, zone });
  }
  zoneAddressCreate(token: string, zone: string, chain: 'evm', name: string): Promise<ZoneAddress> {
    return this.call('zone_address_create', { token, zone, chain, name });
  }
  zoneTestnetUnlock(token: string, zone: string): Promise<{ commitment: string; zoneRootSecretB64: string }> {
    return this.call('zone_testnet_unlock', { token, zone });
  }
  async zoneUnlocked(token: string, zone: string): Promise<void> { await this.call('zone_unlocked', { token, zone }); }
  blobGet(token: string, zone: string, kind: 'sig' | 'pass' | 'data' | 'agent-secrets'): Promise<BlobResult> {
    return this.call('blob_get', { token, zone, kind });
  }
  blobPut(args: { token: string; zone: string; kind: 'data' | 'agent-secrets'; ciphertextB64: string; header: Record<string, unknown>; expectedVersion: number }): Promise<{ version: number }> {
    return this.call('blob_put', args);
  }
  agentArtifactGet(token: string, artifactDigestValue: string): Promise<{ artifactDigest: string; manifest: AgentArtifactManifest; source: string }> {
    return this.call('agent_artifact_get', { token, artifactDigest: artifactDigestValue });
  }
  authChallenge(args: { chain: RootChain; network: Network; address?: string }): Promise<{
    challengeId: string;
    message: import('@mosaic/zone-keys').SessionAuthMessage;
    xaman?: { qrPng: string; websocketStatus: string; deeplink: string };
  }> { return this.call('auth_challenge', args); }
  authVerify(args: { challengeId: string; signature?: Record<string, unknown> }): Promise<GuardianSession> {
    return this.call('auth_verify', args);
  }
}

export interface UnlockedIdentity {
  vault: string;
  name: string;
  index: number;
  address: string;
}

interface UnlockedVault {
  ref: ZoneRef;
  item: ZoneItem;
  secret: Uint8Array;
  data: VaultDataV1;
  dataVersion: number;
  secretRecords: AgentSecretMetadata[];
  secretBuffers: Map<string, Uint8Array>;
  secretStoreVersion: number;
  keys: Map<string, Uint8Array>;
}

type AgentSecretMetadata = Omit<AgentSecretRecordV1, 'materialB64'>;

function bytesToBase64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
function base64ToBytes(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')); }

const AGENT_INSTALLATION_EXTENSION = 'mosaic.agent-installation.v2';

function assertStoredInstallation(policy: AgentInstallationPolicy, agentId: string, network: MosaicNetwork): void {
  const keys = Object.keys(policy as unknown as Record<string, unknown>);
  if (keys.some((key) => !['v', 'revision', 'enabled', 'packageName', 'artifactDigest', 'capabilities', 'resources', 'limits'].includes(key))) throw new Error('installation contains unknown fields');
  if (policy.v !== 2 || !Number.isSafeInteger(policy.revision) || policy.revision < 1) throw new Error('invalid installation revision');
  if (typeof policy.enabled !== 'boolean') throw new Error('invalid installation enabled state');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(policy.packageName) || !/^[0-9a-f]{64}$/.test(policy.artifactDigest)) throw new Error('invalid installation identity');
  if (!Array.isArray(policy.capabilities) || !Array.isArray(policy.resources) || !policy.limits) throw new Error('invalid installation');
  for (const allowance of policy.capabilities) assertCapabilityAllowance(allowance, true);
  for (const resource of policy.resources) {
    if (Object.keys(resource).some((key) => !['kind', 'resourceId', 'label', 'peerAddress', 'environment'].includes(key))) throw new Error('installation resource contains unknown fields');
    if (resource.kind !== 'xmtp-contact' || resource.environment !== (network === 'testnet' ? 'dev' : 'production')) throw new Error('invalid installation resource');
  }
  assertResourceLimits(policy.limits);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) throw new Error('invalid agentId');
}

function generateEvmPrivateKey(): Uint8Array {
  for (;;) {
    const key = new Uint8Array(randomBytes(32));
    try { evmAddressFromPrivateKey(key); return key; } catch { key.fill(0); }
  }
}

function signEip191(privateKey: Uint8Array, message: string): Uint8Array {
  const messageBytes = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${messageBytes.length}`);
  const recovered = secp256k1.sign(keccak_256(concatBytes(prefix, messageBytes)), privateKey, {
    prehash: false,
    format: 'recovered',
  });
  return Uint8Array.from([...recovered.slice(1), recovered[0]! + 27]);
}

export class GuardianService {
  private session?: GuardianSession;
  private readonly vaults = new Map<string, UnlockedVault>();
  private readonly runnerApprovals = new Map<string, number>();
  private guardianIdentity?: UnlockedIdentity;
  private vaultCore?: VaultCore;

  constructor(private readonly api: GuardianApi = new McpGuardianApi()) {}

  attachSession(session: GuardianSession): void {
    if (session.expiresAt <= Date.now()) throw new Error('MCP session is expired');
    this.session = { ...session };
  }

  private requireSession(network: MosaicNetwork): GuardianSession {
    if (!this.session || this.session.expiresAt <= Date.now()) throw new Error('Mosaic Guardian has no active MCP session');
    if (this.session.network !== network) throw new Error(`MCP session is for ${this.session.network}, not ${network}`);
    return this.session;
  }

  async unlockVault(vault: string, network: MosaicNetwork, credential?: UnlockCredential): Promise<void> {
    if (this.vaults.has(vault)) return;
    const session = this.requireSession(network);
    const item = (await this.api.zoneList(session.token)).find((candidate) => candidate.zone === vault);
    if (!item) throw new Error(`vault not found: ${vault} (${network})`);
    const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: vault, network };
    let secret: Uint8Array;
    if (item.mode === 'testnet-server') {
      if (network !== 'testnet') throw new Error('server-managed vaults are Testnet-only');
      const opened = await this.api.zoneTestnetUnlock(session.token, vault);
      if (opened.commitment !== item.commitment) throw new Error('vault commitment mismatch');
      secret = base64ToBytes(opened.zoneRootSecretB64);
    } else if (credential?.type === 'signature') {
      const blob = await this.api.blobGet(session.token, vault, 'sig');
      secret = openSignatureBlob(
        credential.signature,
        decodeBackupBlob({ header: blob.header as unknown as BlobHeader, ciphertext: blob.ciphertextB64 }),
        ref,
        item.commitment,
      );
    } else if (credential?.type === 'passphrase') {
      const blob = await this.api.blobGet(session.token, vault, 'pass');
      const wrapped = decodeBackupBlob({ header: blob.header as unknown as BlobHeader, ciphertext: blob.ciphertextB64 });
      const params = passphraseKdfParams(wrapped);
      const kek = new Uint8Array(await argon2id({
        password: credential.passphrase,
        salt: params.saltBytes,
        parallelism: params.p,
        iterations: params.t,
        memorySize: params.m,
        hashLength: 32,
        outputType: 'binary',
      }));
      try { secret = openPassphraseBlob(kek, wrapped, ref, item.commitment); }
      finally { kek.fill(0); }
    } else {
      throw new Error(`vault ${vault} requires a backup-wrap signature or passphrase`);
    }
    if (secret.length !== 32) { secret.fill(0); throw new Error('vault secret must be 32 bytes'); }

    let data: VaultDataV1;
    let dataVersion: number;
    let secretStore: AgentSecretStoreV1;
    let secretStoreVersion: number;
    try {
      ({ data, version: dataVersion } = await this.fetchVaultData(session, ref, secret));
      ({ store: secretStore, version: secretStoreVersion } = await this.fetchAgentSecrets(session, ref, secret));
    } catch (error) {
      secret.fill(0);
      throw error;
    }
    const secretBuffers = new Map(secretStore.secrets.map((record) => [record.keyId, base64ToBytes(record.materialB64)]));
    const secretRecords = secretStore.secrets.map(({ materialB64: _material, ...metadata }) => metadata);
    secretStore.secrets = [];
    this.vaults.set(vault, { ref, item, secret, data, dataVersion, secretRecords, secretBuffers, secretStoreVersion, keys: new Map() });
    await this.api.zoneUnlocked(session.token, vault);
  }

  /**
   * The mutable data blob holds no key material (spec §4.6), so an unreadable
   * blob must never block unlock: fall back to fresh data but keep the server
   * version so the next save overwrites the bad blob. Only transport failures
   * propagate.
   */
  private async fetchVaultData(
    session: GuardianSession,
    ref: ZoneRef,
    secret: Uint8Array,
  ): Promise<{ data: VaultDataV1; version: number }> {
    if (this.api.zoneGet) {
      const metadata = await this.api.zoneGet(session.token, ref.zone);
      if (!metadata.blobs?.some(({ kind }) => kind === 'data')) {
        return { data: { v: 1 }, version: 0 };
      }
    }
    let blob: BlobResult;
    try {
      blob = await this.api.blobGet(session.token, ref.zone, 'data');
    } catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND' || String(error).includes('no data blob')) {
        return { data: { v: 1 }, version: 0 };
      }
      throw error;
    }
    try {
      return {
        data: openVaultData(secret, ref, {
          header: blob.header as unknown as VaultDataBlobHeader,
          ciphertext: base64ToBytes(blob.ciphertextB64),
        }),
        version: blob.version,
      };
    } catch (error) {
      // Only a blob this Guardian could have written may be treated as
      // corrupt-and-replaceable. An unknown header means a newer client wrote
      // it; overwriting would silently destroy recoverable policies.
      const header = blob.header as { v?: unknown; schema?: unknown; alg?: unknown };
      if (header.v !== 1 || header.schema !== 'mosaic-vault-data' || header.alg !== 'xchacha20poly1305') {
        throw new Error(
          `vault ${ref.zone}: data blob v${blob.version} uses an unsupported format (written by a newer client?); refusing to unlock and overwrite it`,
        );
      }
      console.warn(
        `vault ${ref.zone}: data blob v${blob.version} is unreadable, starting fresh (${error instanceof Error ? error.message : String(error)})`,
      );
      return { data: { v: 1 }, version: blob.version };
    }
  }

  private async fetchAgentSecrets(
    session: GuardianSession,
    ref: ZoneRef,
    secret: Uint8Array,
  ): Promise<{ store: AgentSecretStoreV1; version: number }> {
    if (this.api.zoneGet) {
      const metadata = await this.api.zoneGet(session.token, ref.zone);
      if (!metadata.blobs?.some(({ kind }) => kind === 'agent-secrets')) {
        return { store: { v: 1, agentId: ref.zone, secrets: [] }, version: 0 };
      }
    }
    let blob: BlobResult;
    try { blob = await this.api.blobGet(session.token, ref.zone, 'agent-secrets'); }
    catch (error) {
      if ((error as { code?: string }).code === 'NOT_FOUND' || String(error).includes('no agent-secrets blob')) {
        return { store: { v: 1, agentId: ref.zone, secrets: [] }, version: 0 };
      }
      throw error;
    }
    return {
      store: openAgentSecretStore(secret, ref, {
        header: blob.header as unknown as AgentSecretStoreHeaderV1,
        ciphertext: base64ToBytes(blob.ciphertextB64),
      }),
      version: blob.version,
    };
  }

  private requireVault(vault: string): UnlockedVault {
    const unlocked = this.vaults.get(vault);
    if (!unlocked) throw new Error(`vault is locked: ${vault}`);
    return unlocked;
  }

  async ensureIdentity(vault: string, name: string): Promise<UnlockedIdentity> {
    const unlocked = this.requireVault(vault);
    const session = this.requireSession(unlocked.ref.network);
    let address = unlocked.item.addresses.find((candidate) => candidate.chain === 'evm' && candidate.name === name);
    if (!address) {
      address = await this.api.zoneAddressCreate(session.token, vault, 'evm', name);
      unlocked.item.addresses.push(address);
    }
    const derived = deriveEvmAgentKey(zoneSeed(unlocked.secret, unlocked.ref), address.index);
    unlocked.keys.get(name)?.fill(0);
    unlocked.keys.set(name, derived.privateKey.slice());
    derived.privateKey.fill(0);
    const identity = { vault, name, index: address.index, address: derived.address };
    await this.saveData(unlocked, (data) => ({
      ...data,
      identities: {
        ...data.identities,
        [name]: { chain: 'evm', addressName: name, address: derived.address, index: address.index },
      },
    }));
    return identity;
  }

  /**
   * Compare-and-set save. In-memory state is committed only on success; on a
   * version conflict (another Guardian instance wrote first) the update is
   * rebased once onto the latest server data.
   */
  private async saveData(unlocked: UnlockedVault, update: (data: VaultDataV1) => VaultDataV1): Promise<void> {
    const session = this.requireSession(unlocked.ref.network);
    for (let attempt = 0; ; attempt++) {
      const next = update(unlocked.data);
      const sealed = sealVaultData(unlocked.secret, unlocked.ref, next, unlocked.dataVersion + 1);
      try {
        const saved = await this.api.blobPut({
          token: session.token,
          zone: unlocked.ref.zone,
          kind: 'data',
          ciphertextB64: bytesToBase64(sealed.ciphertext),
          header: sealed.header as unknown as Record<string, unknown>,
          expectedVersion: unlocked.dataVersion,
        });
        unlocked.data = next;
        unlocked.dataVersion = saved.version;
        return;
      } catch (error) {
        const conflict = (error as { code?: string }).code === 'CONFLICT' || /version conflict/i.test(String(error));
        if (!conflict || attempt >= 1) throw error;
        const latest = await this.fetchVaultData(session, unlocked.ref, unlocked.secret);
        unlocked.data = latest.data;
        unlocked.dataVersion = latest.version;
      }
    }
  }

  private async saveAgentSecrets(unlocked: UnlockedVault, records: AgentSecretMetadata[], materials: Map<string, Uint8Array>): Promise<void> {
    const session = this.requireSession(unlocked.ref.network);
    const next: AgentSecretStoreV1 = {
      v: 1,
      agentId: unlocked.ref.zone,
      secrets: records.map((record) => {
        const material = materials.get(record.keyId);
        if (!material) throw new Error(`missing material for agent secret: ${record.keyId}`);
        return { ...record, materialB64: bytesToBase64(material) };
      }),
    };
    const sealed = sealAgentSecretStore(unlocked.secret, unlocked.ref, next, unlocked.secretStoreVersion + 1);
    const saved = await this.api.blobPut({
      token: session.token,
      zone: unlocked.ref.zone,
      kind: 'agent-secrets',
      ciphertextB64: bytesToBase64(sealed.ciphertext),
      header: sealed.header as unknown as Record<string, unknown>,
      expectedVersion: unlocked.secretStoreVersion,
    });
    for (const material of unlocked.secretBuffers.values()) material.fill(0);
    unlocked.secretRecords = records;
    unlocked.secretBuffers = materials;
    unlocked.secretStoreVersion = saved.version;
    next.secrets = [];
  }

  private copySecretBuffers(unlocked: UnlockedVault): Map<string, Uint8Array> {
    return new Map([...unlocked.secretBuffers].map(([keyId, material]) => [keyId, material.slice()]));
  }

  getAgentInstallation(agentId: string): AgentInstallationPolicy | undefined {
    const unlocked = this.requireVault(agentId);
    const raw = unlocked.data.extensions?.[AGENT_INSTALLATION_EXTENSION];
    if (raw === undefined) return undefined;
    const policy = structuredClone(raw) as AgentInstallationPolicy;
    assertStoredInstallation(policy, agentId, unlocked.ref.network);
    return policy;
  }

  async installAgent(params: {
    agentId: string;
    artifactDigest: string;
    capabilities: CapabilityAllowance[];
    resources: XmtpResourceDescriptor[];
    limits: AgentResourceLimits;
    enabled: boolean;
    expectedRevision: number;
  }): Promise<AgentInstallationPolicy> {
    const unlocked = this.requireVault(params.agentId);
    if (this.vaultCore?.hasActiveGrant(params.agentId)) throw new Error('agent must be stopped before changing its installation');
    const session = this.requireSession(unlocked.ref.network);
    if (session.chain !== unlocked.ref.rootChain || session.address.toLowerCase() !== unlocked.ref.rootAddress.toLowerCase()) throw new Error('MCP session does not own the agent vault');
    const current = this.getAgentInstallation(params.agentId);
    if ((current?.revision ?? 0) !== params.expectedRevision) throw new Error(`agent installation revision conflict: expected ${params.expectedRevision}, current ${current?.revision ?? 0}`);
    const artifact = await this.fetchVerifiedArtifact(session.token, params.artifactDigest);
    const next: AgentInstallationPolicy = {
      v: 2,
      revision: params.expectedRevision + 1,
      enabled: params.enabled,
      packageName: artifact.manifest.packageName,
      artifactDigest: params.artifactDigest,
      capabilities: structuredClone(params.capabilities),
      resources: structuredClone(params.resources),
      limits: structuredClone(params.limits),
    };
    assertInstallationPolicy(artifact.manifest, next, unlocked.ref.network);
    await this.saveData(unlocked, (data) => ({
      ...data,
      extensions: { ...data.extensions, [AGENT_INSTALLATION_EXTENSION]: next },
    }));
    return structuredClone(next);
  }

  async deleteAgentInstallation(agentId: string, expectedRevision: number): Promise<void> {
    const unlocked = this.requireVault(agentId);
    if (this.vaultCore?.hasActiveGrant(agentId)) throw new Error('agent must be stopped before deleting its installation');
    const current = this.getAgentInstallation(agentId);
    if (!current || current.revision !== expectedRevision) throw new Error(`agent installation revision conflict: expected ${expectedRevision}, current ${current?.revision ?? 0}`);
    await this.saveData(unlocked, (data) => {
      const extensions = { ...data.extensions };
      delete extensions[AGENT_INSTALLATION_EXTENSION];
      return { ...data, extensions };
    });
  }

  private async fetchVerifiedArtifact(token: string, digest: string): Promise<{ artifactDigest: string; manifest: AgentArtifactManifest; source: string }> {
    const artifact = await this.api.agentArtifactGet(token, digest);
    assertArtifactManifest(artifact.manifest);
    assertCanonicalAgentSource(artifact.source);
    if (artifact.artifactDigest !== digest || artifactDigest(artifact.manifest) !== digest) throw new Error('agent artifact digest mismatch');
    if (artifact.manifest.sourceDigest !== sha256Hex(artifact.source)) throw new Error('agent artifact source digest mismatch');
    return artifact;
  }

  listAgentSecretMetadata(agentId: string): Array<Omit<AgentSecretRecordV1, 'materialB64'>> {
    return this.requireVault(agentId).secretRecords.map((metadata) => ({ ...metadata }));
  }

  async importAgentSecret(agentId: string, record: Omit<AgentSecretRecordV1, 'createdAt' | 'materialB64'>, material: Uint8Array): Promise<void> {
    const unlocked = this.requireVault(agentId);
    if (unlocked.secretRecords.some(({ keyId }) => keyId === record.keyId)) throw new Error(`agent secret already exists: ${record.keyId}`);
    const nextRecord: AgentSecretMetadata = {
      ...record,
      createdAt: new Date().toISOString(),
    };
    const materials = this.copySecretBuffers(unlocked);
    materials.set(record.keyId, material.slice());
    try { await this.saveAgentSecrets(unlocked, [...unlocked.secretRecords, nextRecord], materials); }
    catch (error) { for (const value of materials.values()) value.fill(0); throw error; }
  }

  async rotateAgentSecret(agentId: string, keyId: string, material: Uint8Array): Promise<void> {
    const unlocked = this.requireVault(agentId);
    const index = unlocked.secretRecords.findIndex((record) => record.keyId === keyId);
    if (index < 0) throw new Error(`agent secret not found: ${keyId}`);
    const records = unlocked.secretRecords.map((record, recordIndex) => recordIndex === index ? {
      ...record, createdAt: new Date().toISOString(),
    } : record);
    const materials = this.copySecretBuffers(unlocked);
    materials.get(keyId)?.fill(0);
    materials.set(keyId, material.slice());
    try { await this.saveAgentSecrets(unlocked, records, materials); }
    catch (error) { for (const value of materials.values()) value.fill(0); throw error; }
  }

  async deleteAgentSecret(agentId: string, keyId: string): Promise<void> {
    const unlocked = this.requireVault(agentId);
    const records = unlocked.secretRecords.filter((record) => record.keyId !== keyId);
    if (records.length === unlocked.secretRecords.length) throw new Error(`agent secret not found: ${keyId}`);
    const materials = new Map(records.map((record) => [record.keyId, unlocked.secretBuffers.get(record.keyId)!.slice()]));
    try { await this.saveAgentSecrets(unlocked, records, materials); }
    catch (error) { for (const value of materials.values()) value.fill(0); throw error; }
  }

  async initializeAgentCommunicationKeys(agentId: string): Promise<Array<Omit<AgentSecretRecordV1, 'materialB64'>>> {
    const unlocked = this.requireVault(agentId);
    const additions: AgentSecretMetadata[] = [];
    const materials = this.copySecretBuffers(unlocked);
    const now = new Date().toISOString();
    if (!unlocked.secretRecords.some(({ keyId }) => keyId === 'xmtp-owner')) {
      const material = generateEvmPrivateKey();
      try {
        additions.push({ keyId: 'xmtp-owner', purpose: 'xmtp-owner', algorithm: 'secp256k1', custody: 'supervisor-session', createdAt: now });
        materials.set('xmtp-owner', material.slice());
      } finally { material.fill(0); }
    }
    if (!unlocked.secretRecords.some(({ keyId }) => keyId === 'xmtp-database')) {
      const material = new Uint8Array(randomBytes(32));
      try {
        additions.push({ keyId: 'xmtp-database', purpose: 'xmtp-database', algorithm: 'bytes32', custody: 'supervisor-session', createdAt: now });
        materials.set('xmtp-database', material.slice());
      } finally { material.fill(0); }
    }
    if (additions.length) {
      try { await this.saveAgentSecrets(unlocked, [...unlocked.secretRecords, ...additions], materials); }
      catch (error) { for (const value of materials.values()) value.fill(0); throw error; }
    } else {
      for (const value of materials.values()) value.fill(0);
    }
    return this.listAgentSecretMetadata(agentId);
  }

  async prepareAgent(params: {
    agentId: string;
    certificate: RunnerCertificate;
    supervisorKeyLeasePublicKeyB64: string;
  }): Promise<AgentExecutionPackage> {
    const unlocked = this.requireVault(params.agentId);
    if (unlocked.ref.zone !== params.agentId) throw new Error('agent/vault binding mismatch');
    const policy = this.getAgentInstallation(params.agentId);
    if (!policy?.enabled) throw new Error(`agent is disabled or has no installation: ${params.agentId}`);
    const session = this.requireSession(unlocked.ref.network);
    const artifact = await this.fetchVerifiedArtifact(session.token, policy.artifactDigest);
    assertInstallationPolicy(artifact.manifest, policy, unlocked.ref.network);
    await this.initializeAgentCommunicationKeys(params.agentId);
    const ownerBytes = unlocked.secretBuffers.get('xmtp-owner')?.slice();
    if (!ownerBytes) throw new Error('XMTP owner key is unavailable');
    let xmtpAddress: string;
    try { xmtpAddress = evmAddressFromPrivateKey(ownerBytes); } finally { ownerBytes.fill(0); }
    const grant = this.issueGrant({
      agentId: params.agentId,
      certificate: params.certificate,
      manifest: artifact.manifest,
      artifactDigest: policy.artifactDigest,
      policyRevision: policy.revision,
      xmtpAddress,
      resources: policy.resources,
      limits: policy.limits,
      configDigest: contractDigest({ agentId: params.agentId, resources: policy.resources }),
      policyDigest: contractDigest(policy),
      capabilities: policy.capabilities,
    });
    const secrets = unlocked.secretRecords
      .filter((record) => record.custody === 'supervisor-session')
      .filter((record) => record.purpose === 'xmtp-owner' || record.purpose === 'xmtp-database')
      .map(({ keyId, purpose, algorithm }) => ({ keyId, purpose, algorithm, materialB64: bytesToBase64(unlocked.secretBuffers.get(keyId)!) }));
    const sealedKeyLease = sealAgentKeyLease({
      protocol: grant.protocol,
      agentId: params.agentId,
      grantId: grant.grantId,
      runnerId: grant.runnerId,
      certificateDigest: grant.certificateDigest,
      network: grant.network,
      expiresAt: grant.expiresAt,
      secrets,
    }, params.supervisorKeyLeasePublicKeyB64);
    for (const secret of secrets) secret.materialB64 = '';
    return { agentId: params.agentId, manifest: artifact.manifest, source: artifact.source, grant, sealedKeyLease };
  }

  async startGuardian(vault: string, network: MosaicNetwork, credential?: UnlockCredential): Promise<UnlockedIdentity> {
    await this.unlockVault(vault, network, credential);
    const identity = await this.ensureIdentity(vault, 'guardian');
    this.guardianIdentity = identity;
    const privateKey = this.requireVault(vault).keys.get(identity.name)!;
    this.vaultCore = new VaultCore({
      guardianId: `${identity.vault}:${identity.name}:${identity.index}`,
      guardianAddress: identity.address,
      network,
      signEnvelope: (text) => signEip191(privateKey, text),
    });
    return identity;
  }

  /**
   * Pairing approval (ADR 0001): enrollment must be preceded by an explicit
   * approval — the UI start action or the Guardian terminal. Approvals are
   * single-use and short-lived.
   */
  approveRunner(runnerId: string, ttlMs = 2 * 60_000): void {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(runnerId)) throw new Error('invalid runner ID');
    this.runnerApprovals.set(runnerId, Date.now() + ttlMs);
  }

  isRunnerApproved(runnerId: string): boolean {
    const until = this.runnerApprovals.get(runnerId);
    return until !== undefined && until > Date.now();
  }

  enrollRunner(params: { runnerId: string; runnerPublicKey: string; network: MosaicNetwork; environment: 'local' | 'remote' }): RunnerCertificate {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    if (!this.isRunnerApproved(params.runnerId)) {
      throw new Error(`runner ${params.runnerId} is not approved; start it from the Mosaic app or approve it in the Guardian terminal`);
    }
    this.runnerApprovals.delete(params.runnerId);
    return this.vaultCore.enrollRunner(params);
  }

  issueGrant(params: {
    agentId: string;
    certificate: RunnerCertificate;
    manifest: AgentArtifactManifest;
    configDigest: string;
    policyDigest: string;
    capabilities: CapabilityAllowance[];
    artifactDigest: string;
    policyRevision: number;
    xmtpAddress: string;
    resources: import('@mosaic/local-runtime').AgentResourceDescriptor[];
    limits: AgentResourceLimits;
  }): ExecutionGrant {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    return this.vaultCore.issueGrant(params);
  }

  authorizeCapability(request: CapabilityRequest): CapabilityResult | undefined {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    return this.vaultCore.authorizeCapability(request);
  }

  recordCapability(request: CapabilityRequest, result: Omit<CapabilityResult, 'auditEventDigest'>): CapabilityResult {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    return this.vaultCore.recordCapability(request, result);
  }

  renewLease(agentId: string, grantId: string, supervisorKeyLeasePublicKeyB64: string): AgentLeaseRenewalPackage {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    if (!this.vaults.has(agentId)) throw new Error('agent vault is locked');
    const policy = this.getAgentInstallation(agentId);
    if (!policy?.enabled) throw new Error('agent is disabled');
    const grant = this.vaultCore.getGrant(grantId, agentId);
    if (policy.artifactDigest !== grant.artifactDigest) throw new Error('fresh prepare required: artifact changed');
    const grantedResources = new Map(grant.resources.map((resource) => [resource.resourceId, canonicalJson(resource)]));
    if (policy.resources.some((resource) => grantedResources.get(resource.resourceId) !== canonicalJson(resource))) {
      throw new Error('fresh prepare required: resources expanded or changed');
    }
    const expiresAt = new Date(Date.now() + DEFAULT_GRANT_TTL_MS).toISOString();
    const renewal = this.vaultCore.renew(grantId, policy.capabilities, expiresAt, DEFAULT_OFFLINE_GRACE_MS, agentId, policy.resources);
    const unlocked = this.requireVault(agentId);
    const secrets = unlocked.secretRecords
      .filter((record) => record.custody === 'supervisor-session')
      .filter((record) => record.purpose === 'xmtp-owner' || record.purpose === 'xmtp-database')
      .map(({ keyId, purpose, algorithm }) => ({ keyId, purpose, algorithm, materialB64: bytesToBase64(unlocked.secretBuffers.get(keyId)!) }));
    const sealedKeyLease = sealAgentKeyLease({
        protocol: grant.protocol, agentId, grantId, runnerId: grant.runnerId, certificateDigest: grant.certificateDigest,
        network: grant.network, expiresAt, secrets,
      }, supervisorKeyLeasePublicKeyB64);
    for (const secret of secrets) secret.materialB64 = '';
    return { renewal, sealedKeyLease };
  }

  proposeTransaction(proposal: TransactionProposal): TransactionResult {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    if (!this.vaults.has(proposal.agentId)) throw new Error('transaction agent vault is locked');
    return this.vaultCore.rejectTransaction(proposal);
  }

  lockAgent(agentId: string, grantId?: string): void {
    if (this.guardianIdentity?.vault === agentId) throw new Error('Guardian control vault cannot be stopped as an agent');
    // Stops routinely arrive after the grant's short TTL has lapsed; the
    // binding check must not gate zeroization on the expiry window.
    if (grantId) this.vaultCore?.assertGrantBinding(grantId, agentId);
    const vault = this.vaults.get(agentId);
    if (!vault) return;
    vault.secret.fill(0);
    for (const key of vault.keys.values()) key.fill(0);
    vault.keys.clear();
    for (const material of vault.secretBuffers.values()) material.fill(0);
    vault.secretBuffers.clear();
    vault.secretRecords = [];
    this.vaults.delete(agentId);
    this.vaultCore?.dropAgent(agentId);
  }

  status(): { guardian?: UnlockedIdentity; unlockedVaults: string[] } {
    return { guardian: this.guardianIdentity, unlockedVaults: [...this.vaults.keys()] };
  }

  lockAll(): void {
    for (const vault of this.vaults.values()) {
      vault.secret.fill(0);
      for (const key of vault.keys.values()) key.fill(0);
      vault.keys.clear();
      for (const material of vault.secretBuffers.values()) material.fill(0);
      vault.secretBuffers.clear();
      vault.secretRecords = [];
    }
    this.vaults.clear();
    this.runnerApprovals.clear();
    this.guardianIdentity = undefined;
    this.vaultCore = undefined;
  }
}
