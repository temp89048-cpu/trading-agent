'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { loadLS, saveLS, uid, LS_KEYS } from '@/lib/storage';
import type { McpServer } from '@/lib/types';

type StatusEntry = { checking: boolean; reachable: boolean | null; status?: number; latencyMs?: number; error?: string };

const MCP_HEALTH_RECHECK_MS = 60_000;

type McpValue = {
  servers: McpServer[];
  addServer: (name: string, url: string) => void;
  removeServer: (id: string) => void;
  restoreServers: (list: McpServer[]) => void;
  statusById: Record<string, StatusEntry>;
  checkServer: (id: string) => Promise<void>;
};

const McpContext = createContext<McpValue | null>(null);

export function useMcp(): McpValue {
  const ctx = useContext(McpContext);
  if (!ctx) throw new Error('useMcp must be used within McpProvider');
  return ctx;
}

export function McpProvider({ children }: { children: React.ReactNode }) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [statusById, setStatusById] = useState<Record<string, StatusEntry>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setServers(loadLS<McpServer[]>(LS_KEYS.mcp, []));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveLS(LS_KEYS.mcp, servers);
  }, [servers, hydrated]);

  function addServer(name: string, url: string) {
    if (!name.trim() || !url.trim()) return;
    setServers((prev) => [...prev, { id: uid(), name: name.trim(), url: url.trim() }]);
  }

  function removeServer(id: string) {
    setServers((prev) => prev.filter((s) => s.id !== id));
    setStatusById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function restoreServers(list: McpServer[]) {
    setServers(list);
  }

  async function checkServer(id: string) {
    const server = servers.find((s) => s.id === id);
    if (!server) return;
    setStatusById((prev) => ({ ...prev, [id]: { ...prev[id], checking: true, reachable: prev[id]?.reachable ?? null } }));
    try {
      const res = await fetch('/api/mcp-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: server.url }),
      });
      const json = await res.json();
      setStatusById((prev) => ({
        ...prev,
        [id]: { checking: false, reachable: !!json.reachable, status: json.status, latencyMs: json.latencyMs, error: json.error },
      }));
    } catch (err) {
      setStatusById((prev) => ({
        ...prev,
        [id]: { checking: false, reachable: false, error: err instanceof Error ? err.message : 'check failed' },
      }));
    }
  }

  // Reachability was previously only ever refreshed by a manual click in
  // the MCP Manager modal — a server that went down (or came back up)
  // between visits to that modal would show stale status indefinitely.
  // Auto-recheck every server on a slow cadence so SystemHealthPanel
  // (and anything else reading statusById) reflects current reality
  // without requiring the user to have that modal open.
  const serversRef = useRef(servers);
  serversRef.current = servers;
  useEffect(() => {
    if (!hydrated || serversRef.current.length === 0) return;
    const iv = setInterval(() => {
      for (const server of serversRef.current) checkServer(server.id);
    }, MCP_HEALTH_RECHECK_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, servers.length]);

  const value: McpValue = { servers, addServer, removeServer, restoreServers, statusById, checkServer };
  return <McpContext.Provider value={value}>{children}</McpContext.Provider>;
}
