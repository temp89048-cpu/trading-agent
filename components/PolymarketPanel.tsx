'use client';

// ---------------------------------------------------------------------
// Polymarket prediction-market feed — Phase 37.
//
// THIS IS THE FIRST COMPONENT THAT ACTUALLY CONSUMES `lib/backendConfig.ts`.
//
// That file was created because six components had localhost hardcoded and
// several pointed at paths FastAPI does not serve, and
// `tests/test_stack_integration.py` asserts that every path it declares is
// really mounted. But nothing imported `BACKEND_PATHS` — only
// `agentEventsWsUrl`, via `lib/agentEventStream.ts`.
//
// So the LangGraph endpoints added in the earlier integration work were
// reachable in principle and read by nobody: the audit finding was "layer 4 has
// no API surface", the API was built, and the last hop — a component fetching it
// — was never made. Declaring another five paths and no consumer would repeat
// exactly that.
//
// WHAT THIS PANEL IS FOR
//
// One question: **is this feed contributing anything, and if not, why not?**
// Three independent things must all hold before a single number reaches the
// reasoning panel — the POLYMARKET_ENABLED flag, a usable ccxt adapter, and at
// least one human-confirmed market mapping — and the most likely state for a
// while is that one of them is missing. So the negative answer is rendered in
// full rather than as an empty panel.
//
// IT SHOWS STALENESS AND INAPPLICABILITY EXPLICITLY
//
// A stale snapshot is labelled stale, not rendered as a current probability. A
// symbol with no mapped market is labelled "not applicable — costs this symbol
// nothing", because that is materially different from a failed read, which does
// reduce the panel's confidence. An operator looking at a low confidence number
// needs to be able to tell those two apart.
// ---------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';
import { BACKEND_PATHS, backendUrl } from '@/lib/backendConfig';

type Status = {
  enabled: boolean;
  adapterAvailable: boolean;
  adapterBlocker: string | null;
  mappingsDiscovered: number;
  mappingsConfirmed: number;
  confirmedDirectional: number;
  confirmedEventRisk: number;
  role: string;
  notApplicableMeaning: string;
  gateMeaning: string;
};

type Snapshot = {
  symbol: string;
  present: boolean;
  fresh: boolean;
  reason?: string;
  applicable?: boolean;
  reasonNotApplicable?: string | null;
  ageSeconds?: number | null;
  directional?: {
    direction: string;
    confidence: number;
    driftPct: number;
    observation: string;
  } | null;
  eventRisk?: { concern: number; key: string; observation: string } | null;
};

type LoadState = 'loading' | 'ok' | 'unreachable';

