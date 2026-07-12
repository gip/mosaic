import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import {
  BUILTIN_ASSETS,
  BUILTIN_CHAINS,
  type AssetTrustState,
  type AssetWithTrust,
  type CatalogSnapshot,
  type ChainFamily,
  type ChainWithEnabled,
  type NetworkTag,
  type SupportedChain,
} from '@mosaic/catalog';
import type { AgentChain, Network, RootChain } from '@mosaic/zone-keys';
import { MosaicMcpError } from './errors.js';
import { MIGRATIONS } from './migrations.js';

/**
 * Persistence for the zone MCP. The store holds ONLY ciphertext and public
 * metadata — never key material, never a signature usable to derive keys.
 * Session tokens are stored hashed.
 */

export type BlobKind = 'sig' | 'pass' | 'device' | 'server' | 'data';
export type ChallengePurpose = 'session-auth' | 'authorize-zone';

export interface ChallengeRecord {
  id: string;
  purpose: ChallengePurpose;
  chain: RootChain;
  /** Null for XRPL QR login where the address is learned from the signed payload. */
  address: string | null;
  network: Network;
  /** The exact canonical message fields issued (client must sign these verbatim). */
  message: Record<string, unknown>;
  nonce: string;
  xamanPayloadUuid?: string | null;
  issuedAt: string;
  expiresAt: string;
}

export interface SessionRecord {
  chain: RootChain;
  address: string;
  network: Network;
  expiresAt: number; // epoch ms
}

export interface ZoneRecord {
  id: string;
  rootChain: RootChain;
  rootAddress: string;
  zone: string;
  network: Network;
  commitment: string;
  policyHash: string;
  localSignerPublicKey: string;
  authorizeMessage: Record<string, unknown>;
  authorizeSignature: Record<string, unknown>;
  xrplSignInTemplate: Record<string, unknown> | null;
  layer1Enabled: boolean;
  createdAt: string;
  lastUnlockedAt: string | null;
}

export interface BlobRecord {
  zoneId: string;
  kind: BlobKind;
  version: number;
  ciphertext: Uint8Array;
  header: Record<string, unknown>;
  createdAt: string;
}

export interface ZoneAddressRecord {
  id: string;
  zoneId: string;
  chain: AgentChain;
  index: number;
  name: string;
  createdAt: string;
}

export interface CatalogOwner {
  chain: RootChain;
  address: string;
}

/** Per-wallet UX settings. `lockReminderMinutes: 0` disables the Mainnet lock reminder. */
export interface WalletSettings {
  lockReminderMinutes: number;
}

export const LOCK_REMINDER_MINUTES_OPTIONS = [0, 1, 3, 5, 10, 30] as const;
export const DEFAULT_LOCK_REMINDER_MINUTES = 3;

/** Per-vault chain support, denormalized with catalog metadata for the UI. */
export interface ZoneChainSetting {
  chainId: string;
  chainKey: string;
  name: string;
  family: ChainFamily;
  network: NetworkTag;
  evmChainId?: number;
  enabled: boolean;
}

export interface CustomChainRecord {
  id: string;
  name: string;
  network: NetworkTag;
  evmChainId: number;
  enabled: boolean;
}

export interface MosaicStore {
  init(): Promise<void>;
  healthCheck(): Promise<{ ok: true }>;

  createChallenge(record: ChallengeRecord): Promise<void>;
  /** Atomic single-use consume: returns the record the first time only. */
  consumeChallenge(id: string): Promise<ChallengeRecord | undefined>;
  /** Non-consuming read of an unconsumed challenge (Xaman payload creation). */
  peekChallenge(id: string): Promise<ChallengeRecord | undefined>;
  attachXamanUuid(id: string, uuid: string): Promise<void>;

  createSession(record: SessionRecord): Promise<{ token: string }>;
  getSession(token: string): Promise<SessionRecord | undefined>;
  deleteSession(token: string): Promise<void>;

