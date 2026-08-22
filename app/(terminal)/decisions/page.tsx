'use client';

// ---------------------------------------------------------------------
// /decisions — the table plus the Decision Inspector.
//
// Data: `/api/decisions` (Next.js, same origin, reads `.data/decisions.json`) for
// the records, and `/api/graphs/runs` for the trace that fills the Trade Journey.
//
// THE ONE THING THIS PAGE MUST NOT DO
//
// `riskChecks` is `null` on most stored records — the gateway may never have run,
// or the record predates check capture. The reference's inspector always renders
// seven green risk rows because its mock always has them.
//
// `null` renders as "not captured", never as "passed". A green row for a check
// that never ran is the same class of lie as a fabricated price: it asserts the
// agent verified something it did not. `riskCheckSummary()` returns `null` rather
// than `0/0` for exactly this reason.
// ---------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';

import { TradeJourney } from '@/components/viz/TradeJourney';
import { Badge } from '@/components/ui/Badge';
import { Gauge } from '@/components/ui/Gauge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import type { DecisionRecord, GraphRun } from '@/lib/api/graphs';
import { outcomeBadgeState, riskCheckSummary } from '@/lib/api/graphs';
import { useSameOrigin } from '@/lib/api/useSameOrigin';
import { useBackend } from '@/lib/realtime/useRealtime';
import { buildJourney } from '@/lib/viz/journey';

function tsLabel(ts: number): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/** Same-origin fetch for the Next.js route handlers.
 *
 *  Deliberately NOT `backendUrl()`: `/api/decisions` is served by THIS app, not by
 *  FastAPI. Pointing it at the Python host is the exact 404 class
 *  `lib/backendConfig.ts` was created to prevent — `/api/health` and `/api/trades`
 *  are real Next routes that do not exist on the backend. */

