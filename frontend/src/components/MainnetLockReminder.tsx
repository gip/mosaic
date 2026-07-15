import { useCallback, useEffect, useRef, useState } from 'react';
import Banner from './ui/Banner';
import Modal from './ui/Modal';
import { useSession } from '../contexts/SessionContext';
import { useSettings } from '../contexts/SettingsContext';
import { useVaults } from '../contexts/VaultContext';
import { vaultDisplayName } from '../vaultName';
import { useWalletSettings } from '../contexts/WalletSettingsContext';
import { cachedZoneNames, dropCachedZoneSecretsForNetwork } from '../zone/cache';

const HEARTBEAT_MS = 5_000;
const AUTO_LOCK_SECONDS = 60;
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

interface Prompt {
  zones: string[];
  deadline: number;
}

/**
 * Network switches deliberately never lock vaults, so Mainnet secrets stay
 * cached while the user works elsewhere. This watchdog offers to lock them
 * once the user has been on Testnet — or idle on Mainnet — for the per-wallet
 * reminder interval (backend `settings_get`, 0 = disabled), and locks
 * automatically when the offer goes unanswered for 60 seconds. Mount it with
 * a key of the network + wallet so timers reset when either changes.
 */
export default function MainnetLockReminder() {
  const { session } = useSession();
  const { network } = useSettings();
  const { lockReminderMinutes } = useWalletSettings();
  const { refreshVaults } = useVaults();
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(AUTO_LOCK_SECONDS);
  const [autoLocked, setAutoLocked] = useState(false);
  /* baseline = mount / last prompt resolution; on Mainnet, activity moves the clock too.
     0 means "not started yet" — the mount effect stamps both before any timer reads them. */
  const baselineRef = useRef(0);
  const lastActivityRef = useRef(0);
  const lockingRef = useRef(false);
  const chain = session?.chain;
  const address = session?.address;
  const delayMs = lockReminderMinutes * 60_000;
  const armed = Boolean(chain && address) && delayMs > 0;

  const lockMainnetVaults = useCallback(async (viaTimeout: boolean) => {
    if (!chain || !address || lockingRef.current) return;
    lockingRef.current = true;
    try {
      await dropCachedZoneSecretsForNetwork({ rootChain: chain, rootAddress: address, network: 'mainnet' });
      await refreshVaults();
    } finally {
      lockingRef.current = false;
      baselineRef.current = Date.now();
      setPrompt(null);
      if (viaTimeout) setAutoLocked(true);
    }
  }, [address, chain, refreshVaults]);

  useEffect(() => {
    const now = Date.now();
    baselineRef.current = now;
    lastActivityRef.current = now;
  }, []);

  useEffect(() => {
    if (!armed || network !== 'mainnet') return;
    const onActivity = () => {
      lastActivityRef.current = Date.now();
    };
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, onActivity, { passive: true });
    return () => {
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, onActivity);
    };
  }, [armed, network]);

  useEffect(() => {
    if (!armed || !chain || !address || prompt) return;
    const timer = setInterval(() => {
      const idleSince = network === 'mainnet'
        ? Math.max(baselineRef.current, lastActivityRef.current)
        : baselineRef.current;
      if (Date.now() - idleSince < delayMs) return;
      void cachedZoneNames({ rootChain: chain, rootAddress: address, network: 'mainnet' }).then((zones) => {
        if (zones.length === 0) {
          baselineRef.current = Date.now();
          return;
        }
        setRemainingSeconds(AUTO_LOCK_SECONDS);
        setPrompt({ zones, deadline: Date.now() + AUTO_LOCK_SECONDS * 1000 });
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [address, armed, chain, delayMs, network, prompt]);

  useEffect(() => {
    if (!prompt) return;
    const timer = setInterval(() => {
      const left = Math.ceil((prompt.deadline - Date.now()) / 1000);
      if (left <= 0) {
        void lockMainnetVaults(true);
        return;
      }
      setRemainingSeconds(left);
    }, 1000);
    return () => clearInterval(timer);
  }, [lockMainnetVaults, prompt]);

  function keepUnlocked() {
    baselineRef.current = Date.now();
    setPrompt(null);
  }

  if (autoLocked && !prompt) {
    return (
      <Banner tone="warn" className="app-banner">
        <span>Mainnet vaults were locked automatically after the reminder went unanswered.</span>{' '}
        <button type="button" className="btn-sm" onClick={() => setAutoLocked(false)}>Dismiss</button>
      </Banner>
    );
  }
  if (!prompt || !armed) return null;

  const names = prompt.zones.map(vaultDisplayName).join(', ');

  return (
    <Modal title="Lock Mainnet vaults?" onClose={keepUnlocked}>
      <p>
        {network === 'testnet' ? 'You have been on Testnet for a while' : 'You have been inactive for a while'}, but{' '}
        {prompt.zones.length === 1 ? 'a Mainnet vault is' : 'Mainnet vaults are'} still unlocked on this device:{' '}
        <span className="mono">{names}</span>.
      </p>
      <p className="tile-note">
        Locking only clears this device&apos;s session cache — one wallet signature unlocks again.
        Without a response, they lock automatically in {remainingSeconds}s.
      </p>
      <div className="zone-actions">
        <button type="button" className="btn-primary" onClick={() => void lockMainnetVaults(false)}>
          Lock Mainnet vaults
        </button>
        <button type="button" onClick={keepUnlocked}>
          Keep unlocked
        </button>
      </div>
    </Modal>
  );
}
