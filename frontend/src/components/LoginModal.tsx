import { useCallback, useEffect, useState } from 'react';
import type { Network } from '@mosaic/zone-keys';
import Modal from './ui/Modal';
import Banner from './ui/Banner';
import { api, type AuthChallengeResult, type AuthVerifyResult } from '../api';
import { errorMessage } from '../errors';
import { WALLETCONNECT_PROJECT_ID } from '../config';
import { useSettings } from '../contexts/SettingsContext';
import { useSession, type RootSigner } from '../contexts/SessionContext';

/**
 * Wallet login: one tile per root chain, mobile-wallet-first. Every tile
 * leads with a QR for the wallet's phone app (Xaman payload QR; WalletConnect
 * pairing QR for MetaMask mobile and Freighter mobile). Browser extensions
 * are a deliberately small fallback: an extension login is locked to this
 * browser, so it cannot authorize agents (the local signer) later.
 */
export default function LoginModal({ onClose }: { onClose: () => void }) {
  const { session } = useSession();

  // Close once any tile completes the login.
  useEffect(() => {
    if (session) onClose();
  }, [session, onClose]);

  return (
    <Modal title="Log in with your root wallet" onClose={onClose}>
      <p className="login-intro">
        Your root wallet authorizes vaults and recovers agent keys. Pick the chain it lives on and
        scan with your wallet&rsquo;s mobile app.
      </p>
      <div className="login-tiles">
        <XamanTile />
        <StellarTile />
        <EvmTile />
      </div>
    </Modal>
  );
}

function useLogin() {
  const { login } = useSession();
  const { network } = useSettings();
  return {
    network,
    finish: useCallback(
      (result: AuthVerifyResult, signer: RootSigner) => {
        login(result, signer);
      },
      [login],
    ),
  };
}

function TileError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="tile-error">
      <Banner tone="err">{error}</Banner>
    </div>
  );
}

/** WalletConnect pairing lifecycle for the QR-first tiles. */
type PairingStatus = 'pairing' | 'waiting' | 'signing' | 'error';

function PairingBox({ qr, status, onRetry }: { qr: string | null; status: PairingStatus; onRetry: () => void }) {
  if (qr && status === 'waiting') {
    return <div className="qr-box qr-svg" dangerouslySetInnerHTML={{ __html: qr }} />;
  }
  return (
    <div className="qr-box">
      {status === 'error' ? (
        <button type="button" className="btn-sm" onClick={onRetry}>
          retry QR
        </button>
      ) : (
        <span className="tile-note">{status === 'signing' ? 'approve on your phone…' : 'pairing…'}</span>
      )}
    </div>
  );
}

const EXTENSION_CAVEAT = 'Extension logins are locked to this browser — they can’t authorize agents.';

// ---------------------------------------------------------------- XRPL

/**
 * Pending Xaman challenge, reused across mounts while it is still fresh.
 * Every challenge creates a payload on the Xaman API, which rate-limits the
 * app (429) — reopening the modal repeatedly must not mint a new QR each
 * time, and neither must StrictMode's double mount, so the cache holds the
 * in-flight promise rather than the resolved result. Cleared once the
 * payload resolves (signed, declined, or expired) or when the network
 * changes.
 */
let pendingXamanChallenge: { network: string; promise: Promise<AuthChallengeResult> } | null = null;

function xamanChallenge(network: Network): Promise<AuthChallengeResult> {
  const cached = pendingXamanChallenge;
  if (cached && cached.network === network) {
    return cached.promise.then((challenge) => {
      if (Date.parse(challenge.expiresAt) > Date.now() + 30_000) return challenge;
      // Stale: drop it (unless a concurrent caller already replaced it).
      if (pendingXamanChallenge === cached) pendingXamanChallenge = null;
      return xamanChallenge(network);
    });
  }
  const entry = {
    network,
    promise: api.authChallenge({ chain: 'xrpl', network }).catch((err: unknown) => {
      if (pendingXamanChallenge === entry) pendingXamanChallenge = null;
      throw err;
    }),
  };
  pendingXamanChallenge = entry;
  return entry.promise;
}

