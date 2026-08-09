'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { loadLS, saveLS, uid, LS_KEYS } from '@/lib/storage';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from '@/lib/riskManager';
import { PROVIDERS, type Provider } from '@/lib/constants';
import type { PendingApproval } from '@/lib/types';

// ---------------------------------------------------------------------
// Human-in-the-Loop Controls (Production Readiness Review #17): global
// pause, a manual-approval USD threshold for large trades, and
// operator-configurable risk limit overrides.
//
// Why this is its own small provider instead of living in the main
// Config object (components/AppState.tsx): components/Supervisor.tsx —
// the single execution gate for every AI-agent-initiated trade — sits
// ABOVE AppStateProvider in app/layout.tsx's provider tree (Supervisor
// wraps Agent wraps Memory wraps AppState). React context only flows
// downward, so code inside SupervisorProvider's render body cannot
// consume a context whose provider is one of ITS OWN descendants. This
// provider is mounted above SupervisorProvider instead, specifically so
// Supervisor.tsx can read paused/threshold/riskConfig and queue pending
// approvals. The emergency-stop action itself (which also needs to
// cancel running Agent tasks) lives in the UI panel component
// (TradingControlsPanel.tsx), not here — that component sits below
// BOTH this provider and AgentProvider in the tree, so it can consume
// both hooks and wire them together, whereas neither provider could
// reach into the other's state directly without restructuring the tree.
// ---------------------------------------------------------------------

type TradingControlsPersisted = {
  paused: boolean;
  manualApprovalThresholdUsd: number | null;
  riskConfigOverrides: Partial<RiskConfig>;
  // A user-declared baseline for the 'real' tab, which otherwise has no
  // tracked cash/equity at all — every equity-dependent risk check
  // (checkPositionRisk, checkDailyLoss, checkDrawdown,
  // checkPortfolioExposure in lib/riskManager.ts) has always silently
  // read 'unavailable' for real trades because of this. Left at its
  // default (null) this changes nothing — same 'unavailable' behavior
  // as before, for anyone who hasn't set it.
  realStartingCapitalUsd: number | null;
  // Collaboration Protocol (Section 16) — a genuinely SEPARATE
  // provider/model from the main chat one in components/AppState.tsx.
  // Lives here rather than in AppState's Config specifically because
  // components/Supervisor.tsx (the actual caller) sits ABOVE
  // AppStateProvider in the tree, for the exact same reason this whole
  // provider already exists — see the header comment above.
  // '' provider means "not configured" — the feature no-ops until set.
  secondOpinionProvider: string;
  secondOpinionModel: string;
  secondOpinionApiKeys: Record<string, string>;
  secondOpinionBaseUrlOverride: string;
};

const DEFAULT_PERSISTED: TradingControlsPersisted = {
  paused: false,
  manualApprovalThresholdUsd: null,
  riskConfigOverrides: {},
  realStartingCapitalUsd: null,
  secondOpinionProvider: '',
  secondOpinionModel: '',
  secondOpinionApiKeys: {},
  secondOpinionBaseUrlOverride: '',
};

type TradingControlsValue = {
  paused: boolean;
  setPaused: (v: boolean) => void;
  manualApprovalThresholdUsd: number | null;
  setManualApprovalThresholdUsd: (v: number | null) => void;
  realStartingCapitalUsd: number | null;
  setRealStartingCapitalUsd: (v: number | null) => void;
  // Raw persisted second-opinion fields, for the Settings UI to edit...
  secondOpinionProvider: string;
  secondOpinionModel: string;
  secondOpinionApiKeys: Record<string, string>;
  secondOpinionBaseUrlOverride: string;
  setSecondOpinionConfig: (partial: Partial<Pick<TradingControlsPersisted, 'secondOpinionProvider' | 'secondOpinionModel' | 'secondOpinionApiKeys' | 'secondOpinionBaseUrlOverride'>>) => void;
  // ...and the RESOLVED values (same resolution AppState.tsx already
  // does for the primary provider) so Supervisor.tsx doesn't need to
  // duplicate that lookup logic.
  secondOpinionProviderObj: Provider | null;
  secondOpinionResolvedModel: string;
  secondOpinionResolvedApiKey: string;
  secondOpinionResolvedBaseUrl: string;
  secondOpinionConfigured: boolean;
  riskConfig: RiskConfig; // effective, merged over DEFAULT_RISK_CONFIG
  riskConfigOverrides: Partial<RiskConfig>;
  setRiskConfigOverride: (partial: Partial<RiskConfig>) => void;
  resetRiskConfig: () => void;
  pendingApprovals: PendingApproval[];
  // Returns the id of the queued (or already-existing, if dedupeKey
  // matches a still-pending entry) approval request.
  addPendingApproval: (req: Omit<PendingApproval, 'id' | 'createdAt'>) => string;
  removePendingApproval: (id: string) => PendingApproval | null;
};

const TradingControlsContext = createContext<TradingControlsValue | null>(null);

