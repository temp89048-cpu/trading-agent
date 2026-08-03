'use client';

import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';

export function RiskMeter({ tab }: { tab: 'paper' | 'real' }) {
  const { ticks } = useMarketData();
  const { portfolio } = usePortfolio();

  const positions = tab === 'paper' ? portfolio.paper.positions : portfolio.real.positions;
  const cash = tab === 'paper' ? portfolio.paper.cash : 0;

  if (positions.length === 0) {
    return <p className="text-[11px] text-txt2">No open positions to assess.</p>;
  }

  const valued = positions.map((p) => ({ ...p, value: p.qty * (ticks[p.symbol]?.price ?? p.avgCost) }));
  const marketValue = valued.reduce((s, p) => s + p.value, 0);
  const totalValue = marketValue + cash;
  const largest = [...valued].sort((a, b) => b.value - a.value)[0];
  const concentrationPct = totalValue > 0 ? (largest.value / totalValue) * 100 : 0;
  const cashBufferPct = totalValue > 0 ? (cash / totalValue) * 100 : 0;

  const flags: string[] = [];
  if (concentrationPct > 50) flags.push(`${largest.symbol} is ${concentrationPct.toFixed(0)}% of the book — concentrated`);
  if (tab === 'paper' && cashBufferPct < 10) flags.push(`Cash buffer is only ${cashBufferPct.toFixed(0)}%`);

  return (
    <div className="flex flex-col gap-1.5">
      <Row label="Largest position" value={`${largest.symbol} — ${concentrationPct.toFixed(1)}%`} />
      {tab === 'paper' && <Row label="Cash buffer" value={`${cashBufferPct.toFixed(1)}%`} />}
      <Row label="Positions held" value={String(positions.length)} />
      {flags.length > 0 ? (
        flags.map((f, i) => (
          <p key={i} className="text-[10.5px] mt-1" style={{ color: 'var(--amber)' }}>
            ⚠ {f}
          </p>
        ))
      ) : (
        <p className="text-[10px] mt-1 text-txt2">No concentration or cash-buffer flags right now.</p>
      )}
      <p className="text-[9.5px] mt-1 text-txt2">
        Concentration and cash buffer only — this app doesn&apos;t have enough historical data to compute a real Sharpe/Sortino/drawdown, so it
        doesn&apos;t pretend to.
      </p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-[11px] font-mono">
      <span className="text-txt2">{label}</span>
      <span className="text-txt0">{value}</span>
    </div>
  );
}
