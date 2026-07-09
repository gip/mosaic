import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { Network, RootChain } from '@mosaic/zone-keys';
import { MosaicMcpError } from './errors.js';
import { MIGRATIONS } from './migrations.js';

/**
 * Persistence for the zone MCP. The store holds ONLY ciphertext and public
 * metadata — never key material, never a signature usable to derive keys.
 * Session tokens are stored hashed.
 */

export type BlobKind = 'sig' | 'pass';
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
}

export interface BlobRecord {
  zoneId: string;
  kind: BlobKind;
  version: number;
  ciphertext: Uint8Array;
  header: Record<string, unknown>;
  createdAt: string;
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
  createZone(record: Omit<ZoneRecord, 'id' | 'createdAt'>): Promise<ZoneRecord>;
  getZone(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined>;

  putBlob(record: Omit<BlobRecord, 'version' | 'createdAt'>): Promise<{ version: number }>;
  /** Latest version of the given kind. */
  getBlob(zoneId: string, kind: BlobKind): Promise<BlobRecord | undefined>;
  listBlobKinds(zoneId: string): Promise<{ kind: BlobKind; version: number }[]>;

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

  async createZone(record: Omit<ZoneRecord, 'id' | 'createdAt'>): Promise<ZoneRecord> {
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

  async putBlob(record: Omit<BlobRecord, 'version' | 'createdAt'>): Promise<{ version: number }> {
    const [row] = await this.sql`
      INSERT INTO blobs (zone_id, kind, version, ciphertext, header)
      VALUES (
        ${record.zoneId}, ${record.kind},
        COALESCE((SELECT MAX(version) FROM blobs WHERE zone_id = ${record.zoneId} AND kind = ${record.kind}), 0) + 1,
        ${Buffer.from(record.ciphertext)}, ${this.sql.json(record.header as postgres.JSONValue)}
      ) RETURNING version`;
    return { version: row!.version as number };
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
  };
}

// ------------------------------------------------------------------ Memory

/** In-memory store with identical semantics — used by tests and stdio dev mode. */
export class MemoryStore implements MosaicStore {
  private challenges = new Map<string, ChallengeRecord & { consumed?: boolean }>();
  private sessions = new Map<string, SessionRecord>();
  private zones = new Map<string, ZoneRecord>();
  private blobs = new Map<string, BlobRecord[]>();
  private nonces = new Set<string>();

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

  async createZone(record: Omit<ZoneRecord, 'id' | 'createdAt'>): Promise<ZoneRecord> {
    const key = `${record.rootChain}|${record.rootAddress}|${record.zone}|${record.network}`;
    if (this.zones.has(key)) {
      throw new MosaicMcpError('CONFLICT', `zone already exists: ${record.zone} (${record.network})`);
    }
    const zone: ZoneRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
    this.zones.set(key, zone);
    return zone;
  }

  async getZone(chain: RootChain, address: string, zone: string, network: Network): Promise<ZoneRecord | undefined> {
    return this.zones.get(`${chain}|${address}|${zone}|${network}`);
  }

  async putBlob(record: Omit<BlobRecord, 'version' | 'createdAt'>): Promise<{ version: number }> {
    const key = `${record.zoneId}|${record.kind}`;
    const list = this.blobs.get(key) ?? [];
    const version = (list[list.length - 1]?.version ?? 0) + 1;
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
    for (const kind of ['sig', 'pass'] as const) {
      const blob = await this.getBlob(zoneId, kind);
      if (blob) out.push({ kind, version: blob.version });
    }
    return out;
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
