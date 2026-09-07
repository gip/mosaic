import { BUILTIN_ASSETS } from '@mosaic/catalog';
import { assertReviewedFields, multiplyDecimals, quantizeDecimal, type Asset, type TransactionReview } from '@mosaic/chain-core';
import type { AuthVerifyResult, DexSigningRequest } from '../api';
import type { WalletAccount } from '../hooks/useWalletAccounts';

/** Validate the review itself against local account context and the shipped
 * asset catalog, then decode the actual transaction before loading any keys. */
export async function validateTransactionReview(review: TransactionReview, request: DexSigningRequest, account: WalletAccount, session: AuthVerifyResult): Promise<void> {
  const sameAddress = (a: string, b: string) => account.chain === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (review.network !== session.network || review.chain !== account.chain || review.sourceKind !== account.kind ||
      !sameAddress(review.sourceAddress, account.address) ||
      (account.kind === 'root' && (account.chain !== session.chain || !sameAddress(account.address, session.address))) ||
      (account.kind === 'vault' && (review.zone !== account.zone || review.addressId !== account.addressId))) {
    throw new Error('Transaction review does not match the selected account and network.');
  }
  const chainId = account.chain === 'evm' ? (session.network === 'mainnet' ? 'base-mainnet' : 'base-sepolia') : `${account.chain}-${session.network}`;
  function deployment(asset: Asset, symbol: string, assetId?: string) {
    const deployed = BUILTIN_ASSETS.filter((item) => assetId === undefined || item.id === assetId)
      .flatMap((item) => item.deployments).find((item) => item.chainId === chainId && item.symbol === symbol);
    if (!deployed) throw new Error('Unrecognized reviewed asset.');
    const expected: Asset = deployed.kind === 'native' ? { kind: 'native' } : {
      kind: 'issued', code: deployed.symbol, issuer: deployed.address!,
      ...(deployed.currencyCode ? { currencyCode: deployed.currencyCode } : {}),
    };
    assertReviewedFields(Object.fromEntries(Object.entries(asset).filter(([, value]) => value !== undefined)), expected);
    return deployed;
  }
  let decimals = 0;
  if (review.kind === 'transfer') decimals = deployment(review.asset, review.assetSymbol, review.assetId).decimals;
  else {
    deployment(review.base, review.baseSymbol);
    const quote = deployment(review.quote, review.quoteSymbol);
    if (review.action !== 'cancel') {
      const rounding = review.side === 'sell' ? 'ceil' : 'floor';
      let total = quantizeDecimal(multiplyDecimals(review.amount, review.limitPrice), quote.decimals, rounding);
      if (review.chain === 'xrpl') {
        const { normalizeXrplAssetAmount } = await import('@mosaic/xrpl');
        total = normalizeXrplAssetAmount(review.quote, total, rounding);
      }
      if (review.quoteTotal !== total) throw new Error('Order total does not match the reviewed amount and limit price.');
    }
  }
  if (request.kind === 'xaman') {
    if (account.kind !== 'root' || account.chain !== 'xrpl') throw new Error('Vault transactions require local validation and signing.');
    // Xaman displays the transaction in the root wallet before signing.
    return;
  }
  if (request.kind !== account.chain) throw new Error('Transaction signing chain mismatch.');
  if (request.kind === 'xrpl') {
    const { assertReviewedXrplTransaction } = await import('@mosaic/xrpl');
    assertReviewedXrplTransaction(request.unsignedTransaction, review);
  } else if (request.kind === 'stellar') {
    const { assertReviewedStellarTransaction } = await import('@mosaic/stellar');
    assertReviewedStellarTransaction(request.unsignedXdr, review);
  } else {
    if (review.kind !== 'transfer') throw new Error('EVM orders are not supported.');
    const { assertReviewedEvmTransfer } = await import('@mosaic/evm');
    assertReviewedEvmTransfer(request.transaction as unknown as Parameters<typeof assertReviewedEvmTransfer>[0], review, decimals);
  }
}