export function PolymarketPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [state, setState] = useState<LoadState>('loading');

  const load = useCallback(async () => {
    try {
      const [s, snap] = await Promise.all([
        fetch(backendUrl(BACKEND_PATHS.polymarket)),
        fetch(backendUrl(BACKEND_PATHS.polymarketSnapshots)),
      ]);
      if (!s.ok || !snap.ok) {
        setState('unreachable');
        return;
      }
      setStatus(await s.json());
      setSnapshots((await snap.json()).snapshots ?? []);
      setState('ok');
    } catch {
      // The FastAPI backend is a separate process. Not running it is the normal
      // state for someone using only the Next.js half of this app, so this is a
      // plain explanation rather than an error.
      setState('unreachable');
    }
  }, []);

  useEffect(() => {
    load();
    // The poller writes every 5 minutes; refreshing faster would show the same
    // snapshot repeatedly. 60s is frequent enough to notice a stopped poller.
    const iv = setInterval(load, 60 * 1000);
    return () => clearInterval(iv);
  }, [load]);

  if (state === 'loading') {
    return <p className="text-[11px] text-txt2">Checking the prediction-market feed…</p>;
  }

  if (state === 'unreachable') {
    return (
      <p className="text-[11px] text-txt2">
        The Python backend isn&apos;t reachable, so there&apos;s nothing to report. This panel reads{' '}
        <code className="font-mono">{BACKEND_PATHS.polymarket}</code> on the FastAPI process — the
        prediction-market poller runs there and has no <code className="font-mono">.data/</code> mirror
        for the Next.js side to read.
      </p>
    );
  }

  if (!status) return null;

  // The three gates, in the order they have to pass. Rendered as a checklist
  // because "not contributing" has three distinct causes and an operator's next
  // action is different for each.
  const gates = [
    {
      ok: status.enabled,
      label: 'POLYMARKET_ENABLED',
      detail: status.enabled
        ? 'on — the two supplementary specialists are registered'
        : 'off — no poller, no specialists, and every confidence number is unchanged',
    },
    {
      ok: status.adapterAvailable,
      label: 'ccxt adapter',
      detail: status.adapterAvailable
        ? 'available'
        : status.adapterBlocker ?? 'unavailable',
    },
    {
      ok: status.mappingsConfirmed > 0,
      label: 'human-confirmed mapping',
      detail:
        status.mappingsConfirmed > 0
          ? `${status.confirmedDirectional} directional, ${status.confirmedEventRisk} event-risk`
          : `${status.mappingsDiscovered} discovered, 0 confirmed — a person has to confirm that a market is really about an instrument before it can feed the panel`,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {gates.map((g) => (
          <div key={g.label} className="flex items-start gap-2 text-[11px]">
            <span
              className={`font-mono mt-px ${g.ok ? 'text-green' : 'text-txt2'}`}
              aria-hidden
            >
              {g.ok ? '●' : '○'}
            </span>
            <span>
              <span className="font-mono text-[10.5px] uppercase tracking-wide text-txt2">
                {g.label}
              </span>
              <span className="text-txt2"> — {g.detail}</span>
            </span>
          </div>
        ))}
      </div>

      <p className="text-[10.5px] leading-relaxed text-txt2 border-l border-line pl-2">
        {status.role}
      </p>

      {snapshots.length > 0 && (
        <div className="space-y-2">
          {snapshots.map((s) => (
            <SnapshotRow key={s.symbol} snapshot={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SnapshotRow({ snapshot }: { snapshot: Snapshot }) {
  const { symbol } = snapshot;

  // Order matters, and each branch says something different about what it costs
  // the panel. Presenting them as one "no data" state would erase the only
  // distinction an operator acts on.
  let body: React.ReactNode;

  if (!snapshot.present) {
    body = <span className="text-txt2">{snapshot.reason}</span>;
  } else if (snapshot.applicable === false) {
    body = (
      <span className="text-txt2">
        not applicable — no market resolves to this symbol, and its weight leaves the coverage
        denominator entirely, so this costs {symbol} nothing
      </span>
    );
  } else if (!snapshot.fresh) {
    const age = snapshot.ageSeconds == null ? null : Math.round(snapshot.ageSeconds / 60);
    body = (
      <span className="text-amber">
        STALE{age == null ? '' : ` (${age}m old)`} — not read by the specialists. The poller has
        stopped or is failing.
      </span>
    );
  } else if (!snapshot.directional) {
    body = (
      <span className="text-txt2">
        a market is mapped but the signal is uncomputable — this DOES count against panel coverage
      </span>
    );
  } else {
    const d = snapshot.directional;
    body = (
      <span>
        <span
          className={
            d.direction === 'LONG'
              ? 'text-green'
              : d.direction === 'SHORT'
                ? 'text-red'
                : 'text-txt2'
          }
        >
          {d.direction}
        </span>{' '}
        <span className="text-txt2">
          at {d.confidence.toFixed(2)} — {d.observation}
        </span>
      </span>
    );
  }

  return (
    <div className="text-[11px]">
      <div className="font-mono text-[10.5px] text-txt2">{symbol}</div>
      <div className="mt-0.5 leading-relaxed">{body}</div>
      {snapshot.eventRisk && (
        <div className="mt-0.5 text-[10.5px] text-amber">
          event risk {snapshot.eventRisk.concern.toFixed(2)} ({snapshot.eventRisk.key}) —{' '}
          {snapshot.eventRisk.observation}
        </div>
      )}
    </div>
  );
}