export function useTradingControls(): TradingControlsValue {
  const ctx = useContext(TradingControlsContext);
  if (!ctx) throw new Error('useTradingControls must be used within TradingControlsProvider');
  return ctx;
}

export function TradingControlsProvider({ children }: { children: React.ReactNode }) {
  const [persisted, setPersisted] = useState<TradingControlsPersisted>(DEFAULT_PERSISTED);
  const [hydrated, setHydrated] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  // Supervisor.tsx reads paused/threshold/riskConfig synchronously from
  // inside reviewAndExecute — a ref (kept in sync below) means it always
  // sees the latest value even though reviewAndExecute itself is a
  // function closed over at whatever render created it, same pattern as
  // Agent.tsx's ticksRef/getCandlesRef.
  const pendingRef = useRef(pendingApprovals);
  pendingRef.current = pendingApprovals;

  useEffect(() => {
    setPersisted(loadLS(LS_KEYS.tradingControls, DEFAULT_PERSISTED));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveLS(LS_KEYS.tradingControls, persisted);
  }, [persisted, hydrated]);

  function setPaused(v: boolean) {
    setPersisted((p) => ({ ...p, paused: v }));
  }

  function setManualApprovalThresholdUsd(v: number | null) {
    setPersisted((p) => ({ ...p, manualApprovalThresholdUsd: v }));
  }

  function setRealStartingCapitalUsd(v: number | null) {
    setPersisted((p) => ({ ...p, realStartingCapitalUsd: v }));
  }

  function setSecondOpinionConfig(partial: Partial<Pick<TradingControlsPersisted, 'secondOpinionProvider' | 'secondOpinionModel' | 'secondOpinionApiKeys' | 'secondOpinionBaseUrlOverride'>>) {
    setPersisted((p) => ({ ...p, ...partial }));
  }

  function setRiskConfigOverride(partial: Partial<RiskConfig>) {
    setPersisted((p) => ({ ...p, riskConfigOverrides: { ...p.riskConfigOverrides, ...partial } }));
  }

  function resetRiskConfig() {
    setPersisted((p) => ({ ...p, riskConfigOverrides: {} }));
  }

  function addPendingApproval(req: Omit<PendingApproval, 'id' | 'createdAt'>): string {
    if (req.dedupeKey) {
      const existing = pendingRef.current.find((p) => p.dedupeKey === req.dedupeKey);
      if (existing) return existing.id;
    }
    const entry: PendingApproval = { ...req, id: uid(), createdAt: Date.now() };
    const next = [...pendingRef.current, entry];
    pendingRef.current = next;
    setPendingApprovals(next);
    return entry.id;
  }

  function removePendingApproval(id: string): PendingApproval | null {
    const found = pendingRef.current.find((p) => p.id === id) ?? null;
    const next = pendingRef.current.filter((p) => p.id !== id);
    pendingRef.current = next;
    setPendingApprovals(next);
    return found;
  }

  const riskConfig: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...persisted.riskConfigOverrides };

  const secondOpinionProviderObj = useMemo(() => PROVIDERS.find((p) => p.id === persisted.secondOpinionProvider) ?? null, [persisted.secondOpinionProvider]);
  const secondOpinionResolvedModel = persisted.secondOpinionModel || secondOpinionProviderObj?.models[0] || '';
  const secondOpinionResolvedBaseUrl = persisted.secondOpinionBaseUrlOverride || secondOpinionProviderObj?.baseUrl || '';
  const secondOpinionResolvedApiKey = secondOpinionProviderObj ? persisted.secondOpinionApiKeys[secondOpinionProviderObj.id] || '' : '';
  const secondOpinionConfigured = secondOpinionProviderObj !== null && (!secondOpinionProviderObj.needsKey || !!secondOpinionResolvedApiKey);

  const value: TradingControlsValue = {
    paused: persisted.paused,
    setPaused,
    manualApprovalThresholdUsd: persisted.manualApprovalThresholdUsd,
    setManualApprovalThresholdUsd,
    realStartingCapitalUsd: persisted.realStartingCapitalUsd,
    setRealStartingCapitalUsd,
    secondOpinionProvider: persisted.secondOpinionProvider,
    secondOpinionModel: persisted.secondOpinionModel,
    secondOpinionApiKeys: persisted.secondOpinionApiKeys,
    secondOpinionBaseUrlOverride: persisted.secondOpinionBaseUrlOverride,
    setSecondOpinionConfig,
    secondOpinionProviderObj,
    secondOpinionResolvedModel,
    secondOpinionResolvedApiKey,
    secondOpinionResolvedBaseUrl,
    secondOpinionConfigured,
    riskConfig,
    riskConfigOverrides: persisted.riskConfigOverrides,
    setRiskConfigOverride,
    resetRiskConfig,
    pendingApprovals,
    addPendingApproval,
    removePendingApproval,
  };

  return <TradingControlsContext.Provider value={value}>{children}</TradingControlsContext.Provider>;
}
