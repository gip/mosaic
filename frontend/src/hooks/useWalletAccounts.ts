import { useMemo } from 'react';
import type { AgentChain } from '@mosaic/zone-keys';
import { useSession } from '../contexts/SessionContext';
import { useVaults } from '../contexts/VaultContext';
import { vaultDisplayName } from '../vaultName';

export interface RootWalletAccount {
  kind: 'root';
  chain: AgentChain;
  address: string;
  label: 'Root';
}

export interface VaultWalletAccount {
  kind: 'vault';
  chain: AgentChain;
  address: string;
  label: string;
  zone: string;
  addressId: string;
  addressName: string;
  index: number;
  commitment: string;
}

export type WalletAccount = RootWalletAccount | VaultWalletAccount;

export interface VaultAddressOption {
  chain: AgentChain;
  address: string;
  label: string;
  zone: string;
  addressId: string;
  addressName: string;
  index: number;
  signable: boolean;
}

export function useWalletAccounts(): WalletAccount[] {
  const { session } = useSession();
  const { vaults } = useVaults();
  return useMemo(() => {
    const accounts: WalletAccount[] = [];
    if (session) accounts.push({ kind: 'root', chain: session.chain, address: session.address, label: 'Root' });
    for (const vault of vaults) {
      if (vault.status !== 'unlocked') continue;
      for (const entry of vault.derivedAddresses ?? []) {
        accounts.push({
          kind: 'vault', chain: entry.chain, address: entry.address, zone: vault.zone,
          addressId: entry.id, addressName: entry.name, index: entry.index,
          commitment: vault.commitment, label: `${vaultDisplayName(vault.zone)} / ${entry.name}`,
        });
      }
    }
    return accounts;
  }, [session, vaults]);
}

/** Every registered vault address; locked vaults remain eligible destinations. */
export function useVaultAddressOptions(): VaultAddressOption[] {
  const { vaults } = useVaults();
  return useMemo(() => vaults.flatMap((vault) => vault.addresses.flatMap((entry) => {
    const derived = (vault.derivedAddresses ?? []).find((candidate) => candidate.id === entry.id);
    const address = entry.address ?? derived?.address;
    if (!address) return [];
    const signable = vault.status === 'unlocked' && derived?.address.toLowerCase() === address.toLowerCase();
    return [{
      chain: entry.chain, address, zone: vault.zone, addressId: entry.id,
      addressName: entry.name, index: entry.index, signable,
      label: `${vaultDisplayName(vault.zone)} / ${entry.name}`,
    }];
  })), [vaults]);
}
