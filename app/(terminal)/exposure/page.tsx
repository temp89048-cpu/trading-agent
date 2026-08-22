'use client';

// ---------------------------------------------------------------------
// /exposure — per-asset exposure.
//
// A share is `null` when the position cannot be valued, rather than 0%. A share
// computed over a partial total is wrong in a way that looks precise, which is why
// `exposureBySymbol` returns null for both the value and the share when a price is
// missing.
// ---------------------------------------------------------------------

import { useMemo } from 'react';

import { Gauge } from '@/components/ui/Gauge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { exposureBySymbol, type PortfolioResponse } from '@/lib/api/portfolio';
import { useBackend, useLivePrices } from '@/lib/realtime/useRealtime';

export default function ExposurePage() {
  const portfolio = useBackend<PortfolioResponse>(BACKEND_PATHS.portfolio, { intervalMs: 15_000 });
  const exchange = useBackend<{ liveTradingEnabled?: boolean }>(BACKEND_PATHS.exchangeStatus, { intervalMs: 30_000 });
  const prices = useLivePrices();

  const live = exchange.data?.liveTradingEnabled === true;
  const book = live ? portfolio.data?.real : portfolio.data?.paper;
  const rows = useMemo(() => exposureBySymbol(book, prices), [book, prices]);
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const unvalued = rows.filter((r) => r.value === null).length;

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Exposure</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Assets held" value={<Num value={rows.length} digits={0} />} />
        <StatCard label="Total value" value={<Num value={rows.length ? total : null} prefix="$" />} sub={unvalued ? `${unvalued} could not be valued` : undefined} color={unvalued ? 'var(--warning)' : undefined} />
        <StatCard label="Largest share" value={rows.length && rows.some((r) => r.share !== null) ? <Num value={Math.max(...rows.map((r) => r.share ?? 0))} digits={1} suffix="%" /> : <span style={{ color: 'var(--text-muted)' }}>—</span>} />
        <StatCard label="Book" value={live ? 'Real' : 'Paper'} mono={false} />
      </div>

      <Card>
        <SectionTitle>Per-asset exposure</SectionTitle>
        {rows.length === 0 ? (
          <NotAvailable
            what="Exposure"
            reason={portfolio.state === 'unreachable' ? 'the portfolio endpoint did not respond' : 'no open positions'}
            compact
          />
        ) : (
          <>
            <TermTable
              columns={[
                { key: 's', label: 'Symbol' }, { key: 'q', label: 'Qty', num: true },
                { key: 'v', label: 'Value', num: true }, { key: 'p', label: 'Share', num: true },
              ]}
            >
              {rows.map((r) => (
                <tr key={r.symbol}>
                  <td className="mono text-[11.5px]">{r.symbol}</td>
                  <td className="num"><Num value={r.qty} digits={6} /></td>
                  <td className="num">{r.value === null ? <span style={{ color: 'var(--text-muted)' }}>no price</span> : <Num value={r.value} prefix="$" />}</td>
                  <td className="num">{r.share === null ? <span style={{ color: 'var(--text-muted)' }}>—</span> : <Num value={r.share} digits={1} suffix="%" />}</td>
                </tr>
              ))}
            </TermTable>
            <div className="space-y-2 mt-3">
              {rows.map((r) => (
                <Gauge
                  key={r.symbol}
                  pct={r.share}
                  label={r.symbol}
                  unavailableReason="no live price for this symbol, so its share of the book cannot be computed"
                />
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
