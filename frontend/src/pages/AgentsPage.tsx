import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_GUARDIAN_VAULT,
  DEFAULT_RUNNER_VAULT,
  type ServiceStatus,
} from '@mosaic/local-runtime/contracts';
import { Bot, Copy, Play, ShieldCheck, Square } from 'lucide-react';
import type { ZoneRef } from '@mosaic/zone-keys';
import StatusDot, { type StatusTone } from '../components/ui/StatusDot';
import Banner from '../components/ui/Banner';
import Field from '../components/ui/Field';
import XamanPromptModal, { type XamanPrompt } from '../components/XamanPromptModal';
import { api, type ZoneListItem } from '../api';
import {
  CEREMONY_STEP_LABELS,
  runZoneCeremony,
} from '../zone/ceremony';
import { directCeremonySigner, xamanCeremonySigner } from '../zone/signers';
import { createTestnetVault } from '../zone/testnet';
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

function hasGuardianAddress(vault: ZoneListItem): boolean {
  return vault.addresses.some(({ chain, name }) => chain === 'evm' && name === 'guardian');
}

export default function AgentsPage() {
  const bridge = localBridge();
  const { session, signZoneMessage } = useSession();
  const { network } = useSettings();
  const { registerCreated, refreshVaults } = useVaults();
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [guardianVault, setGuardianVault] = useState(DEFAULT_GUARDIAN_VAULT);
  const [runnerVault, setRunnerVault] = useState(DEFAULT_RUNNER_VAULT);
  const [passphrase, setPassphrase] = useState('');
  const [agentPassphrase, setAgentPassphrase] = useState('');
  const [busy, setBusy] = useState<'guardian' | 'runner' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [xamanPrompt, setXamanPrompt] = useState<XamanPrompt | null>(null);

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
    setProgress(null);
    try {
      const vaultName = guardianVault.trim();
      const ref: ZoneRef = {
        rootChain: session.chain,
        rootAddress: session.address,
        zone: vaultName,
        network: session.network,
      };
      const signer = () => session.chain === 'xrpl'
        ? xamanCeremonySigner({
            token: session.token,
            ref,
            onPayload: (refs, label) => setXamanPrompt({ refs, label }),
            onPayloadDone: () => setXamanPrompt(null),
          })
        : directCeremonySigner(ref, signZoneMessage);

      // Read from the server here rather than relying on the context snapshot:
      // the Agents page may be opened while the initial vault list is loading.
      let vault = (await api.zoneList(session.token)).find(({ zone }) => zone === vaultName);
      if (!vault) {
        if (session.network === 'testnet') {
          setProgress('Creating default Testnet Guardian vault…');
          await createTestnetVault(session.token, ref);
        } else {
          if (passphrase.length < 10) {
            throw new Error('Enter a backup passphrase of at least 10 characters to create the Guardian vault.');
          }
          await runZoneCeremony({
            token: session.token,
            ref,
            passphrase,
            signer: signer(),
            onStep: (step) => setProgress(CEREMONY_STEP_LABELS[step]),
          });
        }
        setProgress('Creating the guardian EVM address…');
        await api.zoneAddressCreate(session.token, vaultName, 'evm', 'guardian');
        await registerCreated(vaultName);
        vault = (await api.zoneList(session.token)).find(({ zone }) => zone === vaultName);
        if (!vault) throw new Error(`Guardian vault was created but could not be loaded: ${vaultName}`);
      } else if (!hasGuardianAddress(vault)) {
        setProgress('Creating the guardian EVM address…');
        await api.zoneAddressCreate(session.token, vaultName, 'evm', 'guardian');
        await refreshVaults();
      }

      setProgress('Unlocking Mosaic Guardian…');
      let signatureB64: string | undefined;
      if (vault && vault.mode !== 'testnet-server' && !passphrase) {
        // XRPL backup-wrap goes through a server-created Xaman payload;
        // EVM/Stellar sign the canonical message directly.
        signatureB64 = bytesToBase64(await signer().signBackupWrap());
      }
      await bridge.startGuardian({
        vault: vaultName,
        network: session.network,
        session,
        ...(signatureB64 ? { signatureB64 } : {}),
        ...(passphrase ? { passphrase } : {}),
      });
      setPassphrase('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function startRunner() {
    if (!bridge) return;
    if (!session) { setError('Log in with the root wallet that owns the agent vault first.'); return; }
    setBusy('runner');
    setError(null);
    try {
      const agentId = runnerVault.trim();
      const vault = (await api.zoneList(session.token)).find(({ zone }) => zone === agentId);
      if (!vault) throw new Error(`Agent vault not found: ${agentId}`);
      const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: agentId, network: session.network };
      let signatureB64: string | undefined;
      if (vault.mode !== 'testnet-server' && !agentPassphrase) {
        const signer = session.chain === 'xrpl'
          ? xamanCeremonySigner({
              token: session.token, ref,
              onPayload: (refs, label) => setXamanPrompt({ refs, label }),
              onPayloadDone: () => setXamanPrompt(null),
            })
          : directCeremonySigner(ref, signZoneMessage);
        signatureB64 = bytesToBase64(await signer.signBackupWrap());
      }
      await bridge.agentStart({
        agentId, network,
        ...(signatureB64 ? { signatureB64 } : {}),
        ...(agentPassphrase ? { passphrase: agentPassphrase } : {}),
      });
      setAgentPassphrase('');
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
    if (!guardian?.evmAddress) return;
    await navigator.clipboard.writeText(guardian.evmAddress);
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
          <Field id="guardian-passphrase" label="Backup passphrase (creation or unlock fallback)">
            <input id="guardian-passphrase" type="password" value={passphrase} autoComplete="off" onChange={(event) => setPassphrase(event.target.value)} placeholder="Required to create a Mainnet Guardian vault" />
          </Field>
          {progress && <p className="tile-note">{progress}</p>}
          {guardian?.detail && <p className="tile-note">{guardian.detail}</p>}
          {guardian?.evmAddress && (
            <div className="local-service-row">
              <code className="mono address-value">{guardian.evmAddress}</code>
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
          <Field id="agent-passphrase" label="Agent-vault passphrase (unlock fallback)">
            <input id="agent-passphrase" type="password" value={agentPassphrase} autoComplete="off" onChange={(event) => setAgentPassphrase(event.target.value)} />
          </Field>
          <p>One persistent Supervisor launches this agent after Guardian unlocks its matching vault and verifies its pinned policy and artifact.</p>
          {runner?.detail && <p className="tile-note">{runner.detail}</p>}
          <div className="vault-page-actions">
            <button type="button" className="btn-primary" disabled={guardian?.phase !== 'running' || busy !== null || !runnerVault.trim()} onClick={() => void startRunner()}>
              <Play size={15} /> {busy === 'runner' ? 'Connecting…' : 'Start agent'}
            </button>
            <button type="button" className="btn-ghost" disabled={runner?.phase !== 'running' || !runnerVault.trim()} onClick={() => void bridge.agentStop(runnerVault.trim())}>
              <Square size={14} /> Stop agent
            </button>
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
      {xamanPrompt && <XamanPromptModal prompt={xamanPrompt} onClose={() => setXamanPrompt(null)} />}
    </section>
  );
}
