'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import type { RiskPreference } from '@/lib/memoryStats';

type MemoryValue = {
  riskPreference: RiskPreference | null;
  riskPreferenceLoaded: boolean;
  getRiskPreference: () => RiskPreference | null;
  setRiskPreference: (pref: RiskPreference | null) => Promise<void>;
};

const MemoryContext = createContext<MemoryValue | null>(null);

export function useMemory(): MemoryValue {
  const ctx = useContext(MemoryContext);
  if (!ctx) throw new Error('useMemory must be used within MemoryProvider');
  return ctx;
}

export function MemoryProvider({ children }: { children: React.ReactNode }) {
  const [riskPreference, setRiskPreferenceState] = useState<RiskPreference | null>(null);
  const [riskPreferenceLoaded, setRiskPreferenceLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/memory');
        const json = await res.json();
        setRiskPreferenceState(json.riskPreference ?? null);
      } catch {
        // Leave as null (unstated) — buildMemoryContext falls back to the
        // inferred heuristic in that case, same "fail honestly, don't
        // block" approach as the rest of this app's context builders.
      } finally {
        setRiskPreferenceLoaded(true);
      }
    })();
  }, []);

  async function setRiskPreference(pref: RiskPreference | null) {
    const prev = riskPreference;
    setRiskPreferenceState(pref); // optimistic — this is a low-stakes preference toggle, not a trade action
    try {
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ riskPreference: pref }),
      });
      if (!res.ok) throw new Error('failed');
    } catch {
      setRiskPreferenceState(prev); // roll back on failure
    }
  }

  const value: MemoryValue = {
    riskPreference,
    riskPreferenceLoaded,
    getRiskPreference: () => riskPreference,
    setRiskPreference,
  };

  return <MemoryContext.Provider value={value}>{children}</MemoryContext.Provider>;
}
