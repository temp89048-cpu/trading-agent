'use client';

// ---------------------------------------------------------------------
// /agent/timeline — the live event feed.
//
// Reads the SHARED stream via the routed store. No socket is opened here; the
// store is reference-counted and this page is just another subscriber, which is
// the whole point of the Phase 5 architecture.
//
// PAUSE FREEZES THE VIEW, NOT THE STREAM.
//
// The reference's autoscroll pause is cosmetic. Here, pausing snapshots the rows
// currently on screen and stops updating them — but the store keeps folding events
// the whole time, so resuming shows everything that arrived rather than a gap. A
// pause that dropped events would make the timeline unreliable exactly when
// someone is reading it carefully.
//
// SUPPRESSED TRIGGERS ARE SHOWN, and that is deliberate. The trigger layer
// publishes both fired and suppressed decisions so an operator can tell "we
// detected it and chose not to act" from "we never detected it" — only one of
// those is a bug, and a feed that showed only what fired could not distinguish
// them.
// ---------------------------------------------------------------------

import { useMemo, useRef, useState } from 'react';

import { LiveAgentInspectorModal } from '@/components/modals/LiveAgentInspectorModal';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import type { AgentStreamEvent } from '@/lib/agentEventStream';
import {
  useEventFeed,
  useRealtimeConnected,
  useStreamAge,
  useTriggers,
} from '@/lib/realtime/useRealtime';

/** Event-type groups for the filter chips.
 *
 *  Grouped by what an operator is looking for rather than by backend module —
 *  "why did nothing trade?" spans TRIGGER_FIRED and the decision events, and a
 *  per-module filter would make that question take three clicks. */
const CATEGORIES: { key: string; label: string; types: string[] }[] = [
  { key: 'all', label: 'All', types: [] },
  { key: 'market', label: 'Market', types: ['TICK_RECEIVED', 'FEATURES_COMPUTED', 'MARKET_STRUCTURE_ANALYZED', 'MACRO_ANALYZED'] },
  { key: 'trigger', label: 'Triggers', types: ['TRIGGER_FIRED'] },
  { key: 'graph', label: 'Graph', types: ['GRAPH_NODE_STARTED', 'GRAPH_NODE_COMPLETED', 'GRAPH_NODE_FAILED'] },
  { key: 'decision', label: 'Decisions', types: ['DECISION_MADE', 'SIGNAL_GENERATED', 'DEBATE_CONCLUDED'] },
  { key: 'execution', label: 'Execution', types: ['TAR_SUBMITTED', 'TAR_APPROVED', 'TAR_REJECTED', 'ORDER_FILLED', 'EXECUTION_PLAN_READY'] },
  { key: 'learning', label: 'Learning', types: ['REFLECTION_COMPLETED', 'HYPOTHESIS_PROPOSED'] },
];

function timeLabel(e: AgentStreamEvent): string {
  if (typeof e.timestamp === 'string') {
    const d = new Date(e.timestamp);
    if (!Number.isNaN(d.getTime())) return d.toTimeString().slice(0, 8);
  }
  return '--:--:--';
}

function summarise(e: AgentStreamEvent): string {
  const parts: string[] = [];
  for (const key of ['detail', 'rationale', 'reason', 'node', 'action', 'decision', 'suppressed_reason']) {
    const v = e[key];
    if (typeof v === 'string' && v) parts.push(v);
  }
  if (typeof e.price === 'number') parts.push(`price ${e.price}`);
  return parts.join(' · ') || '—';
}

