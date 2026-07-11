import { lazy, Suspense, useState } from 'react';
import { Settings } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import ThemeToggle from './components/ui/ThemeToggle';
import StatusDot from './components/ui/StatusDot';
import Banner from './components/ui/Banner';
import MainnetLockReminder from './components/MainnetLockReminder';
import { useSession } from './contexts/SessionContext';
import { useSettings } from './contexts/SettingsContext';
import { useVaults, type VaultState } from './contexts/VaultContext';
import { isLocalApp } from './local/bridge';

const LoginModal = lazy(() => import('./components/LoginModal'));
const UnlockVaultModal = lazy(() => import('./components/ZonePanel').then((module) => ({ default: module.UnlockVaultModal })));

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
}

const CHAIN_LABELS = { evm: 'EVM', xrpl: 'XRPL', stellar: 'Stellar' } as const;

export default function App() {
  const { session, logout, networkSwitching, networkSwitchError } = useSession();
  const { network, setNetwork } = useSettings();
  const { vaults, activeVault, selectVault } = useVaults();
  const [loginOpen, setLoginOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [unlockVault, setUnlockVault] = useState<VaultState | null>(null);
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

  function switchVault(zone: string) {
    const vault = vaults.find((item) => item.zone === zone);
    if (!vault) return;
    selectVault(zone);
    if (vault.status === 'locked') setUnlockVault(vault);
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
          <NavLink to="/vaults" className={({ isActive }) => (isActive ? 'active' : '')}>
            Vaults
          </NavLink>
          {localApp && (
            <NavLink to="/agents" className={({ isActive }) => (isActive ? 'active' : '')}>
              Agents
            </NavLink>
          )}
        </nav>
        <div className="topbar-spacer" />
        <div className="network-switcher">
          <span className="chain-label">Network</span>
          <div className="network-switch" role="group" aria-label="Network">
            <button
              type="button"
              className="mainnet"
              aria-pressed={network === 'mainnet'}
              disabled={networkSwitching}
              onClick={() => setNetwork('mainnet')}
              title="Switch to Mainnet"
            >
              Mainnet
            </button>
            <button
              type="button"
              className="testnet"
              aria-pressed={network === 'testnet'}
              disabled={networkSwitching}
              onClick={() => setNetwork('testnet')}
              title="Switch to Testnet"
            >
              Testnet
            </button>
          </div>
        </div>
        {session && (
          <div className="vault-switcher">
            <span className="chain-label">Active vault</span>
            <div className="vault-switcher-controls">
              <StatusDot tone={activeVault?.status === 'unlocked' ? 'ok' : 'idle'}>
                <select aria-label="Active vault" value={activeVault?.zone ?? ''} disabled={vaults.length === 0} onChange={(event) => switchVault(event.target.value)}>
                  {vaults.length === 0 && <option value="">No vaults</option>}
                  {vaults.map((vault) => <option value={vault.zone} key={vault.zone}>{vault.zone === 'default' ? 'Default' : vault.zone}</option>)}
                </select>
              </StatusDot>
              {activeVault?.status === 'locked' && <button type="button" className="btn-sm" onClick={() => setUnlockVault(activeVault)}>Unlock</button>}
            </div>
          </div>
        )}
        <div className="wallet-stack">
          <div className="wallet-chain">
            <span className="chain-label">{session ? CHAIN_LABELS[session.chain] : 'Root wallet'}</span>
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
      {networkSwitching && <Banner tone="info" className="app-banner">Switching your session to {network}…</Banner>}
      {!networkSwitching && networkSwitchError && <Banner tone="err" className="app-banner">Could not switch network: {networkSwitchError}</Banner>}
      <MainnetLockReminder key={`${network}|${session?.address ?? ''}`} />
      <main className="app-main">
        <Outlet />
      </main>
      {loginOpen && (
        <Suspense fallback={null}>
          <LoginModal onClose={() => setLoginOpen(false)} />
        </Suspense>
      )}
      {unlockVault && (
        <Suspense fallback={null}>
          <UnlockVaultModal vault={vaults.find(({ zone }) => zone === unlockVault.zone) ?? unlockVault} onClose={() => setUnlockVault(null)} />
        </Suspense>
      )}
    </>
  );
}
