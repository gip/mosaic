import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AssetTrustState } from '@mosaic/catalog';
import {
  AGENT_ARTIFACT_PROTOCOL,
  AGENT_RUNTIME_VERSION,
  artifactDigest,
  assertArtifactManifest,
  sha256Hex,
  type AgentArtifactManifest,
} from '@mosaic/local-runtime';
import { authorizeZoneMessage, backupWrapMessage, verifyCommitment, type AgentChain, type Network, type ZoneRef } from '@mosaic/zone-keys';
import { xrplSignInTxJson } from '@mosaic/zone-keys/verify';
import { AuthService, validateChain, validateNetwork, type SignatureEnvelope, type Session } from './auth.js';
import { MosaicMcpError, mcpErrorContent } from './errors.js';
import { createStderrLogger, type MosaicLogger } from './logging.js';
import { MemoryStore, type BlobKind, type MosaicStore } from './store.js';
import { openTestnetSecret, sealTestnetSecret, TESTNET_SERVER_POLICY } from './testnetVault.js';
import type { XamanService } from './xaman.js';

export interface MosaicMcpOptions {
  store?: MosaicStore;
  auth?: AuthService;
  xaman?: XamanService;
  logger?: MosaicLogger;
  /** Persistent server-side envelope key for the explicitly custodial Testnet sandbox mode. */
  testnetVaultKey?: Uint8Array;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
// A tool failure must set the protocol-level isError flag, not just embed
// {ok:false} in text — otherwise generic MCP clients read failures as results.
const fail = (error: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, ...mcpErrorContent(error) }) }],
  isError: true,
});

