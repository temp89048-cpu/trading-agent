'use client';

// ---------------------------------------------------------------------
// /history — closed trades, with a per-row journey.
//
// `pnl` is optional on a trade record. Rows without one are shown with an em dash
// and counted separately in the header, so a win rate is never computed over
// records that cannot contribute to it.
// ---------------------------------------------------------------------

import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';

import { TradeJourney } from '@/components/viz/TradeJourney';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { realised, type Trade } from '@/lib/api/portfolio';
import { useSameOrigin } from '@/lib/api/useSameOrigin';
import { DEFAULT_PAGE, page, pageLabel } from '@/lib/ui/paging';
import { buildJourney } from '@/lib/viz/journey';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const HistoryOperator = dynamic(
  () => import('@/components/operator/HistoryOperator').then((m) => ({ default: m.HistoryOperator })),
  { ssr: false },
);

export default function HistoryPage() {
  const trades = useSameOrigin<{ trades?: Trade[] }>('/api/trades', { intervalMs: 30_000 });
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'paper' | 'real'>('all');

  const all = trades.data?.trades ?? [];
  const rows = useMemo(
    () => [...all].filter((t) => tab === 'all' || t.tab === tab).sort((a, b) => b.ts - a.ts),
    [all, tab],
  );
  const pnl = realised(rows);
  const selected = rows.find((t) => t.id === journeyId) ?? null;

  // The log is append-only and never pruned, so this table has no natural bound.
  // Paged rather than truncated — the hidden count is stated, because a silent
  // slice on a trade log reads as "that is every trade".
  const [shown, setShown] = useState(DEFAULT_PAGE);
  const visible = page(rows, shown);

  if (trades.state === 'unreachable') {
    return (
      <div className="max-w-[820px]">
        <h1 className="text-[17px] font-semibold mb-3">Trade History</h1>
        <NotAvailable what="The trade log" reason="/api/trades did not respond. It is a Next.js route reading .data/trades.json." />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Trade History</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Trades" value={<Num value={rows.length} digits={0} />} />
        <StatCard
          label="Realised P&L"
          value={<Num value={pnl.counted ? pnl.total : null} prefix="$" colored signed />}
          sub={pnl.withoutPnl ? `${pnl.withoutPnl} without a pnl, excluded` : undefined}
          color={pnl.withoutPnl ? 'var(--warning)' : undefined}
        />
        <StatCard
          label="Win rate"
          value={pnl.winRatePct === null ? <span style={{ color: 'var(--text-muted)' }}>—</span> : <Num value={pnl.winRatePct} digits={1} suffix="%" />}
          sub={pnl.counted ? `${pnl.wins}W / ${pnl.losses}L over ${pnl.counted}` : 'not measurable'}
        />
        <StatCard label="Symbols" value={<Num value={new Set(rows.map((t) => t.symbol)).size} digits={0} />} />
      </div>

      <Card>
        <SectionTitle
          action={
            <span className="flex gap-1.5">
              {(['all', 'paper', 'real'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip${tab === t ? ' on' : ''}`}
                  // Reset the page with the filter, or "page 3 of all" becomes an
                  // empty table when the filter has fewer rows than that.
                  onClick={() => {
                    setTab(t);
                    setShown(DEFAULT_PAGE);
                  }}
                >
                  {t}
                </button>
              ))}
            </span>
          }
        >
          Closed trades
        </SectionTitle>
        <TermTable
          columns={[
            { key: 't', label: 'When' },
            { key: 's', label: 'Symbol' },
            { key: 'd', label: 'Side' },
            { key: 'q', label: 'Qty', num: true },
            { key: 'p', label: 'Price', num: true },
            { key: 'l', label: 'P&L', num: true },
            { key: 'tb', label: 'Tab' },
            { key: 'a', label: '' },
          ]}
          empty={trades.state === 'loading' ? 'Loading trades…' : 'No trades logged.'}
        >
          {visible.rows.map((t) => (
            <tr key={t.id}>
              <td className="mono text-[11px]">{new Date(t.ts).toLocaleString()}</td>
              <td className="mono text-[11.5px]">{t.symbol}</td>
              <td>
                <span className="mono text-[11.5px]" style={{ color: t.side === 'buy' ? 'var(--positive)' : 'var(--negative)' }}>
                  {t.side?.toUpperCase()}
                </span>
              </td>
              <td className="num"><Num value={t.qty} digits={6} /></td>
              <td className="num"><Num value={t.price} /></td>
              <td className="num">
                {typeof t.pnl === 'number' ? <Num value={t.pnl} colored signed /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
              </td>
              <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t.tab}</td>
              <td>
                <span className="flex gap-1.5">
                  <button type="button" className="chip" onClick={() => setJourneyId(t.id)}>◎ How</button>
                  {/* The detail route carries the reflection, the hypothesis and the
                      delete — the four things this table cannot show inline. */}
                  <Link href={`/history/${t.id}`} className="chip">Detail</Link>
                </span>
              </td>
            </tr>
          ))}
        </TermTable>
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

      {selected ? (
        <Card>
          <SectionTitle action={<button type="button" className="chip" onClick={() => setJourneyId(null)}>Close</button>}>
            How this trade happened — {selected.symbol}
          </SectionTitle>
          <TradeJourney
            steps={buildJourney({
              symbol: selected.symbol,
              price: selected.price,
              execution: { submitted: true, status: 'filled' },
              outcome: typeof selected.pnl === 'number' ? { pnl: selected.pnl } : { status: 'unknown' },
            })}
          />
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Indicators, regime, strategy and risk are unknown for this trade: a trade record
            stores no link to the decision that produced it. The first and last steps are
            real; the middle would need a decision id on the trade.
          </div>
        </Card>
      ) : null}
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <HistoryOperator />
    </div>
  );
}
