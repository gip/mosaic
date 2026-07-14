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
      <div className="intro-mark">
        <span className="intro-logo" role="img" aria-label="Mosaic logo" />
      </div>
      <h2 className="intro-title">Personal and Agentic Finance Built by Onchain Specialists</h2>
      <button type="button" className="btn-primary intro-cta" onClick={() => setLoginOpen(true)}>
        <span>Log in</span>
        <span aria-hidden="true">→</span>
      </button>
      {loginOpen && (
        <Suspense fallback={null}>
          <LoginModal onClose={() => setLoginOpen(false)} />
        </Suspense>
      )}
    </section>
  );
}