const MAX_BLOB_BYTES = 4 * 1024;
const MAX_DATA_BLOB_BYTES = 64 * 1024 + 16; // v1 plaintext limit plus XChaCha20-Poly1305 tag
const MAX_AGENT_SECRET_BLOB_BYTES = 64 * 1024 + 16;
const MAX_AGENT_ARTIFACT_BYTES = 2 * 1024 * 1024;
const zoneNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const signatureSchema = z.union([
  z.object({ type: z.literal('evm'), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
  z.object({ type: z.literal('stellar'), signatureB64: z.string() }),
  z.object({ type: z.literal('xrpl'), payloadUuid: z.string() }),
]);

export function createMosaicMcpServer(opts: MosaicMcpOptions = {}): McpServer {
  const store = opts.store ?? new MemoryStore();
  const auth = opts.auth ?? new AuthService(store, opts.xaman);
  const logger = opts.logger ?? createStderrLogger();

  const server = new McpServer({ name: 'mosaic-zone-mcp', version: '0.0.0' });

  const reg = (
    name: string,
    config: { description: string; inputSchema: Record<string, z.ZodTypeAny> },
    handler: ToolHandler,
  ): void => {
    const wrapped: ToolHandler = async (args) => {
      try {
        return await handler(args);
      } catch (error) {
        logger.warn?.(`tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        return fail(error);
      }
    };
    (server.registerTool as unknown as (n: string, c: unknown, h: ToolHandler) => void)(name, config, wrapped);
  };

  const requireSession = (args: Record<string, unknown>): Promise<Session> => {
    const token = args.token;
    if (typeof token !== 'string' || !token) {
      throw new MosaicMcpError('VALIDATION_FAILED', 'missing session token');
    }
    return auth.requireSession(token);
  };

  /** Resolve a zone owned by the session, or throw NOT_FOUND. */
  const requireZone = async (session: Session, zone: string) => {
    const record = await store.getZone(session.chain, session.address, zone, session.network);
    if (!record) throw new MosaicMcpError('NOT_FOUND', `zone not found: ${zone} (${session.network})`);
    return record;
  };

  reg(
    'auth_challenge',
    {
      description:
        'Begin wallet login. Returns the canonical session-auth message to sign (EVM: EIP-712 with evmChainId; Stellar: SEP-53 over the canonical JSON). For XRPL, returns a Xaman SignIn payload (QR png + status websocket) instead.',
      inputSchema: {
        chain: z.enum(['evm', 'xrpl', 'stellar']),
        network: z.enum(['mainnet', 'testnet']),
        address: z.string().optional().describe('Root address; required for evm/stellar'),
      },
    },
    async (args) =>
      ok(
        await auth.challenge({
          chain: validateChain(String(args.chain)),
          network: validateNetwork(String(args.network)),
          address: args.address ? String(args.address) : undefined,
        }),
      ),
  );

  reg(
    'auth_verify',
    {
      description:
        'Complete wallet login: verify the signed session-auth challenge and mint a session token. For XRPL the signature is fetched from the Xaman payload attached to the challenge.',
      inputSchema: {
        challengeId: z.string(),
        signature: signatureSchema.optional(),
      },
    },
    async (args) =>
      ok(
        await auth.verify({
          challengeId: String(args.challengeId),
          signature: args.signature as SignatureEnvelope | undefined,
        }),
      ),
  );

  reg(
    'auth_logout',
    { description: 'Delete the session.', inputSchema: { token: z.string() } },
    async (args) => {
      await auth.logout(String(args.token));
      return ok({ ok: true });
    },
  );

  reg(
    'auth_network_switch',
    {
      description: 'Exchange a valid session for the same wallet on another derivation network without another signature.',
      inputSchema: { token: z.string(), network: z.enum(['mainnet', 'testnet']) },
    },
    async (args) => {
      const session = await requireSession(args);
      const network = String(args.network) as Network;
      if (network === session.network) return ok(session);
      const { token } = await store.createSession({
        chain: session.chain, address: session.address, network, expiresAt: session.expiresAt,
      });
      await store.deleteSession(session.token);
      return ok({ token, chain: session.chain, address: session.address, network, expiresAt: session.expiresAt });
    },
  );

  reg(
    'catalog_list',
    {
      description: 'List supported chains (with enabled state) and assets (with trust preferences) for the authenticated root wallet.',
      inputSchema: { token: z.string() },
    },
    async (args) => {
      const session = await requireSession(args);
      return ok(await store.listCatalog({ chain: session.chain, address: session.address }));
    },
  );

  reg(
    'chain_enabled_set',
    {
      description:
        'Enable or disable a supported chain for the authenticated root wallet. Applies to every network '
        + 'variant of the chain (mainnet and testnet); new vaults copy these settings at creation. Returns '
        + 'the updated chain variants.',
      inputSchema: { token: z.string(), chainKey: z.string().min(1), enabled: z.boolean() },
    },
    async (args) => {
      const session = await requireSession(args);
      return ok(
        await store.setChainEnabled(
          { chain: session.chain, address: session.address },
          String(args.chainKey),
          Boolean(args.enabled),
        ),
      );
    },
  );

  reg(
    'asset_trust_set',
    {
      description: 'Set an asset to Hidden, Review, or Allowed for the authenticated root wallet.',
      inputSchema: { token: z.string(), assetId: z.string().min(1), state: z.enum(['hidden', 'review', 'allowed']) },
    },
    async (args) => {
      const session = await requireSession(args);
      return ok(
        await store.setAssetTrust(
          { chain: session.chain, address: session.address },
          String(args.assetId),
          String(args.state) as AssetTrustState,
        ),
      );
    },
  );

  reg(
    'settings_get',
    {
      description: 'Read per-wallet settings (Mainnet vault lock reminder) for the authenticated root wallet.',
      inputSchema: { token: z.string() },
    },
    async (args) => {
      const session = await requireSession(args);
      return ok(await store.getWalletSettings({ chain: session.chain, address: session.address }));
    },
  );

  reg(
    'settings_set',
    {
      description:
        'Update per-wallet settings; omitted fields keep their current value. lockReminderMinutes must be one of '
        + '0 (disabled), 1, 3, 5, 10, 30.',
      inputSchema: {
        token: z.string(),
        lockReminderMinutes: z.number().int().optional(),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const owner = { chain: session.chain, address: session.address };
      const current = await store.getWalletSettings(owner);
      return ok(await store.setWalletSettings(owner, {
        lockReminderMinutes: args.lockReminderMinutes === undefined ? current.lockReminderMinutes : Number(args.lockReminderMinutes),
      }));
    },
  );

  reg(
    'zone_list',
    {
      description: 'List zone metadata for the authenticated root wallet and session network.',
      inputSchema: { token: z.string() },
    },
    async (args) => {
      const session = await requireSession(args);
      const records = await store.listZones(session.chain, session.address, session.network);
      return ok(await Promise.all(records.map(async (record) => ({
        zoneId: record.id,
        zone: record.zone,
        commitment: record.commitment,
        mode: record.policyHash === TESTNET_SERVER_POLICY
          ? 'testnet-server'
          : record.policyHash === 'testnet-device-v1' ? 'testnet-device' : 'signed',
        createdAt: record.createdAt,
        lastUnlockedAt: record.lastUnlockedAt ?? undefined,
        addresses: await store.listZoneAddresses(record.id),
        chains: await store.listZoneChainSettings(record.id),
      }))));
    },
  );

  reg(
    'zone_chain_set',
    {
      description:
        'Enable or disable a chain for one owned vault. Vault chain settings start as a copy of the '
        + 'account-level settings and change independently afterwards. Returns the vault\'s full chain list.',
      inputSchema: { token: z.string(), zone: z.string().min(1).max(64), chainKey: z.string().min(1), enabled: z.boolean() },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = await requireZone(session, String(args.zone));
      return ok(await store.setZoneChainEnabled(zone.id, String(args.chainKey), Boolean(args.enabled)));
    },
  );

  reg(
    'zone_address_create',
    {
      description: 'Allocate the next deterministic address index for one chain in an owned zone.',
      inputSchema: {
        token: z.string(), zone: z.string().min(1).max(64),
        chain: z.enum(['evm', 'xrpl', 'stellar']),
        name: z.string().trim().min(1).max(64).optional(),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = await requireZone(session, String(args.zone));
      return ok(await store.createZoneAddress(zone.id, String(args.chain) as AgentChain, args.name ? String(args.name) : undefined));
    },
  );

  reg(
    'zone_unlocked',
    {
      description: 'Record that the authenticated owner successfully unlocked a zone.',
      inputSchema: { token: z.string(), zone: z.string().min(1).max(64) },
    },
    async (args) => {
      const session = await requireSession(args);
      const record = await store.markZoneUnlocked(session.chain, session.address, String(args.zone), session.network);
      if (!record) throw new MosaicMcpError('NOT_FOUND', `zone not found: ${String(args.zone)} (${session.network})`);
      return ok({ lastUnlockedAt: record.lastUnlockedAt });
    },
  );

  reg(
    'zone_begin',
    {
      description: 'Issue server freshness (nonce, issuedAt, expiresAt) for an authorize-zone signature.',
      inputSchema: { token: z.string(), zone: zoneNameSchema },
    },
    async (args) => {
      const session = await requireSession(args);
      return ok(await auth.zoneBegin(session, String(args.zone)));
    },
  );

  reg(
    'zone_create_testnet',
    {
      description: 'Create a Testnet sandbox vault whose secret is envelope-encrypted by the server and available after authenticated login on any device.',
      inputSchema: {
        token: z.string(), zone: zoneNameSchema,
        zoneRootCommitment: z.string().regex(/^[0-9a-f]{64}$/),
        zoneRootSecretB64: z.string().min(1),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      if (session.network !== 'testnet') throw new MosaicMcpError('VALIDATION_FAILED', 'server-managed vault creation is Testnet-only');
      if (!opts.testnetVaultKey) throw new MosaicMcpError('INTERNAL', 'Testnet server vault key is not configured');
      const secret = Buffer.from(String(args.zoneRootSecretB64), 'base64');
      if (secret.byteLength !== 32) throw new MosaicMcpError('VALIDATION_FAILED', 'zoneRootSecretB64 must decode to exactly 32 bytes');
      const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: String(args.zone), network: 'testnet' };
      const commitment = String(args.zoneRootCommitment);
      if (!verifyCommitment(new Uint8Array(secret), commitment)) {
        throw new MosaicMcpError('VALIDATION_FAILED', 'zoneRootSecret does not match zoneRootCommitment');
      }
      try {
        const sealed = sealTestnetSecret(new Uint8Array(secret), opts.testnetVaultKey, ref, commitment);
        const record = await store.createZone({
          rootChain: ref.rootChain, rootAddress: ref.rootAddress, zone: ref.zone, network: ref.network,
          commitment, policyHash: TESTNET_SERVER_POLICY,
          localSignerPublicKey: 'server:testnet-sandbox',
          authorizeMessage: { mode: TESTNET_SERVER_POLICY }, authorizeSignature: { mode: 'none' },
          xrplSignInTemplate: null, layer1Enabled: false,
        });
        await store.putBlob({ zoneId: record.id, kind: 'server', ciphertext: sealed.ciphertext, header: sealed.header as unknown as Record<string, unknown> });
        return ok({ zoneId: record.id, createdAt: record.createdAt });
      } finally {
        secret.fill(0);
      }
    },
  );

  reg(
    'zone_testnet_unlock',
    {
      description: 'Unlock an explicitly server-managed Testnet sandbox vault for its authenticated owner.',
      inputSchema: { token: z.string(), zone: zoneNameSchema },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = await requireZone(session, String(args.zone));
      if (zone.policyHash !== TESTNET_SERVER_POLICY) {
        throw new MosaicMcpError('VALIDATION_FAILED', 'zone is not a server-managed Testnet sandbox');
      }
      if (!opts.testnetVaultKey) throw new MosaicMcpError('INTERNAL', 'Testnet server vault key is not configured');
      const blob = await store.getBlob(zone.id, 'server');
      if (!blob) throw new MosaicMcpError('NOT_FOUND', `no server Testnet secret for zone ${zone.zone}`);
      const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: zone.zone, network: 'testnet' };
      const secret = openTestnetSecret(
        blob.ciphertext,
        blob.header as unknown as Parameters<typeof openTestnetSecret>[1],
        opts.testnetVaultKey,
        ref,
        zone.commitment,
      );
      try {
        return ok({ commitment: zone.commitment, zoneRootSecretB64: Buffer.from(secret).toString('base64') });
      } finally {
        secret.fill(0);
      }
    },
  );

  reg(
    'zone_create',
    {
      description:
        'Create a zone: verifies the authorize-zone signature against the session identity and records the zone. Store only public metadata + the signature; never any secret.',
      inputSchema: {
        token: z.string(),
        challengeId: z.string(),
        zone: zoneNameSchema,
        localSignerPublicKey: z.string().min(1).max(512),
        policyHash: z.string().min(1).max(128),
        zoneRootCommitment: z.string().regex(/^[0-9a-f]{64}$/),
        signature: signatureSchema,
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = String(args.zone);
      const { message } = await auth.verifyAuthorizeZone(session, {
        challengeId: String(args.challengeId),
        zone,
        localSignerPublicKey: String(args.localSignerPublicKey),
        policyHash: String(args.policyHash),
        zoneRootCommitment: String(args.zoneRootCommitment),
        signature: args.signature as SignatureEnvelope,
      });
      const ref: ZoneRef = {
        rootChain: session.chain,
        rootAddress: session.address,
        zone,
        network: session.network,
      };
      const record = await store.createZone({
        rootChain: ref.rootChain,
        rootAddress: ref.rootAddress,
        zone: ref.zone,
        network: ref.network,
        commitment: String(args.zoneRootCommitment),
        policyHash: String(args.policyHash),
        localSignerPublicKey: String(args.localSignerPublicKey),
        authorizeMessage: message as unknown as Record<string, unknown>,
        authorizeSignature: args.signature as Record<string, unknown>,
        // The exact SignIn txjson Xaman must re-sign byte-identically at
        // recovery. Server-derived from the frozen canonical message — never
        // taken from the client.
        xrplSignInTemplate:
          session.chain === 'xrpl'
            ? (xrplSignInTxJson(backupWrapMessage(ref)) as unknown as Record<string, unknown>)
            : null,
        layer1Enabled: true,
      });
      return ok({ zoneId: record.id, createdAt: record.createdAt });
    },
  );

  reg(
    'zone_get',
    {
      description: 'Fetch zone metadata and which recovery blob kinds exist for the session identity.',
      inputSchema: { token: z.string(), zone: z.string() },
    },
    async (args) => {
      const session = await requireSession(args);
      const record = await store.getZone(session.chain, session.address, String(args.zone), session.network);
      if (!record) return ok({ exists: false });
      const blobs = await store.listBlobKinds(record.id);
      return ok({
        exists: true,
        zoneId: record.id,
        commitment: record.commitment,
        policyHash: record.policyHash,
        localSignerPublicKey: record.localSignerPublicKey,
        layer1Enabled: record.layer1Enabled,
        createdAt: record.createdAt,
        lastUnlockedAt: record.lastUnlockedAt ?? undefined,
        blobs,
        chains: await store.listZoneChainSettings(record.id),
      });
    },
  );

  reg(
    'blob_put',
    {
      description: `Store an encrypted blob. Recovery blobs are capped at ${MAX_BLOB_BYTES} bytes; data and agent-secret ciphertext at ${MAX_DATA_BLOB_BYTES} bytes.`,
      inputSchema: {
        token: z.string(),
        zone: z.string(),
        kind: z.enum(['sig', 'pass', 'device', 'data', 'agent-secrets']),
        ciphertextB64: z.string(),
        header: z.record(z.string(), z.unknown()),
        expectedVersion: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = await requireZone(session, String(args.zone));
      const ciphertext = Buffer.from(String(args.ciphertextB64), 'base64');
      const maxBytes = args.kind === 'data'
        ? MAX_DATA_BLOB_BYTES
        : args.kind === 'agent-secrets' ? MAX_AGENT_SECRET_BLOB_BYTES : MAX_BLOB_BYTES;
      if (ciphertext.byteLength === 0 || ciphertext.byteLength > maxBytes) {
        throw new MosaicMcpError('VALIDATION_FAILED', `ciphertext must be 1..${maxBytes} bytes`);
      }
      const { version } = await store.putBlob({
        zoneId: zone.id,
        kind: args.kind as BlobKind,
        ciphertext: new Uint8Array(ciphertext),
        header: args.header as Record<string, unknown>,
        ...(args.expectedVersion === undefined ? {} : { expectedVersion: Number(args.expectedVersion) }),
      });
      return ok({ version });
    },
  );

  reg(
    'blob_get',
    {
      description:
        'Fetch the latest encrypted recovery blob of a kind. Served only to a session authenticated via session-auth — never ask users to sign backup-wrap to log in.',
      inputSchema: { token: z.string(), zone: z.string(), kind: z.enum(['sig', 'pass', 'device', 'server', 'data', 'agent-secrets']) },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = await requireZone(session, String(args.zone));
      const blob = await store.getBlob(zone.id, args.kind as BlobKind);
      if (!blob) throw new MosaicMcpError('NOT_FOUND', `no ${String(args.kind)} blob for zone ${String(args.zone)}`);
      return ok({
        kind: blob.kind,
        version: blob.version,
        header: blob.header,
        ciphertextB64: Buffer.from(blob.ciphertext).toString('base64'),
        commitment: zone.commitment,
      });
    },
  );

  reg(
    'agent_artifact_put',
    {
      description: 'Store one immutable, content-addressed UTF-8 JavaScript agent bundle and its canonical manifest.',
      inputSchema: {
        token: z.string(),
        manifest: z.record(z.string(), z.unknown()),
        source: z.string().min(1),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const manifest = args.manifest as unknown as AgentArtifactManifest;
      try { assertArtifactManifest(manifest); } catch (error) {
        throw new MosaicMcpError('VALIDATION_FAILED', error instanceof Error ? error.message : String(error));
      }
      const source = String(args.source);
      const sourceBytes = Buffer.from(source, 'utf8');
      if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > MAX_AGENT_ARTIFACT_BYTES) {
        throw new MosaicMcpError('VALIDATION_FAILED', `agent source must be 1..${MAX_AGENT_ARTIFACT_BYTES} UTF-8 bytes`);
      }
      if (sourceBytes.toString('utf8') !== source) throw new MosaicMcpError('VALIDATION_FAILED', 'agent source is not canonical UTF-8');
      const actualSourceDigest = sha256Hex(sourceBytes);
      if (manifest.sourceDigest !== actualSourceDigest) throw new MosaicMcpError('VALIDATION_FAILED', 'agent source digest mismatch');
      const digest = artifactDigest(manifest);
      const result = await store.putAgentArtifact({
        owner: { chain: session.chain, address: session.address },
        network: session.network,
        artifactDigest: digest,
        manifest,
        source: new Uint8Array(sourceBytes),
      });
      return ok({ protocol: AGENT_ARTIFACT_PROTOCOL, runtimeVersion: AGENT_RUNTIME_VERSION, artifactDigest: digest, created: result.created });
    },
  );

  reg(
    'agent_artifact_get',
    {
      description: 'Fetch an immutable agent artifact owned by the authenticated root wallet.',
      inputSchema: { token: z.string(), artifactDigest: z.string().regex(/^[0-9a-f]{64}$/) },
    },
    async (args) => {
      const session = await requireSession(args);
      const digest = String(args.artifactDigest);
      const record = await store.getAgentArtifact({ chain: session.chain, address: session.address }, session.network, digest);
      if (!record) throw new MosaicMcpError('NOT_FOUND', `agent artifact not found: ${digest}`);
      if (artifactDigest(record.manifest) !== digest || sha256Hex(record.source) !== record.manifest.sourceDigest) {
        throw new MosaicMcpError('INTERNAL', 'stored agent artifact failed integrity verification');
      }
      return ok({ artifactDigest: digest, manifest: record.manifest, source: Buffer.from(record.source).toString('utf8'), createdAt: record.createdAt });
    },
  );

  reg(
    'agent_artifact_list',
    {
      description: 'List immutable agent artifact manifests owned by the authenticated root wallet.',
      inputSchema: { token: z.string(), agentId: zoneNameSchema.optional() },
    },
    async (args) => {
      const session = await requireSession(args);
      const records = await store.listAgentArtifacts(
        { chain: session.chain, address: session.address },
        session.network,
        args.agentId === undefined ? undefined : String(args.agentId),
      );
      return ok({ artifacts: records.map(({ owner: _owner, network: _network, ...record }) => record) });
    },
  );

  reg(
    'xaman_sign_create',
    {
      description:
        'Create a Xaman SignIn payload for a ceremony signature (backup-wrap or authorize-zone). The txjson is derived server-side from the canonical message so recovery re-signs byte-identical content; the client never supplies the message.',
      inputSchema: {
        token: z.string(),
        purpose: z.enum(['backup-wrap', 'authorize-zone']),
        zone: z.string().min(1).max(64),
        // authorize-zone only: the zone_begin challenge providing freshness,
        // plus the commitment fields the browser computed.
        challengeId: z.string().optional(),
        localSignerPublicKey: z.string().max(512).optional(),
        policyHash: z.string().max(128).optional(),
        zoneRootCommitment: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      if (session.chain !== 'xrpl') {
        throw new MosaicMcpError('VALIDATION_FAILED', 'xaman_sign_create requires an XRPL session');
      }
      if (!opts.xaman) throw new MosaicMcpError('XAMAN_UNAVAILABLE', 'Xaman is not configured');
      const ref: ZoneRef = {
        rootChain: 'xrpl',
        rootAddress: session.address,
        zone: String(args.zone),
        network: session.network,
      };
      if (args.purpose === 'backup-wrap') {
        const refs = await opts.xaman.createSignInPayload(
          backupWrapMessage(ref),
          `Mosaic backup key for vault "${ref.zone}" (${ref.network})`,
        );
        return ok(refs);
      }
      for (const field of ['challengeId', 'localSignerPublicKey', 'policyHash', 'zoneRootCommitment'] as const) {
        if (typeof args[field] !== 'string') {
          throw new MosaicMcpError('VALIDATION_FAILED', `authorize-zone payload requires ${field}`);
        }
      }
      const challenge = await store.peekChallenge(String(args.challengeId));
      if (!challenge || challenge.purpose !== 'authorize-zone' || challenge.address !== session.address) {
        throw new MosaicMcpError('AUTH_INVALID', 'unknown or mismatched authorize-zone challenge');
      }
      const message = authorizeZoneMessage(ref, {
        localSignerPublicKey: String(args.localSignerPublicKey),
        policyHash: String(args.policyHash),
        zoneRootCommitment: String(args.zoneRootCommitment),
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
      });
      const refs = await opts.xaman.createSignInPayload(
        message,
        `Authorize Mosaic vault "${ref.zone}" (${ref.network})`,
      );
      return ok(refs);
    },
  );

  reg(
    'xaman_payload_result',
    {
      description: 'Fetch the result of a Xaman payload created for this session (signed blob hex + account).',
      inputSchema: { token: z.string(), uuid: z.string() },
    },
    async (args) => {
      await requireSession(args);
      if (!opts.xaman) throw new MosaicMcpError('XAMAN_UNAVAILABLE', 'Xaman is not configured');
      return ok(await opts.xaman.getPayloadResult(String(args.uuid)));
    },
  );

  return server;
}
