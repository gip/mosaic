import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import './index.css';
import App from './App';
import Home from './pages/Home';
import DexPage, { DexCustomMarketPage, DexOverviewPage } from './pages/DexPage';
import ActivityPage from './pages/ActivityPage';
import SettingsPage from './pages/SettingsPage';
import AssetsPage from './pages/AssetsPage';
import AgentsPage from './pages/AgentsPage';
import { ThemeProvider } from './contexts/ThemeContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { SessionProvider } from './contexts/SessionContext';
import { CatalogProvider } from './contexts/CatalogContext';
import { BalancesProvider } from './contexts/BalancesContext';
import { VaultProvider } from './contexts/VaultContext';
import { WalletSettingsProvider } from './contexts/WalletSettingsContext';
import { ActivityProvider } from './contexts/ActivityContext';
import SettingsLayout from './pages/SettingsLayout';
import VaultsPage from './pages/VaultsPage';
import TransferPage from './pages/TransferPage';

if (import.meta.env.DEV) {
  console.info(
    __MOSAIC_ENV_FILES__.length
      ? `[mosaic] env files loaded (repo root): ${__MOSAIC_ENV_FILES__.join(', ')}`
      : '[mosaic] no env files found at the repo root',
  );
}

// eslint-disable-next-line react-refresh/only-export-components
function AppRoute() {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <SessionProvider>
          <WalletSettingsProvider>
            <VaultProvider>
              <CatalogProvider>
                <BalancesProvider>
                  <ActivityProvider>
                    <App />
                  </ActivityProvider>
                </BalancesProvider>
              </CatalogProvider>
            </VaultProvider>
          </WalletSettingsProvider>
        </SessionProvider>
      </SettingsProvider>
    </ThemeProvider>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppRoute />,
    children: [
      { index: true, element: <Home /> },
      { path: 'dex', element: <DexOverviewPage /> },
      { path: 'dex/:chain/market', element: <DexCustomMarketPage /> },
      { path: 'dex/:chain/:pair', element: <DexPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'assets', element: <AssetsPage /> },
      { path: 'transfer', element: <TransferPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'vaults', element: <VaultsPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <SettingsPage /> },
          { path: 'vaults', element: <Navigate to="/vaults" replace /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
