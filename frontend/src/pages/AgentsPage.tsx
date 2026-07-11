import { useEffect, useState } from 'react';
import type { ServiceStatus } from '@mosaic/local-runtime';
import { Bot, LockKeyhole } from 'lucide-react';
import StatusDot, { type StatusTone } from '../components/ui/StatusDot';
import { useSettings } from '../contexts/SettingsContext';
import { useSession } from '../contexts/SessionContext';
import { ZONE_NAME } from '../config';
import { localBridge } from '../local/bridge';

const SERVICE_LABELS: Record<ServiceStatus['name'], string> = {
  'signer-policy-manager': 'Signer & Policy Manager',
  'agent-runner': 'Agent Runner',
};

function tone(phase: ServiceStatus['phase']): StatusTone {
  if (phase === 'running') return 'ok';
  if (phase === 'failed') return 'err';
  if (phase === 'starting' || phase === 'stopping') return 'busy';
  return 'idle';
}

export default function AgentsPage() {
  const bridge = localBridge();
  const { session } = useSession();
  const { network } = useSettings();
  const [services, setServices] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    if (!bridge) return;
    void bridge.listServices().then(setServices);
    return bridge.onStatus(setServices);
  }, [bridge]);

  if (!bridge) {
    return (
      <section className="reading zone-panel">
        <div className="zone-head"><h2>Local agents</h2></div>
        <div className="zone-card">
          <h3>Open Mosaic Local</h3>
          <p>Agent processes run on your machine and are managed from the Mosaic desktop app.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="reading agents-page">
      <div className="agents-page-head">
        <div>
          <h2>Agents</h2>
          <p>Start and monitor agents running locally on this machine.</p>
        </div>
        <button type="button" className="btn-primary" disabled title="Unlock a zone before starting its agent">
          <Bot size={15} aria-hidden="true" />
          Start agent
        </button>
      </div>

      <div className="zone-card agent-zone-card">
        <div className="agent-zone-title">
          <div>
            <span className="chain-label">Zone</span>
            <h3 className="mono">{ZONE_NAME} · {session?.network ?? network}</h3>
          </div>
          <StatusDot tone="warn">locked</StatusDot>
        </div>
        <p>The local signer must unlock this zone before its agent can start. Keys remain inside the signer process.</p>
        <button type="button" className="btn-primary" disabled title="Local zone unlock is the next signer slice">
          <LockKeyhole size={15} aria-hidden="true" />
          Unlock zone
        </button>
      </div>

      <div className="agents-grid">
        <div className="zone-card agent-empty">
          <Bot size={26} strokeWidth={1.5} aria-hidden="true" />
          <h3>No agent running</h3>
          <p>Unlock the zone, then start its locally assigned agent here.</p>
        </div>

        <div className="zone-card local-services-card">
          <h3>Local services</h3>
          {services.length === 0 && <p className="tile-note">Starting services…</p>}
          {services.map((service) => (
            <div className="local-service-row" key={service.name}>
              <span>{SERVICE_LABELS[service.name]}</span>
              <StatusDot tone={tone(service.phase)}>
                {service.phase}{service.pid ? ` · ${service.pid}` : ''}
              </StatusDot>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
