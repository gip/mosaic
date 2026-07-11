import { useCallback, useState } from 'react';
import type { ZoneRef } from '@mosaic/zone-keys';
import Modal from './ui/Modal';
import Banner from './ui/Banner';
import Field from './ui/Field';
import ProgressSteps from './ui/ProgressSteps';
import AgentAddressCards from './AgentAddresses';
import { type XamanRefs } from '../api';
import { errorMessage } from '../errors';
import { useSession } from '../contexts/SessionContext';
import { useVaults, type VaultState } from '../contexts/VaultContext';
import {
  CEREMONY_STEP_LABELS,
  NonDeterministicWalletError,
  runZoneCeremony,
  type CeremonySigner,
} from '../zone/ceremony';
import { directCeremonySigner, xamanCeremonySigner } from '../zone/signers';
import { unlockWithPassphrase, unlockWithSignature } from '../zone/unlock';
import { createTestnetVault, unlockTestnetVault } from '../zone/testnet';

interface XamanPrompt { refs: XamanRefs; label: string }
const VAULT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function useVaultSigner(ref: ZoneRef | null, setPrompt: (prompt: XamanPrompt | null) => void): () => CeremonySigner {
  const { session, signZoneMessage } = useSession();
  return useCallback(() => {
    if (!session || !ref) throw new Error('not logged in');
    if (session.chain === 'xrpl') {
      return xamanCeremonySigner({
        token: session.token,
        ref,
        onPayload: (refs, label) => setPrompt({ refs, label }),
        onPayloadDone: () => setPrompt(null),
      });
    }
    return directCeremonySigner(ref, signZoneMessage);
  }, [ref, session, setPrompt, signZoneMessage]);
}

function XamanPromptModal({ prompt, onClose }: { prompt: XamanPrompt; onClose: () => void }) {
  return (
    <Modal title={prompt.label} onClose={onClose}>
      <div className="qr-box qr-large"><img src={prompt.refs.qrPng} alt="Xaman signing QR code" /></div>
      <p className="tile-note">
        Scan with Xaman, or <a href={prompt.refs.deeplink} target="_blank" rel="noreferrer">open the request directly</a>.
      </p>
    </Modal>
  );
}

export default function ZonePanel({ onCreate }: { onCreate: () => void }) {
  const { session } = useSession();
  const { activeVault, loading, error, metadataWarning, createAddress, lockVault } = useVaults();
  const [unlockOpen, setUnlockOpen] = useState(false);
  if (!session) return null;

  return (
    <section className="zone-panel">
      <div className="zone-head vault-page-head">
        <div>
          <h2>{activeVault ? <>Vault <span className="mono">{activeVault.zone === 'default' ? 'Default' : activeVault.zone}</span> · {session.network}</> : 'Vaults'}</h2>
        </div>
        <button type="button" onClick={onCreate}>Create vault</button>
      </div>
      {loading && <p className="tile-note">Loading vaults…</p>}
      {error && <Banner tone="err">{error}</Banner>}
      {metadataWarning && <Banner tone="warn">{metadataWarning}</Banner>}
      {!loading && !error && !activeVault && (
        <div className="zone-card">
          <h3>Create your first vault</h3>
          <p>A vault generates deterministic agent addresses while its secret remains encrypted outside this browser.</p>
          <button type="button" onClick={onCreate}>Create vault</button>
        </div>
      )}
      {activeVault?.status === 'locked' && (
        <div className="zone-card">
          <h3>Vault locked</h3>
          <p>{activeVault.mode === 'testnet-device' ? 'The vault secret is not available on this device. Unlock with this device’s key.' : 'The vault secret is not available on this device. Restore it with your wallet signature or backup passphrase.'}</p>
          <button type="button" onClick={() => setUnlockOpen(true)}>Unlock vault</button>
        </div>
      )}
      {activeVault?.status === 'unlocked' && activeVault.derivedAddresses && (
        <>
          <AgentAddressCards
            addresses={activeVault.derivedAddresses}
            chains={activeVault.chains}
            onCreate={(chain, name) => createAddress(activeVault.zone, chain, name)}
          />
          <div className="zone-actions">
            <span className="tile-note mono" title="zoneRootCommitment">commitment {activeVault.commitment.slice(0, 16)}…</span>
            <button type="button" className="btn-sm" onClick={() => void lockVault(activeVault.zone)}>Lock vault on this device</button>
          </div>
        </>
      )}
      {unlockOpen && activeVault && <UnlockVaultModal vault={activeVault} onClose={() => setUnlockOpen(false)} />}
    </section>
  );
}

