import { useEffect, useMemo, useState } from 'react';
import {
  AGENT_PACKAGE_PROTOCOL,
  DEFAULT_GUARDIAN_VAULT,
  DEFAULT_RUNNER_VAULT,
  type AgentArtifactPackage,
  type AgentInstallationPolicy,
  type AgentResourceLimits,
  type CapabilityAllowance,
  type ServiceStatus,
} from '@mosaic/local-runtime/contracts';
import { Bot, Copy, PackageOpen, Play, ShieldCheck, Square } from 'lucide-react';
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

function reduceLimits(requested: AgentResourceLimits, current: AgentResourceLimits): AgentResourceLimits {
  return Object.fromEntries(Object.entries(requested).map(([key, value]) => [
    key,
    Math.min(value, current[key as keyof AgentResourceLimits] ?? value),
  ])) as unknown as AgentResourceLimits;
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
  const [busy, setBusy] = useState<'guardian' | 'runner' | 'install' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [xamanPrompt, setXamanPrompt] = useState<XamanPrompt | null>(null);
  const [agentPackage, setAgentPackage] = useState<AgentArtifactPackage | null>(null);
  const [selectedOptional, setSelectedOptional] = useState<Set<string>>(new Set());
  const [capabilityDrafts, setCapabilityDrafts] = useState<CapabilityAllowance[]>([]);
  const [limitDraft, setLimitDraft] = useState<AgentResourceLimits | null>(null);
  const [resourceBindings, setResourceBindings] = useState<Record<string, string>>({});
  const [installation, setInstallation] = useState<AgentInstallationPolicy | null>(null);
  const [installEnabled, setInstallEnabled] = useState(true);
  const [olderArtifacts, setOlderArtifacts] = useState<Array<{ artifactDigest: string; manifest: AgentArtifactPackage['manifest']; createdAt: string }>>([]);

  useEffect(() => {
    if (!bridge) return;
    void bridge.listServices().then(setServices);
    return bridge.onStatus(setServices);
  }, [bridge]);

  const guardian = useMemo(() => services.find(({ name }) => name === 'mosaic-guardian'), [services]);
  const runner = useMemo(() => services.find(({ name }) => name === 'agent-runner'), [services]);

  function reviewPackage(pkg: AgentArtifactPackage, currentInstallation = installation) {
    const currentByOperation = new Map(currentInstallation?.capabilities.map((capability) => [capability.operation, capability]));
    const requested = [...pkg.manifest.capabilities.required, ...pkg.manifest.capabilities.optional];
    setAgentPackage(pkg);
    setInstallEnabled(currentInstallation?.enabled ?? true);
    setSelectedOptional(new Set(pkg.manifest.capabilities.optional.filter(({ operation }) => currentByOperation.has(operation)).map(({ operation }) => operation)));
    setCapabilityDrafts(requested.map((capability) => {
      const current = currentByOperation.get(capability.operation);
      if (!current || JSON.stringify(current.constraints) !== JSON.stringify(capability.constraints)) return structuredClone(capability);
      return { ...structuredClone(capability), maxCalls: Math.min(current.maxCalls, capability.maxCalls), maxResponseBytes: Math.min(current.maxResponseBytes, capability.maxResponseBytes) } as CapabilityAllowance;
    }));
    setLimitDraft(currentInstallation ? reduceLimits(pkg.manifest.limits, currentInstallation.limits) : structuredClone(pkg.manifest.limits));
    setResourceBindings(Object.fromEntries(pkg.manifest.resourceSlots.map(({ slotId }) => [
      slotId,
      currentInstallation?.resources.find(({ resourceId }) => resourceId === slotId)?.peerAddress ?? '',
    ])));
  }

  async function loadCurrentInstallation() {
    if (!bridge || !session || !agentPackage) return;
    if (!window.confirm(`Stop any live authority for ${runnerVault.trim()} and unlock its vault to load the encrypted installation policy?`)) return;
    setBusy('install');
    setError(null);
    try {
      const agentId = runnerVault.trim();
      const vault = (await api.zoneList(session.token)).find(({ zone }) => zone === agentId);
      if (!vault) throw new Error(`Agent vault not found: ${agentId}`);
      const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: agentId, network: session.network };
      let signatureB64: string | undefined;
      if (vault.mode !== 'testnet-server' && !agentPassphrase) {
        const signer = session.chain === 'xrpl'
          ? xamanCeremonySigner({ token: session.token, ref, onPayload: (refs, label) => setXamanPrompt({ refs, label }), onPayloadDone: () => setXamanPrompt(null) })
          : directCeremonySigner(ref, signZoneMessage);
        signatureB64 = bytesToBase64(await signer.signBackupWrap());
      }
      const current = await bridge.agentInstallationGet({
        agentId,
        network: session.network,
        ...(signatureB64 ? { signatureB64 } : {}),
        ...(agentPassphrase ? { passphrase: agentPassphrase } : {}),
      });
      setInstallation(current ?? null);
      reviewPackage(agentPackage, current ?? null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }

  async function openPackage() {
    if (!bridge) return;
    setError(null);
    try {
      const pkg = await bridge.agentPackageOpen();
      if (!pkg) return;
      reviewPackage(pkg);
      if (session) {
        const artifacts = await api.agentArtifactList(session.token, pkg.manifest.packageName);
        setOlderArtifacts(artifacts.filter(({ artifactDigest }) => artifactDigest !== pkg.artifactDigest));
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  async function selectStoredArtifact(artifactDigest: string) {
    if (!session) return;
    setError(null);
    try {
      const stored = await api.agentArtifactGet(session.token, artifactDigest);
      reviewPackage({ protocol: AGENT_PACKAGE_PROTOCOL, artifactDigest, manifest: stored.manifest, source: stored.source });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }

  function updateCapability(operation: string, field: 'maxCalls' | 'maxResponseBytes', raw: string) {
    const value = Math.max(1, Math.floor(Number(raw) || 1));
    setCapabilityDrafts((items) => items.map((item) => item.operation === operation ? { ...item, [field]: value } as CapabilityAllowance : item));
  }

  function updateLimit(field: keyof AgentResourceLimits, raw: string) {
    const value = Math.max(1, Math.floor(Number(raw) || 1));
    setLimitDraft((limits) => limits ? { ...limits, [field]: value } : limits);
  }

  async function installPackage() {
    if (!bridge || !agentPackage || !limitDraft) return;
    if (!session) { setError('Log in with the root wallet that owns the agent vault first.'); return; }
    if (guardian?.phase !== 'running') { setError('Unlock Mosaic Guardian before installing an agent.'); return; }
    setBusy('install');
    setError(null);
    try {
      const agentId = runnerVault.trim();
      const vault = (await api.zoneList(session.token)).find(({ zone }) => zone === agentId);
      if (!vault) throw new Error(`Agent vault not found: ${agentId}`);
      const requiredOperations = new Set(agentPackage.manifest.capabilities.required.map(({ operation }) => operation));
      const capabilities = capabilityDrafts.filter(({ operation }) => requiredOperations.has(operation) || selectedOptional.has(operation));
      const requestedByOperation = new Map([...agentPackage.manifest.capabilities.required, ...agentPackage.manifest.capabilities.optional].map((item) => [item.operation, item]));
      for (const capability of capabilities) {
        const requested = requestedByOperation.get(capability.operation)!;
        if (capability.maxCalls > requested.maxCalls || capability.maxResponseBytes > requested.maxResponseBytes) throw new Error(`${capability.operation} quotas cannot exceed the package request`);
      }
      for (const [key, value] of Object.entries(limitDraft)) {
        const requested = agentPackage.manifest.limits[key as keyof AgentResourceLimits];
        if (requested !== undefined && value !== undefined && value > requested) throw new Error(`${key} cannot exceed the package request`);
      }
      const resources = agentPackage.manifest.resourceSlots.flatMap((slot) => {
        const peerAddress = resourceBindings[slot.slotId]?.trim();
        if (slot.required && !peerAddress) throw new Error(`Bind required resource: ${slot.label}`);
        return peerAddress ? [{
          kind: 'xmtp-contact' as const,
          resourceId: slot.slotId,
          label: slot.label,
          peerAddress,
          environment: session.network === 'testnet' ? 'dev' as const : 'production' as const,
        }] : [];
      });
      const approved = window.confirm(
        `${installation ? 'Update' : 'Install'} ${agentPackage.manifest.packageName}@${agentPackage.manifest.version} in ${agentId}?\n\n` +
        `Digest: ${agentPackage.artifactDigest}\nCapabilities: ${capabilities.map(({ operation }) => operation).join(', ') || 'none'}\n\n` +
        'XMTP credentials remain software-local in Agent Runner. The package receives only the reviewed hooks and resource slots.',
      );
      if (!approved) return;
      await api.agentArtifactPut(session.token, agentPackage.manifest, agentPackage.source);
      const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: agentId, network: session.network };
      let signatureB64: string | undefined;
      if (vault.mode !== 'testnet-server' && !agentPassphrase) {
        const signer = session.chain === 'xrpl'
          ? xamanCeremonySigner({ token: session.token, ref, onPayload: (refs, label) => setXamanPrompt({ refs, label }), onPayloadDone: () => setXamanPrompt(null) })
          : directCeremonySigner(ref, signZoneMessage);
        signatureB64 = bytesToBase64(await signer.signBackupWrap());
      }
      const installed = await bridge.agentInstall({
        agentId,
        artifactDigest: agentPackage.artifactDigest,
        capabilities,
        resources,
        limits: limitDraft,
        enabled: installEnabled,
        expectedRevision: installation?.revision ?? 0,
        network: session.network,
        ...(signatureB64 ? { signatureB64 } : {}),
        ...(agentPassphrase ? { passphrase: agentPassphrase } : {}),
      });
      setInstallation(installed);
      setAgentPassphrase('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }

  async function deleteInstallation() {
    if (!bridge || !session || !installation) return;
    if (!window.confirm(`Delete installation revision ${installation.revision} from ${runnerVault.trim()}? The immutable artifact remains available for later rollback.`)) return;
    setBusy('install');
    setError(null);
    try {
      const agentId = runnerVault.trim();
      const vault = (await api.zoneList(session.token)).find(({ zone }) => zone === agentId);
      if (!vault) throw new Error(`Agent vault not found: ${agentId}`);
      const ref: ZoneRef = { rootChain: session.chain, rootAddress: session.address, zone: agentId, network: session.network };
      let signatureB64: string | undefined;
      if (vault.mode !== 'testnet-server' && !agentPassphrase) {
        const signer = session.chain === 'xrpl'
          ? xamanCeremonySigner({ token: session.token, ref, onPayload: (refs, label) => setXamanPrompt({ refs, label }), onPayloadDone: () => setXamanPrompt(null) })
          : directCeremonySigner(ref, signZoneMessage);
        signatureB64 = bytesToBase64(await signer.signBackupWrap());
      }
      await bridge.agentInstallationDelete(agentId, installation.revision, {
        network: session.network,
        ...(signatureB64 ? { signatureB64 } : {}),
        ...(agentPassphrase ? { passphrase: agentPassphrase } : {}),
      });
      setInstallation(null);
      if (agentPackage) reviewPackage(agentPackage, null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(null); }
  }

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
    if (session.network !== network) { setError('Wait for the wallet session to switch to the selected network.'); return; }
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
        agentId, network: session.network,
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
        <div className="agent-zone-title">
          <div>
            <span className="chain-label">Install-time authority review</span>
            <h3>Agent package</h3>
          </div>
          <button type="button" className="btn-primary" disabled={busy !== null} onClick={() => void openPackage()}>
            <PackageOpen size={15} /> Open package
          </button>
        </div>
        {!agentPackage ? (
          <p>Select a compiled <code>.mosaic-agent</code> package. Opening a package verifies its canonical envelope, manifest, source digest, and artifact digest before review.</p>
        ) : (
          <>
            <div className="local-service-row">
              <span><strong>{agentPackage.manifest.packageName}</strong> · {agentPackage.manifest.version}</span>
              <span>
                <code className="mono">{agentPackage.artifactDigest.slice(0, 16)}…</code>{' '}
                <button type="button" className="btn-sm" disabled={!session || busy !== null || !runnerVault.trim()} onClick={() => void loadCurrentInstallation()}>
                  Stop &amp; load installed policy
                </button>
              </span>
            </div>
            {installation && installation.artifactDigest !== agentPackage.artifactDigest && (
              <Banner tone="warn">This writes installation revision {installation.revision + 1}. Current digest: {installation.artifactDigest.slice(0, 16)}…</Banner>
            )}
            <h4>Capabilities</h4>
            {capabilityDrafts.map((capability) => {
              const optional = agentPackage.manifest.capabilities.optional.some(({ operation }) => operation === capability.operation);
              const selected = !optional || selectedOptional.has(capability.operation);
              return (
                <div className="zone-card" key={capability.operation}>
                  <div className="local-service-row">
                    <label>
                      {optional && <input type="checkbox" checked={selected} onChange={(event) => setSelectedOptional((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(capability.operation); else next.delete(capability.operation);
                        return next;
                      })} />}
                      {' '}<strong>{capability.operation}</strong> · {optional ? 'optional' : installation && !installation.capabilities.some(({ operation }) => operation === capability.operation) ? 'new required authority' : 'required'}
                    </label>
                    <code className="mono">{capability.constraints === undefined ? 'no constraints' : JSON.stringify(capability.constraints)}</code>
                  </div>
                  {selected && (
                    <div className="agents-grid">
                      <Field id={`calls-${capability.operation}`} label="Maximum calls per execution grant">
                        <input id={`calls-${capability.operation}`} type="number" min={1} value={capability.maxCalls} onChange={(event) => updateCapability(capability.operation, 'maxCalls', event.target.value)} />
                      </Field>
                      <Field id={`response-${capability.operation}`} label="Maximum response bytes per call">
                        <input id={`response-${capability.operation}`} type="number" min={1} value={capability.maxResponseBytes} onChange={(event) => updateCapability(capability.operation, 'maxResponseBytes', event.target.value)} />
                      </Field>
                    </div>
                  )}
                </div>
              );
            })}

            {agentPackage.manifest.resourceSlots.length > 0 && <h4>Resource bindings</h4>}
            {agentPackage.manifest.resourceSlots.map((slot) => (
              <Field key={slot.slotId} id={`slot-${slot.slotId}`} label={`${slot.label} (${slot.slotId}) · ${slot.required ? 'required' : 'optional'}`}>
                <input id={`slot-${slot.slotId}`} value={resourceBindings[slot.slotId] ?? ''} onChange={(event) => setResourceBindings((bindings) => ({ ...bindings, [slot.slotId]: event.target.value }))} placeholder="Concrete XMTP peer address" />
              </Field>
            ))}

            {limitDraft && (
              <>
                <h4>Runtime limits</h4>
                <div className="agents-grid">
                  {(Object.entries(limitDraft) as Array<[keyof AgentResourceLimits, number]>).map(([key, value]) => (
                    <Field key={key} id={`limit-${key}`} label={key}>
                      <input id={`limit-${key}`} type="number" min={1} value={value} onChange={(event) => updateLimit(key, event.target.value)} />
                    </Field>
                  ))}
                </div>
              </>
            )}
            <Banner tone="warn">XMTP custody uses the software-local trust tier: raw XMTP credentials remain in Agent Runner and are never exposed to QuickJS. The selected package receives only capability hooks.</Banner>
            <label>
              <input type="checkbox" checked={installEnabled} onChange={(event) => setInstallEnabled(event.target.checked)} />{' '}
              Installation enabled (clear this to install or update it in a disabled state)
            </label>
            <div className="vault-page-actions">
              <button type="button" className="btn-primary" disabled={!session || guardian?.phase !== 'running' || busy !== null || !runnerVault.trim()} onClick={() => void installPackage()}>
                <ShieldCheck size={15} /> {busy === 'install' ? 'Installing…' : installation ? 'Approve update' : 'Approve installation'}
              </button>
              {installation && (
                <button type="button" className="btn-ghost" disabled={busy !== null} onClick={() => void deleteInstallation()}>
                  Delete installation
                </button>
              )}
            </div>

            {olderArtifacts.length > 0 && (
              <div>
                <h4>Rollback candidates</h4>
                {olderArtifacts.map((artifact) => (
                  <div className="local-service-row" key={artifact.artifactDigest}>
                    <span>{artifact.manifest.version} · <code>{artifact.artifactDigest.slice(0, 16)}…</code></span>
                    <button type="button" className="btn-sm" onClick={() => void selectStoredArtifact(artifact.artifactDigest)}>Review rollback</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
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
