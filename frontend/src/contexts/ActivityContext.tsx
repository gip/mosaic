import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActivityRecord } from '@mosaic/chain-core';
import { api } from '../api';
import { useSession } from './SessionContext';

const POLL_MS = 8_000;

interface ActivityValue {
  activities: ActivityRecord[];
  loading: boolean;
  error: string | null;
  activeCount: number;
  refresh: () => Promise<void>;
}

const ActivityContext = createContext<ActivityValue | null>(null);
const ACTIVE = new Set(['awaiting_signature', 'submitted', 'confirmed', 'open', 'partially_filled', 'unknown']);

function mergeActivities(current: ActivityRecord[], incoming: ActivityRecord[]): ActivityRecord[] {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) records.set(record.id, record);
  return [...records.values()].sort((left, right) => right.cursor - left.cursor);
}

export function ActivityProvider({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const [activities, setActivities] = useState<ActivityRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const result = await api.activityList(session.token, { limit: 250 });
      setActivities(result.activities);
      cursorRef.current = Math.max(0, ...result.activities.map(({ cursor }) => cursor));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    cursorRef.current = 0;
    queueMicrotask(() => {
      setActivities([]);
      setError(null);
      if (session) void refresh();
    });
    if (!session) return;
    let cancelled = false;
    const poll = window.setInterval(() => {
      void api.activityList(session.token, { after: cursorRef.current, limit: 100 }).then((result) => {
        if (cancelled || result.activities.length === 0) return;
        cursorRef.current = Math.max(cursorRef.current, ...result.activities.map(({ cursor }) => cursor));
        setActivities((current) => mergeActivities(current, result.activities));
        setError(null);
      }).catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [refresh, session]);

  const value = useMemo(() => ({
    activities,
    loading,
    error,
    activeCount: activities.filter(({ status }) => ACTIVE.has(status)).length,
    refresh,
  }), [activities, error, loading, refresh]);
  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useActivity(): ActivityValue {
  const value = useContext(ActivityContext);
  if (!value) throw new Error('useActivity outside ActivityProvider');
  return value;
}
