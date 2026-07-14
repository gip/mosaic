import { divDecimals, type Asset, type DexOrderIntent, type Network } from '@mosaic/chain-core';
import {
  Asset as StellarAsset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { HORIZON_ENDPOINTS } from './adapter.js';

export interface PreparedStellarOrder {
  kind: 'stellar';
  unsignedXdr: string;
  networkPassphrase: string;
  fee: string;
  feeSymbol: 'XLM';
  reserveImpact: string | null;
  expiresAt: string;
}

function passphrase(network: Network): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

function stellarAsset(asset: Asset): StellarAsset {
  return asset.kind === 'native' ? StellarAsset.native() : new StellarAsset(asset.code, asset.issuer);
}

export function buildStellarOfferOperation(intent: DexOrderIntent): ReturnType<typeof Operation.manageSellOffer> {
  return intent.side === 'sell'
    ? Operation.manageSellOffer({
        selling: stellarAsset(intent.base), buying: stellarAsset(intent.quote),
        amount: intent.amount, price: intent.limitPrice, offerId: '0',
      })
    : Operation.manageBuyOffer({
        selling: stellarAsset(intent.quote), buying: stellarAsset(intent.base),
        buyAmount: intent.amount, price: intent.limitPrice, offerId: '0',
      });
}

export async function prepareStellarOrder(intent: DexOrderIntent, _quoteTotal: string): Promise<PreparedStellarOrder> {
  const server = new Horizon.Server(HORIZON_ENDPOINTS[intent.network]);
  const [account, baseFee] = await Promise.all([server.loadAccount(intent.sourceAddress), server.fetchBaseFee()]);
  const operation = buildStellarOfferOperation(intent);
  const transaction = new TransactionBuilder(account, { fee: String(baseFee), networkPassphrase: passphrase(intent.network) })
    .addOperation(operation)
    .setTimeout(180)
    .build();
  return {
    kind: 'stellar', unsignedXdr: transaction.toXDR(), networkPassphrase: passphrase(intent.network),
    fee: String(baseFee / 10_000_000), feeSymbol: 'XLM',
    reserveImpact: 'One subentry reserve may be required while the offer remains open.',
    expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
  };
}

export async function prepareStellarCancel(network: Network, sourceAddress: string, offerId: string, selling: Asset, buying: Asset): Promise<PreparedStellarOrder> {
  const server = new Horizon.Server(HORIZON_ENDPOINTS[network]);
  const [account, baseFee] = await Promise.all([server.loadAccount(sourceAddress), server.fetchBaseFee()]);
  const transaction = new TransactionBuilder(account, { fee: String(baseFee), networkPassphrase: passphrase(network) })
    .addOperation(Operation.manageSellOffer({ selling: stellarAsset(selling), buying: stellarAsset(buying), amount: '0', price: '1', offerId }))
    .setTimeout(180)
    .build();
  return {
    kind: 'stellar', unsignedXdr: transaction.toXDR(), networkPassphrase: passphrase(network),
    fee: String(baseFee / 10_000_000), feeSymbol: 'XLM', reserveImpact: null,
    expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
  };
}

export function signStellarTransaction(unsignedXdr: string, network: Network, privateKey: Uint8Array): string {
  const transaction = TransactionBuilder.fromXDR(unsignedXdr, passphrase(network));
  if (!(transaction instanceof Transaction)) throw new Error('fee-bump transactions are not supported');
  transaction.sign(Keypair.fromRawEd25519Seed(privateKey));
  return transaction.toXDR();
}

export function verifyStellarTransaction(signedXdr: string, network: Network, sourceAddress: string): Transaction {
  const transaction = TransactionBuilder.fromXDR(signedXdr, passphrase(network));
  if (!(transaction instanceof Transaction) || !('source' in transaction) || transaction.source !== sourceAddress || transaction.signatures.length !== 1) {
    throw new Error('unexpected Stellar transaction envelope');
  }
  const signature = transaction.signatures[0]!;
  if (!Keypair.fromPublicKey(sourceAddress).verify(transaction.hash(), signature.signature())) {
    throw new Error('Stellar transaction signature verification failed');
  }
  return transaction;
}

export function stellarTransactionMatchesUnsigned(signedXdr: string, unsignedXdr: string, network: Network, sourceAddress: string): boolean {
  const signed = verifyStellarTransaction(signedXdr, network, sourceAddress);
  const unsigned = TransactionBuilder.fromXDR(unsignedXdr, passphrase(network));
  const left = signed.signatureBase() as Uint8Array;
  const right = unsigned.signatureBase() as Uint8Array;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function stellarTransactionHash(signedXdr: string, network: Network): string {
  const bytes = TransactionBuilder.fromXDR(signedXdr, passphrase(network)).hash() as Uint8Array;
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

export async function lookupStellarTransaction(network: Network, hash: string): Promise<{ hash: string; ledger?: string; resultCode: string } | null> {
  try {
    const response = await new Horizon.Server(HORIZON_ENDPOINTS[network]).transactions().transaction(hash).call();
    return { hash, ledger: response.ledger.toString(), resultCode: response.successful ? 'success' : 'failed' };
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 404) return null;
    throw error;
  }
}

interface StellarOfferResult {
  currentOffer?: { offerId?: string; amount?: string };
  amountBought?: string;
  amountSold?: string;
  wasImmediatelyFilled?: boolean;
  wasPartiallyFilled?: boolean;
}

export async function submitStellarTransaction(network: Network, signedXdr: string): Promise<{
  hash: string;
  ledger?: string;
  resultCode: string;
  offerId?: string;
  amountBought?: string;
  amountSold?: string;
  remainingAmount?: string;
  fullyFilled?: boolean;
}> {
  const decoded = TransactionBuilder.fromXDR(signedXdr, passphrase(network));
  if (!('source' in decoded)) throw new Error('fee-bump transactions are not supported');
  const transaction = verifyStellarTransaction(signedXdr, network, decoded.source);
  const response = await new Horizon.Server(HORIZON_ENDPOINTS[network]).submitTransaction(transaction);
  const offer = (response as typeof response & { offerResults?: StellarOfferResult[] }).offerResults?.[0];
  return {
    hash: response.hash,
    ledger: response.ledger.toString(),
    resultCode: response.successful ? 'success' : 'failed',
    offerId: offer?.currentOffer?.offerId,
    amountBought: offer?.amountBought,
    amountSold: offer?.amountSold,
    remainingAmount: offer?.currentOffer?.amount,
    fullyFilled: offer?.wasImmediatelyFilled,
  };
}

/** null means Horizon no longer exposes the offer in the current ledger. */
export async function getStellarOfferRemaining(
  network: Network,
  offerId: string,
  side: 'buy' | 'sell',
): Promise<string | null> {
  try {
    const offer = await new Horizon.Server(HORIZON_ENDPOINTS[network]).offers().offer(offerId).call();
    return side === 'sell' ? offer.amount : divDecimals(offer.amount, offer.price);
  } catch (error) {
    const status = (error as { response?: { status?: number } }).response?.status;
    if (status === 404) return null;
    throw error;
  }
}