  /** Throws CONFLICT if the (chain,address,zone,network) zone already exists. */
  createZone(record: Omit<ZoneRecord, 'id' | 'createdAt' | 'lastUnlockedAt'>): Promise<ZoneRecord>;
  getZone(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined>;
  listZones(chain: RootChain, address: string, network: Network): Promise<ZoneRecord[]>;
  markZoneUnlocked(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined>;
  listZoneAddresses(zoneId: string): Promise<ZoneAddressRecord[]>;
  createZoneAddress(zoneId: string, chain: AgentChain, name?: string): Promise<ZoneAddressRecord>;

  putBlob(record: Omit<BlobRecord, 'version' | 'createdAt'> & { expectedVersion?: number }): Promise<{ version: number }>;
  /** Latest version of the given kind. */
  getBlob(zoneId: string, kind: BlobKind): Promise<BlobRecord | undefined>;
  listBlobKinds(zoneId: string): Promise<{ kind: BlobKind; version: number }[]>;

  ensureCatalogPreferences(owner: CatalogOwner): Promise<void>;
  listCatalog(owner: CatalogOwner): Promise<CatalogSnapshot>;
  /** Enables/disables every network variant of the logical chain; returns the updated variants. */
  setChainEnabled(owner: CatalogOwner, chainKey: string, enabled: boolean): Promise<ChainWithEnabled[]>;
  setAssetTrust(owner: CatalogOwner, assetId: string, state: AssetTrustState): Promise<AssetWithTrust>;

  /** Vault chain support; lazily seeded from the owner's account-level settings. */
  listZoneChainSettings(zoneId: string): Promise<ZoneChainSetting[]>;
  setZoneChainEnabled(zoneId: string, chainKey: string, enabled: boolean): Promise<ZoneChainSetting[]>;

  getWalletSettings(owner: CatalogOwner): Promise<WalletSettings>;
  setWalletSettings(owner: CatalogOwner, settings: WalletSettings): Promise<WalletSettings>;

  /** Internal administration hook. No MCP tool exposes custom-chain mutation. */
  upsertCustomChain(record: CustomChainRecord): Promise<void>;

  sweepExpired(): Promise<void>;
  close(): Promise<void>;
}

export const SESSION_TTL_MS = 60 * 60_000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export function normalizeCatalogOwner(owner: CatalogOwner): CatalogOwner {
  return {
    chain: owner.chain,
    address: owner.chain === 'evm' ? owner.address.toLowerCase() : owner.address,
  };
}

function validateWalletSettings(settings: WalletSettings): void {
  if (!(LOCK_REMINDER_MINUTES_OPTIONS as readonly number[]).includes(settings.lockReminderMinutes)) {
    throw new MosaicMcpError(
      'VALIDATION_FAILED',
      `invalid lockReminderMinutes: ${settings.lockReminderMinutes} (allowed: ${LOCK_REMINDER_MINUTES_OPTIONS.join(', ')})`,
    );
  }
}

/** The root wallet's family keeps at least one enabled chain per network so the login chain never disappears. */
function assertRootFamilyStaysEnabled(
  owner: CatalogOwner,
  chains: ChainWithEnabled[],
  targets: ChainWithEnabled[],
  enabled: boolean,
): void {
  if (enabled) return;
  const targetIds = new Set(targets.map(({ id }) => id));
  for (const tag of ['mainnet', 'testnet'] as const) {
    const familyChains = chains.filter((chain) => chain.family === owner.chain && chain.network === tag);
    if (!familyChains.some((chain) => targetIds.has(chain.id))) continue;
    if (!familyChains.some((chain) => !targetIds.has(chain.id) && chain.enabled)) {
      throw new MosaicMcpError(
        'VALIDATION_FAILED',
        `cannot disable every ${owner.chain} chain on ${tag}: the root wallet chain must stay enabled`,
      );
    }
  }
}

function validateCustomChain(record: CustomChainRecord): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id)) {
    throw new MosaicMcpError('VALIDATION_FAILED', `invalid custom chain id: ${record.id}`);
  }
  if (!record.name.trim()) throw new MosaicMcpError('VALIDATION_FAILED', 'custom chain name is required');
  if (!Number.isSafeInteger(record.evmChainId) || record.evmChainId <= 0) {
    throw new MosaicMcpError('VALIDATION_FAILED', `invalid EVM chain id: ${record.evmChainId}`);
  }
  if (BUILTIN_CHAINS.some(({ id, chainKey }) => id === record.id || chainKey === record.id)) {
    throw new MosaicMcpError('CONFLICT', `custom chain conflicts with built-in: ${record.id}`);
  }
}

// ---------------------------------------------------------------- Postgres

