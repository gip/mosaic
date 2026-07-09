import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import App from './App';
import Home from './pages/Home';
import SettingsPage from './pages/SettingsPage';
import { ThemeProvider } from './contexts/ThemeContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { SessionProvider } from './contexts/SessionContext';

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
          <App />
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
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
