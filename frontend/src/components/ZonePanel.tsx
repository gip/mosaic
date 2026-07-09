import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentAddresses as Addresses, ZoneRef } from '@mosaic/zone-keys';
import Modal from './ui/Modal';
import Banner from './ui/Banner';
import Field from './ui/Field';
import ProgressSteps from './ui/ProgressSteps';
import AgentAddressCards from './AgentAddresses';
import { api, type XamanRefs } from '../api';
import { errorMessage } from '../errors';
import { ZONE_NAME } from '../config';
import { useSession } from '../contexts/SessionContext';
import {
  CEREMONY_STEP_LABELS,
  NonDeterministicWalletError,
  runZoneCeremony,
  type CeremonySigner,
} from '../zone/ceremony';
import { directCeremonySigner, xamanCeremonySigner } from '../zone/signers';
import { unlockFromCache, unlockWithPassphrase, unlockWithSignature } from '../zone/unlock';
import { dropCachedZoneSecret } from '../zone/cache';

type PanelState =
  | { status: 'checking' }
  | { status: 'absent' }
  | { status: 'creating'; step: string }
  | { status: 'locked'; commitment: string; hint?: string }
  | { status: 'unlocking'; commitment: string; step: string }
  | { status: 'needs-passphrase'; commitment: string; reason: string }
  | { status: 'unlocked'; addresses: Addresses; commitment: string }
  | { status: 'rejected'; message: string }
  | { status: 'error'; message: string };

interface XamanPrompt {
  refs: XamanRefs;
  label: string;
}

