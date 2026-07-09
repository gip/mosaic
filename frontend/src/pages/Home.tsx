import { lazy, Suspense, useState } from 'react';
import { useSession } from '../contexts/SessionContext';

// Code-split: the zone panel drags in the derivation + ceremony stack and the
// login modal drags in wallet connectors — neither belongs in the entry chunk.
const ZonePanel = lazy(() => import('../components/ZonePanel'));
const LoginModal = lazy(() => import('../components/LoginModal'));

export default function Home() {
  const { session } = useSession();
  return session ? (
    <Suspense fallback={null}>
      <ZonePanel />
    </Suspense>
  ) : (
    <Hero />
  );
}

function Hero() {
  const [loginOpen, setLoginOpen] = useState(false);
  return (
    <section className="intro">
      <span className="intro-logo" role="img" aria-label="Mosaic logo" />
      <h2 className="intro-title">Zone-derived agent wallets</h2>
      <p className="intro-sub">
        Log in with your root wallet — Xaman, MetaMask, or Freighter — and derive deterministic agent
        addresses on EVM, XRPL, and Stellar from one locally generated zone secret. The platform stores only
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
