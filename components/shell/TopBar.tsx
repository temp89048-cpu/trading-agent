'use client';

// ---------------------------------------------------------------------
// The global status bar. Every item is a REAL reading or explicitly absent.
//
// THE FIELD NAMES HERE WERE WRONG AND THAT IS WORTH RECORDING.
//
// The first version read `is_paused`, `emergency_stop` and `live_trading` from
// `/api/admin/status`, on the assumption it matched the Python attribute names.
// It does not. The live response is:
//
//   /api/admin/status      isPaused, emergencyStop, exitsAllowed, auth
//   /api/exchange/status   liveTradingEnabled, useTestnet, credentialsConfigured
//   /api/dashboard         portfolio.{paper,real}, system.{...}, wsClients
//
// So `paused` was always `undefined` (falsy — the bar showed ACTIVE while paused)
// and the mode badge fell to "MODE UNKNOWN" permanently. Both read as plausible.
// This is the same class of bug the backend hit with `system_state.snapshot()`
// earlier in the project: guessed camelCase against real snake_case, `.get()`
// returning `None`, and a specialist reporting "no governance block active" while
// the system was paused.
//
// Fixed by reading the live responses instead of guessing. There is now a test
// asserting the field names against the running backend's OpenAPI-documented
// shape (`lib/topbar.test.ts`).
//
// TODAY'S P&L IS NOT SHOWN, because the backend does not compute it. `/api/dashboard`
// returns cash and a positions array — no daily mark. Deriving it here would mean
// picking a session boundary and a mark price, which is a real calculation this
// component has no business inventing.
// ---------------------------------------------------------------------

import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Num } from '@/components/ui/primitives';
import { ThemeToggle } from '@/components/ui/Theme';
import { BACKEND_PATHS, backendUrl } from '@/lib/backendConfig';
import { useBackend, useRealtimeConnected, useStreamAge } from '@/lib/realtime/useRealtime';

import { EmergencyStopModal } from './EmergencyStopModal';

type AdminStatus = {
  status?: string;
  isPaused?: boolean;
  emergencyStop?: boolean;
  /** Closes are never blocked, so this is expected to stay true even when
   *  emergency-stopped. Surfaced because an operator staring at a kill switch
   *  needs to know exits still work. */
  exitsAllowed?: boolean;
  auth?: { writeAuthEnabled?: boolean; note?: string };
};

type ExchangeStatus = {
  liveTradingEnabled?: boolean;
  useTestnet?: boolean;
  credentialsConfigured?: boolean;
  ordersRoutedTo?: string;
};

type Position = { symbol?: string; qty?: number; avgCost?: number };
type PortfolioResponse = {
  paper?: { cash?: number; positions?: Position[] };
  real?: { cash?: number; positions?: Position[] };
};

function Item({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex flex-col justify-center leading-tight shrink-0" title={title}>
      <span className="text-[9.5px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {label}
      </span>
      <span className="text-[12px]">{children}</span>
    </div>
  );
}

export function TopBar({ onAskAgent }: { onAskAgent: () => void }) {
  const [estopOpen, setEstopOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const admin = useBackend<AdminStatus>(BACKEND_PATHS.adminStatus, { intervalMs: 10_000 });
  const exchange = useBackend<ExchangeStatus>('/api/exchange/status', { intervalMs: 30_000 });
  const portfolio = useBackend<PortfolioResponse>(`${BACKEND_PATHS.dashboard}/portfolio`, {
    intervalMs: 15_000,
  });

  const wsConnected = useRealtimeConnected();
  const streamAge = useStreamAge();

  const paused = admin.data?.isPaused === true;
  const stopped = admin.data?.emergencyStop === true;
  const exitsAllowed = admin.data?.exitsAllowed;

  const agentState = stopped
    ? 'CRITICAL'
    : paused
      ? 'PAUSED'
      : admin.state === 'ok'
        ? 'ACTIVE'
        : 'UNAVAILABLE';

  // Read, never inferred. An absent field renders UNKNOWN rather than defaulting
  // to PAPER — showing PAPER while the system is live would be the most dangerous
  // pixel in the app.
  const live = exchange.data?.liveTradingEnabled;
  const modeLabel = live === true ? 'REAL MONEY' : live === false ? 'PAPER' : 'MODE UNKNOWN';
  const modeState = live === true ? 'CRITICAL' : live === false ? 'INFO' : 'WARN';

  // The tab that matters is the one orders route to.
  const book = live === true ? portfolio.data?.real : portfolio.data?.paper;
  const cash = typeof book?.cash === 'number' ? book.cash : null;
  const positions = book?.positions ?? [];
  const posCount = portfolio.state === 'ok' ? positions.length : null;

  async function togglePause() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch(backendUrl(paused ? BACKEND_PATHS.resume : BACKEND_PATHS.pause), { method: 'POST' });
      await admin.reload();
    } catch {
      // The reload reflects reality either way; without the catch a thrown fetch
      // would leave the button stuck busy.
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header
        className="h-12 shrink-0 border-b hairline flex items-center gap-5 px-4 overflow-x-auto"
        style={{ background: 'var(--bg-surface)' }}
      >
        <Item label="Agent">
          <Badge state={agentState} />
        </Item>

        <Item
          label="Mode"
          title={exchange.data?.ordersRoutedTo ? `Orders routed to: ${exchange.data.ordersRoutedTo}` : undefined}
        >
          <Badge state={modeState} label={modeLabel} />
        </Item>

        {/* Only rendered when emergency-stopped — the one moment an operator needs
            to know that closing a position still works. CLAUDE.md invariant 4. */}
        {stopped && exitsAllowed ? (
          <Item label="Exits" title="Closes are never blocked, not even by an emergency stop">
            <Badge state="PASS" label="Allowed" />
          </Item>
        ) : null}

        <Item label="Exchange">
          {exchange.state === 'unreachable' ? (
            <Badge state="UNAVAILABLE" label="No backend" />
          ) : (
            <Badge
              state={exchange.data?.credentialsConfigured ? 'HEALTHY' : 'WARN'}
              label={exchange.data?.credentialsConfigured ? 'Connected' : 'No keys'}
            />
          )}
        </Item>

        <Item label="Stream">
          <span className="flex items-center gap-1.5">
            <Badge state={wsConnected ? 'HEALTHY' : 'DOWN'} label={wsConnected ? 'Live' : 'Offline'} />
            {wsConnected && streamAge !== null ? (
              <span className="mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
                {streamAge}s
              </span>
            ) : null}
          </span>
        </Item>

        <div className="w-px h-6 shrink-0" style={{ background: 'var(--border)' }} />

        <Item label={live === true ? 'Cash (real)' : 'Cash (paper)'}>
          <Num value={cash} prefix="$" />
        </Item>
        <Item label="Positions">
          <Num value={posCount} digits={0} />
        </Item>

        <div className="flex-1" />

        <div className="flex items-center gap-2 shrink-0">
          <ThemeToggle />
          <button
            type="button"
            className="chip"
            onClick={togglePause}
            disabled={busy || admin.state !== 'ok'}
          >
            {busy ? '…' : paused ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => setEstopOpen(true)}
            style={{ borderColor: 'var(--negative)', color: 'var(--negative)' }}
          >
            Emergency Stop
          </button>
          <button type="button" className="chip btn-accent" onClick={onAskAgent}>
            Ask Agent
          </button>
        </div>
      </header>

      <EmergencyStopModal
        open={estopOpen}
        onClose={() => setEstopOpen(false)}
        onStopped={() => void admin.reload()}
      />
    </>
  );
}
