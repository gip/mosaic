import { useEffect, useState } from 'react';
import type { ZoneRef } from '@mosaic/zone-keys';
import type { ZoneAddressItem } from '../api';
import Banner from './ui/Banner';
import Modal from './ui/Modal';
import { readVaultData, type VaultDataSnapshot } from '../zone/vaultData';
import AccountAddress from './address/AccountAddress';
import { vaultDisplayName } from '../vaultName';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; snapshot: VaultDataSnapshot }
  | { phase: 'failed'; message: string };

export default function VaultDataModal({
  token,
  vaultRef,
  commitment,
  registeredAddresses,
  onClose,
}: {
  token: string;
  vaultRef: ZoneRef;
  commitment: string;
  registeredAddresses: readonly (ZoneAddressItem & { address?: string })[];
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ phase: 'loading' });
  const { rootChain, rootAddress, zone, network } = vaultRef;

  useEffect(() => {
    let cancelled = false;
    void readVaultData({
      token,
      commitment,
      ref: { rootChain, rootAddress, zone, network },
    }).then(
      (snapshot) => { if (!cancelled) setState({ phase: 'loaded', snapshot }); },
      (cause: unknown) => {
        if (!cancelled) setState({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
    return () => { cancelled = true; };
  }, [commitment, network, rootAddress, rootChain, token, zone]);

  return (
    <Modal title={<>Vault data · <span className="mono">{vaultDisplayName(zone)}</span></>} onClose={onClose}>
      <section className="vault-data-section">
        <h4>Registered addresses</h4>
        <p className="tile-note">Public address records allocated for this vault. Derived addresses are calculated locally while the vault is unlocked.</p>
        <div className="vault-data-addresses">
          {registeredAddresses.map((item) => <div key={item.id}><span>{item.name} · {item.chain.toUpperCase()}</span>{item.address
            ? <AccountAddress chain={item.chain} network={network} address={item.address} className="mono">{item.address}</AccountAddress>
            : <span className="tile-note">Not bound</span>}</div>)}
        </div>
      </section>
      <section className="vault-data-section">
        <h4>Encrypted vault data</h4>
        <p className="tile-note">Decrypted locally from the latest mutable data blob. Private keys and the vault root secret are never included.</p>
        {state.phase === 'loading' && <p role="status">Loading encrypted vault data…</p>}
        {state.phase === 'failed' && <Banner tone="err">{state.message}</Banner>}
        {state.phase === 'loaded' && (
          <>
            <p className="vault-data-meta tile-note">
              {state.snapshot.stored
                ? `Revision ${state.snapshot.revision} · storage version ${state.snapshot.version}`
                : 'No mutable data blob has been stored yet.'}
            </p>
            <pre className="vault-data-json" aria-label="Encrypted vault data JSON">{JSON.stringify(state.snapshot.data, null, 2)}</pre>
          </>
        )}
      </section>
    </Modal>
  );
}
