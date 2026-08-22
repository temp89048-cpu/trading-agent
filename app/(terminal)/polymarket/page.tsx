'use client';

// ---------------------------------------------------------------------
// /polymarket — the prediction-market grid.
//
// FOUR THINGS THE REFERENCE SHOWS THAT THE BACKEND DOES NOT STORE, each omitted
// rather than invented: per-question volume, liquidity, 24h change, and an "Agent
// Relevance" score. The first three are on the ccxt payload but are not persisted
// in the snapshot store; the fourth does not exist at all — the backend computes
// `directional.confidence` and `eventRisk.concern`, which mean different things and
// are shown under their own names.
//
// The three gates that must all pass before this page shows anything are rendered
// as a checklist, because "no markets" has three distinct causes and the operator's
// next action differs for each.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useMemo } from 'react';

import { PolymarketCard, type PolymarketCardData } from '@/components/cards/PolymarketCard';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useBackend } from '@/lib/realtime/useRealtime';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const PolymarketOperator = dynamic(
  () => import('@/components/operator/PolymarketOperator').then((m) => ({ default: m.PolymarketOperator })),
  { ssr: false },
);

type Status = {
  enabled: boolean; adapterAvailable: boolean; adapterBlocker: string | null;
  mappingsDiscovered: number; mappingsConfirmed: number;
  confirmedDirectional: number; confirmedEventRisk: number;
  role: string; notApplicableMeaning: string; gateMeaning: string;
  series?: { trackedOutcomes?: number; totalPoints?: number };
};
type Mapping = {
  symbol: string; outcome: string; market: string | null; role: string;
  confirmed: boolean; directionalBasis: string | null; title: string | null;
  classificationReason: string; endTs: number | null;
};
type Snapshot = {
  symbol: string; applicable: boolean; fresh: boolean; ageSeconds: number | null;
  reason?: string; reasonNotApplicable?: string | null;
  directional?: Record<string, unknown> | null; eventRisk?: Record<string, unknown> | null;
};

