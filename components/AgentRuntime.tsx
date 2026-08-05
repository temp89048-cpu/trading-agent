'use client';

// =====================================================================
// Agent Runtime — Phase 21
//
// React context provider that wraps the AgentOS singleton. Initializes
// the runtime, registers all agents from agentDescriptors, starts the
// scheduler, and exposes the runtime state to child components via
// useSyncExternalStore for efficient re-renders.
// =====================================================================

import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AgentOS, getAgentOS, type AgentId, type AgentHealthRecord, type AgentDescriptor, type AgentLifecycleState } from '@/lib/agentOS';
import { AGENT_DESCRIPTORS } from '@/lib/agentDescriptors';

type AgentRuntimeSnapshot = {
  agents: {
    descriptor: AgentDescriptor;
    health: AgentHealthRecord;
  }[];
  schedulerRunning: boolean;
};

type AgentRuntimeValue = {
  snapshot: AgentRuntimeSnapshot;
  pauseAgent: (id: AgentId) => boolean;
  resumeAgent: (id: AgentId) => boolean;
  restartAgent: (id: AgentId) => boolean;
  stopAgent: (id: AgentId) => boolean;
  getHealth: (id: AgentId) => AgentHealthRecord | undefined;
  getStatus: (id: AgentId) => AgentLifecycleState | undefined;
  isStale: (id: AgentId) => boolean;
  getAvgTickDuration: (id: AgentId) => number | null;
  os: AgentOS;
};

const AgentRuntimeContext = createContext<AgentRuntimeValue | null>(null);

export function useAgentRuntime(): AgentRuntimeValue {
  const ctx = useContext(AgentRuntimeContext);
  if (!ctx) throw new Error('useAgentRuntime must be used within AgentRuntimeProvider');
  return ctx;
}

// Build a plain-data snapshot from the OS for React consumption.
function buildSnapshot(os: AgentOS): AgentRuntimeSnapshot {
  const all = os.getAllAgents();
  return {
    agents: all.map((a) => ({ descriptor: a.descriptor, health: { ...a.health } })),
    schedulerRunning: os.isSchedulerRunning(),
  };
}

// Empty snapshot for SSR — must be referentially stable.
const EMPTY_SNAPSHOT: AgentRuntimeSnapshot = { agents: [], schedulerRunning: false };

export function AgentRuntimeProvider({ children }: { children: React.ReactNode }) {
  const os = useMemo(() => getAgentOS(), []);

  // ---- Cached snapshot for useSyncExternalStore ---------------------
  // useSyncExternalStore requires getSnapshot to return the SAME object
  // (by reference) if nothing changed. buildSnapshot() creates a new
  // object every call, so we cache it in a ref and only rebuild when
  // the OS fires notify() through our subscribe callback.
  const snapshotRef = useRef<AgentRuntimeSnapshot>(EMPTY_SNAPSHOT);

  // Rebuild the cached snapshot. Called once initially and then every
  // time the OS notifies us of a state change.
  const refreshSnapshot = useMemo(() => {
    return () => {
      snapshotRef.current = buildSnapshot(os);
    };
  }, [os]);

  // Subscribe function for useSyncExternalStore — on each notify(),
  // rebuild the cached snapshot THEN call the React onStoreChange
  // callback so React re-reads from getSnapshot.
  const subscribe = useMemo(() => {
    return (onStoreChange: () => void) => {
      return os.subscribe(() => {
        refreshSnapshot();
        onStoreChange();
      });
    };
  }, [os, refreshSnapshot]);

  // getSnapshot returns the cached ref — same object until refreshed.
  const getSnapshot = useMemo(() => {
    return () => snapshotRef.current;
  }, []);

  // Build the initial snapshot synchronously before the first render.
  if (snapshotRef.current === EMPTY_SNAPSHOT) {
    // Safe: this runs once during the first render pass, before any
    // effects. On the server (SSR), getAllAgents() returns [] anyway.
    try {
      snapshotRef.current = buildSnapshot(os);
    } catch {
      // OS not ready yet — keep EMPTY_SNAPSHOT
    }
  }

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_SNAPSHOT);

  // Register all agents on mount
  useEffect(() => {
    for (const descriptor of AGENT_DESCRIPTORS) {
      os.register(descriptor, null); // monitoring-only — existing providers handle actual execution
    }

    // Start the scheduler (handles lifecycle transitions + health monitoring)
    os.startScheduler(1000);

    // Rebuild snapshot after registration so the UI reflects all agents
    refreshSnapshot();

    return () => {
      os.stopScheduler();
    };
  }, [os, refreshSnapshot]);

  const value = useMemo<AgentRuntimeValue>(
    () => ({
      snapshot,
      pauseAgent: (id) => os.pauseAgent(id),
      resumeAgent: (id) => os.resumeAgent(id),
      restartAgent: (id) => os.restartAgent(id),
      stopAgent: (id) => os.stopAgent(id),
      getHealth: (id) => os.getHealth(id),
      getStatus: (id) => os.getStatus(id),
      isStale: (id) => os.isStale(id),
      getAvgTickDuration: (id) => os.getAvgTickDuration(id),
      os,
    }),
    [snapshot, os],
  );

  return <AgentRuntimeContext.Provider value={value}>{children}</AgentRuntimeContext.Provider>;
}
