import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_GUARDIAN_VAULT,
  DEFAULT_RUNNER_VAULT,
  type ServiceStatus,
} from '@mosaic/local-runtime/contracts';
import { Bot, Copy, Play, ShieldCheck, Square } from 'lucide-react';
import { backupWrapMessage, type ZoneRef } from '@mosaic/zone-keys';
import StatusDot, { type StatusTone } from '../components/ui/StatusDot';
import Banner from '../components/ui/Banner';
import Field from '../components/ui/Field';
import { useSettings } from '../contexts/SettingsContext';
import { useSession } from '../contexts/SessionContext';
import { useVaults } from '../contexts/VaultContext';
import { localBridge } from '../local/bridge';

const SERVICE_LABELS: Record<ServiceStatus['name'], string> = {
  'mosaic-guardian': 'Mosaic Guardian',
  'agent-runner': 'Agent Runner',
};

function tone(phase: ServiceStatus['phase']): StatusTone {
  if (phase === 'running') return 'ok';
  if (phase === 'failed') return 'err';
  if (['starting', 'awaiting-wallet', 'authenticating', 'unlocking', 'connecting', 'stopping'].includes(phase)) return 'busy';
  return 'idle';
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export default function AgentsPage() {
  const bridge = localBridge();
  const { session, signZoneMessage } = useSession();
  const { network } = useSettings();
  const { vaults } = useVaults();
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [guardianVault, setGuardianVault] = useState(DEFAULT_GUARDIAN_VAULT);
  const [runnerVault, setRunnerVault] = useState(DEFAULT_RUNNER_VAULT);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState<'guardian' | 'runner' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge.listServices().then(setServices);
    return bridge.onStatus(setServices);
  }, [bridge]);

  const guardian = useMemo(() => services.find(({ name }) => name === 'mosaic-guardian'), [services]);
  const runner = useMemo(() => services.find(({ name }) => name === 'agent-runner'), [services]);

  if (!bridge) {
    return (
      <section className="reading zone-panel">
        <div className="zone-head"><h2>Local agents</h2></div>
        <div className="zone-card">
          <h3>Open Mosaic Local</h3>
          <p>Mosaic Guardian and agent processes run locally and are controlled from the desktop app.</p>
        </div>
      </section>
    );
  }

  async function startGuardian() {
    if (!bridge) return;
    if (!session) { setError('Log in with the root wallet that owns the Guardian vault first.'); return; }
    if (session.network !== network) { setError('Wait for the wallet session to switch to the selected network.'); return; }
    setBusy('guardian');
    setError(null);
    try {
      const vault = vaults.find(({ zone }) => zone === guardianVault);
      let signatureB64: string | undefined;
      if (vault && vault.mode !== 'testnet-server' && !passphrase) {
        const ref: ZoneRef = {
          rootChain: session.chain,
          rootAddress: session.address,
          zone: guardianVault,
          network: session.network,
        };
        const signed = await signZoneMessage(backupWrapMessage(ref));
        signatureB64 = bytesToBase64(signed.signatureBytes);
      }
      await bridge.startGuardian({
        vault: guardianVault,
        network: session.network,
        session,
        ...(signatureB64 ? { signatureB64 } : {}),
        ...(passphrase ? { passphrase } : {}),
      });
      setPassphrase('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(null); }
  }

  async function startRunner() {
    if (!bridge) return;
    setBusy('runner');
    setError(null);
    try {
      await bridge.startAgent({ vault: runnerVault, network });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally { setBusy(null); }
  }

  async function stop(name: ServiceStatus['name']) {
    if (!bridge) return;
    setError(null);
    try { await bridge.stopService(name); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function copyGuardian() {
    if (!guardian?.xmtpAddress) return;
    await navigator.clipboard.writeText(guardian.xmtpAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_200);
  }

  return (
    <section className="reading agents-page">
      <div className="agents-page-head">
        <div>
          <h2>Agents</h2>
          <p>Unlock Mosaic Guardian, then start an independently supervised Runner with a short-lived signed grant.</p>
        </div>
      </div>

      {error && <Banner tone="err">{error}</Banner>}
      {!session && <Banner tone="warn">Log in with your root wallet before starting Mosaic Guardian.</Banner>}

      <div className="agents-grid">
        <article className="zone-card local-services-card">
          <div className="agent-zone-title">
            <div><span className="chain-label">Signer and policy boundary</span><h3>Mosaic Guardian</h3></div>
            <StatusDot tone={tone(guardian?.phase ?? 'stopped')}>{guardian?.phase ?? 'stopped'}</StatusDot>
          </div>
          <Field id="guardian-vault" label="Guardian vault">
            <input id="guardian-vault" value={guardianVault} maxLength={64} onChange={(event) => setGuardianVault(event.target.value)} />
          </Field>
          <Field id="guardian-passphrase" label="Backup passphrase (fallback)">
            <input id="guardian-passphrase" type="password" value={passphrase} autoComplete="off" onChange={(event) => setPassphrase(event.target.value)} placeholder="Use only if wallet-signature unlock is unavailable" />
          </Field>
          {guardian?.detail && <p className="tile-note">{guardian.detail}</p>}
          {guardian?.xmtpAddress && (
            <div className="local-service-row">
              <code className="mono address-value">{guardian.xmtpAddress}</code>
              <button type="button" className="btn-sm" onClick={() => void copyGuardian()}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
            </div>
          )}
          <div className="vault-page-actions">
            {guardian?.phase === 'running' ? (
              <button type="button" className="btn-ghost" onClick={() => void stop('mosaic-guardian')}><Square size={14} /> Stop Guardian</button>
            ) : (
              <button type="button" className="btn-primary" disabled={!session || busy !== null || !guardianVault.trim()} onClick={() => void startGuardian()}>
                <ShieldCheck size={15} /> {busy === 'guardian' ? 'Unlocking…' : 'Start Guardian'}
              </button>
            )}
          </div>
        </article>

        <article className="zone-card local-services-card">
          <div className="agent-zone-title">
            <div><span className="chain-label">Sandbox supervisor</span><h3>Agent Runner</h3></div>
            <StatusDot tone={tone(runner?.phase ?? 'stopped')}>{runner?.phase ?? 'stopped'}</StatusDot>
          </div>
          <Field id="runner-vault" label="Agent ID">
            <input id="runner-vault" value={runnerVault} maxLength={64} onChange={(event) => setRunnerVault(event.target.value)} />
          </Field>
          <p>The Runner creates its own device key. The unlocked Guardian issues a short-lived grant bound to this agent ID, device key, policy, and source digest.</p>
          {runner?.detail && <p className="tile-note">{runner.detail}</p>}
          <div className="vault-page-actions">
            {runner?.phase === 'running' ? (
              <button type="button" className="btn-ghost" onClick={() => void stop('agent-runner')}><Square size={14} /> Stop runner</button>
            ) : (
              <button type="button" className="btn-primary" disabled={guardian?.phase !== 'running' || busy !== null || !runnerVault.trim()} onClick={() => void startRunner()}>
                <Play size={15} /> {busy === 'runner' ? 'Connecting…' : 'Start runner'}
              </button>
            )}
          </div>
        </article>
      </div>

      <div className="zone-card local-services-card">
        <h3>Local services</h3>
        {services.map((service) => (
          <div className="local-service-row" key={service.name}>
            <span><Bot size={14} aria-hidden="true" /> {SERVICE_LABELS[service.name]}{service.vault ? ` · ${service.vault}` : ''}</span>
            <StatusDot tone={tone(service.phase)}>{service.phase}{service.pid ? ` · ${service.pid}` : ''}</StatusDot>
          </div>
        ))}
      </div>
    </section>
  );
}