function XamanTile() {
  const { network, finish } = useLogin();
  const [qrPng, setQrPng] = useState<string | null>(null);
  const [deeplink, setDeeplink] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'waiting' | 'verifying' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const challenge = await xamanChallenge(network);
        if (!challenge.xaman) throw new Error('Server has no Xaman configured');
        if (abort.signal.aborted) return;
        setQrPng(challenge.xaman.qrPng);
        setDeeplink(challenge.xaman.deeplink);
        setStatus('waiting');
        const { watchXamanPayload } = await import('@mosaic/web-connector/xrpl');
        const watched = await watchXamanPayload(challenge.xaman.websocketStatus, { signal: abort.signal });
        pendingXamanChallenge = null;
        if (!watched.signed) throw new Error(watched.expired ? 'QR expired — reopen the modal.' : 'Declined in Xaman.');
        setStatus('verifying');
        const result = await api.authVerify({ challengeId: challenge.challengeId });
        finish(result, { kind: 'xrpl' });
      } catch (err) {
        if (abort.signal.aborted) return;
        setStatus('error');
        setError(errorMessage(err));
      }
    })();
    return () => abort.abort();
  }, [network, finish]);

  return (
    <div className="login-tile">
      <h4>XRPL</h4>
      <p className="tile-sub">Xaman — scan with your phone</p>
      <div className="qr-box">
        {qrPng ? (
          <img src={qrPng} alt="Xaman sign-in QR code" />
        ) : (
          <span className="tile-note">{status === 'error' ? 'unavailable' : 'loading…'}</span>
        )}
      </div>
      {deeplink && (
        <a className="tile-note" href={deeplink} target="_blank" rel="noreferrer">
          open in Xaman instead
        </a>
      )}
      {status === 'waiting' && <span className="tile-note">waiting for signature…</span>}
      {status === 'verifying' && <span className="tile-note">verifying…</span>}
      <TileError error={error} />
    </div>
  );
}

// ----------------------------------------------------------------- EVM

function EvmTile() {
  const { network, finish } = useLogin();
  const [qr, setQr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [status, setStatus] = useState<PairingStatus>('pairing');
  const [extBusy, setExtBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Default path: WalletConnect pairing QR for MetaMask mobile, auto-started
  // like the Xaman tile. The whole login (pair → challenge → sign → verify)
  // runs on the phone.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { connectEvmWalletConnect, metamaskWcLink, signEvmZoneMessage } = await import(
          '@mosaic/web-connector/evm'
        );
        const { qrSvg } = await import('@mosaic/web-connector/qr');
        if (cancelled) return;
        setQr(null);
        setLink(null);
        setError(null);
        setStatus('pairing');
        if (!WALLETCONNECT_PROJECT_ID) {
          throw new Error('Set VITE_WALLETCONNECT_PROJECT_ID to enable mobile-wallet login.');
        }
        const { provider, address } = await connectEvmWalletConnect({
          projectId: WALLETCONNECT_PROJECT_ID,
          network,
          onDisplayUri: (uri) => {
            if (cancelled) return;
            // Pin the QR to MetaMask: a bare wc: uri opens whatever wallet
            // owns the scheme on the phone.
            const wallet = metamaskWcLink(uri);
            setLink(wallet);
            setQr(qrSvg(wallet));
            setStatus('waiting');
          },
        });
        if (cancelled) return;
        setStatus('signing');
        const challenge = await api.authChallenge({ chain: 'evm', network, address });
        const signed = await signEvmZoneMessage(provider, address, challenge.message, network);
        const result = await api.authVerify({ challengeId: challenge.challengeId, signature: signed.envelope });
        if (cancelled) return;
        finish(result, { kind: 'evm', provider });
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, finish, attempt]);

  async function loginWithProvider(provider: import('@mosaic/web-connector/evm').Eip1193Provider, address: string) {
    setExtBusy('signing');
    const challenge = await api.authChallenge({ chain: 'evm', network, address });
    const { signEvmZoneMessage } = await import('@mosaic/web-connector/evm');
    const signed = await signEvmZoneMessage(provider, address, challenge.message, network);
    const result = await api.authVerify({ challengeId: challenge.challengeId, signature: signed.envelope });
    finish(result, { kind: 'evm', provider });
  }

  async function connectExtension() {
    setError(null);
    setExtBusy('connecting');
    try {
      const { discoverEvmExtensions, requestEvmAccount } = await import('@mosaic/web-connector/evm');
      const details = await discoverEvmExtensions();
      if (!details.length) throw new Error('No EVM wallet extension found (install MetaMask).');
      const detail = details.find((d) => d.info.rdns === 'io.metamask') ?? details[0]!;
      const address = await requestEvmAccount(detail.provider);
      await loginWithProvider(detail.provider, address);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExtBusy(null);
    }
  }

  return (
    <div className="login-tile">
      <h4>EVM</h4>
      <p className="tile-sub">MetaMask mobile — scan to connect</p>
      <PairingBox qr={qr} status={status} onRetry={() => setAttempt((n) => n + 1)} />
      {link && status === 'waiting' && (
        <a className="tile-note" href={link} target="_blank" rel="noreferrer">
          open in MetaMask instead
        </a>
      )}
      <div className="tile-fallback">
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => void connectExtension()}
          disabled={extBusy !== null || status === 'signing'}
        >
          {extBusy ? 'waiting for wallet…' : 'Use browser extension instead'}
        </button>
        {import.meta.env.DEV && import.meta.env.VITE_DEMO_WALLET && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => void connectDemo()} disabled={extBusy !== null}>
            Demo wallet (dev)
          </button>
        )}
        <span className="tile-note">{EXTENSION_CAVEAT}</span>
      </div>
      <TileError error={error} />
    </div>
  );

  async function connectDemo() {
    setError(null);
    setExtBusy('connecting');
    try {
      const { createDemoProvider } = await import('../dev/demoProvider');
      const demo = await createDemoProvider(import.meta.env.VITE_DEMO_WALLET as `0x${string}`);
      await loginWithProvider(demo.provider, demo.address);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExtBusy(null);
    }
  }
}

