import { lazy, Suspense, useState } from 'react';
import { Settings } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import ThemeToggle from './components/ui/ThemeToggle';
import StatusDot from './components/ui/StatusDot';
import { useSession } from './contexts/SessionContext';
import { useSettings } from './contexts/SettingsContext';
import { isLocalApp } from './local/bridge';

const LoginModal = lazy(() => import('./components/LoginModal'));

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
}

const CHAIN_LABELS = { evm: 'EVM', xrpl: 'XRPL', stellar: 'Stellar' } as const;

export default function App() {
  const { session, logout } = useSession();
  const { network } = useSettings();
  const [loginOpen, setLoginOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const localApp = isLocalApp();

  async function copyAddress() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <>
      <header className={`topbar${localApp ? ' topbar--local' : ''}`}>
        <h1 className={`brand${localApp ? ' brand--local' : ''}`}>
          <Link to="/">
            {!localApp && <span className="brand-word">MOSAIC</span>}
            <span className="brand-logo" role="img" aria-label="Mosaic logo" />
          </Link>
        </h1>
        <nav className="topnav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Home
          </NavLink>
          <NavLink to="/dex" className={({ isActive }) => (isActive ? 'active' : '')}>
            DEX
          </NavLink>
          <NavLink to="/assets" className={({ isActive }) => (isActive ? 'active' : '')}>
            Assets
          </NavLink>
          {localApp && (
            <NavLink to="/agents" className={({ isActive }) => (isActive ? 'active' : '')}>
              Agents
            </NavLink>
          )}
        </nav>
        <div className="topbar-spacer" />
        <div className="wallet-stack">
          <div className="wallet-chain">
            <span className="chain-label">{session ? `${CHAIN_LABELS[session.chain]} · ${network}` : network}</span>
            <div className="wallet-controls">
              {session ? (
                <>
                  <StatusDot tone="ok">
                    <button
                      type="button"
                      className="address-button mono"
                      onClick={copyAddress}
                      title="Copy root address"
                    >
                      {copied ? 'copied' : short(session.address)}
                    </button>
                  </StatusDot>
                  <button type="button" onClick={() => void logout()}>
                    Log out
                  </button>
                </>
              ) : (
                <button type="button" className="btn-primary btn-sm" onClick={() => setLoginOpen(true)}>
                  Log in
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="topbar-actions">
          <ThemeToggle />
          <button
            type="button"
            className="topbar-icon-link"
            onClick={() => navigate('/settings')}
            title="Settings"
            aria-label="Settings"
          >
            <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
      {loginOpen && (
        <Suspense fallback={null}>
          <LoginModal onClose={() => setLoginOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