export default function DecisionsPage() {
  const decisions = useSameOrigin<{ decisions: DecisionRecord[] }>('/api/decisions', { intervalMs: 20_000 });
  const runs = useBackend<{ runs: GraphRun[] }>(`${BACKEND_PATHS.graphRuns}?limit=50`, {
    intervalMs: 30_000,
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = decisions.data?.decisions ?? [];
    return [...all].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  }, [decisions.data]);

  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const risk = selected ? riskCheckSummary(selected.riskChecks) : null;

  // Best-effort match of a decision to a traced run: same symbol, run started
  // closest to the decision timestamp. Reported as approximate rather than
  // presented as the authoritative link, because there is no run_id on a decision
  // record to join on.
  const matchedRun = useMemo(() => {
    if (!selected || !runs.data?.runs) return null;
    const candidates = runs.data.runs.filter((r) => r.symbol === selected.symbol);
    if (candidates.length === 0) return null;
    const target = selected.ts / 1000;
    return candidates.reduce((best, r) =>
      Math.abs(r.started_at - target) < Math.abs(best.started_at - target) ? r : best,
    );
  }, [selected, runs.data]);

  const journey = useMemo(() => {
    if (!selected) return [];
    return buildJourney({
      symbol: selected.symbol,
      price: selected.requestedPrice,
      strategy: selected.ensembleConsensus ? `${selected.ensembleConsensus} ensemble` : null,
      confidencePct: selected.ensembleConfidencePct,
      risk: risk
        ? { approved: risk.failed.length === 0, passed: risk.passed, total: risk.total }
        : null,
      decision: {
        action: selected.outcome.includes('reject')
          ? 'DO_NOT_TRADE'
          : selected.outcome.includes('executed') && !selected.outcome.includes('not')
            ? 'TRADE'
            : 'WAIT',
        direction: selected.side?.toUpperCase() ?? null,
      },
      execution: {
        submitted: selected.outcome.includes('executed') && !selected.outcome.includes('not'),
        status: selected.outcome,
      },
      // No realised P&L is stored on a decision record, so the outcome step is
      // honestly `unknown` rather than inferred from the approval status.
      outcome: null,
    });
  }, [selected, risk]);

  if (decisions.state === 'unreachable') {
    return (
      <div className="max-w-[820px]">
        <h1 className="text-[17px] font-semibold mb-3">Decisions</h1>
        <NotAvailable
          what="The decision store"
          reason="/api/decisions did not respond. It is a Next.js route reading .data/decisions.json, so this is a local failure rather than a backend one."
        />
      </div>
    );
  }

  const approved = rows.filter((r) => r.outcome.startsWith('approved')).length;
  const rejected = rows.filter((r) => r.outcome.includes('reject')).length;
  const withChecks = rows.filter((r) => riskCheckSummary(r.riskChecks) !== null).length;

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Decisions</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Recorded" value={<Num value={rows.length} digits={0} />} />
        <StatCard label="Approved" value={<Num value={approved} digits={0} />} color="var(--positive)" />
        <StatCard label="Rejected" value={<Num value={rejected} digits={0} />} color="var(--negative)" />
        <StatCard
          label="With risk checks"
          value={<Num value={withChecks} digits={0} />}
          sub={
            withChecks < rows.length
              ? `${rows.length - withChecks} have none captured`
              : undefined
          }
          color={withChecks < rows.length ? 'var(--warning)' : undefined}
        />
      </div>

      <Card>
        <SectionTitle action={<span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>click a row to inspect</span>}>
          Decision log
        </SectionTitle>
        <TermTable
          columns={[
            { key: 'ts', label: 'When' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'side', label: 'Side' },
            { key: 'origin', label: 'Origin' },
            { key: 'conf', label: 'Ensemble', num: true },
            { key: 'debate', label: 'Debate', num: true },
            { key: 'risk', label: 'Risk' },
            { key: 'outcome', label: 'Outcome' },
          ]}
          empty={
            decisions.state === 'loading'
              ? 'Loading decisions…'
              : 'No decisions recorded yet.'
          }
        >
          {rows.map((d) => {
            const rc = riskCheckSummary(d.riskChecks);
            return (
              <tr
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                className="cursor-pointer"
                style={d.id === selectedId ? { background: 'var(--bg-surface-2)' } : undefined}
              >
                <td className="mono text-[11px]">{tsLabel(d.ts)}</td>
                <td className="mono text-[11.5px]">{d.symbol}</td>
                <td>
                  <span
                    className="mono text-[11.5px]"
                    style={{ color: d.side === 'buy' ? 'var(--positive)' : 'var(--negative)' }}
                  >
                    {d.side?.toUpperCase()}
                  </span>
                </td>
                <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {d.originTag}
                </td>
                <td className="num mono">
                  {typeof d.ensembleConfidencePct === 'number' ? `${d.ensembleConfidencePct.toFixed(0)}%` : '—'}
                </td>
                <td className="num mono">
                  {typeof d.debateConfidencePct === 'number' ? `${d.debateConfidencePct.toFixed(0)}%` : '—'}
                </td>
                <td>
                  {/* `null` -> "none captured", NOT a pass. */}
                  {rc === null ? (
                    <Badge state="UNAVAILABLE" label="none captured" />
                  ) : rc.failed.length > 0 ? (
                    <Badge state="FAIL" label={`${rc.passed}/${rc.total}`} />
                  ) : rc.warned.length > 0 ? (
                    <Badge state="WARN" label={`${rc.passed}/${rc.total}`} />
                  ) : (
                    <Badge state="PASS" label={`${rc.passed}/${rc.total}`} />
                  )}
                </td>
                <td>
                  <Badge state={outcomeBadgeState(d.outcome)} label={d.outcome} />
                </td>
              </tr>
            );
          })}
        </TermTable>
      </Card>

      {/* ---- Inspector ---- */}
      {selected ? (
        <Card>
          <SectionTitle
            action={
              <button type="button" className="chip" onClick={() => setSelectedId(null)}>
                Close
              </button>
            }
          >
            Decision Inspector — {selected.symbol} · {tsLabel(selected.ts)}
          </SectionTitle>

          <div className="mb-4">
            <div className="font-mono text-[10.5px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
              Trade Journey
            </div>
            <TradeJourney steps={journey} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* ---- Signal factors ---- */}
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Signal factors
              </div>
              <div className="space-y-2.5">
                <Gauge
                  pct={selected.ensembleConfidencePct}
                  label="Strategy ensemble"
                  value={
                    selected.ensembleConsensus
                      ? `${selected.ensembleConsensus} ${selected.ensembleConfidencePct?.toFixed(0) ?? '—'}%`
                      : undefined
                  }
                  unavailableReason="the ensemble did not report on this decision"
                />
                <Gauge
                  pct={selected.debateConfidencePct}
                  label="Debate panel"
                  color="var(--accent-2)"
                  value={
                    selected.debateRecommendation
                      ? `${selected.debateRecommendation} ${selected.debateConfidencePct?.toFixed(0) ?? '—'}%`
                      : undefined
                  }
                  unavailableReason="no debate verdict was attached to this decision"
                />
              </div>

              {selected.cautionNotes.length > 0 ? (
                <div className="mt-3">
                  <div className="text-[10.5px] uppercase tracking-wider mb-1" style={{ color: 'var(--warning)' }}>
                    Caution notes ({selected.cautionNotes.length})
                  </div>
                  <ul className="space-y-1">
                    {selected.cautionNotes.map((n, i) => (
                      <li key={i} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        • {n}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {selected.conflictNotes.length > 0 ? (
                <div className="mt-3">
                  <div className="text-[10.5px] uppercase tracking-wider mb-1" style={{ color: 'var(--warning)' }}>
                    Conflicts ({selected.conflictNotes.length})
                  </div>
                  <ul className="space-y-1">
                    {selected.conflictNotes.map((n, i) => (
                      <li key={i} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        • {n}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {/* ---- Risk checks ---- */}
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
                Risk checks
              </div>
              {risk === null ? (
                <NotAvailable
                  what="Risk checks"
                  reason={
                    'none were captured on this record. That is NOT the same as all checks ' +
                    'passing — the gateway may never have run for this decision. The nine ' +
                    'checks execute inside a graph run and are only stored when one reached ' +
                    'the gateway.'
                  }
                  compact
                />
              ) : (
                <div className="space-y-1.5">
                  {Object.entries(selected.riskChecks ?? {}).map(([name, v]) => {
                    const status = String(v?.status ?? (v?.ok ? 'pass' : 'fail')).toLowerCase();
                    const state =
                      status === 'pass'
                        ? 'PASS'
                        : status === 'warn'
                          ? 'WARN'
                          : status === 'unavailable' || status === 'delegated'
                            ? 'UNAVAILABLE'
                            : 'FAIL';
                    return (
                      <div key={name} className="flex items-start justify-between gap-2 text-[11.5px]">
                        <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                          {name}
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          {v?.detail ? (
                            <span className="text-[10.5px] text-right max-w-[240px]" style={{ color: 'var(--text-muted)' }}>
                              {v.detail}
                            </span>
                          ) : null}
                          <Badge state={state} />
                        </span>
                      </div>
                    );
                  })}
                  <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                    A check reporting <span className="mono">unavailable</span> did not pass — it
                    could not run. It is counted as neither.
                  </div>
                </div>
              )}

              {selected.rejectionReasons.length > 0 ? (
                <div className="mt-3">
                  <div className="text-[10.5px] uppercase tracking-wider mb-1" style={{ color: 'var(--negative)' }}>
                    Rejection reasons
                  </div>
                  <ul className="space-y-1">
                    {selected.rejectionReasons.map((n, i) => (
                      <li key={i} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--negative)' }}>
                        • {n}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>

          {selected.rationale ? (
            <div className="mt-4 pt-3 border-t hairline">
              <div className="font-mono text-[10.5px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
                Rationale
              </div>
              <div className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                {selected.rationale}
              </div>
            </div>
          ) : null}

          {matchedRun ? (
            <div className="mt-3 text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Closest traced run: <span className="mono">{matchedRun.run_id.slice(0, 8)}</span> (
              {matchedRun.graph}, {matchedRun.nodes.length} nodes). Matched by symbol and nearest
              timestamp — a decision record carries no run id, so this link is approximate and is
              not used to fill the journey above.
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
