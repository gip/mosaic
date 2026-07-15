import { useEffect, useRef, useState } from 'react';
import { Activity, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useActivity } from '../../contexts/ActivityContext';
import ActivityList from './ActivityList';

export default function ActivityDrawer() {
  const { activities, activeCount, error } = useActivity();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', pointer);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', pointer); };
  }, [open]);
  return <div className="activity-drawer" ref={root}>
    {open && <section className="activity-panel" aria-label="Recent activity">
      <div className="activity-panel-header"><div><h3>Recent activity</h3><span>{activeCount} active</span></div><Link to="/activity" onClick={() => setOpen(false)}>View all</Link></div>
      {error && <p className="activity-summary-error">{error}</p>}
      <ActivityList activities={activities.slice(0, 8)} />
    </section>}
    <button type="button" className="btn-primary activity-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      {open ? <X size={15} aria-hidden="true" /> : <Activity size={15} aria-hidden="true" />} Activity{activeCount > 0 ? ` · ${activeCount}` : ''}
    </button>
  </div>;
}
