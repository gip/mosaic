import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AssetDeployment, AssetTrustState } from '@mosaic/catalog';
import {
  assertPositiveDecimal,
  multiplyDecimals,
  quantizeDecimal,
  type DexOrderIntent,
  type OrderStatus,
} from '@mosaic/chain-core';
import {
  prepareStellarCancel,
  prepareStellarOrder,
  getStellarOfferRemaining,
  lookupStellarTransaction,
  stellarTransactionMatchesUnsigned,
  submitStellarTransaction,
  stellarTransactionHash,
} from '@mosaic/stellar';
import {
  prepareXrplCancel,
  prepareXrplOrder,
  getXrplOfferRemaining,
  lookupXrplTransaction,
  normalizeXrplAssetAmount,
  submitXrplTransaction,
  verifyXrplTransaction,
  xrplTransactionHash,
} from '@mosaic/xrpl';
import {
  AGENT_ARTIFACT_PROTOCOL,
  AGENT_RUNTIME_VERSION,
  MAX_AGENT_SOURCE_BYTES,
  artifactDigest,
  assertArtifactManifest,
  assertCanonicalAgentSource,
  sha256Hex,
  type AgentArtifactManifest,
} from '@mosaic/local-runtime';
import { authorizeZoneMessage, backupWrapMessage, verifyCommitment, type AgentChain, type Network, type ZoneRef } from '@mosaic/zone-keys';
import { xrplSignInTxJson } from '@mosaic/zone-keys/verify';
import { AuthService, validateChain, validateNetwork, type SignatureEnvelope, type Session } from './auth.js';
import { requireEnvUint32, validateUint32 } from './env.js';
import { MosaicMcpError, mcpErrorContent } from './errors.js';
import { createStderrLogger, type MosaicLogger } from './logging.js';
import { MemoryStore, type BlobKind, type DexOrderRecord, type MosaicStore, type SigningRequest } from './store.js';
import { openTestnetSecret, sealTestnetSecret, TESTNET_SERVER_POLICY } from './testnetVault.js';
import type { XamanService } from './xaman.js';

