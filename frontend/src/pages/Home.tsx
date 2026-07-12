import { lazy, Suspense, useState } from 'react';
import { useSession } from '../contexts/SessionContext';

// Code-split: the zone panel drags in the derivation + ceremony stack and the
// login modal drags in wallet connectors — neither belongs in the entry chunk.
const ZonePanel = lazy(() => import('../components/ZonePanel'));
const CreateVaultModal = lazy(() => import('../components/ZonePanel').then((module) => ({ default: module.CreateVaultModal })));
const LoginModal = lazy(() => import('../components/LoginModal'));

export default function Home() {
  const { session } = useSession();
  const [createOpen, setCreateOpen] = useState(false);
  return session ? <Suspense fallback={null}>
    <ZonePanel onCreate={() => setCreateOpen(true)} />
    {createOpen && <CreateVaultModal onClose={() => setCreateOpen(false)} />}
  </Suspense> : <Hero />;
}

function Hero() {
  const [loginOpen, setLoginOpen] = useState(false);
  return (
    <section className="intro">
      <span className="intro-logo" role="img" aria-label="Mosaic logo" />
      <h2 className="intro-title">Vault-derived agent wallets</h2>
      <p className="intro-sub">
        Log in with your root wallet — Xaman, Freighter, or MetaMask — and derive deterministic agent
        addresses on XRPL, Stellar, and EVM from one locally generated vault secret. The platform stores only
        ciphertext it cannot decrypt.
      </p>
      <button type="button" className="btn-primary" onClick={() => setLoginOpen(true)}>
        Log in
      </button>
      {loginOpen && (
        <Suspense fallback={null}>
          <LoginModal onClose={() => setLoginOpen(false)} />
        </Suspense>
      )}
    </section>
  );
}