/** The zone "top" lifecycle: check → (ceremony | unlock) → addresses. */
export default function ZonePanel() {
  const { session, signZoneMessage } = useSession();
  const [state, setState] = useState<PanelState>({ status: 'checking' });
  const [xamanPrompt, setXamanPrompt] = useState<XamanPrompt | null>(null);
  const checkSeq = useRef(0);

  const ref: ZoneRef | null = session
    ? { rootChain: session.chain, rootAddress: session.address, zone: ZONE_NAME, network: session.network }
    : null;

  const makeSigner = useCallback((): CeremonySigner => {
    if (!session || !ref) throw new Error('not logged in');
    if (session.chain === 'xrpl') {
      return xamanCeremonySigner({
        token: session.token,
        ref,
        onPayload: (refs, label) => setXamanPrompt({ refs, label }),
        onPayloadDone: () => setXamanPrompt(null),
      });
    }
    return directCeremonySigner(ref, signZoneMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, signZoneMessage]);

  // Establish zone state whenever the session identity changes.
  useEffect(() => {
    if (!session || !ref) return;
    const seq = ++checkSeq.current;
    void (async () => {
      setState({ status: 'checking' });
      try {
        const zone = await api.zoneGet(session.token, ZONE_NAME);
        if (seq !== checkSeq.current) return;
        if (!zone.exists || !zone.commitment) {
          setState({ status: 'absent' });
          return;
        }
        const cached = await unlockFromCache(ref, zone.commitment);
        if (seq !== checkSeq.current) return;
        setState(
          cached
            ? { status: 'unlocked', addresses: cached.addresses, commitment: zone.commitment }
            : { status: 'locked', commitment: zone.commitment },
        );
      } catch (error) {
        if (seq !== checkSeq.current) return;
        setState({ status: 'error', message: errorMessage(error) });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token, session?.address, session?.network]);

  async function create(passphrase: string) {
    if (!session || !ref) return;
    try {
      const result = await runZoneCeremony({
        token: session.token,
        ref,
        passphrase,
        signer: makeSigner(),
        onStep: (step) => setState({ status: 'creating', step: CEREMONY_STEP_LABELS[step] }),
      });
      setState({ status: 'unlocked', addresses: result.addresses, commitment: result.commitment });
    } catch (error) {
      if (error instanceof NonDeterministicWalletError) {
        setState({ status: 'rejected', message: error.message });
      } else {
        setState({ status: 'error', message: errorMessage(error) });
      }
    }
  }

  async function unlock(commitment: string) {
    if (!session || !ref) return;
    setState({ status: 'unlocking', commitment, step: 'One backup signature unlocks this zone' });
    try {
      const signer = makeSigner();
      const result = await unlockWithSignature({
        token: session.token,
        ref,
        commitment,
        signBackupWrap: () => signer.signBackupWrap(),
      });
      setState({ status: 'unlocked', addresses: result.addresses, commitment });
    } catch (error) {
      // Signature path failed — wallet signing behavior may have changed
      // (spec §4.2). Offer the passphrase blob.
      setState({
        status: 'needs-passphrase',
        commitment,
        reason: errorMessage(error),
      });
    }
  }

  async function unlockPassphrase(commitment: string, passphrase: string) {
    if (!session || !ref) return;
    setState({ status: 'unlocking', commitment, step: 'Deriving passphrase key (intentionally slow)…' });
    try {
      const result = await unlockWithPassphrase({ token: session.token, ref, commitment, passphrase });
      setState({ status: 'unlocked', addresses: result.addresses, commitment });
    } catch (error) {
      setState({
        status: 'needs-passphrase',
        commitment,
        reason: errorMessage(error),
      });
    }
  }

  async function lock() {
    if (!ref) return;
    await dropCachedZoneSecret(ref);
    const commitment = state.status === 'unlocked' ? state.commitment : '';
    setState({ status: 'locked', commitment });
  }

  if (!session || !ref) return null;

  return (
    <section className="zone-panel">
      <div className="zone-head">
        <h2>
          Zone <span className="mono">{ZONE_NAME}</span> · {session.network}
        </h2>
      </div>

      {state.status === 'checking' && <p className="tile-note">Checking zone…</p>}

      {state.status === 'absent' && <CeremonyForm onCreate={create} />}

      {state.status === 'creating' && (
        <div className="zone-card">
          <h3>Creating zone</h3>
          <ProgressSteps running step={state.step} />
          <p className="tile-note">{state.step}</p>
        </div>
      )}

      {state.status === 'locked' && (
        <div className="zone-card">
          <h3>Zone locked</h3>
          <p>
            The zone secret is not on this device. One wallet signature over the backup message restores it —
            new device, evicted storage, and recovery are all this same step.
          </p>
          <button type="button" className="btn-primary" onClick={() => void unlock(state.commitment)}>
            Unlock with wallet signature
          </button>
        </div>
      )}

      {state.status === 'unlocking' && (
        <div className="zone-card">
          <h3>Unlocking</h3>
          <ProgressSteps running step={state.step} />
          <p className="tile-note">{state.step}</p>
        </div>
      )}

      {state.status === 'needs-passphrase' && (
        <PassphraseUnlock
          reason={state.reason}
          onRetrySignature={() => void unlock(state.commitment)}
          onSubmit={(passphrase) => void unlockPassphrase(state.commitment, passphrase)}
        />
      )}

      {state.status === 'unlocked' && (
        <>
          <AgentAddressCards addresses={state.addresses} />
          <div className="zone-actions">
            <span className="tile-note mono" title="zoneRootCommitment">
              commitment {state.commitment.slice(0, 16)}…
            </span>
            <button type="button" className="btn-ghost btn-sm" onClick={() => void lock()}>
              Lock zone on this device
            </button>
          </div>
        </>
      )}

      {state.status === 'rejected' && (
        <Banner tone="err">
          <strong>Wallet rejected for browser zones.</strong> {state.message}
        </Banner>
      )}

      {state.status === 'error' && <Banner tone="err">{state.message}</Banner>}

      {xamanPrompt && (
        <Modal title={xamanPrompt.label} onClose={() => setXamanPrompt(null)}>
          <div className="qr-box qr-large">
            <img src={xamanPrompt.refs.qrPng} alt="Xaman signing QR code" />
          </div>
          <p className="tile-note">
            Scan with Xaman, or{' '}
            <a href={xamanPrompt.refs.deeplink} target="_blank" rel="noreferrer">
              open the request directly
            </a>
            .
          </p>
        </Modal>
      )}
    </section>
  );
}

function CeremonyForm({ onCreate }: { onCreate: (passphrase: string) => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const mismatch = confirm.length > 0 && passphrase !== confirm;
  const tooShort = passphrase.length > 0 && passphrase.length < 10;
  const ready = passphrase.length >= 10 && passphrase === confirm;

  return (
    <div className="zone-card">
      <h3>Create zone “{ZONE_NAME}”</h3>
      <p>
        A fresh 32-byte zone secret is generated in this browser and never leaves it unencrypted. Your wallet
        signs the zone authorization and a backup message (twice — a determinism self-test); a backup
        passphrase wraps a second recovery blob. Both encrypted blobs are stored on the server and downloaded
        to this device.
      </p>
      <Field id="zone-passphrase" label="Backup passphrase" error={tooShort ? 'Use at least 10 characters.' : undefined}>
        <input
          type="password"
          value={passphrase}
          autoComplete="new-password"
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </Field>
      <Field id="zone-passphrase-confirm" label="Confirm passphrase" error={mismatch ? 'Passphrases do not match.' : undefined}>
        <input
          type="password"
          value={confirm}
          autoComplete="new-password"
          onChange={(e) => setConfirm(e.target.value)}
        />
      </Field>
      <button type="button" className="btn-primary" disabled={!ready} onClick={() => onCreate(passphrase)}>
        Create zone
      </button>
    </div>
  );
}

function PassphraseUnlock({
  reason,
  onRetrySignature,
  onSubmit,
}: {
  reason: string;
  onRetrySignature: () => void;
  onSubmit: (passphrase: string) => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  return (
    <div className="zone-card">
      <h3>Signature unlock failed</h3>
      <Banner tone="warn">{reason}</Banner>
      <p>
        If your wallet's signing behavior changed (wallet update, different key), the signature blob can no
        longer unwrap. Use your backup passphrase instead.
      </p>
      <Field id="unlock-passphrase" label="Backup passphrase">
        <input
          type="password"
          value={passphrase}
          autoComplete="current-password"
          onChange={(e) => setPassphrase(e.target.value)}
        />
      </Field>
      <div className="zone-actions">
        <button type="button" className="btn-primary" disabled={!passphrase} onClick={() => onSubmit(passphrase)}>
          Unlock with passphrase
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={onRetrySignature}>
          Retry wallet signature
        </button>
      </div>
    </div>
  );
}
