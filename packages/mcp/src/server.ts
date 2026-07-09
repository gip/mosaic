import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { authorizeZoneMessage, backupWrapMessage, type ZoneRef } from '@mosaic/zone-keys';
import { xrplSignInTxJson } from '@mosaic/zone-keys/verify';
import { AuthService, validateChain, validateNetwork, type SignatureEnvelope, type Session } from './auth.js';
import { MosaicMcpError, mcpErrorContent } from './errors.js';
import { createStderrLogger, type MosaicLogger } from './logging.js';
import { MemoryStore, type BlobKind, type MosaicStore } from './store.js';
import type { XamanService } from './xaman.js';

export interface MosaicMcpOptions {
  store?: MosaicStore;
  auth?: AuthService;
  xaman?: XamanService;
  logger?: MosaicLogger;
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
    'zone_begin',
    {
      description: 'Issue server freshness (nonce, issuedAt, expiresAt) for an authorize-zone signature.',
      inputSchema: { token: z.string(), zone: z.string().min(1).max(64) },
    },
    async (args) => {
      const session = await requireSession(args);
      return ok(await auth.zoneBegin(session, String(args.zone)));
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
        zone: z.string().min(1).max(64),
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
        blobs,
      });
    },
  );

  reg(
    'blob_put',
    {
      description: `Store an encrypted recovery blob (ciphertext only, max ${MAX_BLOB_BYTES} bytes).`,
      inputSchema: {
        token: z.string(),
        zone: z.string(),
        kind: z.enum(['sig', 'pass']),
        ciphertextB64: z.string(),
        header: z.record(z.string(), z.unknown()),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = await requireZone(session, String(args.zone));
      const ciphertext = Buffer.from(String(args.ciphertextB64), 'base64');
      if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_BLOB_BYTES) {
        throw new MosaicMcpError('VALIDATION_FAILED', `ciphertext must be 1..${MAX_BLOB_BYTES} bytes`);
      }
      const { version } = await store.putBlob({
        zoneId: zone.id,
        kind: args.kind as BlobKind,
        ciphertext: new Uint8Array(ciphertext),
        header: args.header as Record<string, unknown>,
      });
      return ok({ version });
    },
  );

  reg(
    'blob_get',
    {
      description:
        'Fetch the latest encrypted recovery blob of a kind. Served only to a session authenticated via session-auth — never ask users to sign backup-wrap to log in.',
      inputSchema: { token: z.string(), zone: z.string(), kind: z.enum(['sig', 'pass']) },
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
          `Mosaic backup key for zone "${ref.zone}" (${ref.network})`,
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
        `Authorize Mosaic zone "${ref.zone}" (${ref.network})`,
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