export class PostgresStore implements MosaicStore {
  private readonly sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 10, onnotice: () => {} });
  }

  async init(): Promise<void> {
    await this.sql`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    for (let version = 0; version < MIGRATIONS.length; version++) {
      await this.sql.begin(async (tx) => {
        const [row] = await tx`SELECT version FROM schema_migrations WHERE version = ${version} FOR UPDATE`;
        if (row) return;
        await tx.unsafe(MIGRATIONS[version]!);
        await tx`INSERT INTO schema_migrations (version) VALUES (${version})`;
      });
    }
  }

  async healthCheck(): Promise<{ ok: true }> {
    await this.sql`SELECT 1`;
    return { ok: true };
  }

  async createChallenge(record: ChallengeRecord): Promise<void> {
    await this.sql`INSERT INTO auth_challenges ${this.sql({
      id: record.id,
      purpose: record.purpose,
      chain: record.chain,
      address: record.address,
      network: record.network,
      message: this.sql.json(record.message as postgres.JSONValue),
      nonce: record.nonce,
      xaman_payload_uuid: record.xamanPayloadUuid ?? null,
      issued_at: record.issuedAt,
      expires_at: record.expiresAt,
    })}`;
  }

  async consumeChallenge(id: string): Promise<ChallengeRecord | undefined> {
    const [row] = await this.sql`
      UPDATE auth_challenges SET consumed_at = now()
      WHERE id = ${id} AND consumed_at IS NULL
      RETURNING id, purpose, chain, address, network, message, nonce, xaman_payload_uuid, issued_at, expires_at`;
    return row ? rowToChallenge(row) : undefined;
  }

  async peekChallenge(id: string): Promise<ChallengeRecord | undefined> {
    const [row] = await this.sql`
      SELECT id, purpose, chain, address, network, message, nonce, xaman_payload_uuid, issued_at, expires_at
      FROM auth_challenges WHERE id = ${id} AND consumed_at IS NULL`;
    return row ? rowToChallenge(row) : undefined;
  }

  async attachXamanUuid(id: string, uuid: string): Promise<void> {
    await this.sql`UPDATE auth_challenges SET xaman_payload_uuid = ${uuid} WHERE id = ${id} AND consumed_at IS NULL`;
  }

  async createSession(record: SessionRecord): Promise<{ token: string }> {
    const token = newToken();
    await this.sql`INSERT INTO sessions ${this.sql({
      token_hash: hashToken(token),
      chain: record.chain,
      address: record.address,
      network: record.network,
      expires_at: new Date(record.expiresAt).toISOString(),
    })}`;
    await this.ensureCatalogPreferences({ chain: record.chain, address: record.address });
    return { token };
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const [row] = await this.sql`
      SELECT chain, address, network, expires_at FROM sessions
      WHERE token_hash = ${hashToken(token)} AND expires_at > now()`;
    if (!row) return undefined;
    return {
      chain: row.chain as RootChain,
      address: row.address as string,
      network: row.network as Network,
      expiresAt: new Date(row.expires_at as string).getTime(),
    };
  }

  async deleteSession(token: string): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE token_hash = ${hashToken(token)}`;
  }

  async createZone(record: Omit<ZoneRecord, 'id' | 'createdAt' | 'lastUnlockedAt'>): Promise<ZoneRecord> {
    try {
      const [row] = await this.sql`INSERT INTO zones ${this.sql({
        root_chain: record.rootChain,
        root_address: record.rootAddress,
        zone: record.zone,
        network: record.network,
        commitment: record.commitment,
        policy_hash: record.policyHash,
        local_signer_public_key: record.localSignerPublicKey,
        authorize_message: this.sql.json(record.authorizeMessage as postgres.JSONValue),
        authorize_signature: this.sql.json(record.authorizeSignature as postgres.JSONValue),
        xrpl_signin_template: record.xrplSignInTemplate ? this.sql.json(record.xrplSignInTemplate as postgres.JSONValue) : null,
        layer1_enabled: record.layer1Enabled,
      })} RETURNING *`;
      for (const chain of ['evm', 'xrpl', 'stellar'] as const) {
        await this.sql`INSERT INTO zone_addresses (zone_id, chain, derivation_index, name) VALUES (${row!.id as string}, ${chain}, 0, '#0')`;
      }
      // The vault starts with a copy of the account-level chain settings and diverges independently.
      const catalog = await this.listCatalog({ chain: record.rootChain, address: record.rootAddress });
      for (const chain of catalog.chains.filter((chain) => chain.network === record.network)) {
        await this.sql`
          INSERT INTO zone_chain_settings (zone_id, chain_id, enabled)
          VALUES (${row!.id as string}, ${chain.id}, ${chain.enabled})
          ON CONFLICT DO NOTHING`;
      }
      return rowToZone(row!);
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new MosaicMcpError('CONFLICT', `zone already exists: ${record.zone} (${record.network})`);
      }
      throw error;
    }
  }

  async getZone(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined> {
    const [row] = await this.sql`
      SELECT * FROM zones
      WHERE root_chain = ${chain} AND root_address = ${address} AND zone = ${zone} AND network = ${network}`;
    return row ? rowToZone(row) : undefined;
  }

  async listZones(chain: RootChain, address: string, network: Network): Promise<ZoneRecord[]> {
    const rows = await this.sql`
      SELECT * FROM zones
      WHERE root_chain = ${chain} AND root_address = ${address} AND network = ${network}
      ORDER BY created_at ASC, zone ASC`;
    return rows.map(rowToZone);
  }

  async markZoneUnlocked(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined> {
    const [row] = await this.sql`
      UPDATE zones SET last_unlocked_at = now()
      WHERE root_chain = ${chain} AND root_address = ${address} AND zone = ${zone} AND network = ${network}
      RETURNING *`;
    return row ? rowToZone(row) : undefined;
  }

  async listZoneAddresses(zoneId: string): Promise<ZoneAddressRecord[]> {
    const rows = await this.sql`SELECT * FROM zone_addresses WHERE zone_id = ${zoneId} ORDER BY chain, derivation_index`;
    return rows.map(rowToZoneAddress);
  }

  async createZoneAddress(zoneId: string, chain: AgentChain, requestedName?: string): Promise<ZoneAddressRecord> {
    try {
      return await this.sql.begin(async (tx) => {
        const [zone] = await tx`SELECT id FROM zones WHERE id = ${zoneId} FOR UPDATE`;
        if (!zone) throw new MosaicMcpError('NOT_FOUND', 'zone not found');
        const [next] = await tx`SELECT COALESCE(MAX(derivation_index), -1) + 1 AS index FROM zone_addresses WHERE zone_id = ${zoneId} AND chain = ${chain}`;
        const index = Number(next!.index);
        const name = requestedName?.trim() || `#${index}`;
        const [row] = await tx`INSERT INTO zone_addresses (zone_id, chain, derivation_index, name) VALUES (${zoneId}, ${chain}, ${index}, ${name}) RETURNING *`;
        return rowToZoneAddress(row!);
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new MosaicMcpError('CONFLICT', `address name already exists: ${requestedName}`);
      throw error;
    }
  }

  async putBlob(record: Omit<BlobRecord, 'version' | 'createdAt'> & { expectedVersion?: number }): Promise<{ version: number }> {
    return this.sql.begin(async (tx) => {
      const [zone] = await tx`SELECT id FROM zones WHERE id = ${record.zoneId} FOR UPDATE`;
      if (!zone) throw new MosaicMcpError('NOT_FOUND', 'zone not found');
      const [latest] = await tx`SELECT COALESCE(MAX(version), 0) AS version FROM blobs WHERE zone_id = ${record.zoneId} AND kind = ${record.kind}`;
      const currentVersion = Number(latest!.version);
      if (record.expectedVersion !== undefined && record.expectedVersion !== currentVersion) {
        throw new MosaicMcpError('CONFLICT', `blob version conflict: expected ${record.expectedVersion}, current ${currentVersion}`);
      }
      const version = currentVersion + 1;
      await tx`
        INSERT INTO blobs (zone_id, kind, version, ciphertext, header)
        VALUES (${record.zoneId}, ${record.kind}, ${version}, ${Buffer.from(record.ciphertext)}, ${tx.json(record.header as postgres.JSONValue)})`;
      return { version };
    });
  }

  async getBlob(zoneId: string, kind: BlobKind): Promise<BlobRecord | undefined> {
    const [row] = await this.sql`
      SELECT * FROM blobs WHERE zone_id = ${zoneId} AND kind = ${kind}
      ORDER BY version DESC LIMIT 1`;
    if (!row) return undefined;
    return {
      zoneId: row.zone_id as string,
      kind: row.kind as BlobKind,
      version: row.version as number,
      ciphertext: new Uint8Array(row.ciphertext as Buffer),
      header: row.header as Record<string, unknown>,
      createdAt: new Date(row.created_at as string).toISOString(),
    };
  }

  async listBlobKinds(zoneId: string): Promise<{ kind: BlobKind; version: number }[]> {
    const rows = await this.sql`
      SELECT kind, MAX(version) AS version FROM blobs WHERE zone_id = ${zoneId} GROUP BY kind`;
    return rows.map((row) => ({ kind: row.kind as BlobKind, version: Number(row.version) }));
  }

  async ensureCatalogPreferences(rawOwner: CatalogOwner): Promise<void> {
    const owner = normalizeCatalogOwner(rawOwner);
    for (const chain of BUILTIN_CHAINS) {
      await this.sql`
        INSERT INTO chain_preferences (root_chain, root_address, chain_id, enabled)
        VALUES (${owner.chain}, ${owner.address}, ${chain.id}, TRUE)
        ON CONFLICT DO NOTHING`;
    }
    await this.sql`
      INSERT INTO chain_preferences (root_chain, root_address, chain_id, enabled)
      SELECT ${owner.chain}, ${owner.address}, id, FALSE FROM custom_chains WHERE enabled = TRUE
      ON CONFLICT DO NOTHING`;
    for (const asset of BUILTIN_ASSETS) {
      await this.sql`
        INSERT INTO asset_preferences (root_chain, root_address, asset_id, trust_state)
        VALUES (${owner.chain}, ${owner.address}, ${asset.id}, 'allowed')
        ON CONFLICT DO NOTHING`;
    }
  }

  async listCatalog(rawOwner: CatalogOwner): Promise<CatalogSnapshot> {
    const owner = normalizeCatalogOwner(rawOwner);
    await this.ensureCatalogPreferences(owner);
    const customRows = await this.sql`
      SELECT id, name, network, evm_chain_id FROM custom_chains WHERE enabled = TRUE ORDER BY name, id`;
    const customChains: SupportedChain[] = customRows.flatMap((row) => {
      const id = row.id as string;
      const evmChainId = Number(row.evm_chain_id);
      if (BUILTIN_CHAINS.some((chain) => chain.id === id) || !Number.isSafeInteger(evmChainId) || evmChainId <= 0) {
        return [];
      }
      return [{
        id,
        chainKey: id,
        name: row.name as string,
        family: 'evm' as const,
        network: row.network as NetworkTag,
        source: 'database' as const,
        evmChainId,
      }];
    });
    const chainRows = await this.sql`
      SELECT chain_id, enabled FROM chain_preferences
      WHERE root_chain = ${owner.chain} AND root_address = ${owner.address}`;
    const chainEnabled = new Map(chainRows.map((row) => [row.chain_id as string, row.enabled as boolean]));
    const assetRows = await this.sql`
      SELECT asset_id, trust_state FROM asset_preferences
      WHERE root_chain = ${owner.chain} AND root_address = ${owner.address}`;
    const assetTrust = new Map(assetRows.map((row) => [row.asset_id as string, row.trust_state as AssetTrustState]));
    return {
      chains: [...BUILTIN_CHAINS, ...customChains].map((chain) => ({ ...chain, enabled: chainEnabled.get(chain.id) ?? false })),
      assets: BUILTIN_ASSETS.map((asset) => ({
        ...asset,
        deployments: [...asset.deployments],
        trustState: assetTrust.get(asset.id) ?? 'review',
      })),
    };
  }

  async setChainEnabled(owner: CatalogOwner, chainKey: string, enabled: boolean): Promise<ChainWithEnabled[]> {
    const catalog = await this.listCatalog(owner);
    const targets = catalog.chains.filter((chain) => chain.chainKey === chainKey);
    if (targets.length === 0) throw new MosaicMcpError('NOT_FOUND', `unknown chain: ${chainKey}`);
    assertRootFamilyStaysEnabled(owner, catalog.chains, targets, enabled);
    const normalized = normalizeCatalogOwner(owner);
    for (const chain of targets) {
      await this.sql`
        INSERT INTO chain_preferences (root_chain, root_address, chain_id, enabled, updated_at)
        VALUES (${normalized.chain}, ${normalized.address}, ${chain.id}, ${enabled}, now())
        ON CONFLICT (root_chain, root_address, chain_id)
        DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`;
    }
    return targets.map((chain) => ({ ...chain, enabled }));
  }

  async setAssetTrust(owner: CatalogOwner, assetId: string, state: AssetTrustState): Promise<AssetWithTrust> {
    if (!(['hidden', 'review', 'allowed'] as const).includes(state)) {
      throw new MosaicMcpError('VALIDATION_FAILED', `invalid asset trust state: ${String(state)}`);
    }
    const catalog = await this.listCatalog(owner);
    const asset = catalog.assets.find(({ id }) => id === assetId);
    if (!asset) throw new MosaicMcpError('NOT_FOUND', `unknown asset: ${assetId}`);
    const normalized = normalizeCatalogOwner(owner);
    await this.sql`
      INSERT INTO asset_preferences (root_chain, root_address, asset_id, trust_state, updated_at)
      VALUES (${normalized.chain}, ${normalized.address}, ${assetId}, ${state}, now())
      ON CONFLICT (root_chain, root_address, asset_id)
      DO UPDATE SET trust_state = EXCLUDED.trust_state, updated_at = now()`;
    return { ...asset, trustState: state };
  }

  async getWalletSettings(owner: CatalogOwner): Promise<WalletSettings> {
    const normalized = normalizeCatalogOwner(owner);
    const [row] = await this.sql`
      SELECT lock_reminder_minutes FROM wallet_settings
      WHERE root_chain = ${normalized.chain} AND root_address = ${normalized.address}`;
    if (!row) return { lockReminderMinutes: DEFAULT_LOCK_REMINDER_MINUTES };
    return { lockReminderMinutes: Number(row.lock_reminder_minutes) };
  }

  async setWalletSettings(owner: CatalogOwner, settings: WalletSettings): Promise<WalletSettings> {
    validateWalletSettings(settings);
    const normalized = normalizeCatalogOwner(owner);
    await this.sql`
      INSERT INTO wallet_settings (root_chain, root_address, lock_reminder_minutes, updated_at)
      VALUES (${normalized.chain}, ${normalized.address}, ${settings.lockReminderMinutes}, now())
      ON CONFLICT (root_chain, root_address)
      DO UPDATE SET lock_reminder_minutes = EXCLUDED.lock_reminder_minutes, updated_at = now()`;
    return { lockReminderMinutes: settings.lockReminderMinutes };
  }

  async listZoneChainSettings(zoneId: string): Promise<ZoneChainSetting[]> {
    const [zoneRow] = await this.sql`SELECT * FROM zones WHERE id = ${zoneId}`;
    if (!zoneRow) throw new MosaicMcpError('NOT_FOUND', 'zone not found');
    const zone = rowToZone(zoneRow);
    const catalog = await this.listCatalog({ chain: zone.rootChain, address: zone.rootAddress });
    const rows = await this.sql`SELECT chain_id, enabled FROM zone_chain_settings WHERE zone_id = ${zoneId}`;
    const existing = new Map(rows.map((row) => [row.chain_id as string, row.enabled as boolean]));
    const out: ZoneChainSetting[] = [];
    for (const chain of catalog.chains.filter((chain) => chain.network === zone.network)) {
      let enabled = existing.get(chain.id);
      if (enabled === undefined) {
        // Pre-existing vaults and chains added after creation copy the account-level value.
        enabled = chain.enabled;
        await this.sql`
          INSERT INTO zone_chain_settings (zone_id, chain_id, enabled)
          VALUES (${zoneId}, ${chain.id}, ${enabled})
          ON CONFLICT DO NOTHING`;
      }
      out.push({
        chainId: chain.id, chainKey: chain.chainKey, name: chain.name,
        family: chain.family, network: chain.network, evmChainId: chain.evmChainId, enabled,
      });
    }
    return out;
  }

  async setZoneChainEnabled(zoneId: string, chainKey: string, enabled: boolean): Promise<ZoneChainSetting[]> {
    const settings = await this.listZoneChainSettings(zoneId);
    const targetIds = settings.filter((setting) => setting.chainKey === chainKey).map(({ chainId }) => chainId);
    if (targetIds.length === 0) throw new MosaicMcpError('NOT_FOUND', `unknown chain: ${chainKey}`);
    await this.sql`
      UPDATE zone_chain_settings SET enabled = ${enabled}, updated_at = now()
      WHERE zone_id = ${zoneId} AND chain_id = ANY(${this.sql.array(targetIds)})`;
    return settings.map((setting) => (setting.chainKey === chainKey ? { ...setting, enabled } : setting));
  }

  async upsertCustomChain(record: CustomChainRecord): Promise<void> {
    validateCustomChain(record);
    await this.sql`
      INSERT INTO custom_chains (id, name, family, network, evm_chain_id, enabled)
      VALUES (${record.id}, ${record.name.trim()}, 'evm', ${record.network}, ${record.evmChainId}, ${record.enabled})
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name, network = EXCLUDED.network, evm_chain_id = EXCLUDED.evm_chain_id,
        enabled = EXCLUDED.enabled, updated_at = now()`;
  }

  async sweepExpired(): Promise<void> {
    await this.sql`DELETE FROM sessions WHERE expires_at < now()`;
    await this.sql`DELETE FROM auth_challenges WHERE expires_at < now() - interval '1 day'`;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

function rowToChallenge(row: postgres.Row): ChallengeRecord {
  return {
    id: row.id as string,
    purpose: row.purpose as ChallengePurpose,
    chain: row.chain as RootChain,
    address: (row.address as string | null) ?? null,
    network: row.network as Network,
    message: row.message as Record<string, unknown>,
    nonce: row.nonce as string,
    xamanPayloadUuid: (row.xaman_payload_uuid as string | null) ?? null,
    issuedAt: new Date(row.issued_at as string).toISOString(),
    expiresAt: new Date(row.expires_at as string).toISOString(),
  };
}

function rowToZone(row: postgres.Row): ZoneRecord {
  return {
    id: row.id as string,
    rootChain: row.root_chain as RootChain,
    rootAddress: row.root_address as string,
    zone: row.zone as string,
    network: row.network as Network,
    commitment: row.commitment as string,
    policyHash: row.policy_hash as string,
    localSignerPublicKey: row.local_signer_public_key as string,
    authorizeMessage: row.authorize_message as Record<string, unknown>,
    authorizeSignature: row.authorize_signature as Record<string, unknown>,
    xrplSignInTemplate: (row.xrpl_signin_template as Record<string, unknown> | null) ?? null,
    layer1Enabled: row.layer1_enabled as boolean,
    createdAt: new Date(row.created_at as string).toISOString(),
    lastUnlockedAt: row.last_unlocked_at ? new Date(row.last_unlocked_at as string).toISOString() : null,
  };
}

function rowToZoneAddress(row: postgres.Row): ZoneAddressRecord {
  return {
    id: row.id as string,
    zoneId: row.zone_id as string,
    chain: row.chain as AgentChain,
    index: row.derivation_index as number,
    name: row.name as string,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

// ------------------------------------------------------------------ Memory

/** In-memory store with identical semantics — used by tests and stdio dev mode. */
export class MemoryStore implements MosaicStore {
  private challenges = new Map<string, ChallengeRecord & { consumed?: boolean }>();
  private sessions = new Map<string, SessionRecord>();
  private zones = new Map<string, ZoneRecord>();
  private blobs = new Map<string, BlobRecord[]>();
  private zoneAddresses = new Map<string, ZoneAddressRecord[]>();
  private nonces = new Set<string>();
  private customChains = new Map<string, CustomChainRecord>();
  /** owner key → chain id → enabled */
  private chainPreferences = new Map<string, Map<string, boolean>>();
  private assetPreferences = new Map<string, Map<string, AssetTrustState>>();
  private walletSettings = new Map<string, WalletSettings>();
  /** zone id → chain id → enabled */
  private zoneChainSettings = new Map<string, Map<string, boolean>>();

  async init(): Promise<void> {}
  async healthCheck(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async createChallenge(record: ChallengeRecord): Promise<void> {
    if (this.nonces.has(record.nonce)) throw new MosaicMcpError('CONFLICT', 'nonce already used');
    this.nonces.add(record.nonce);
    this.challenges.set(record.id, { ...record });
  }

  async consumeChallenge(id: string): Promise<ChallengeRecord | undefined> {
    const record = this.challenges.get(id);
    if (!record || record.consumed) return undefined;
    record.consumed = true;
    return { ...record };
  }

  async peekChallenge(id: string): Promise<ChallengeRecord | undefined> {
    const record = this.challenges.get(id);
    if (!record || record.consumed) return undefined;
    return { ...record };
  }

  async attachXamanUuid(id: string, uuid: string): Promise<void> {
    const record = this.challenges.get(id);
    if (record && !record.consumed) record.xamanPayloadUuid = uuid;
  }

  async createSession(record: SessionRecord): Promise<{ token: string }> {
    const token = newToken();
    this.sessions.set(hashToken(token), { ...record });
    await this.ensureCatalogPreferences({ chain: record.chain, address: record.address });
    return { token };
  }

  async getSession(token: string): Promise<SessionRecord | undefined> {
    const session = this.sessions.get(hashToken(token));
    if (!session || session.expiresAt < Date.now()) return undefined;
    return session;
  }

  async deleteSession(token: string): Promise<void> {
    this.sessions.delete(hashToken(token));
  }

  async createZone(record: Omit<ZoneRecord, 'id' | 'createdAt' | 'lastUnlockedAt'>): Promise<ZoneRecord> {
    const key = `${record.rootChain}|${record.rootAddress}|${record.zone}|${record.network}`;
    if (this.zones.has(key)) {
      throw new MosaicMcpError('CONFLICT', `zone already exists: ${record.zone} (${record.network})`);
    }
    const zone: ZoneRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString(), lastUnlockedAt: null };
    this.zones.set(key, zone);
    this.zoneAddresses.set(zone.id, (['evm', 'xrpl', 'stellar'] as const).map((chain) => ({
      id: randomUUID(), zoneId: zone.id, chain, index: 0, name: '#0', createdAt: zone.createdAt,
    })));
    // The vault starts with a copy of the account-level chain settings and diverges independently.
    const catalog = await this.listCatalog({ chain: record.rootChain, address: record.rootAddress });
    this.zoneChainSettings.set(zone.id, new Map(
      catalog.chains.filter((chain) => chain.network === record.network).map((chain) => [chain.id, chain.enabled]),
    ));
    return zone;
  }

  async getZone(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined> {
    return this.zones.get(`${chain}|${address}|${zone}|${network}`);
  }

  async listZones(chain: RootChain, address: string, network: Network): Promise<ZoneRecord[]> {
    return [...this.zones.values()]
      .filter((record) => record.rootChain === chain && record.rootAddress === address && record.network === network)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.zone.localeCompare(b.zone));
  }

  async markZoneUnlocked(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined> {
    const record = await this.getZone(chain, address, zone, network);
    if (!record) return undefined;
    record.lastUnlockedAt = new Date().toISOString();
    return record;
  }

  async listZoneAddresses(zoneId: string): Promise<ZoneAddressRecord[]> {
    return [...(this.zoneAddresses.get(zoneId) ?? [])].sort((a, b) => a.chain.localeCompare(b.chain) || a.index - b.index);
  }

  async createZoneAddress(zoneId: string, chain: AgentChain, requestedName?: string): Promise<ZoneAddressRecord> {
    const list = this.zoneAddresses.get(zoneId);
    if (!list) throw new MosaicMcpError('NOT_FOUND', 'zone not found');
    const index = Math.max(-1, ...list.filter((item) => item.chain === chain).map((item) => item.index)) + 1;
    const name = requestedName?.trim() || `#${index}`;
    if (list.some((item) => item.chain === chain && item.name === name)) {
      throw new MosaicMcpError('CONFLICT', `address name already exists: ${name}`);
    }
    const record = { id: randomUUID(), zoneId, chain, index, name, createdAt: new Date().toISOString() };
    list.push(record);
    return record;
  }

  async putBlob(record: Omit<BlobRecord, 'version' | 'createdAt'> & { expectedVersion?: number }): Promise<{ version: number }> {
    const key = `${record.zoneId}|${record.kind}`;
    const list = this.blobs.get(key) ?? [];
    const currentVersion = list[list.length - 1]?.version ?? 0;
    if (record.expectedVersion !== undefined && record.expectedVersion !== currentVersion) {
      throw new MosaicMcpError('CONFLICT', `blob version conflict: expected ${record.expectedVersion}, current ${currentVersion}`);
    }
    const version = currentVersion + 1;
    list.push({ ...record, ciphertext: record.ciphertext.slice(), version, createdAt: new Date().toISOString() });
    this.blobs.set(key, list);
    return { version };
  }

  async getBlob(zoneId: string, kind: BlobKind): Promise<BlobRecord | undefined> {
    const list = this.blobs.get(`${zoneId}|${kind}`);
    return list?.[list.length - 1];
  }

  async listBlobKinds(zoneId: string): Promise<{ kind: BlobKind; version: number }[]> {
    const out: { kind: BlobKind; version: number }[] = [];
    for (const kind of ['sig', 'pass', 'device', 'server'] as const) {
      const blob = await this.getBlob(zoneId, kind);
      if (blob) out.push({ kind, version: blob.version });
    }
    return out;
  }

  async ensureCatalogPreferences(rawOwner: CatalogOwner): Promise<void> {
    const owner = normalizeCatalogOwner(rawOwner);
    const key = `${owner.chain}|${owner.address}`;
    const chains = this.chainPreferences.get(key) ?? new Map<string, boolean>();
    for (const chain of BUILTIN_CHAINS) if (!chains.has(chain.id)) chains.set(chain.id, true);
    for (const chain of this.customChains.values()) if (chain.enabled && !chains.has(chain.id)) chains.set(chain.id, false);
    this.chainPreferences.set(key, chains);
    const assets = this.assetPreferences.get(key) ?? new Map<string, AssetTrustState>();
    for (const asset of BUILTIN_ASSETS) if (!assets.has(asset.id)) assets.set(asset.id, 'allowed');
    this.assetPreferences.set(key, assets);
  }

  async listCatalog(rawOwner: CatalogOwner): Promise<CatalogSnapshot> {
    const owner = normalizeCatalogOwner(rawOwner);
    await this.ensureCatalogPreferences(owner);
    const key = `${owner.chain}|${owner.address}`;
    const enabledById = this.chainPreferences.get(key)!;
    const custom: SupportedChain[] = [...this.customChains.values()]
      .filter(({ enabled }) => enabled)
      .map(({ id, name, network, evmChainId }) => ({ id, chainKey: id, name, family: 'evm', network, source: 'database', evmChainId }));
    const states = this.assetPreferences.get(key)!;
    return {
      chains: [...BUILTIN_CHAINS, ...custom].map((chain) => ({ ...chain, enabled: enabledById.get(chain.id) ?? false })),
      assets: BUILTIN_ASSETS.map((asset) => ({
        ...asset,
        deployments: [...asset.deployments],
        trustState: states.get(asset.id) ?? 'review',
      })),
    };
  }

  async setChainEnabled(owner: CatalogOwner, chainKey: string, enabled: boolean): Promise<ChainWithEnabled[]> {
    const catalog = await this.listCatalog(owner);
    const targets = catalog.chains.filter((chain) => chain.chainKey === chainKey);
    if (targets.length === 0) throw new MosaicMcpError('NOT_FOUND', `unknown chain: ${chainKey}`);
    assertRootFamilyStaysEnabled(owner, catalog.chains, targets, enabled);
    const normalized = normalizeCatalogOwner(owner);
    const preferences = this.chainPreferences.get(`${normalized.chain}|${normalized.address}`)!;
    for (const chain of targets) preferences.set(chain.id, enabled);
    return targets.map((chain) => ({ ...chain, enabled }));
  }

  async setAssetTrust(owner: CatalogOwner, assetId: string, state: AssetTrustState): Promise<AssetWithTrust> {
    if (!(['hidden', 'review', 'allowed'] as const).includes(state)) {
      throw new MosaicMcpError('VALIDATION_FAILED', `invalid asset trust state: ${String(state)}`);
    }
    const catalog = await this.listCatalog(owner);
    const asset = catalog.assets.find(({ id }) => id === assetId);
    if (!asset) throw new MosaicMcpError('NOT_FOUND', `unknown asset: ${assetId}`);
    const normalized = normalizeCatalogOwner(owner);
    this.assetPreferences.get(`${normalized.chain}|${normalized.address}`)!.set(assetId, state);
    return { ...asset, trustState: state };
  }

  async getWalletSettings(owner: CatalogOwner): Promise<WalletSettings> {
    const normalized = normalizeCatalogOwner(owner);
    const settings = this.walletSettings.get(`${normalized.chain}|${normalized.address}`);
    return settings ? { ...settings } : { lockReminderMinutes: DEFAULT_LOCK_REMINDER_MINUTES };
  }

  async setWalletSettings(owner: CatalogOwner, settings: WalletSettings): Promise<WalletSettings> {
    validateWalletSettings(settings);
    const normalized = normalizeCatalogOwner(owner);
    this.walletSettings.set(`${normalized.chain}|${normalized.address}`, { ...settings });
    return { ...settings };
  }

  async listZoneChainSettings(zoneId: string): Promise<ZoneChainSetting[]> {
    const zone = [...this.zones.values()].find((record) => record.id === zoneId);
    if (!zone) throw new MosaicMcpError('NOT_FOUND', 'zone not found');
    const catalog = await this.listCatalog({ chain: zone.rootChain, address: zone.rootAddress });
    const settings = this.zoneChainSettings.get(zoneId) ?? new Map<string, boolean>();
    this.zoneChainSettings.set(zoneId, settings);
    const out: ZoneChainSetting[] = [];
    for (const chain of catalog.chains.filter((chain) => chain.network === zone.network)) {
      let enabled = settings.get(chain.id);
      if (enabled === undefined) {
        // Pre-existing vaults and chains added after creation copy the account-level value.
        enabled = chain.enabled;
        settings.set(chain.id, enabled);
      }
      out.push({
        chainId: chain.id, chainKey: chain.chainKey, name: chain.name,
        family: chain.family, network: chain.network, evmChainId: chain.evmChainId, enabled,
      });
    }
    return out;
  }

  async setZoneChainEnabled(zoneId: string, chainKey: string, enabled: boolean): Promise<ZoneChainSetting[]> {
    const settings = await this.listZoneChainSettings(zoneId);
    const targets = settings.filter((setting) => setting.chainKey === chainKey);
    if (targets.length === 0) throw new MosaicMcpError('NOT_FOUND', `unknown chain: ${chainKey}`);
    const stored = this.zoneChainSettings.get(zoneId)!;
    for (const target of targets) stored.set(target.chainId, enabled);
    return settings.map((setting) => (setting.chainKey === chainKey ? { ...setting, enabled } : setting));
  }

  async upsertCustomChain(record: CustomChainRecord): Promise<void> {
    validateCustomChain(record);
    this.customChains.set(record.id, { ...record, name: record.name.trim() });
  }

  async sweepExpired(): Promise<void> {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt < now) this.sessions.delete(key);
  }

  async close(): Promise<void> {}
}

export function openMosaicStore(databaseUrl?: string): MosaicStore {
  return databaseUrl ? new PostgresStore(databaseUrl) : new MemoryStore();
}
