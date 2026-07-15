import type { ActivityRecord } from '@mosaic/chain-core';
import type { WalletActivityRecord } from '@mosaic/chain-core';
import { transactionExplorerUrl } from '../address/explorers';

export function activityExplorerUrl(activity: WalletActivityRecord): string | null {
  if (!activity.transactionHash) return null;
  return transactionExplorerUrl(activity.chain, activity.network, activity.transactionHash);
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

export function activityStatusLabel(status: WalletActivityRecord['status']): string {
  const label = status.replaceAll('_', ' ');
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}
