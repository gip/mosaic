import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Client, ClientOptions, Signer, XmtpEnv } from '@xmtp/node-sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { argon2id } from 'hash-wasm';
import {
  decodeBackupBlob,
  deriveEvmAgentKey,
  openPassphraseBlob,
  openSignatureBlob,
  openVaultData,
  passphraseKdfParams,
  sealVaultData,
  zoneSeed,
  type BlobHeader,
  type Network,
  type RootChain,
  type VaultDataBlobHeader,
  type VaultDataV1,
  type ZoneRef,
} from '@mosaic/zone-keys';
import {
  mosaicRuntimeDirectory,
  type AgentManifest,
  type CapabilityAllowance,
  type ExecutionGrant,
  type MosaicNetwork,
  type RunnerCertificate,
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
  zoneAddressCreate(token: string, zone: string, chain: 'evm', name: string): Promise<ZoneAddress>;
  zoneTestnetUnlock(token: string, zone: string): Promise<{ commitment: string; zoneRootSecretB64: string }>;
  zoneUnlocked(token: string, zone: string): Promise<void>;
  blobGet(token: string, zone: string, kind: 'sig' | 'pass' | 'data'): Promise<BlobResult>;
  blobPut(args: { token: string; zone: string; kind: 'data'; ciphertextB64: string; header: Record<string, unknown>; expectedVersion: number }): Promise<{ version: number }>;
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
  zoneAddressCreate(token: string, zone: string, chain: 'evm', name: string): Promise<ZoneAddress> {
    return this.call('zone_address_create', { token, zone, chain, name });
  }
  zoneTestnetUnlock(token: string, zone: string): Promise<{ commitment: string; zoneRootSecretB64: string }> {
    return this.call('zone_testnet_unlock', { token, zone });
  }
  async zoneUnlocked(token: string, zone: string): Promise<void> { await this.call('zone_unlocked', { token, zone }); }
  blobGet(token: string, zone: string, kind: 'sig' | 'pass' | 'data'): Promise<BlobResult> {
    return this.call('blob_get', { token, zone, kind });
  }
  blobPut(args: { token: string; zone: string; kind: 'data'; ciphertextB64: string; header: Record<string, unknown>; expectedVersion: number }): Promise<{ version: number }> {
    return this.call('blob_put', args);
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
  keys: Map<string, Uint8Array>;
}

function bytesToBase64(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64'); }
function base64ToBytes(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, 'base64')); }

/** FROZEN domain for deterministic encryption of the persistent XMTP installation database. */
function xmtpDbKey(privateKey: Uint8Array, network: MosaicNetwork): Uint8Array {
  return sha256(concatBytes(utf8ToBytes('MOSAIC_XMTP_DB_V1'), utf8ToBytes(network), privateKey));
}

