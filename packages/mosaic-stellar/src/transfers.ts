import type { TransferIntent } from '@mosaic/chain-core';
import { Asset, Horizon, Networks, Operation, StrKey, TransactionBuilder } from '@stellar/stellar-sdk';
import { HORIZON_ENDPOINTS } from './adapter.js';

export interface PreparedStellarTransfer {
  kind: 'stellar';
  unsignedXdr: string;
  networkPassphrase: string;
  fee: string;
  feeSymbol: 'XLM';
  reserveImpact: string | null;
  expiresAt: string;
}

function passphrase(network: TransferIntent['network']): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

export function stellarTransferMode(
  asset: TransferIntent['asset'],
  destinationExists: boolean,
  destinationTrustsAsset = false,
): 'create-account' | 'payment' {
  if (!destinationExists) {
    if (asset.kind !== 'native') throw new Error('the Stellar destination must exist and trust this issued asset');
    return 'create-account';
  }
  if (asset.kind === 'issued' && !destinationTrustsAsset) {
    throw new Error('the Stellar destination does not trust this issued asset');
  }
  return 'payment';
}

export async function prepareStellarTransfer(intent: TransferIntent): Promise<PreparedStellarTransfer> {
  if (intent.chain !== 'stellar') throw new Error('Stellar transfer requires the stellar chain');
  if (!StrKey.isValidEd25519PublicKey(intent.sourceAddress) || !StrKey.isValidEd25519PublicKey(intent.destinationAddress)) {
    throw new Error('invalid Stellar account address');
  }
  if (intent.sourceAddress === intent.destinationAddress) throw new Error('source and destination must differ');
  const server = new Horizon.Server(HORIZON_ENDPOINTS[intent.network]);
  const [source, baseFee] = await Promise.all([server.loadAccount(intent.sourceAddress), server.fetchBaseFee()]);
  let destination: Awaited<ReturnType<typeof server.loadAccount>> | null = null;
  try {
    destination = await server.loadAccount(intent.destinationAddress);
  } catch (error) {
    if ((error as { response?: { status?: number } }).response?.status !== 404) throw error;
  }
  let operation;
  let reserveImpact: string | null = null;
  const transferAsset = intent.asset;
  const trusted = destination && transferAsset.kind === 'issued' ? destination.balances.some((balance) => (
    balance.asset_type !== 'native' && 'asset_code' in balance && 'asset_issuer' in balance
    && balance.asset_code === transferAsset.code && balance.asset_issuer === transferAsset.issuer
  )) : false;
  const mode = stellarTransferMode(intent.asset, Boolean(destination), trusted);
  if (mode === 'create-account') {
    operation = Operation.createAccount({ destination: intent.destinationAddress, startingBalance: intent.amount });
    reserveImpact = 'This XLM transfer creates and funds the destination account.';
  } else if (intent.asset.kind === 'native') {
    operation = Operation.payment({ destination: intent.destinationAddress, asset: Asset.native(), amount: intent.amount });
  } else {
    const issued = intent.asset;
    operation = Operation.payment({
      destination: intent.destinationAddress,
      asset: new Asset(issued.code, issued.issuer), amount: intent.amount,
    });
  }
  const networkPassphrase = passphrase(intent.network);
  const transaction = new TransactionBuilder(source, { fee: String(baseFee), networkPassphrase })
    .addOperation(operation).setTimeout(180).build();
  return {
    kind: 'stellar', unsignedXdr: transaction.toXDR(), networkPassphrase,
    fee: String(baseFee / 10_000_000), feeSymbol: 'XLM', reserveImpact,
    expiresAt: new Date(Date.now() + 3 * 60_000).toISOString(),
  };
}
