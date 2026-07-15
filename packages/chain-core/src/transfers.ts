import type { Asset, DexChain, Network } from './types.js';

export type TransferStatus =
  | 'awaiting_signature'
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'unknown';

export interface TransferIntent {
  kind: 'transfer';
  chain: DexChain;
  network: Network;
  sourceAddress: string;
  sourceKind: 'root' | 'vault';
  zone?: string;
  addressId?: string;
  addressName?: string;
  destinationAddress: string;
  assetId: string;
  asset: Asset;
  assetSymbol: string;
  /** Asset units as a decimal string, never a JS number. */
  amount: string;
}

export interface TransferPreview extends TransferIntent {
  fee: string;
  feeSymbol: string;
  reserveImpact: string | null;
  expiresAt: string;
}

export interface TransferActivityRecord extends TransferPreview {
  id: string;
  cursor: number;
  status: TransferStatus;
  transactionHash?: string;
  ledger?: string;
  resultCode?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  confirmedAt?: string;
}

