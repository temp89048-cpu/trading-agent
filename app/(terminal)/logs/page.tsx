'use client';

// ---------------------------------------------------------------------
// /logs — the audit trail plus the live event stream.
//
// NOT APPLICATION LOGS, and the page says so. There is no app-wide levelled log
// store: the audit trail records decisions (symbol, decision, confidence,
// reasoning) and the bus carries events. So the level filter offers what actually
// exists rather than the reference's INFO/WARNING/ERROR/CRITICAL, which would be
// four buttons where three match nothing.
// ---------------------------------------------------------------------

import { useMemo, useState } from 'react';

import { AgentActivityTerminal } from '@/components/AgentActivityTerminal';
import { OperatorSection } from '@/components/operator/OperatorSection';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { DEFAULT_PAGE, page, pageLabel } from '@/lib/ui/paging';
import { useBackend, useEventFeed } from '@/lib/realtime/useRealtime';

type AuditLog = {
  id?: number; timestamp?: string; symbol?: string; decision?: string;
  confidence?: number; reasoning?: string;
};

export default function LogsPage() {
  const audit = useBackend<{ logs?: AuditLog[]; status?: string; message?: string }>(
    `${BACKEND_PATHS.executionAudit}?limit=200`, { intervalMs: 30_000 },
  );
  const events = useEventFeed({ limit: 300 });
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<'audit' | 'stream'>('audit');
  // 200 audit rows and 300 stream events is a lot of DOM for a page an operator
  // leaves open. Paged, with the hidden count stated.
  const [shown, setShown] = useState(DEFAULT_PAGE);

  const logs = audit.data?.logs ?? [];
  const filteredAudit = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter((l) =>
      [l.symbol, l.decision, l.reasoning].some((v) => String(v ?? '').toLowerCase().includes(q)),
    );
  }, [logs, query]);

  const filteredEvents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return events;
    return events.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
  }, [events, query]);

  const visibleAudit = page(filteredAudit, shown);
  const visibleEvents = page(filteredEvents, shown);
  const visible = source === 'audit' ? visibleAudit : visibleEvents;

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Event Logs</h1>

      <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Two real sources: the decision <strong>audit trail</strong> and the live{' '}
        <strong>event bus</strong>. There is no app-wide levelled log store, so this is not
        application logging and there are no INFO/WARN/ERROR levels to filter by.
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Audit records" value={<Num value={logs.length} digits={0} />} />
        <StatCard label="Stream events" value={<Num value={events.length} digits={0} />} />
        <StatCard
          label="Rendered"
          value={<Num value={visible.rows.length} digits={0} />}
          sub={visible.hidden > 0 ? `${visible.hidden} more match` : undefined}
        />
        <StatCard label="Levels" value={<span style={{ color: 'var(--text-muted)' }}>n/a</span>} sub="no levelled store" mono={false} />
      </div>

      <Card>
        <SectionTitle
          action={
            <span className="flex items-center gap-1.5">
              {(['audit', 'stream'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip${source === s ? ' on' : ''}`}
                  onClick={() => {
                    setSource(s);
                    setShown(DEFAULT_PAGE);
                  }}
                >
                  {s}
                </button>
              ))}
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShown(DEFAULT_PAGE);
                }}
                placeholder="Search…"
                className="px-2 py-1 text-[11.5px] rounded w-[180px]"
              />
            </span>
          }
        >
          {source === 'audit' ? 'Decision audit trail' : 'Live event stream'}
        </SectionTitle>

        {source === 'audit' ? (
          <TermTable
            columns={[
              { key: 't', label: 'When' }, { key: 's', label: 'Symbol' }, { key: 'd', label: 'Decision' },
              { key: 'c', label: 'Confidence', num: true }, { key: 'r', label: 'Reasoning' },
            ]}
            empty={audit.data?.message ?? (audit.state === 'unreachable' ? 'The backend did not respond.' : 'No audit records.')}
          >
            {visibleAudit.rows.map((l, i) => (
              <tr key={l.id ?? i}>
                <td className="mono text-[11px]">{l.timestamp ?? '—'}</td>
                <td className="mono text-[11.5px]">{l.symbol ?? '—'}</td>
                <td className="text-[11.5px]">{l.decision ?? '—'}</td>
                <td className="num"><Num value={typeof l.confidence === 'number' ? l.confidence : null} digits={3} /></td>
                <td className="text-[11px] whitespace-normal max-w-[520px]" style={{ color: 'var(--text-secondary)' }}>
                  {l.reasoning ?? '—'}
                </td>
              </tr>
            ))}
          </TermTable>
        ) : (
          <TermTable
            columns={[{ key: 't', label: 'Time' }, { key: 'e', label: 'Event' }, { key: 's', label: 'Symbol' }, { key: 'p', label: 'Payload' }]}
            empty="No events on the stream."
          >
            {visibleEvents.rows.map((e, i) => (
              <tr key={i}>
                <td className="mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {typeof e.timestamp === 'string' ? e.timestamp.slice(11, 19) : '—'}
                </td>
                <td className="mono text-[11px]">{String(e.event_type)}</td>
                <td className="mono text-[11.5px]">{typeof e.symbol === 'string' ? e.symbol : '—'}</td>
                <td className="mono text-[10.5px] whitespace-normal max-w-[520px]" style={{ color: 'var(--text-muted)' }}>
                  {JSON.stringify(e).slice(0, 220)}
                </td>
              </tr>
            ))}
          </TermTable>
        )}
        {visible.hidden > 0 ? (
          <div className="flex items-center gap-2 mt-2">
            <button type="button" className="chip" onClick={() => setShown(visible.next ?? DEFAULT_PAGE)}>
              Show 50 more
            </button>
            <span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
              {pageLabel(visible)}
            </span>
          </div>
        ) : null}
      </Card>

      <OperatorSection
        title="Activity console"
        note="The raw event console the old Glass-Box route hosted, on the same shared connection — no second socket."
      >
        <AgentActivityTerminal />
      </OperatorSection>

      <NotAvailable
        what="Level and service filters"
        reason={
          'there is no app-wide levelled log store to filter. The audit trail records decisions ' +
          'and the bus carries typed events; neither carries a syslog level or a service name, so ' +
          'offering INFO/WARNING/ERROR/CRITICAL buttons would give four filters where none matches.'
        }
      />
    </div>
  );
}