export function CreateVaultModal({ onClose }: { onClose: () => void }) {
  const { session } = useSession();
  const { vaults, registerCreated } = useVaults();
  const [name, setName] = useState(vaults.length === 0 ? 'default' : '');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [xamanPrompt, setXamanPrompt] = useState<XamanPrompt | null>(null);
  const ref: ZoneRef | null = session && name ? {
    rootChain: session.chain, rootAddress: session.address, zone: name, network: session.network,
  } : null;
  const makeSigner = useVaultSigner(ref, setXamanPrompt);
  const nameValid = name.length <= 64 && VAULT_NAME.test(name);
  const duplicate = vaults.some((vault) => vault.zone === name);
  const testnet = session?.network === 'testnet';
  const ready = nameValid && !duplicate && !step && (testnet || (passphrase.length >= 10 && passphrase === confirm));

  async function create() {
    if (!session || !ref || !ready) return;
    setError(null);
    try {
      if (testnet) {
        setStep('Encrypting Testnet vault for this device…');
        await createTestnetVault(session.token, ref);
      } else {
        await runZoneCeremony({ token: session.token, ref, passphrase, signer: makeSigner(), onStep: (next) => setStep(CEREMONY_STEP_LABELS[next]) });
      }
      await registerCreated(name);
      onClose();
    } catch (cause) {
      setStep(null);
      setError(cause instanceof NonDeterministicWalletError
        ? `Wallet rejected for browser vaults. ${cause.message}`
        : errorMessage(cause));
    }
  }

  return (
    <>
      <Modal title="Create vault" onClose={onClose}>
        <p>{testnet ? 'Testnet vaults are encrypted with a device key and require no additional wallet signatures.' : 'Vault names are permanent because they are part of key derivation. Use lowercase letters, numbers, and single hyphens.'}</p>
        {error && <Banner tone="err">{error}</Banner>}
        {step ? <><ProgressSteps running step={step} /><p className="tile-note">{step}</p></> : (
          <>
            <Field id="vault-name" label="Vault name" error={duplicate ? 'A vault with this name already exists.' : (name && !nameValid ? 'Use lowercase letters, numbers, and single hyphens (64 characters maximum).' : undefined)}>
              <input value={name} maxLength={64} autoComplete="off" onChange={(event) => setName(event.target.value)} placeholder="trading" />
            </Field>
            {!testnet && <Field id="vault-passphrase" label="Backup passphrase" error={passphrase && passphrase.length < 10 ? 'Use at least 10 characters.' : undefined}>
              <input type="password" value={passphrase} autoComplete="new-password" onChange={(event) => setPassphrase(event.target.value)} />
            </Field>}
            {!testnet && <Field id="vault-passphrase-confirm" label="Confirm passphrase" error={confirm && passphrase !== confirm ? 'Passphrases do not match.' : undefined}>
              <input type="password" value={confirm} autoComplete="new-password" onChange={(event) => setConfirm(event.target.value)} />
            </Field>}
            <button type="button" className="btn-primary" disabled={!ready} onClick={() => void create()}>Create vault</button>
          </>
        )}
      </Modal>
      {xamanPrompt && <XamanPromptModal prompt={xamanPrompt} onClose={() => setXamanPrompt(null)} />}
    </>
  );
}

export function UnlockVaultModal({ vault, onClose }: { vault: VaultState; onClose: () => void }) {
  const { session } = useSession();
  const { markUnlocked } = useVaults();
  const [phase, setPhase] = useState<'choice' | 'signature' | 'passphrase'>('choice');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [xamanPrompt, setXamanPrompt] = useState<XamanPrompt | null>(null);
  const ref: ZoneRef | null = session ? {
    rootChain: session.chain, rootAddress: session.address, zone: vault.zone, network: session.network,
  } : null;
  const makeSigner = useVaultSigner(ref, setXamanPrompt);

  async function unlockSignature() {
    if (!session || !ref) return;
    setPhase('signature');
    setError(null);
    try {
      const result = await unlockWithSignature({
        token: session.token, ref, commitment: vault.commitment,
        entries: vault.addresses,
        signBackupWrap: () => makeSigner().signBackupWrap(),
      });
      await markUnlocked(vault.zone, result.addresses);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase('passphrase');
    }
  }

  async function unlockPassphrase() {
    if (!session || !ref || !passphrase) return;
    setError(null);
    try {
      const result = await unlockWithPassphrase({ token: session.token, ref, commitment: vault.commitment, passphrase, entries: vault.addresses });
      await markUnlocked(vault.zone, result.addresses);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function unlockTestnet() {
    if (!session || !ref) return;
    setError(null);
    try {
      const addresses = await unlockTestnetVault(session.token, ref, vault.commitment, vault.addresses);
      await markUnlocked(vault.zone, addresses);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <>
      <Modal title={<>Unlock vault <span className="mono">{vault.zone === 'default' ? 'Default' : vault.zone}</span></>} onClose={onClose}>
        {phase === 'signature' && <><ProgressSteps running step="One backup signature unlocks this vault" /><p className="tile-note">Waiting for wallet signature…</p></>}
        {phase !== 'signature' && (
          <>
            {error && <Banner tone="warn">{error}</Banner>}
            {phase === 'choice' && <p>{vault.mode === 'testnet-device' ? 'Unlock with this device’s key. Testnet vaults can only be unlocked on the device that created them.' : 'Restore this vault with one wallet signature. If wallet signing behavior changed, use the backup passphrase.'}</p>}
            {phase === 'passphrase' && (
              <Field id={`unlock-passphrase-${vault.zone}`} label="Backup passphrase">
                <input type="password" value={passphrase} autoComplete="current-password" onChange={(event) => setPassphrase(event.target.value)} />
              </Field>
            )}
            <div className="zone-actions">
              {phase === 'passphrase' && <button type="button" className="btn-primary" disabled={!passphrase} onClick={() => void unlockPassphrase()}>Unlock with passphrase</button>}
              {vault.mode === 'testnet-device'
                ? phase === 'choice' && <button type="button" className="btn-primary" onClick={() => void unlockTestnet()}>Unlock on this device</button>
                : <button type="button" className={phase === 'choice' ? 'btn-primary' : 'btn-ghost btn-sm'} onClick={() => void unlockSignature()}>{phase === 'choice' ? 'Unlock with wallet signature' : 'Retry wallet signature'}</button>}
            </div>
          </>
        )}
      </Modal>
      {xamanPrompt && <XamanPromptModal prompt={xamanPrompt} onClose={() => setXamanPrompt(null)} />}
    </>
  );
}
