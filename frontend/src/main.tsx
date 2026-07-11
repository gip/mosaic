import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import App from './App';
import Home from './pages/Home';
import DexPage from './pages/DexPage';
import SettingsPage from './pages/SettingsPage';
import AssetsPage from './pages/AssetsPage';
import AgentsPage from './pages/AgentsPage';
import { ThemeProvider } from './contexts/ThemeContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { SessionProvider } from './contexts/SessionContext';
import { CatalogProvider } from './contexts/CatalogContext';
import { VaultProvider } from './contexts/VaultContext';
import SettingsLayout from './pages/SettingsLayout';
import VaultsPage from './pages/VaultsPage';

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
          <VaultProvider>
            <CatalogProvider>
              <App />
            </CatalogProvider>
          </VaultProvider>
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
      { path: 'dex', element: <DexPage /> },
      { path: 'assets', element: <AssetsPage /> },
      { path: 'agents', element: <AgentsPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <SettingsPage /> },
          { path: 'vaults', element: <VaultsPage /> },
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
