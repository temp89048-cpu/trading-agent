'use client';

// =====================================================================
// Mission Planner Provider — Phase 22
//
// Loads missions from /api/missions, exposes the active mission,
// provides mission CRUD, runs periodic mission evaluation against
// live portfolio state, and supplies trade alignment scoring for the
// Supervisor to consume.
// =====================================================================

import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { usePortfolio } from './Portfolio';
import { useMarketData } from './MarketData';
import { uid } from '@/lib/storage';

// Empty string = same origin, i.e. this app's own /api/missions route handler.
//
// This was hardcoded to 'http://localhost:8000', which breaks in any deployment
// that is not the developer's machine and needed CORS to work even there.
// /api/missions exists on BOTH servers with the same shape, so the same-origin
// route is used: it needs no CORS, no configured host, and no Postgres.
//
// To drive the FastAPI backend instead, set NEXT_PUBLIC_BACKEND_URL and change
// this to BACKEND_BASE from lib/backendConfig.
const API_BASE = '';
import {
  evaluateMission,
  scoreMissionAlignment,
  checkMissionExpiry,
  getDefaultConstraints,
  type Mission,
  type MissionType,
  type MissionTarget,
  type MissionConstraint,
  type MissionStatus,
  type MissionPortfolioContext,
  type MissionAlignmentResult,
} from '@/lib/missionPlanner';

const EVAL_INTERVAL_MS = 30_000; // evaluate mission progress every 30s

type MissionPlannerValue = {
  missions: Mission[];
  activeMission: Mission | null;
  createMission: (params: {
    type: MissionType;
    name: string;
    description: string;
    target: MissionTarget;
    constraints?: MissionConstraint[];
    expiresAt?: number | null;
  }) => void;
  updateMissionStatus: (id: string, status: MissionStatus) => void;
  deleteMission: (id: string) => void;
  getMissionAlignment: (trade: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    price: number;
    leverage?: number;
  }) => MissionAlignmentResult | null;
};

const MissionPlannerContext = createContext<MissionPlannerValue | null>(null);

export function useMissionPlanner(): MissionPlannerValue {
  const ctx = useContext(MissionPlannerContext);
  if (!ctx) throw new Error('useMissionPlanner must be used within MissionPlannerProvider');
  return ctx;
}