export interface MosaicMcpOptions {
  store?: MosaicStore;
  auth?: AuthService;
  xaman?: XamanService;
  logger?: MosaicLogger;
  /** XRPL UInt32 SourceTag. Defaults to the required MOSAIC_XRPL_SOURCE_TAG environment variable. */
  xrplSourceTag?: number;
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
const XAMAN_RELATIVE_LEDGER_THRESHOLD = 32_570;
const XAMAN_LAST_LEDGER_OFFSET = 20;
const XAMAN_MAX_LAST_LEDGER_DRIFT = 100;
const XRPL_SOURCE_TAG_ENV = 'MOSAIC_XRPL_SOURCE_TAG';
const zoneNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const signatureSchema = z.union([
  z.object({ type: z.literal('evm'), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
  z.object({ type: z.literal('stellar'), signatureB64: z.string() }),
  z.object({ type: z.literal('xrpl'), payloadUuid: z.string() }),
]);

const dexAssetSchema = z.union([
  z.object({ kind: z.literal('native') }),
  z.object({
    kind: z.literal('issued'),
    code: z.string().min(1).max(40),
    issuer: z.string().min(1).max(128),
    currencyCode: z.string().min(1).max(40).optional(),
  }),
]);
const orderStatusSchema = z.enum([
  'awaiting_signature', 'submitted', 'confirmed', 'open', 'partially_filled',
  'filled', 'cancelled', 'failed', 'expired', 'unknown',
]);

function publicActivity(record: DexOrderRecord): Record<string, unknown> {
  const { owner: _owner, signingRequest: _request, preparedTransaction: _prepared, signedPayload: _payload, ...activity } = record;
  return activity;
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

/** Xaman interprets LastLedgerSequence values below 32570 as a relative offset. */
export function xamanTransactionTemplate(transaction: Record<string, unknown>): Record<string, unknown> {
  const lastLedgerSequence = transaction.LastLedgerSequence;
  return typeof lastLedgerSequence === 'number'
    && Number.isSafeInteger(lastLedgerSequence)
    && lastLedgerSequence > 0
    && lastLedgerSequence < XAMAN_RELATIVE_LEDGER_THRESHOLD
    ? { ...transaction, LastLedgerSequence: XAMAN_LAST_LEDGER_OFFSET }
    : transaction;
}

export function xrplSignedFieldMatches(
  field: string,
  signed: unknown,
  expected: unknown,
  xaman: boolean,
): boolean {
  if (xaman && field === 'LastLedgerSequence') {
    return typeof signed === 'number'
      && typeof expected === 'number'
      && Number.isSafeInteger(signed)
      && Number.isSafeInteger(expected)
      && signed > 0
      && expected > 0
      && Math.abs(signed - expected) <= XAMAN_MAX_LAST_LEDGER_DRIFT;
  }
  return jsonValuesEqual(signed, expected);
}

export function resolveXrplSourceTag(override?: number): number {
  return override === undefined
    ? requireEnvUint32(XRPL_SOURCE_TAG_ENV)
    : validateUint32('xrplSourceTag', override);
}

class XrplSourceTagMismatchError extends MosaicMcpError {
  constructor(expected: number) {
    super('VALIDATION_FAILED', `XRPL transaction SourceTag must equal configured source tag ${expected}`);
  }
}

function preparedXrplTransaction(record: DexOrderRecord): Record<string, unknown> | undefined {
  if (record.preparedTransaction) return record.preparedTransaction;
  return record.signingRequest.kind === 'xrpl' ? record.signingRequest.unsignedTransaction : undefined;
}

function assertPreparedXrplSourceTag(record: DexOrderRecord, expected: number): void {
  if (record.chain === 'xrpl' && preparedXrplTransaction(record)?.SourceTag !== expected) {
    throw new XrplSourceTagMismatchError(expected);
  }
}

async function failSourceTagRecord(
  store: MosaicStore,
  record: DexOrderRecord,
  error: XrplSourceTagMismatchError,
): Promise<DexOrderRecord> {
  return store.updateDexOrder(record.owner, record.network, record.id, {
    status: 'failed', error: error.message, signedPayload: undefined, confirmedAt: new Date().toISOString(),
  });
}

function sameAsset(left: DexOrderIntent['base'], right: DexOrderIntent['base']): boolean {
  return left.kind === 'native'
    ? right.kind === 'native'
    : right.kind === 'issued' && left.code === right.code && left.issuer === right.issuer;
}

function subtractDecimals(left: string, right: string): string {
  const leftFraction = left.split('.')[1]?.length ?? 0;
  const rightFraction = right.split('.')[1]?.length ?? 0;
  const scale = Math.max(leftFraction, rightFraction);
  const scaled = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(`${whole}${fraction.padEnd(scale, '0')}`);
  };
  const result = scaled(left) - scaled(right);
  if (result <= 0n) return '0';
  if (scale === 0) return result.toString();
  const text = result.toString().padStart(scale + 1, '0');
  const fraction = text.slice(-scale).replace(/0+$/, '');
  return fraction ? `${text.slice(0, -scale)}.${fraction}` : text.slice(0, -scale);
}

async function reconcileDexOrder(store: MosaicStore, record: DexOrderRecord, xrplSourceTag: number): Promise<DexOrderRecord> {
  if (['submitted', 'unknown'].includes(record.status) && record.signedPayload) {
    const known = record.transactionHash
      ? record.chain === 'xrpl'
        ? await lookupXrplTransaction(record.network, record.transactionHash)
        : await lookupStellarTransaction(record.network, record.transactionHash)
      : null;
    if (known) {
      const successful = known.resultCode === 'tesSUCCESS' || known.resultCode === 'success';
      const offerId = record.action === 'cancel'
        ? record.offerId
        : record.chain === 'xrpl' ? String(record.preparedTransaction?.Sequence ?? '') || undefined : record.offerId;
      const next = await store.updateDexOrder(record.owner, record.network, record.id, {
        status: successful ? (record.action === 'cancel' ? 'cancelled' : offerId ? 'open' : 'confirmed') : 'failed',
        ledger: known.ledger,
        resultCode: known.resultCode,
        offerId,
        confirmedAt: new Date().toISOString(),
        signedPayload: undefined,
        ...(successful ? { error: undefined } : { error: `Network rejected the transaction: ${known.resultCode}` }),
      });
      if (successful && record.action === 'cancel' && record.orderId !== record.id) {
        await store.updateDexOrder(record.owner, record.network, record.orderId, { status: 'cancelled', confirmedAt: new Date().toISOString() });
      }
      return next;
    }
    if (record.chain === 'xrpl') {
      try {
        assertPreparedXrplSourceTag(record, xrplSourceTag);
        const signed = verifyXrplTransaction(record.signedPayload);
        if (signed.SourceTag !== xrplSourceTag) throw new XrplSourceTagMismatchError(xrplSourceTag);
      } catch (error) {
        if (error instanceof XrplSourceTagMismatchError) return failSourceTagRecord(store, record, error);
        throw error;
      }
    }
    const result = record.chain === 'xrpl'
      ? await submitXrplTransaction(record.network, record.signedPayload, xrplSourceTag)
      : await submitStellarTransaction(record.network, record.signedPayload);
    const successful = result.resultCode === 'tesSUCCESS' || result.resultCode === 'success';
    const stellarResult = record.chain === 'stellar'
      ? result as Awaited<ReturnType<typeof submitStellarTransaction>>
      : undefined;
    const offerId = record.action === 'cancel'
      ? record.offerId
      : record.chain === 'xrpl'
        ? String(record.preparedTransaction?.Sequence ?? '') || undefined
        : stellarResult?.offerId;
    const fullyFilled = stellarResult?.fullyFilled ?? false;
    const remainingAmount = fullyFilled ? '0' : stellarResult?.remainingAmount ?? record.remainingAmount;
    const next = await store.updateDexOrder(record.owner, record.network, record.id, {
      status: successful ? (record.action === 'cancel' ? 'cancelled' : fullyFilled ? 'filled' : 'open') : 'failed',
      transactionHash: result.hash,
      ledger: result.ledger,
      resultCode: result.resultCode,
      offerId,
      remainingAmount,
      filledAmount: subtractDecimals(record.amount, remainingAmount),
      confirmedAt: new Date().toISOString(),
      signedPayload: undefined,
      ...(successful ? { error: undefined } : { error: `Network rejected the transaction: ${result.resultCode}` }),
    });
    if (successful && record.action === 'cancel' && record.orderId !== record.id) {
      await store.updateDexOrder(record.owner, record.network, record.orderId, {
        status: 'cancelled', confirmedAt: new Date().toISOString(),
      });
    }
    return next;
  }
  if (record.action === 'cancel' || !record.offerId || !['open', 'partially_filled', 'confirmed'].includes(record.status)) return record;
  const remaining = record.chain === 'xrpl'
    ? await getXrplOfferRemaining(record.network, record.sourceAddress, Number(record.offerId), record.side)
    : await getStellarOfferRemaining(record.network, record.offerId, record.side);
  const status: OrderStatus = remaining === null ? 'filled' : remaining === record.amount ? 'open' : 'partially_filled';
  const remainingAmount = remaining ?? '0';
  const filledAmount = subtractDecimals(record.amount, remainingAmount);
  if (record.status === status && record.remainingAmount === remainingAmount && record.filledAmount === filledAmount) return record;
  return store.updateDexOrder(record.owner, record.network, record.id, {
    status,
    remainingAmount,
    filledAmount,
    ...(status === 'filled' ? { confirmedAt: new Date().toISOString() } : {}),
  });
}

const reconciliationStarted = new WeakSet<object>();

function assertXrplMatches(record: DexOrderRecord, txBlob: string, xrplSourceTag: number): void {
  if (record.signingRequest.kind !== 'xrpl' && record.signingRequest.kind !== 'xaman') {
    throw new MosaicMcpError('VALIDATION_FAILED', 'order does not expect an XRPL signature');
  }
  const signed = verifyXrplTransaction(txBlob) as unknown as Record<string, unknown>;
  const expected = record.signingRequest.kind === 'xrpl'
    ? record.signingRequest.unsignedTransaction
    : (record as DexOrderRecord & { preparedTransaction?: Record<string, unknown> }).preparedTransaction;
  if (!expected) throw new MosaicMcpError('INTERNAL', 'prepared XRPL transaction is missing');
  if (expected.SourceTag !== xrplSourceTag || signed.SourceTag !== xrplSourceTag) {
    throw new XrplSourceTagMismatchError(xrplSourceTag);
  }
  const signatureFields = new Set(['SigningPubKey', 'TxnSignature']);
  for (const field of Object.keys(signed)) {
    if (!signatureFields.has(field) && !(field in expected)) {
      throw new MosaicMcpError('VALIDATION_FAILED', `signed XRPL transaction added ${field}`);
    }
  }
  for (const field of Object.keys(expected)) {
    if (!xrplSignedFieldMatches(field, signed[field], expected[field], record.signingRequest.kind === 'xaman')) {
      throw new MosaicMcpError('VALIDATION_FAILED', `signed XRPL transaction changed ${field}`);
    }
  }
}

function assertStellarMatches(record: DexOrderRecord, signedXdr: string): void {
  if (record.signingRequest.kind !== 'stellar') throw new MosaicMcpError('VALIDATION_FAILED', 'order does not expect a Stellar signature');
  if (!stellarTransactionMatchesUnsigned(signedXdr, record.signingRequest.unsignedXdr, record.network, record.sourceAddress)) {
    throw new MosaicMcpError('VALIDATION_FAILED', 'signed Stellar transaction differs from the prepared order');
  }
}

export function createMosaicMcpServer(opts: MosaicMcpOptions = {}): McpServer {
  const xrplSourceTag = resolveXrplSourceTag(opts.xrplSourceTag);
  const store = opts.store ?? new MemoryStore();
  const auth = opts.auth ?? new AuthService(store, opts.xaman);
  const logger = opts.logger ?? createStderrLogger();

  if (!reconciliationStarted.has(store as object)) {
    reconciliationStarted.add(store as object);
    queueMicrotask(() => {
      void store.listNonterminalDexOrders()
        .then((records) => Promise.allSettled(records.map((record) => reconcileDexOrder(store, record, xrplSourceTag))))
        .catch((error: unknown) => logger.warn?.(`DEX restart reconciliation failed: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

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

  const requireTradingSource = async (
    session: Session,
    chain: 'xrpl' | 'stellar',
    source: { kind: 'root' | 'vault'; address: string; zone?: string; addressId?: string; name?: string },
  ): Promise<{ sourceKind: 'root' | 'vault'; zone?: string; addressId?: string; addressName?: string }> => {
    if (source.kind === 'root') {
      if (session.chain !== chain || source.address !== session.address) {
        throw new MosaicMcpError('AUTH_INVALID', 'root trading account does not match the authenticated wallet');
      }
      return { sourceKind: 'root', addressName: 'Root' };
    }
    if (!source.zone || !source.addressId) throw new MosaicMcpError('VALIDATION_FAILED', 'vault source requires zone and addressId');
    const zone = await requireZone(session, source.zone);
    const address = (await store.listZoneAddresses(zone.id)).find(({ id }) => id === source.addressId);
    if (!address || address.chain !== chain || address.address !== source.address) {
      throw new MosaicMcpError('AUTH_INVALID', 'vault address is not bound to this wallet and chain');
    }
    return { sourceKind: 'vault', zone: zone.zone, addressId: address.id, addressName: address.name };
  };

  const requireAllowedDeployment = async (
    session: Session,
    chain: 'xrpl' | 'stellar',
    symbol: string,
    asset: { kind: 'native' } | { kind: 'issued'; code: string; issuer: string; currencyCode?: string },
  ): Promise<AssetDeployment> => {
    const chainId = `${chain}-${session.network}`;
    const catalog = await store.listCatalog({ chain: session.chain, address: session.address });
    const deployment = catalog.assets
      .filter((candidate) => candidate.trustState === 'allowed')
      .flatMap((candidate) => candidate.deployments)
      .find((candidate) => (
        candidate.chainId === chainId && candidate.symbol === symbol && candidate.kind === asset.kind
        && (asset.kind === 'native' || (
          candidate.address === asset.issuer
          && asset.code === symbol
          && (!asset.currencyCode || asset.currencyCode === (candidate.currencyCode ?? candidate.symbol))
        ))
      ));
    if (!deployment) throw new MosaicMcpError('VALIDATION_FAILED', `${symbol} is not an allowed ${chain} asset`);
    return deployment;
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
    'chain_setup_complete',
    {
      description:
        'Complete first-login chain setup for the authenticated root wallet. The root-wallet chain is required; '
        + 'the selected built-in logical chains apply to both Mainnet and Testnet.',
      inputSchema: {
        token: z.string(),
        enabledChainKeys: z.array(z.enum(['xrpl', 'stellar', 'base'])).min(1).max(3),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      return ok(await store.completeChainSetup(
        { chain: session.chain, address: session.address },
        args.enabledChainKeys as string[],
      ));
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
    'dex_order_prepare',
    {
      description: 'Prepare one owner-bound XRPL or Stellar limit order for local wallet/vault signing.',
      inputSchema: {
        token: z.string(), chain: z.enum(['xrpl', 'stellar']), side: z.enum(['buy', 'sell']),
        source: z.object({
          kind: z.enum(['root', 'vault']), address: z.string().min(1).max(128),
          zone: z.string().max(64).optional(), addressId: z.string().uuid().optional(), name: z.string().max(64).optional(),
        }),
        base: dexAssetSchema, quote: dexAssetSchema,
        baseSymbol: z.string().min(1).max(40), quoteSymbol: z.string().min(1).max(40),
        amount: z.string().min(1).max(80), limitPrice: z.string().min(1).max(80),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const chain = String(args.chain) as 'xrpl' | 'stellar';
      const source = args.source as { kind: 'root' | 'vault'; address: string; zone?: string; addressId?: string; name?: string };
      const base = args.base as DexOrderIntent['base'];
      const quote = args.quote as DexOrderIntent['quote'];
      const requestedAmount = String(args.amount);
      const limitPrice = String(args.limitPrice);
      try { assertPositiveDecimal(requestedAmount, 'amount'); assertPositiveDecimal(limitPrice, 'limitPrice'); }
      catch (error) { throw new MosaicMcpError('VALIDATION_FAILED', error instanceof Error ? error.message : String(error)); }
      if (sameAsset(base, quote)) {
        throw new MosaicMcpError('VALIDATION_FAILED', 'base and quote assets must differ');
      }
      const ownership = await requireTradingSource(session, chain, source);
      const baseDeployment = await requireAllowedDeployment(session, chain, String(args.baseSymbol), base);
      const quoteDeployment = await requireAllowedDeployment(session, chain, String(args.quoteSymbol), quote);
      const quoteRounding = String(args.side) === 'sell' ? 'ceil' : 'floor';
      let amount: string;
      let quoteTotal: string;
      try {
        amount = quantizeDecimal(requestedAmount, baseDeployment.decimals);
        assertPositiveDecimal(amount, 'amount at asset precision');
        quoteTotal = quantizeDecimal(multiplyDecimals(amount, limitPrice), quoteDeployment.decimals, quoteRounding);
        if (chain === 'xrpl') {
          amount = normalizeXrplAssetAmount(base, amount);
          quoteTotal = normalizeXrplAssetAmount(quote, quoteTotal, quoteRounding);
        }
        assertPositiveDecimal(quoteTotal, 'quote total at asset precision');
      } catch (error) {
        throw new MosaicMcpError('VALIDATION_FAILED', error instanceof Error ? error.message : String(error));
      }
      const intent: DexOrderIntent = {
        chain, network: session.network, sourceAddress: source.address, ...ownership,
        side: String(args.side) as 'buy' | 'sell', base, quote,
        baseSymbol: String(args.baseSymbol), quoteSymbol: String(args.quoteSymbol), amount, limitPrice,
      };
      const prepared = chain === 'xrpl'
        ? await prepareXrplOrder(intent, quoteTotal, xrplSourceTag)
        : await prepareStellarOrder(intent, quoteTotal);
      let signingRequest: SigningRequest;
      let preparedTransaction: Record<string, unknown> | undefined;
      if (prepared.kind === 'xrpl') {
        preparedTransaction = prepared.unsignedTransaction as unknown as Record<string, unknown>;
        if (source.kind === 'root') {
          if (!opts.xaman?.createTransactionPayload) throw new MosaicMcpError('XAMAN_UNAVAILABLE', 'Xaman transaction signing is not configured');
          const refs = await opts.xaman.createTransactionPayload(
            xamanTransactionTemplate(preparedTransaction),
            `${intent.side === 'buy' ? 'Buy' : 'Sell'} ${amount} ${intent.baseSymbol} at ${limitPrice} ${intent.quoteSymbol}`,
          );
          signingRequest = { kind: 'xaman', ...refs };
        } else {
          signingRequest = { kind: 'xrpl', unsignedTransaction: preparedTransaction };
        }
      } else {
        signingRequest = { kind: 'stellar', unsignedXdr: prepared.unsignedXdr, networkPassphrase: prepared.networkPassphrase };
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      const record = await store.createDexOrder({
        id, orderId: id, owner: { chain: session.chain, address: session.address }, signingRequest, preparedTransaction,
        ...intent, action: intent.side, quoteTotal,
        fee: prepared.fee, feeSymbol: prepared.feeSymbol, reserveImpact: prepared.reserveImpact,
        expiresAt: prepared.expiresAt, status: 'awaiting_signature', filledAmount: '0', remainingAmount: amount,
        createdAt: now, updatedAt: now,
      });
      return ok({ order: publicActivity(record), signingRequest });
    },
  );

  reg(
    'dex_order_submit',
    {
      description: 'Verify an exact prepared signed order and submit it from the MCP backend. Repeated calls are idempotent.',
      inputSchema: {
        token: z.string(), orderId: z.string().uuid(),
        signed: z.union([
          z.object({ kind: z.literal('xrpl'), txBlob: z.string().regex(/^[0-9A-Fa-f]+$/) }),
          z.object({ kind: z.literal('stellar'), signedXdr: z.string().min(1) }),
          z.object({ kind: z.literal('xaman'), payloadUuid: z.string().min(1) }),
        ]),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const owner = { chain: session.chain, address: session.address };
      const record = await store.getDexOrder(owner, session.network, String(args.orderId));
      if (!record) throw new MosaicMcpError('NOT_FOUND', `order not found: ${String(args.orderId)}`);
      if (record.status !== 'awaiting_signature') return ok({ order: publicActivity(record) });
      if (Date.parse(record.expiresAt) <= Date.now()) {
        const expired = await store.updateDexOrder(owner, session.network, record.id, { status: 'expired', signedPayload: undefined });
        return ok({ order: publicActivity(expired) });
      }
      const signed = args.signed as { kind: 'xrpl'; txBlob: string } | { kind: 'stellar'; signedXdr: string } | { kind: 'xaman'; payloadUuid: string };
      let payload: string;
      try {
        assertPreparedXrplSourceTag(record, xrplSourceTag);
        if (signed.kind === 'xaman') {
          if (record.signingRequest.kind !== 'xaman' || record.signingRequest.uuid !== signed.payloadUuid || !opts.xaman) {
            throw new MosaicMcpError('VALIDATION_FAILED', 'Xaman payload does not belong to this order');
          }
          const result = await opts.xaman.getPayloadResult(signed.payloadUuid);
          if (!result.resolved || !result.signed || !result.hex) throw new MosaicMcpError('AUTH_INVALID', 'Xaman order payload is not signed');
          payload = result.hex;
          assertXrplMatches(record, payload, xrplSourceTag);
        } else if (signed.kind === 'xrpl') {
          payload = signed.txBlob;
          assertXrplMatches(record, payload, xrplSourceTag);
        } else {
          payload = signed.signedXdr;
          assertStellarMatches(record, payload);
        }
      } catch (error) {
        if (error instanceof XrplSourceTagMismatchError) await failSourceTagRecord(store, record, error);
        throw error;
      }
      const submittedAt = new Date().toISOString();
      const transactionHash = record.chain === 'xrpl'
        ? xrplTransactionHash(payload)
        : stellarTransactionHash(payload, record.network);
      await store.updateDexOrder(owner, session.network, record.id, { status: 'submitted', signedPayload: payload, submittedAt, transactionHash });
      try {
        const result = record.chain === 'xrpl'
          ? await submitXrplTransaction(record.network, payload, xrplSourceTag)
          : await submitStellarTransaction(record.network, payload);
        const stellarResult = record.chain === 'stellar'
          ? result as Awaited<ReturnType<typeof submitStellarTransaction>>
          : undefined;
        const successful = result.resultCode === 'tesSUCCESS' || result.resultCode === 'success';
        const expectedXrpl = record.preparedTransaction;
        const offerId = record.action === 'cancel'
          ? record.offerId
          : record.chain === 'xrpl'
            ? String(expectedXrpl?.Sequence ?? '') || undefined
            : stellarResult?.offerId;
        const stellarFilled = stellarResult
          ? (record.side === 'buy' ? stellarResult.amountBought : stellarResult.amountSold)
          : undefined;
        const fullyFilled = stellarResult?.fullyFilled ?? false;
        const remainingAmount = stellarResult?.remainingAmount;
        const next = await store.updateDexOrder(owner, session.network, record.id, {
          status: successful
            ? (record.action === 'cancel' ? 'cancelled' : fullyFilled ? 'filled' : remainingAmount && remainingAmount !== record.amount ? 'partially_filled' : 'open')
            : 'failed',
          transactionHash: result.hash, ledger: result.ledger, resultCode: result.resultCode, offerId,
          filledAmount: stellarFilled ?? record.filledAmount,
          remainingAmount: fullyFilled ? '0' : remainingAmount ?? record.remainingAmount,
          confirmedAt: new Date().toISOString(), signedPayload: undefined,
          ...(successful ? {} : { error: `Network rejected the transaction: ${result.resultCode}` }),
        });
        if (successful && record.action === 'cancel' && record.orderId !== record.id) {
          await store.updateDexOrder(owner, session.network, record.orderId, {
            status: 'cancelled', remainingAmount: record.remainingAmount, confirmedAt: new Date().toISOString(),
          });
        }
        return ok({ order: publicActivity(next) });
      } catch (error) {
        const next = await store.updateDexOrder(owner, session.network, record.id, {
          status: 'unknown', error: error instanceof Error ? error.message : String(error), signedPayload: payload,
        });
        return ok({ order: publicActivity(next) });
      }
    },
  );

  reg(
    'dex_order_cancel_prepare',
    {
      description: 'Prepare cancellation of an owned open XRPL or Stellar offer.',
      inputSchema: { token: z.string(), orderId: z.string().uuid() },
    },
    async (args) => {
      const session = await requireSession(args);
      const owner = { chain: session.chain, address: session.address };
      const original = await store.getDexOrder(owner, session.network, String(args.orderId));
      if (!original || !['open', 'partially_filled', 'unknown'].includes(original.status)) {
        throw new MosaicMcpError('VALIDATION_FAILED', 'only an open order can be cancelled');
      }
      if (!original.offerId) throw new MosaicMcpError('VALIDATION_FAILED', 'the network offer id is not available yet');
      const prepared = original.chain === 'xrpl'
        ? await prepareXrplCancel(original.network, original.sourceAddress, Number(original.offerId), xrplSourceTag)
        : await prepareStellarCancel(
            original.network,
            original.sourceAddress,
            original.offerId,
            original.side === 'sell' ? original.base : original.quote,
            original.side === 'sell' ? original.quote : original.base,
          );
      let signingRequest: SigningRequest;
      if (prepared.kind === 'xrpl') {
        const unsignedTransaction = prepared.unsignedTransaction as unknown as Record<string, unknown>;
        if (original.sourceKind === 'root') {
          if (!opts.xaman?.createTransactionPayload) throw new MosaicMcpError('XAMAN_UNAVAILABLE', 'Xaman transaction signing is not configured');
          const refs = await opts.xaman.createTransactionPayload(xamanTransactionTemplate(unsignedTransaction), `Cancel ${original.baseSymbol}/${original.quoteSymbol} offer`);
          signingRequest = { kind: 'xaman', ...refs };
        } else {
          signingRequest = { kind: 'xrpl', unsignedTransaction };
        }
      } else {
        signingRequest = { kind: 'stellar', unsignedXdr: prepared.unsignedXdr, networkPassphrase: prepared.networkPassphrase };
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      const { cursor: _cursor, ...previous } = original;
      const record = await store.createDexOrder({
        ...previous, id, orderId: id, signingRequest,
        preparedTransaction: prepared.kind === 'xrpl' ? prepared.unsignedTransaction as unknown as Record<string, unknown> : undefined,
        action: 'cancel', fee: prepared.fee, feeSymbol: prepared.feeSymbol, reserveImpact: null,
        expiresAt: prepared.expiresAt, status: 'awaiting_signature', transactionHash: undefined, resultCode: undefined,
        error: undefined, submittedAt: undefined, confirmedAt: undefined, createdAt: now, updatedAt: now, signedPayload: undefined,
      });
      return ok({ order: publicActivity(record), signingRequest });
    },
  );

  reg(
    'activity_list',
    {
      description: 'List Mosaic-submitted activity for the authenticated wallet and network.',
      inputSchema: {
        token: z.string(), after: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(250).optional(),
        chain: z.enum(['xrpl', 'stellar']).optional(), status: orderStatusSchema.optional(), sourceAddress: z.string().optional(),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const pending = (await store.listNonterminalDexOrders())
        .filter((record) => record.owner.chain === session.chain && record.owner.address === session.address && record.network === session.network)
        .slice(0, 20);
      if (pending.length > 0) await Promise.allSettled(pending.map((record) => reconcileDexOrder(store, record, xrplSourceTag)));
      let records = await store.listActivity(
        { chain: session.chain, address: session.address }, session.network,
        {
          after: args.after === undefined ? undefined : Number(args.after),
          limit: args.limit === undefined ? undefined : Number(args.limit),
          chain: args.chain as 'xrpl' | 'stellar' | undefined,
          status: args.status as OrderStatus | undefined,
          sourceAddress: args.sourceAddress === undefined ? undefined : String(args.sourceAddress),
        },
      );
      return ok({ activities: records.map(publicActivity) });
    },
  );

  reg(
    'activity_get',
    { description: 'Fetch one Mosaic activity record.', inputSchema: { token: z.string(), id: z.string().uuid() } },
    async (args) => {
      const session = await requireSession(args);
      const record = await store.getDexOrder({ chain: session.chain, address: session.address }, session.network, String(args.id));
      if (!record) throw new MosaicMcpError('NOT_FOUND', `activity not found: ${String(args.id)}`);
      return ok({ activity: publicActivity(record) });
    },
  );

  reg(
    'settings_get',
    {
      description: 'Read per-wallet settings and first-login chain-setup state for the authenticated root wallet.',
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
        chainSetupCompleted: current.chainSetupCompleted,
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
    'zone_chain_add',
    {
      description:
        'Enable one logical chain in an owned vault and atomically ensure that chain family has its #0 derived address.',
      inputSchema: { token: z.string(), zone: z.string().min(1).max(64), chainKey: z.string().min(1) },
    },
    async (args) => {
      const session = await requireSession(args);
      const zone = await requireZone(session, String(args.zone));
      return ok(await store.addZoneChain(zone.id, String(args.chainKey)));
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
      description: 'Record an unlock and bind its public derived addresses. No secret or private key is accepted.',
      inputSchema: {
        token: z.string(), zone: z.string().min(1).max(64),
        addresses: z.array(z.object({ id: z.string().uuid(), address: z.string().min(1).max(128) })).max(256).optional(),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const record = await store.markZoneUnlocked(session.chain, session.address, String(args.zone), session.network);
      if (!record) throw new MosaicMcpError('NOT_FOUND', `zone not found: ${String(args.zone)} (${session.network})`);
      const addresses = args.addresses as { id: string; address: string }[] | undefined;
      if (addresses?.length) await store.bindZoneAddresses(record.id, addresses);
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
      if (!(await store.getWalletSettings({ chain: session.chain, address: session.address })).chainSetupCompleted) {
        throw new MosaicMcpError('VALIDATION_FAILED', 'complete chain setup before creating a vault');
      }
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
      if (!(await store.getWalletSettings({ chain: session.chain, address: session.address })).chainSetupCompleted) {
        throw new MosaicMcpError('VALIDATION_FAILED', 'complete chain setup before creating a vault');
      }
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
      try { assertCanonicalAgentSource(source); } catch (error) {
        throw new MosaicMcpError('VALIDATION_FAILED', error instanceof Error ? error.message : String(error));
      }
      const sourceBytes = Buffer.from(source, 'utf8');
      if (sourceBytes.byteLength === 0 || sourceBytes.byteLength > MAX_AGENT_SOURCE_BYTES) {
        throw new MosaicMcpError('VALIDATION_FAILED', `agent source must be 1..${MAX_AGENT_SOURCE_BYTES} UTF-8 bytes`);
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
      const source = Buffer.from(record.source).toString('utf8');
      try { assertArtifactManifest(record.manifest); assertCanonicalAgentSource(source); } catch {
        throw new MosaicMcpError('INTERNAL', 'stored agent artifact failed structural verification');
      }
      if (Buffer.from(source, 'utf8').compare(Buffer.from(record.source)) !== 0 || artifactDigest(record.manifest) !== digest || sha256Hex(record.source) !== record.manifest.sourceDigest) {
        throw new MosaicMcpError('INTERNAL', 'stored agent artifact failed integrity verification');
      }
      return ok({ artifactDigest: digest, manifest: record.manifest, source, createdAt: record.createdAt });
    },
  );

  reg(
    'agent_artifact_list',
    {
      description: 'List immutable agent artifact manifests owned by the authenticated root wallet.',
      inputSchema: { token: z.string(), packageName: zoneNameSchema.optional() },
    },
    async (args) => {
      const session = await requireSession(args);
      const records = await store.listAgentArtifacts(
        { chain: session.chain, address: session.address },
        session.network,
        args.packageName === undefined ? undefined : String(args.packageName),
      );
      for (const record of records) {
        try { assertArtifactManifest(record.manifest); } catch {
          throw new MosaicMcpError('INTERNAL', 'stored agent artifact manifest failed structural verification');
        }
        if (artifactDigest(record.manifest) !== record.artifactDigest) throw new MosaicMcpError('INTERNAL', 'stored agent artifact manifest failed integrity verification');
      }
      return ok({ artifacts: records.map(({ owner: _owner, network: _network, ...record }) => record) });
    },
  );

  reg(
    'agent_artifact_ticket_create',
    {
      description: 'Create a short-lived, Runner-certificate-scoped capability for downloading one immutable agent artifact.',
      inputSchema: {
        token: z.string(),
        artifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
        runnerCertificateDigest: z.string().regex(/^[0-9a-f]{64}$/),
      },
    },
    async (args) => {
      const session = await requireSession(args);
      const digest = String(args.artifactDigest);
      const owner = { chain: session.chain, address: session.address };
      if (!await store.getAgentArtifact(owner, session.network, digest)) {
        throw new MosaicMcpError('NOT_FOUND', `agent artifact not found: ${digest}`);
      }
      const ticket = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      await store.createAgentArtifactTicket({
        ticketHash: sha256Hex(ticket),
        owner,
        network: session.network,
        artifactDigest: digest,
        runnerCertificateDigest: String(args.runnerCertificateDigest),
        expiresAt,
        maxReads: 3,
      });
      return ok({ ticket, artifactDigest: digest, runnerCertificateDigest: String(args.runnerCertificateDigest), expiresAt, maxReads: 3 });
    },
  );

  reg(
    'agent_artifact_download',
    {
      description: 'Consume a scoped artifact capability. The raw ticket is never stored and may be read at most three times.',
      inputSchema: { ticket: z.string().regex(/^[0-9a-f]{64}$/) },
    },
    async (args) => {
      const ticket = await store.consumeAgentArtifactTicket(sha256Hex(String(args.ticket)));
      if (!ticket) throw new MosaicMcpError('AUTH_INVALID', 'artifact ticket is expired, exhausted, or invalid');
      const record = await store.getAgentArtifact(ticket.owner, ticket.network, ticket.artifactDigest);
      if (!record) throw new MosaicMcpError('NOT_FOUND', 'ticketed artifact no longer exists');
      const source = Buffer.from(record.source).toString('utf8');
      try { assertArtifactManifest(record.manifest); assertCanonicalAgentSource(source); } catch {
        throw new MosaicMcpError('INTERNAL', 'ticketed artifact failed structural verification');
      }
      if (artifactDigest(record.manifest) !== ticket.artifactDigest || sha256Hex(record.source) !== record.manifest.sourceDigest) {
        throw new MosaicMcpError('INTERNAL', 'ticketed artifact failed integrity verification');
      }
      return ok({
        artifactDigest: ticket.artifactDigest,
        runnerCertificateDigest: ticket.runnerCertificateDigest,
        manifest: record.manifest,
        source,
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