export default function PolymarketPage() {
  const status = useBackend<Status>(BACKEND_PATHS.polymarket, { intervalMs: 30_000 });
  const mappings = useBackend<{ mappings: Mapping[]; count: number; confirmationMeaning: string }>(
    BACKEND_PATHS.polymarketMappings, { intervalMs: 30_000 },
  );
  const snapshots = useBackend<{ snapshots: Snapshot[]; maxAgeSeconds: number; stalenessMeaning: string; applicableMeaning: string }>(
    BACKEND_PATHS.polymarketSnapshots, { intervalMs: 30_000 },
  );
  const signals = useBackend<{ signals: string[]; total: number; unimplemented: Record<string, string>; refusedPath: string }>(
    BACKEND_PATHS.polymarketSignals, { intervalMs: 300_000 },
  );

  const s = status.data;
  const gates = [
    { ok: s?.enabled === true, label: 'POLYMARKET_ENABLED', detail: s?.enabled ? 'on' : 'off — no poller, no specialists' },
    { ok: s?.adapterAvailable === true, label: 'ccxt adapter', detail: s?.adapterAvailable ? 'available' : (s?.adapterBlocker ?? 'unavailable') },
    {
      ok: (s?.mappingsConfirmed ?? 0) > 0,
      label: 'human-confirmed mapping',
      detail: (s?.mappingsConfirmed ?? 0) > 0
        ? `${s?.confirmedDirectional} directional, ${s?.confirmedEventRisk} event-risk`
        : `${s?.mappingsDiscovered ?? 0} discovered, 0 confirmed`,
    },
  ];

  const cards: PolymarketCardData[] = useMemo(() => {
    const out: PolymarketCardData[] = [];
    for (const snap of snapshots.data?.snapshots ?? []) {
      if (snap.directional) {
        out.push({
          question: String(snap.directional.event ?? `${snap.symbol} price range`),
          category: snap.symbol, yes: null, role: 'directional',
          confidence: typeof snap.directional.confidence === 'number' ? snap.directional.confidence : null,
          confirmed: true,
          observation: typeof snap.directional.observation === 'string' ? snap.directional.observation : null,
        });
      }
      if (snap.eventRisk) {
        out.push({
          question: String(snap.eventRisk.title ?? snap.eventRisk.key ?? 'Event risk'),
          category: String(snap.eventRisk.key ?? 'Event'),
          yes: typeof snap.eventRisk.probability === 'number' ? snap.eventRisk.probability : null,
          role: 'event_risk',
          concern: typeof snap.eventRisk.concern === 'number' ? snap.eventRisk.concern : null,
          confirmed: true,
          observation: typeof snap.eventRisk.observation === 'string' ? snap.eventRisk.observation : null,
        });
      }
    }
    return out;
  }, [snapshots.data]);

  if (status.state === 'unreachable') {
    return (
      <div className="max-w-[820px]">
        <h1 className="text-[17px] font-semibold mb-3">Polymarket Signals</h1>
        <NotAvailable what="The Polymarket API" reason="the backend did not respond." />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Polymarket Signals</h1>

      <Card>
        <SectionTitle>Three gates must all pass</SectionTitle>
        <div className="space-y-1.5">
          {gates.map((g) => (
            <div key={g.label} className="flex items-start gap-2 text-[11.5px]">
              <span className="font-mono mt-px" style={{ color: g.ok ? 'var(--positive)' : 'var(--text-muted)' }} aria-hidden>
                {g.ok ? '●' : '○'}
              </span>
              <span>
                <span className="font-mono text-[10.5px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{g.label}</span>
                <span style={{ color: 'var(--text-secondary)' }}> — {g.detail}</span>
              </span>
            </div>
          ))}
        </div>
        {s?.role ? (
          <div className="text-[10.5px] mt-2.5 leading-relaxed border-l pl-2" style={{ color: 'var(--text-muted)', borderColor: 'var(--border)' }}>
            {s.role}
          </div>
        ) : null}
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Discovered" value={<Num value={s?.mappingsDiscovered ?? null} digits={0} />} />
        <StatCard label="Confirmed" value={<Num value={s?.mappingsConfirmed ?? null} digits={0} />} color={(s?.mappingsConfirmed ?? 0) > 0 ? 'var(--positive)' : 'var(--warning)'} />
        <StatCard label="Tracked outcomes" value={<Num value={s?.series?.trackedOutcomes ?? null} digits={0} />} />
        <StatCard label="Signals defined" value={<Num value={signals.data?.total ?? null} digits={0} />} sub={signals.data ? `${Object.keys(signals.data.unimplemented).length} unimplemented` : undefined} />
      </div>

      <Card>
        <SectionTitle>Readings</SectionTitle>
        {cards.length === 0 ? (
          <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            No reading available. {s?.notApplicableMeaning}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {cards.map((c, i) => <PolymarketCard key={i} data={c} />)}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Snapshots per symbol</SectionTitle>
        <TermTable
          columns={[
            { key: 's', label: 'Symbol' }, { key: 'a', label: 'Applicable' },
            { key: 'f', label: 'Fresh' }, { key: 'g', label: 'Age', num: true }, { key: 'r', label: 'Reason' },
          ]}
          empty="No snapshots written."
        >
          {(snapshots.data?.snapshots ?? []).map((snap) => (
            <tr key={snap.symbol}>
              <td className="mono text-[11.5px]">{snap.symbol}</td>
              <td><Badge state={snap.applicable ? 'PASS' : 'UNAVAILABLE'} label={snap.applicable ? 'Yes' : 'Not applicable'} /></td>
              <td><Badge state={snap.fresh ? 'HEALTHY' : 'WARN'} label={snap.fresh ? 'Fresh' : 'Stale'} /></td>
              <td className="num mono">{snap.ageSeconds === null || snap.ageSeconds === undefined ? '—' : `${Math.round(snap.ageSeconds)}s`}</td>
              <td className="text-[11px] whitespace-normal max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                {snap.reasonNotApplicable ?? snap.reason ?? '—'}
              </td>
            </tr>
          ))}
        </TermTable>
        {snapshots.data?.applicableMeaning ? (
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{snapshots.data.applicableMeaning}</div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Mappings</SectionTitle>
        <TermTable
          columns={[
            { key: 'sy', label: 'Symbol' }, { key: 'o', label: 'Outcome' }, { key: 'r', label: 'Role' },
            { key: 'b', label: 'Basis' }, { key: 'c', label: 'Confirmed' },
          ]}
          empty="No mappings discovered. Discovery needs POLYMARKET_ENABLED and network access to Polymarket."
        >
          {(mappings.data?.mappings ?? []).map((m, i) => (
            <tr key={`${m.symbol}-${m.outcome}-${i}`}>
              <td className="mono text-[11.5px]">{m.symbol}</td>
              <td className="mono text-[11px]">{m.outcome}</td>
              <td className="text-[11px]">{m.role}</td>
              <td className="mono text-[10.5px]" style={{ color: 'var(--text-secondary)' }}>{m.directionalBasis ?? '—'}</td>
              <td><Badge state={m.confirmed ? 'CONFIRMED' : 'WARN'} label={m.confirmed ? 'Yes' : 'Pending'} /></td>
            </tr>
          ))}
        </TermTable>
        {mappings.data?.confirmationMeaning ? (
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{mappings.data.confirmationMeaning}</div>
        ) : null}
      </Card>

      <NotAvailable
        what="Per-question volume, liquidity, 24h change and an 'Agent Relevance' score"
        reason={
          'the first three are on the ccxt payload but are not persisted in the snapshot store, ' +
          'so there is nothing to read. The fourth does not exist at all — the backend computes ' +
          'directional confidence and event-risk concern, which mean different things and are ' +
          'shown above under their own names. Calling either one "relevance" would be a false label.'
        }
      />
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <PolymarketOperator />
    </div>
  );
}
