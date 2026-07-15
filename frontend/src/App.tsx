import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Menu, Settings, X } from 'lucide-react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import ThemeToggle from './components/ui/ThemeToggle';
import StatusDot from './components/ui/StatusDot';
import Banner from './components/ui/Banner';
import MainnetLockReminder from './components/MainnetLockReminder';
import BalancesStrip from './components/balances/BalancesStrip';
import ActivityDrawer from './components/activity/ActivityDrawer';
import { useSession } from './contexts/SessionContext';
import { useSettings } from './contexts/SettingsContext';
import { useTheme } from './contexts/ThemeContext';
import { useVaults, type VaultState } from './contexts/VaultContext';
import { useWalletSettings } from './contexts/WalletSettingsContext';
import { isLocalApp } from './local/bridge';
import AccountAddress from './components/address/AccountAddress';
import { vaultDisplayName } from './vaultName';

const LoginModal = lazy(() => import('./components/LoginModal'));
const UnlockVaultModal = lazy(() => import('./components/ZonePanel').then((module) => ({ default: module.UnlockVaultModal })));
const ChainOnboardingModal = lazy(() => import('./components/ChainOnboardingModal'));

function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 5)}…${addr.slice(-4)}` : addr;
}

const CHAIN_LABELS = { evm: 'EVM', xrpl: 'XRPL', stellar: 'Stellar' } as const;

export default function App() {
  const { session, logout, networkSwitching, networkSwitchError } = useSession();
  const { network, setNetwork } = useSettings();
  const { cycleTheme } = useTheme();
  const { vaults, activeVault, selectVault } = useVaults();
  const { chainSetupCompleted, loading: walletSettingsLoading } = useWalletSettings();
  const [loginOpen, setLoginOpen] = useState(false);
  const [unlockVault, setUnlockVault] = useState<VaultState | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const localApp = isLocalApp();

  const navItems = [
    { to: '/', label: 'Home', end: true },
    { to: '/dex', label: 'DEX' },
    { to: '/activity', label: 'Activity' },
    { to: '/assets', label: 'Assets' },
    { to: '/transfer', label: 'Transfer' },
    { to: '/vaults', label: 'Vaults' },
    ...(localApp ? [{ to: '/agents', label: 'Agents' }] : []),
  ];

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  function switchVault(zone: string) {
    const vault = vaults.find((item) => item.zone === zone);
    if (!vault) return;
    selectVault(zone);
    if (vault.status === 'locked') setUnlockVault(vault);
  }

  /* Desktop-header only; on small screens network selection lives in Settings. */
  const networkSwitcher = (
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
  );

  const vaultSwitcher = session ? (
    <div className="vault-switcher">
      <span className="chain-label">Active vault</span>
      <div className="vault-switcher-controls">
        <StatusDot tone={activeVault?.status === 'unlocked' ? 'ok' : 'idle'}>
          <select aria-label="Active vault" value={activeVault?.zone ?? ''} disabled={vaults.length === 0} onChange={(event) => switchVault(event.target.value)}>
            {vaults.length === 0 && <option value="">No vaults</option>}
            {vaults.map((vault) => <option value={vault.zone} key={vault.zone}>{vaultDisplayName(vault.zone)}</option>)}
          </select>
        </StatusDot>
        {activeVault?.status === 'locked' && <button type="button" className="topbar-session-button" onClick={() => setUnlockVault(activeVault)}>Unlock</button>}
      </div>
    </div>
  ) : null;

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
          {navItems.map(({ to, label, end }) => (
            <NavLink to={to} end={end} key={to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-spacer" />
        {networkSwitcher}
        {vaultSwitcher}
        <div className={`wallet-stack${session ? ' wallet-stack--authed' : ''}`}>
          <div className="wallet-chain">
            <span className="chain-label">{session ? CHAIN_LABELS[session.chain] : 'Root wallet'}</span>
            <div className="wallet-controls">
              {session ? (
                <>
                  <StatusDot tone="ok">
                    <AccountAddress
                      chain={session.chain}
                      network={session.network}
                      address={session.address}
                      className="address-button mono"
                      title="Root account actions"
                    >
                      {short(session.address)}
                    </AccountAddress>
                  </StatusDot>
                  <button type="button" className="topbar-session-button" onClick={() => void logout()}>
                    Log out
                  </button>
                </>
              ) : (
                <button type="button" className="topbar-session-button" onClick={() => setLoginOpen(true)}>
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
        <div className="mobile-menu-root" ref={menuRef}>
          <button
            type="button"
            className="topbar-icon-link hamburger"
            onClick={() => setMenuOpen((open) => !open)}
            title="Menu"
            aria-label="Menu"
            aria-expanded={menuOpen}
          >
            {menuOpen
              ? <X size={18} strokeWidth={1.75} aria-hidden="true" />
              : <Menu size={18} strokeWidth={1.75} aria-hidden="true" />}
          </button>
          {menuOpen && (
            <div className="mobile-menu">
              <nav className="mobile-menu-nav">
                {navItems.map(({ to, label, end }) => (
                  <NavLink to={to} end={end} key={to} onClick={() => setMenuOpen(false)} className={({ isActive }) => (isActive ? 'active' : '')}>
                    {label}
                  </NavLink>
                ))}
              </nav>
              <div className="mobile-menu-actions">
                <NavLink to="/settings" onClick={() => setMenuOpen(false)} className={({ isActive }) => (isActive ? 'active' : '')}>
                  Settings
                </NavLink>
                <button type="button" onClick={cycleTheme}>
                  Change theme
                </button>
                {session && (
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      void logout();
                    }}
                  >
                    Log out
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </header>
      <BalancesStrip />
      {networkSwitching && <Banner tone="info" className="app-banner">Switching your session to {network}…</Banner>}
      {!networkSwitching && networkSwitchError && <Banner tone="err" className="app-banner">Could not switch network: {networkSwitchError}</Banner>}
      <MainnetLockReminder key={`${network}|${session?.address ?? ''}`} />
      <main className="app-main">
        <Outlet />
      </main>
      {session && <ActivityDrawer />}
      {loginOpen && (
        <Suspense fallback={null}>
          <LoginModal onClose={() => setLoginOpen(false)} />
        </Suspense>
      )}
      {session && !walletSettingsLoading && !chainSetupCompleted && (
        <Suspense fallback={null}>
          <ChainOnboardingModal />
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