function xmtpEnvironment(network: MosaicNetwork): 'dev' | 'production' {
  return network === 'testnet' ? 'dev' : 'production';
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

export function assertXmtpSignatureText(message: string): void {
  if (
    message.length === 0 || message.length > 16 * 1024 || message.includes('\0') ||
    !message.startsWith('XMTP : ') || !message.includes('For more info: https://xmtp.org/signatures/')
  ) {
    throw new Error('refusing non-XMTP signature text');
  }
}

function signerFor(address: string, signMessage: (message: string) => Promise<Uint8Array>): Signer {
  return {
    type: 'EOA',
    getIdentifier: () => ({ identifier: address.toLowerCase(), identifierKind: 0 }),
    signMessage,
  };
}

export class GuardianService {
  private session?: GuardianSession;
  private readonly vaults = new Map<string, UnlockedVault>();
  private guardianIdentity?: UnlockedIdentity;
  private guardianClient?: Client<unknown>;
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

    let data: VaultDataV1 = { v: 1 };
    let dataVersion = 0;
    try {
      const blob = await this.api.blobGet(session.token, vault, 'data');
      data = openVaultData(secret, ref, {
        header: blob.header as unknown as VaultDataBlobHeader,
        ciphertext: base64ToBytes(blob.ciphertextB64),
      });
      dataVersion = blob.version;
    } catch (error) {
      if ((error as { code?: string }).code !== 'NOT_FOUND' && !String(error).includes('no data blob')) {
        secret.fill(0);
        throw error;
      }
    }
    this.vaults.set(vault, { ref, item, secret, data, dataVersion, keys: new Map() });
    await this.api.zoneUnlocked(session.token, vault);
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
    const identity = { vault, name, index: address.index, address: derived.address };
    unlocked.data = {
      ...unlocked.data,
      identities: {
        ...unlocked.data.identities,
        [name]: { chain: 'evm', addressName: name, address: derived.address, index: address.index },
      },
    };
    await this.saveData(unlocked);
    return identity;
  }

  private async saveData(unlocked: UnlockedVault): Promise<void> {
    const session = this.requireSession(unlocked.ref.network);
    const revision = unlocked.dataVersion + 1;
    const sealed = sealVaultData(unlocked.secret, unlocked.ref, unlocked.data, revision);
    const saved = await this.api.blobPut({
      token: session.token,
      zone: unlocked.ref.zone,
      kind: 'data',
      ciphertextB64: bytesToBase64(sealed.ciphertext),
      header: sealed.header as unknown as Record<string, unknown>,
      expectedVersion: unlocked.dataVersion,
    });
    unlocked.dataVersion = saved.version;
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
    if (process.env.MOSAIC_XMTP_DISABLED !== '1') await this.startGuardianXmtp(identity, network);
    return identity;
  }

  private async startGuardianXmtp(identity: UnlockedIdentity, network: MosaicNetwork): Promise<void> {
    if (this.guardianClient) return;
    const unlocked = this.requireVault(identity.vault);
    const privateKey = unlocked.keys.get(identity.name)!;
    const env = xmtpEnvironment(network);
    const { Client: XmtpClient } = await import('@xmtp/node-sdk');
    const dbRoot = join(mosaicRuntimeDirectory(), 'xmtp');
    await mkdir(dbRoot, { recursive: true, mode: 0o700 });
    const clientOptions: ClientOptions = {
      env: env as XmtpEnv,
      appVersion: 'mosaic-guardian/0.0.0',
      dbPath: (inboxId) => join(dbRoot, `guardian-${env}-${inboxId}.db3`),
      dbEncryptionKey: xmtpDbKey(privateKey, network),
    };
    const client = await XmtpClient.create(
      signerFor(identity.address, async (message) => {
        assertXmtpSignatureText(message);
        return signEip191(privateKey, message);
      }),
      clientOptions,
    );
    this.guardianClient = client as Client<unknown>;
  }

  enrollRunner(params: { runnerId: string; runnerPublicKey: string; network: MosaicNetwork; environment: 'local' | 'remote' }): RunnerCertificate {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    return this.vaultCore.enrollRunner(params);
  }

  issueGrant(params: {
    certificate: RunnerCertificate;
    manifest: AgentManifest;
    configDigest: string;
    policyDigest: string;
    capabilities: CapabilityAllowance[];
  }): ExecutionGrant {
    if (!this.vaultCore) throw new Error('Mosaic Guardian is not running');
    return this.vaultCore.issueGrant(params);
  }

  status(): { guardian?: UnlockedIdentity; unlockedVaults: string[] } {
    return { guardian: this.guardianIdentity, unlockedVaults: [...this.vaults.keys()] };
  }

  lockAll(): void {
    for (const vault of this.vaults.values()) {
      vault.secret.fill(0);
      for (const key of vault.keys.values()) key.fill(0);
      vault.keys.clear();
    }
    this.vaults.clear();
    this.guardianIdentity = undefined;
    this.guardianClient = undefined;
    this.vaultCore = undefined;
  }
}
