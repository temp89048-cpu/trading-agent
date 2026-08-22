'use client';

// ---------------------------------------------------------------------
// /intel — regime per asset.
//
// The reference also shows a correlation matrix. It is OMITTED, not faked:
// `algorithms/market_graph.py` computes cross-asset correlation but no endpoint
// exposes it. Building a correlation panel from candle data in the browser would
// give a second, differently-computed answer to a question the backend already
// answers one way — and two disagreeing correlation numbers is worse than one
// missing panel.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useMemo } from 'react';

import { Card, Num, NotAvailable, SectionTitle, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useBackend, useLivePrices } from '@/lib/realtime/useRealtime';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const IntelOperator = dynamic(
  () => import('@/components/operator/IntelOperator').then((m) => ({ default: m.IntelOperator })),
  { ssr: false },
);

function RegimeRow({ symbol }: { symbol: string }) {
  const regime = useBackend<{ regime?: string; classified?: boolean; candlesUsed?: number; timeframe?: string }>(
    `/api/market/regime/${encodeURIComponent(symbol.replace('/', '-'))}`,
    { intervalMs: 60_000 },
  );
  return (
    <tr>
      <td className="mono text-[11.5px]">{symbol}</td>
      <td className="text-[11.5px]">
        {regime.state === 'loading' ? '…' : (regime.data?.regime ?? <span style={{ color: 'var(--text-muted)' }}>not classified</span>)}
      </td>
      <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{regime.data?.timeframe ?? '—'}</td>
      <td className="num mono"><Num value={regime.data?.candlesUsed ?? null} digits={0} /></td>
    </tr>
  );
}

export default function IntelPage() {
  const pricesApi = useBackend<{ prices?: Record<string, number> }>(BACKEND_PATHS.marketPrices, { intervalMs: 30_000 });
  const live = useLivePrices();
  const symbols = useMemo(
    () => Object.keys({ ...(pricesApi.data?.prices ?? {}), ...live }).sort(),
    [pricesApi.data, live],
  );

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Market Intelligence</h1>

      <Card>
        <SectionTitle>Regime per asset</SectionTitle>
        {symbols.length === 0 ? (
          <NotAvailable
            what="Watched symbols"
            reason="no symbol has a price yet, so there is nothing to classify. The list is derived from live data rather than hardcoded."
            compact
          />
        ) : (
          <TermTable
            columns={[
              { key: 's', label: 'Symbol' }, { key: 'r', label: 'Regime' },
              { key: 't', label: 'Timeframe' }, { key: 'c', label: 'Candles', num: true },
            ]}
          >
            {symbols.map((s) => <RegimeRow key={s} symbol={s} />)}
          </TermTable>
        )}
      </Card>

      <NotAvailable
        what="Cross-asset correlation"
        reason={
          'computed by algorithms/market_graph.py but not exposed by any HTTP route. Deriving it ' +
          'in the browser would give a second, differently-computed answer to a question the ' +
          'backend already answers one way, and two disagreeing correlation numbers are worse ' +
          'than one absent panel. A thin read-only route would unblock it.'
        }
      />
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <IntelOperator />
    </div>
  );
}
