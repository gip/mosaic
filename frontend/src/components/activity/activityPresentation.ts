import type { ActivityRecord } from '@mosaic/chain-core';

export function activityExplorerUrl(activity: ActivityRecord): string | null {
  if (!activity.transactionHash) return null;
  if (activity.chain === 'xrpl') {
    const host = activity.network === 'mainnet' ? 'livenet.xrpl.org' : 'testnet.xrpl.org';
    return `https://${host}/transactions/${activity.transactionHash}`;
  }
  const network = activity.network === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${network}/tx/${activity.transactionHash}`;
}

export function activityIntent(activity: ActivityRecord): { title: string; detail: string } {
  const pair = `${activity.baseSymbol}/${activity.quoteSymbol}`;
  if (activity.action === 'cancel') {
    return {
      title: `Cancel ${pair} order`,
      detail: activity.offerId ? `Offer ${activity.offerId}` : 'Cancel the open offer',
    };
  }

  const action = activity.action === 'buy' ? 'Buy' : 'Sell';
  return {
    title: `${action} ${activity.amount} ${activity.baseSymbol}`,
    detail: `Limit ${activity.limitPrice} ${activity.quoteSymbol} per ${activity.baseSymbol}`,
  };
}

export function shortTransactionId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}
