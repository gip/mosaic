import { localBridge } from './local/bridge';
import { deleteZoneCacheDatabase } from './zone/cache';

async function deleteDatabase(name: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete ${name}`));
    request.onblocked = () => reject(new Error(`Could not delete ${name}: the database is still open`));
  });
}

function clearScriptAccessibleCookies(): void {
  for (const cookie of document.cookie.split(';')) {
    const separator = cookie.indexOf('=');
    const name = (separator === -1 ? cookie : cookie.slice(0, separator)).trim();
    if (!name) continue;
    document.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
  }
}

/** Clear all Mosaic data owned by this browser origin. */
export async function clearBrowserData(): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (operation: Promise<unknown>) => {
    try {
      await operation;
    } catch (cause) {
      failures.push(cause);
    }
  };

  // Clear the known sensitive database first. This also works in browsers that
  // do not expose indexedDB.databases().
  await attempt(deleteZoneCacheDatabase());

  if (typeof indexedDB.databases === 'function') {
    try {
      const databases = await indexedDB.databases();
      await attempt(Promise.all(databases.flatMap(({ name }) => name ? [deleteDatabase(name)] : [])));
    } catch (cause) {
      failures.push(cause);
    }
  }

  if ('caches' in window) {
    try {
      const names = await caches.keys();
      await attempt(Promise.all(names.map((name) => caches.delete(name))));
    } catch (cause) {
      failures.push(cause);
    }
  }
  if ('serviceWorker' in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await attempt(Promise.all(registrations.map((registration) => registration.unregister())));
    } catch (cause) {
      failures.push(cause);
    }
  }

  clearScriptAccessibleCookies();
  localStorage.clear();
  sessionStorage.clear();

  // Electron can clear storage that page JavaScript cannot reach, including
  // HttpOnly cookies and Chromium's HTTP cache.
  const bridge = localBridge();
  if (bridge) await attempt(bridge.clearBrowserData());

  if (failures.length > 0) {
    const first = failures[0];
    throw first instanceof Error ? first : new Error(String(first));
  }
}