export function MissionPlannerProvider({ children }: { children: React.ReactNode }) {
  const { tradeLog, getPortfolioSnapshot } = usePortfolio();
  const { ticks } = useMarketData();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loaded, setLoaded] = useState(false);
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  const getPortfolioSnapshotRef = useRef(getPortfolioSnapshot);
  getPortfolioSnapshotRef.current = getPortfolioSnapshot;
  const tradeLogRef = useRef(tradeLog);
  tradeLogRef.current = tradeLog;

  // Load missions from server on mount
  useEffect(() => {
    fetch(`${API_BASE}/api/missions`)
      .then((r) => r.json())
      .then((data: Mission[]) => {
        setMissions(data);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  const activeMission = missions.find((m) => m.status === 'active') ?? null;

  // Build portfolio context for mission evaluation — uses refs to avoid
  // stale closure issues without creating deps that trigger re-renders.
  const missionsRef = useRef(missions);
  missionsRef.current = missions;

  const buildPortfolioContext = useCallback((): MissionPortfolioContext => {
    const portfolio = getPortfolioSnapshotRef.current();
    const currentTicks = ticksRef.current;
    const log = tradeLogRef.current;
    const currentMissions = missionsRef.current;

    const positions = portfolio.paper.positions.map((p) => ({
      symbol: p.symbol,
      qty: p.qty,
      valueUsd: p.qty * (currentTicks[p.symbol]?.price ?? p.avgCost),
      avgCost: p.avgCost,
    }));

    const totalEquityUsd = portfolio.paper.cash + positions.reduce((s, p) => s + p.valueUsd, 0);

    // Today's trade count
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayTradeCount = log.filter((t) => t.ts >= startOfDay.getTime() && t.tab === 'paper').length;

    // Peak/trough — compute from trade log if we have an active mission
    const active = currentMissions.find((m) => m.status === 'active');
    const missionStart = active?.createdAt ?? Date.now();

    // Simple approximation — use current equity as both peak and trough
    let peakEquityUsd = totalEquityUsd;
    let troughEquityUsd = totalEquityUsd;

    // Use checkpoints to find historical peak/trough if available
    if (active) {
      for (const cp of active.checkpoints) {
        const cpEquity = (cp.progressPct / 100) * totalEquityUsd;
        peakEquityUsd = Math.max(peakEquityUsd, cpEquity || totalEquityUsd);
        troughEquityUsd = Math.min(troughEquityUsd, cpEquity || totalEquityUsd);
      }
    }

    return {
      cashUsd: portfolio.paper.cash,
      totalEquityUsd,
      positions,
      todayTradeCount,
      // The type documents this as "equity at mission creation", and it was set to
      // CURRENT equity — so it always equalled totalEquityUsd and every metric
      // derived from the difference read exactly zero change, forever. It now
      // reports the active mission's captured baseline, falling back to current
      // equity only when there is no mission to have a baseline for.
      startEquityUsd: active?.baselineEquityUsd ?? totalEquityUsd,
      peakEquityUsd,
      troughEquityUsd,
    };
  }, []); // no deps — reads everything from refs

  // Periodic mission evaluation — MUST NOT depend on `missions` state
  // to avoid an infinite loop (evaluate → setMissions → re-trigger).
  // Reads missions from missionsRef instead.
  useEffect(() => {
    if (!loaded) return;

    const evaluate = () => {
      const currentMissions = missionsRef.current;
      const active = currentMissions.find((m) => m.status === 'active');
      if (!active) return;

      const ctx = buildPortfolioContext();

      // Check expiry
      const newStatus = checkMissionExpiry(active);
      if (newStatus !== 'active') {
        const updated = { ...active, status: newStatus, updatedAt: Date.now() };
        setMissions((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        fetch(`${API_BASE}/api/missions`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: updated.id, status: newStatus }),
        }).catch(() => {});
        return;
      }

      // Evaluate progress
      const progress = evaluateMission(active, ctx);
      const checkpoint = { ts: Date.now(), progressPct: progress.currentPct, note: progress.detail };
      const updated: Mission = {
        ...active,
        progress,
        checkpoints: [...active.checkpoints.slice(-99), checkpoint],
        updatedAt: Date.now(),
      };

      if (progress.currentPct >= 100) {
        updated.status = 'completed';
      }

      setMissions((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));

      // Persist (fire-and-forget)
      fetch(`${API_BASE}/api/missions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: updated.id, progress: updated.progress, checkpoints: updated.checkpoints, status: updated.status }),
      }).catch(() => {});
    };

    // Delay the first evaluation slightly to let the UI settle
    const timeout = setTimeout(evaluate, 2000);
    const iv = setInterval(evaluate, EVAL_INTERVAL_MS);
    return () => {
      clearTimeout(timeout);
      clearInterval(iv);
    };
  }, [loaded, buildPortfolioContext]);

  function createMission(params: {
    type: MissionType;
    name: string;
    description: string;
    target: MissionTarget;
    constraints?: MissionConstraint[];
    expiresAt?: number | null;
  }) {
    // Deactivate any currently active mission
    const deactivated = missions.map((m) =>
      m.status === 'active' ? { ...m, status: 'paused' as const, updatedAt: Date.now() } : m,
    );

    // The equity the book ACTUALLY held at this moment, captured once. Every
    // "since the mission began" figure is measured from it.
    //
    // Without this, capital-target progress was `liveEquity - declaredStart` — a
    // typed number subtracted from a real one — so a mission read 100% and flipped
    // to 'completed' the instant it was created. Capturing the observation at
    // creation makes progress 0 at creation by construction, whatever was declared.
    const baselineEquityUsd = buildPortfolioContext().totalEquityUsd;

    const mission: Mission = {
      id: uid(),
      type: params.type,
      name: params.name,
      description: params.description,
      status: 'active',
      createdAt: Date.now(),
      baselineEquityUsd,
      updatedAt: Date.now(),
      expiresAt: params.expiresAt ?? null,
      target: params.target,
      progress: {
        currentPct: 0,
        status: 'on-track',
        lastEvaluatedAt: Date.now(),
        detail: 'Mission just started.',
      },
      constraints: params.constraints ?? getDefaultConstraints(params.type),
      checkpoints: [],
    };

    const next = [...deactivated, mission];
    setMissions(next);

    // Persist all changes
    for (const m of deactivated.filter((dm) => dm.status === 'paused')) {
      fetch(`${API_BASE}/api/missions`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: m.id, status: 'paused' }),
      }).catch(() => {});
    }
    fetch(`${API_BASE}/api/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mission),
    }).catch(() => {});
  }

  function updateMissionStatus(id: string, status: MissionStatus) {
    setMissions((prev) => prev.map((m) => (m.id === id ? { ...m, status, updatedAt: Date.now() } : m)));
    fetch(`${API_BASE}/api/missions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    }).catch(() => {});
  }

  function handleDeleteMission(id: string) {
    setMissions((prev) => prev.filter((m) => m.id !== id));
    fetch(`${API_BASE}/api/missions?id=${id}`, { method: 'DELETE' }).catch(() => {});
  }

  function getMissionAlignment(trade: {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    price: number;
    leverage?: number;
  }): MissionAlignmentResult | null {
    if (!activeMission) return null;
    const ctx = buildPortfolioContext();
    return scoreMissionAlignment(activeMission, trade, ctx);
  }

  const value: MissionPlannerValue = {
    missions,
    activeMission,
    createMission,
    updateMissionStatus,
    deleteMission: handleDeleteMission,
    getMissionAlignment,
  };

  return <MissionPlannerContext.Provider value={value}>{children}</MissionPlannerContext.Provider>;
}
