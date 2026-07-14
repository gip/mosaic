import {
  assertPositiveDecimal,
  dropsToXrp,
  quantizeDecimal,
  type Asset,
  type DecimalRounding,
  type DexOrderIntent,
  type Network,
} from '@mosaic/chain-core';
import {
  Client,
  Wallet,
  decode,
  hashes,
  verifySignature,
  xrpToDrops,
  type Amount,
  type OfferCancel,
  type OfferCreate,
  type Transaction,
} from 'xrpl';
import { normalizeCurrency } from './adapter.js';
import { XRPL_WS_ENDPOINTS } from './adapter.js';

export interface PreparedXrplOrder {
  kind: 'xrpl';
  unsignedTransaction: OfferCreate | OfferCancel;
  fee: string;
  feeSymbol: 'XRP';
  reserveImpact: string | null;
  expiresAt: string;
}

const XRPL_IOU_SIGNIFICANT_DIGITS = 16;

function normalizeIssuedValue(value: string, rounding: DecimalRounding): string {
  assertPositiveDecimal(value, 'XRPL issued amount');
  const [whole, fraction = ''] = value.split('.');
  const digits = `${whole}${fraction}`;
  const leadingZeros = digits.match(/^0*/)?.[0].length ?? 0;
  const trailingZeros = digits.match(/0*$/)?.[0].length ?? 0;
  const significantDigits = digits.length - leadingZeros - trailingZeros;
  if (significantDigits <= XRPL_IOU_SIGNIFICANT_DIGITS) {
    const trimmed = fraction.replace(/0+$/, '');
    return trimmed ? `${whole}.${trimmed}` : whole;
  }

  const discardedDigits = trailingZeros + significantDigits - XRPL_IOU_SIGNIFICANT_DIGITS;
  const factor = 10n ** BigInt(discardedDigits);
  const scaled = BigInt(digits);
  let retained = scaled / factor;
  if (rounding === 'ceil' && scaled % factor !== 0n) retained += 1n;
  const quantized = retained * factor;
  if (fraction.length === 0) return quantized.toString();
  const text = quantized.toString().padStart(fraction.length + 1, '0');
  const normalizedFraction = text.slice(-fraction.length).replace(/0+$/, '');
  return normalizedFraction ? `${text.slice(0, -fraction.length)}.${normalizedFraction}` : text.slice(0, -fraction.length);
}

/** Normalize a user-facing amount to the exact decimal representation XRPL can serialize. */
export function normalizeXrplAssetAmount(asset: Asset, value: string, rounding: DecimalRounding = 'floor'): string {
  if (asset.kind === 'issued') return normalizeIssuedValue(value, rounding);
  const quantized = quantizeDecimal(value, 6, rounding);
  assertPositiveDecimal(quantized, 'XRP amount');
  return dropsToXrp(xrpToDrops(quantized));
}

function xrplAmount(asset: Asset, value: string, rounding: DecimalRounding = 'floor'): Amount {
  const normalized = normalizeXrplAssetAmount(asset, value, rounding);
  return asset.kind === 'native'
    ? xrpToDrops(normalized)
    : { currency: normalizeCurrency(asset.currencyCode ?? asset.code), issuer: asset.issuer, value: normalized };
}

