import { useMemo } from 'react';
import type { TradingChain } from '@mosaic/chain-core';
import { useSession } from '../contexts/SessionContext';
import { useVaults } from '../contexts/VaultContext';

export interface RootTradingAccount {
  kind: 'root';
  chain: TradingChain;
  address: string;
  label: 'Root';
}

export interface VaultTradingAccount {
  kind: 'vault';
  chain: TradingChain;
  address: string;
  label: string;
  zone: string;
  addressId: string;
  addressName: string;
  index: number;
  commitment: string;
}

export type TradingAccount = RootTradingAccount | VaultTradingAccount;

export function useTradingAccounts(chain: TradingChain): TradingAccount[] {
  const { session } = useSession();
  const { vaults } = useVaults();
  return useMemo(() => {
    const accounts: TradingAccount[] = [];
    if (session?.chain === chain) {
      accounts.push({ kind: 'root', chain, address: session.address, label: 'Root' });
    }
    for (const vault of vaults) {
      if (vault.status !== 'unlocked') continue;
      for (const entry of vault.derivedAddresses ?? []) {
        if (entry.chain !== chain) continue;
        accounts.push({
          kind: 'vault', chain, address: entry.address, zone: vault.zone,
          addressId: entry.id, addressName: entry.name, index: entry.index,
          commitment: vault.commitment, label: `${vault.zone} / ${entry.name}`,
        });
      }
    }
    return accounts;
  }, [chain, session, vaults]);
}
