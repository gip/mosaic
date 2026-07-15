import type { AgentChain, Network } from '@mosaic/zone-keys';

export function explorerName(chain: AgentChain): string {
  return chain === 'xrpl' ? 'XRPL Explorer' : chain === 'stellar' ? 'Stellar Expert' : 'BaseScan';
}

export function accountExplorerUrl(chain: AgentChain, network: Network, address: string): string {
  const value = encodeURIComponent(address);
  if (chain === 'xrpl') return `https://${network === 'mainnet' ? 'livenet' : 'testnet'}.xrpl.org/accounts/${value}`;
  if (chain === 'stellar') return `https://stellar.expert/explorer/${network === 'mainnet' ? 'public' : 'testnet'}/account/${value}`;
  return `https://${network === 'mainnet' ? '' : 'sepolia.'}basescan.org/address/${value}`;
}

export function transactionExplorerUrl(chain: AgentChain, network: Network, hash: string): string {
  const value = encodeURIComponent(hash);
  if (chain === 'xrpl') return `https://${network === 'mainnet' ? 'livenet' : 'testnet'}.xrpl.org/transactions/${value}`;
  if (chain === 'stellar') return `https://stellar.expert/explorer/${network === 'mainnet' ? 'public' : 'testnet'}/tx/${value}`;
  return `https://${network === 'mainnet' ? '' : 'sepolia.'}basescan.org/tx/${value}`;
}

