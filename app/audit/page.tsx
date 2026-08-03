'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import type { DecisionRecord, DecisionOutcome } from '@/lib/types';

// Complete Audit Trail (Production Readiness Review #9) — every
// Supervisor decision this app has made, approved/rejected/pending, not
// just the ones that became a logged trade. Backed by
// app/api/decisions/route.ts + lib/decisionStore.server.ts.

type FilterOutcome = 'all' | DecisionOutcome;

const OUTCOME_LABEL: Record<DecisionOutcome, string> = {
  'approved-executed': 'Executed',
  'approved-not-executed': 'Approved (not executed)',
  rejected: 'Rejected',
  'pending-approval': 'Pending approval',
  'manually-approved': 'Manually approved',
  'manually-rejected': 'Manually rejected',
};

const OUTCOME_COLOR: Record<DecisionOutcome, string> = {
  'approved-executed': 'text-green',
  'approved-not-executed': 'text-txt2',
  rejected: 'text-red',
  'pending-approval': 'text-amber',
  'manually-approved': 'text-green',
  'manually-rejected': 'text-red',
};

export default function AuditPage() {
  const router = useRouter();
  const [decisions, setDecisions] = useState<DecisionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterOutcome>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/decisions')
      .then((res) => res.json())
      .then((json) => {
        if (Array.isArray(json.decisions)) setDecisions(json.decisions);
        else setError('Unexpected response from /api/decisions');
      })
      .catch(() => setError('Could not reach the audit trail server — see lib/decisionStore.server.ts (file-backed, requires a normal filesystem).'))
      .finally(() => setLoading(false));
  }, []);

  const rows = filter === 'all' ? decisions : decisions.filter((d) => d.outcome === filter);

  return (
    <div className="min-h-screen bg-bg0 text-txt0">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-line bg-bg1 sticky top-0 z-10">
        <button onClick={() => router.push('/')} className="p-1.5 rounded-md hover:bg-bg3 transition text-txt1" title="Back to terminal">
          <Icon name="x" size={18} />
        </button>
        <span className="font-mono text-sm font-semibold">Audit Trail</span>
        <div className="flex-1" />
        <div className="flex flex-wrap gap-1 text-[10.5px] font-mono">
          {(['all', 'approved-executed', 'rejected', 'pending-approval', 'manually-approved', 'manually-rejected'] as FilterOutcome[]).map((f) => (
            <button key={f} onClick={() => setFilter(f)} className={`tabbtn ${filter === f ? 'bg-bg3 text-amber' : 'text-txt2'}`}>
              {f === 'all' ? 'ALL' : OUTCOME_LABEL[f].toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6">
        <p className="text-[10.5px] text-txt2 mb-4">
          Every Supervisor decision — approved, rejected, or queued for manual approval — not just the ones that became a logged
          trade. A rejection used to only flash as a transient event and vanish on reload; this is the persistent record.
        </p>
        {loading && <p className="text-sm text-txt2">Loading…</p>}
        {error && <p className="text-sm text-red">{error}</p>}
        {!loading && !error && rows.length === 0 && <p className="text-sm text-txt2">No decisions recorded yet.</p>}
        {!loading && !error && rows.length > 0 && (
          <div className="flex flex-col divide-y divide-line border border-line rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-2 text-[10px] font-mono uppercase tracking-wider text-txt2 bg-bg1">
              <span>Symbol / Time / Origin</span>
              <span>Side</span>
              <span>Qty @ Price</span>
              <span>Outcome</span>
            </div>
            {rows.map((d) => (
              <div key={d.id} className="bg-bg1">
                <button
                  onClick={() => setExpandedId(expandedId === d.id ? null : d.id)}
                  className="w-full grid grid-cols-[1fr_auto_auto_auto] gap-3 px-4 py-3 items-center hover:bg-bg2 transition text-left"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-mono text-sm">
                      <span className="truncate">{d.symbol}</span>
                      <span className="text-[10px] text-txt2 uppercase">{d.tab}</span>
                    </div>
                    <p className="text-[10.5px] text-txt2">
                      {new Date(d.ts).toLocaleString()} · {d.originTag} · urgency {d.urgency}
                    </p>
                  </div>
                  <span className="font-mono text-[11px]" style={{ color: d.side === 'buy' ? 'var(--green)' : 'var(--red)' }}>
                    {d.side.toUpperCase()}
                  </span>
                  <span className="font-mono text-[12px] text-txt0 whitespace-nowrap">
                    {d.requestedQty % 1 === 0 ? d.requestedQty : d.requestedQty.toFixed(4)} @ {d.requestedPrice.toFixed(2)}
                  </span>
                  <span className={`font-mono text-[11px] whitespace-nowrap ${OUTCOME_COLOR[d.outcome]}`}>{OUTCOME_LABEL[d.outcome]}</span>
                </button>
                {expandedId === d.id && (
                  <div className="px-4 pb-4 flex flex-col gap-2 text-[11px] font-mono">
                    {d.rationale && (
                      <p className="text-txt2">
                        <span className="text-txt1">Rationale:</span> {d.rationale}
                      </p>
                    )}
                    {d.rejectionReasons.length > 0 && (
                      <div>
                        <p className="text-red mb-0.5">Rejection reasons:</p>
                        {d.rejectionReasons.map((r, i) => (
                          <p key={i} className="text-txt2 pl-2">
                            – {r}
                          </p>
                        ))}
                      </div>
                    )}
                    {d.conflictNotes.length > 0 && (
                      <div>
                        <p className="text-amber mb-0.5">Conflict notes:</p>
                        {d.conflictNotes.map((r, i) => (
                          <p key={i} className="text-txt2 pl-2">
                            – {r}
                          </p>
                        ))}
                      </div>
                    )}
                    {d.cautionNotes.length > 0 && (
                      <div>
                        <p className="text-txt1 mb-0.5">Caution notes:</p>
                        {d.cautionNotes.map((r, i) => (
                          <p key={i} className="text-txt2 pl-2">
                            – {r}
                          </p>
                        ))}
                      </div>
                    )}
                    {d.riskChecks && (
                      <div>
                        <p className="text-txt1 mb-0.5">Risk checks:</p>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 pl-2">
                          {Object.entries(d.riskChecks).map(([name, check]) => (
                            <p key={name} className={check.status === 'reject' ? 'text-red' : check.status === 'unavailable' ? 'text-txt2' : 'text-txt0'}>
                              {name}: {check.status} — {check.detail}
                            </p>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="flex gap-4 text-txt2">
                      {d.stopLoss !== null && <span>SL: {d.stopLoss.toFixed(2)}</span>}
                      {d.takeProfit !== null && <span>TP: {d.takeProfit.toFixed(2)}</span>}
                      {d.recommendedQty !== null && <span>Recommended qty: {d.recommendedQty.toFixed(4)}</span>}
                    </div>
                    {(d.ensembleConsensus || d.debateRecommendation) && (
                      <div className="flex gap-4 text-txt2">
                        {d.ensembleConsensus && (
                          <span>
                            Ensemble: {d.ensembleConsensus} {d.ensembleConfidencePct !== null ? `(${d.ensembleConfidencePct.toFixed(0)}%)` : ''}
                          </span>
                        )}
                        {d.debateRecommendation && (
                          <span>
                            Debate: {d.debateRecommendation} {d.debateConfidencePct !== null ? `(${d.debateConfidencePct.toFixed(0)}%)` : ''}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