// -------------------------------------------------------------- Stellar

function StellarTile() {
  const { network, finish } = useLogin();
  const [qr, setQr] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [status, setStatus] = useState<PairingStatus>('pairing');
  const [extBusy, setExtBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Default path: WalletConnect pairing QR for Freighter mobile (the mobile
  // app speaks WalletConnect only — the extension has no QR pairing).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stellar = await import('@mosaic/web-connector/stellar');
        const { qrSvg } = await import('@mosaic/web-connector/qr');
        if (cancelled) return;
        setQr(null);
        setLink(null);
        setError(null);
        setStatus('pairing');
        if (!WALLETCONNECT_PROJECT_ID) {
          throw new Error('Set VITE_WALLETCONNECT_PROJECT_ID to enable mobile-wallet login.');
        }
        const wcSession = await stellar.connectStellarWalletConnect({
          projectId: WALLETCONNECT_PROJECT_ID,
          network,
          onDisplayUri: (uri) => {
            if (cancelled) return;
            // Pin the QR to Freighter mobile: a bare wc: uri opens whatever
            // wallet owns the scheme on the phone (often MetaMask).
            const wallet = stellar.freighterWcLink(uri);
            setLink(wallet);
            setQr(qrSvg(wallet));
            setStatus('waiting');
          },
        });
        if (cancelled) return;
        setStatus('signing');
        const challenge = await api.authChallenge({ chain: 'stellar', network, address: wcSession.address });
        const signed = await wcSession.signZoneMessage(challenge.message);
        const result = await api.authVerify({ challengeId: challenge.challengeId, signature: signed.envelope });
        if (cancelled) return;
        finish(result, { kind: 'stellar-wc', wcSession });
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(errorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [network, finish, attempt]);

  async function connectFreighterExtension() {
    setError(null);
    setExtBusy('connecting');
    try {
      const stellar = await import('@mosaic/web-connector/stellar');
      const address = await stellar.connectFreighter();
      setExtBusy('signing');
      const challenge = await api.authChallenge({ chain: 'stellar', network, address });
      const signed = await stellar.signStellarZoneMessageWithFreighter(address, challenge.message, network);
      const result = await api.authVerify({ challengeId: challenge.challengeId, signature: signed.envelope });
      finish(result, { kind: 'stellar-freighter' });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setExtBusy(null);
    }
  }

  return (
    <div className="login-tile">
      <h4>Stellar</h4>
      <p className="tile-sub">Freighter mobile — scan to connect</p>
      <PairingBox qr={qr} status={status} onRetry={() => setAttempt((n) => n + 1)} />
      {link && status === 'waiting' && (
        <a className="tile-note" href={link} target="_blank" rel="noreferrer">
          open in Freighter instead
        </a>
      )}
      <div className="tile-fallback">
        <button
          type="button"
          className="btn-ghost btn-sm"
          onClick={() => void connectFreighterExtension()}
          disabled={extBusy !== null || status === 'signing'}
        >
          {extBusy ? 'waiting for wallet…' : 'Use browser extension instead'}
        </button>
        <span className="tile-note">{EXTENSION_CAVEAT}</span>
      </div>
      <TileError error={error} />
    </div>
  );
}