function endpoint(network: Network): string {
  return XRPL_WS_ENDPOINTS[network];
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export async function prepareXrplOrder(
  intent: DexOrderIntent,
  quoteTotal: string,
  clientFactory: (url: string) => Client = (url) => new Client(url),
): Promise<PreparedXrplOrder> {
  const client = clientFactory(endpoint(intent.network));
  await client.connect();
  try {
    const transaction: OfferCreate = intent.side === 'sell'
      ? {
          TransactionType: 'OfferCreate', Account: intent.sourceAddress,
          TakerGets: xrplAmount(intent.base, intent.amount),
          TakerPays: xrplAmount(intent.quote, quoteTotal, 'ceil'),
          Flags: 0x00080000,
        }
      : {
          TransactionType: 'OfferCreate', Account: intent.sourceAddress,
          TakerGets: xrplAmount(intent.quote, quoteTotal),
          TakerPays: xrplAmount(intent.base, intent.amount),
          Flags: 0,
        };
    const prepared = await client.autofill(transaction);
    return {
      kind: 'xrpl',
      unsignedTransaction: prepared,
      fee: String(prepared.Fee ? Number(prepared.Fee) / 1_000_000 : 0),
      feeSymbol: 'XRP',
      reserveImpact: 'One owner reserve may be required while the offer remains open.',
      expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
    };
  } finally {
    await client.disconnect();
  }
}

export async function prepareXrplCancel(
  network: Network,
  sourceAddress: string,
  offerSequence: number,
  clientFactory: (url: string) => Client = (url) => new Client(url),
): Promise<PreparedXrplOrder> {
  const client = clientFactory(endpoint(network));
  await client.connect();
  try {
    const prepared = await client.autofill({
      TransactionType: 'OfferCancel', Account: sourceAddress, OfferSequence: offerSequence,
    } as OfferCancel) as OfferCancel;
    return {
      kind: 'xrpl', unsignedTransaction: prepared,
      fee: String(prepared.Fee ? Number(prepared.Fee) / 1_000_000 : 0), feeSymbol: 'XRP',
      reserveImpact: null, expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
    };
  } finally { await client.disconnect(); }
}

export function signXrplTransaction(transaction: Transaction, privateKey: Uint8Array, publicKey: Uint8Array): { txBlob: string; hash: string } {
  const wallet = new Wallet(
    bytesToHex(publicKey),
    `00${bytesToHex(privateKey)}`,
  );
  const signed = wallet.sign(transaction);
  return { txBlob: signed.tx_blob, hash: signed.hash };
}

export function verifyXrplTransaction(txBlob: string): Transaction {
  if (!verifySignature(txBlob)) throw new Error('XRPL transaction signature verification failed');
  return decode(txBlob) as Transaction;
}

export function xrplTransactionHash(txBlob: string): string {
  return hashes.hashSignedTx(txBlob);
}

export async function lookupXrplTransaction(
  network: Network,
  hash: string,
  clientFactory: (url: string) => Client = (url) => new Client(url),
): Promise<{ hash: string; ledger?: string; resultCode: string } | null> {
  const client = clientFactory(endpoint(network));
  await client.connect();
  try {
    const response = await client.request({ command: 'tx', transaction: hash });
    const meta = response.result.meta;
    const resultCode = typeof meta === 'object' && meta && 'TransactionResult' in meta ? String(meta.TransactionResult) : 'unknown';
    return { hash, ledger: response.result.ledger_index?.toString(), resultCode };
  } catch (error) {
    if ((error as { data?: { error?: string } }).data?.error === 'txnNotFound') return null;
    throw error;
  } finally { await client.disconnect(); }
}

export async function submitXrplTransaction(
  network: Network,
  txBlob: string,
  clientFactory: (url: string) => Client = (url) => new Client(url),
): Promise<{ hash: string; ledger?: string; resultCode: string }> {
  const client = clientFactory(endpoint(network));
  await client.connect();
  try {
    const result = await client.submitAndWait(txBlob);
    const meta = result.result.meta;
    const resultCode = typeof meta === 'object' && meta && 'TransactionResult' in meta
      ? String(meta.TransactionResult)
      : 'unknown';
    return { hash: String(result.result.hash), ledger: result.result.ledger_index?.toString(), resultCode };
  } finally { await client.disconnect(); }
}

function remainingAmount(amount: Amount): string {
  return typeof amount === 'string' ? dropsToXrp(amount) : amount.value;
}

/** null means the validated ledger no longer contains the offer. */
export async function getXrplOfferRemaining(
  network: Network,
  sourceAddress: string,
  offerSequence: number,
  side: 'buy' | 'sell',
  clientFactory: (url: string) => Client = (url) => new Client(url),
): Promise<string | null> {
  const client = clientFactory(endpoint(network));
  await client.connect();
  try {
    const response = await client.request({ command: 'account_offers', account: sourceAddress, ledger_index: 'validated', limit: 400 });
    const offer = response.result.offers?.find(({ seq }) => seq === offerSequence);
    if (!offer) return null;
    return remainingAmount(side === 'sell' ? offer.taker_gets : offer.taker_pays);
  } finally { await client.disconnect(); }
}
