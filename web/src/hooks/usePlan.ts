import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlanData, WeightUnit } from '../../../lib/types';
import { createNewPlan } from '../../../lib/defaults';
import { toISODate } from '../../../lib/dateUtils';
import {
  PlanConflictError,
  ServerUnreachableError,
  fetchPlan,
  savePlan,
  subscribeToChanges,
} from '../lib/api';
import { downloadJSON, readJSONFile } from '../lib/persistence';

export type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'error' | 'offline';

export function usePlan() {
  const [plan, setPlanState] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [error, setError] = useState<string | null>(null);

  const revRef = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set while this tab is mid-write, so the revision bump caused by our own
  // save doesn't trigger a redundant refetch.
  const pendingRef = useRef(false);

  const applySnapshot = useCallback((rev: number, next: PlanData | null) => {
    revRef.current = rev;
    setPlanState(next);
  }, []);

  const reload = useCallback(async () => {
    try {
      const snapshot = await fetchPlan();
      applySnapshot(snapshot.rev, snapshot.plan);
      setSaveStatus('saved');
      setError(null);
    } catch (err) {
      if (err instanceof ServerUnreachableError) setSaveStatus('offline');
      setError(message(err));
    } finally {
      setLoading(false);
    }
  }, [applySnapshot]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live updates: a set logged from Discord lands here without a refresh.
  useEffect(() => {
    return subscribeToChanges((rev) => {
      if (pendingRef.current || rev === revRef.current) return;
      void reload();
    });
  }, [reload]);

  const flush = useCallback(async (next: PlanData) => {
    pendingRef.current = true;
    setSaveStatus('saving');
    try {
      revRef.current = await savePlan(revRef.current, next);
      setSaveStatus('saved');
      setError(null);
    } catch (err) {
      if (err instanceof PlanConflictError) {
        // The server's copy wins; adopt it rather than overwrite a change made
        // elsewhere. Losing a keystroke beats losing a logged set.
        applySnapshot(err.snapshot.rev, err.snapshot.plan);
        setSaveStatus('saved');
        setError('Reloaded — the log was changed somewhere else while you were editing.');
      } else if (err instanceof ServerUnreachableError) {
        setSaveStatus('offline');
        setError(message(err));
      } else {
        setSaveStatus('error');
        setError(message(err));
      }
    } finally {
      pendingRef.current = false;
    }
  }, [applySnapshot]);

  const updatePlan = useCallback(
    (updater: (prev: PlanData) => PlanData) => {
      setPlanState((prev) => {
        if (!prev) return prev;
        const next = updater(prev);
        setSaveStatus('unsaved');
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void flush(next), 400);
        return next;
      });
    },
    [flush],
  );

  const startNewPlan = useCallback(
    (planName: string, unit: WeightUnit) => {
      const data = createNewPlan(planName, unit, toISODate(new Date()));
      setPlanState(data);
      void flush(data);
    },
    [flush],
  );

  const exportJSON = useCallback(() => {
    if (plan) downloadJSON(plan, 'training-log.json');
  }, [plan]);

  const importJSON = useCallback(
    async (file: File) => {
      try {
        const data = await readJSONFile(file);
        setPlanState(data);
        await flush(data);
      } catch (err) {
        setError(message(err));
      }
    },
    [flush],
  );

  return {
    plan,
    loading,
    saveStatus,
    error,
    dismissError: () => setError(null),
    retry: reload,
    updatePlan,
    startNewPlan,
    exportJSON,
    importJSON,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