export default function TimelinePage() {
  const connected = useRealtimeConnected();
  const age = useStreamAge();
  const triggers = useTriggers();

  const [category, setCategory] = useState('all');
  const [symbolFilter, setSymbolFilter] = useState<string>('');
  const [paused, setPaused] = useState(false);
  const [inspect, setInspect] = useState<string | null>(null);

  const types = CATEGORIES.find((c) => c.key === category)?.types ?? [];
  const live = useEventFeed({
    types: types.length ? types : undefined,
    symbol: symbolFilter || undefined,
    limit: 300,
  });

  // Snapshot taken at the moment of pausing. The store keeps folding events
  // regardless, so resuming shows everything that arrived rather than a gap.
  const frozen = useRef<AgentStreamEvent[]>([]);
  if (!paused) frozen.current = live;
  const rows = paused ? frozen.current : live;

  const symbols = useMemo(() => {
    const set = new Set<string>();
    for (const e of live) if (typeof e.symbol === 'string') set.add(e.symbol);
    return [...set].sort();
  }, [live]);

  const suppressed = triggers.filter((t) => !t.acted).length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Agent Timeline</h1>
        <div className="flex items-center gap-2 text-[11.5px]">
          <Badge state={connected ? 'HEALTHY' : 'DOWN'} label={connected ? 'Stream live' : 'Stream offline'} />
          {connected && age !== null ? (
            <span className="mono" style={{ color: 'var(--text-muted)' }}>
              last event {age}s ago
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Events buffered" value={<Num value={live.length} digits={0} />} />
        <StatCard label="Triggers seen" value={<Num value={triggers.length} digits={0} />} />
        <StatCard
          label="Suppressed"
          value={<Num value={suppressed} digits={0} />}
          sub={suppressed ? 'detected, deliberately not acted on' : undefined}
          color={suppressed ? 'var(--warning)' : undefined}
        />
        <StatCard label="Symbols" value={<Num value={symbols.length} digits={0} />} sub={symbols.join(', ') || undefined} />
      </div>

      {/* ---- Triggers ---- */}
      <Card>
        <SectionTitle>Triggers — fired and suppressed</SectionTitle>
        <TermTable
          columns={[
            { key: 'when', label: 'When' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'kind', label: 'Kind' },
            { key: 'detail', label: 'Detail' },
            { key: 'state', label: 'State' },
          ]}
          empty="No triggers on the stream yet. With no market data reaching the backend, none will fire."
        >
          {triggers.slice(0, 25).map((t, i) => (
            <tr key={`${t.at}-${i}`}>
              <td className="mono text-[11px]">{new Date(t.at).toTimeString().slice(0, 8)}</td>
              <td className="mono text-[11.5px]">{t.symbol}</td>
              <td className="text-[11.5px]">{t.kind}</td>
              <td className="text-[11px] whitespace-normal" style={{ color: 'var(--text-secondary)' }}>
                {t.detail}
                {t.suppressedReason ? (
                  <span style={{ color: 'var(--warning)' }}> — {t.suppressedReason}</span>
                ) : null}
              </td>
              <td>
                <Badge state={t.acted ? 'PASS' : 'SKIPPED'} label={t.acted ? 'Fired' : 'Suppressed'} />
              </td>
            </tr>
          ))}
        </TermTable>
      </Card>

      {/* ---- Feed ---- */}
      <Card>
        <SectionTitle
          action={
            <div className="flex items-center gap-2">
              {symbols.length > 0 ? (
                <select
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  className="text-[11.5px] px-1.5 py-1 rounded"
                  aria-label="Filter by symbol"
                >
                  <option value="">All symbols</option>
                  {symbols.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : null}
              <button type="button" className="chip" onClick={() => setPaused((p) => !p)}>
                {paused ? 'Resume' : 'Pause'}
              </button>
            </div>
          }
        >
          Event feed
        </SectionTitle>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`chip${category === c.key ? ' on' : ''}`}
              onClick={() => setCategory(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {paused ? (
          <div className="text-[11px] mb-2" style={{ color: 'var(--warning)' }}>
            Paused — the view is frozen, but the stream keeps recording. Resuming shows
            everything that arrived.
          </div>
        ) : null}

        <TermTable
          columns={[
            { key: 'time', label: 'Time' },
            { key: 'type', label: 'Event' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'summary', label: 'Detail' },
            { key: 'act', label: '' },
          ]}
          empty={
            connected
              ? 'Connected, no events yet. The backend publishes on the bus when something happens.'
              : 'The event stream is not connected. This page reads the shared WebSocket to the FastAPI backend.'
          }
        >
          {rows.slice(0, 150).map((e, i) => (
            <tr key={`${String(e.timestamp)}-${i}`}>
              <td className="mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {timeLabel(e)}
              </td>
              <td className="mono text-[11px]">{String(e.event_type)}</td>
              <td className="mono text-[11.5px]">{typeof e.symbol === 'string' ? e.symbol : '—'}</td>
              <td className="text-[11px] whitespace-normal max-w-[520px]" style={{ color: 'var(--text-secondary)' }}>
                {summarise(e)}
              </td>
              <td>
                {typeof e.symbol === 'string' ? (
                  <button type="button" className="btn-live" onClick={() => setInspect(e.symbol as string)}>
                    <span className="live-dot" aria-hidden /> Live
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </TermTable>
      </Card>

      <LiveAgentInspectorModal symbol={inspect} onClose={() => setInspect(null)} />
    </div>
  );
}
