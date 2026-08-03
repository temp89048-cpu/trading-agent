'use client';

import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';

export function PortfolioStats({ tab }: { tab: 'paper' | 'real' }) {
  const { ticks } = useMarketData();
  const { portfolio, tradeLog } = usePortfolio();

  const positions = tab === 'paper' ? portfolio.paper.positions : portfolio.real.positions;
  const unrealizedPnl = positions.reduce((sum, p) => {
    const live = ticks[p.symbol]?.price;
    return live ? sum + (live - p.avgCost) * p.qty : sum;
  }, 0);

  const tabTrades = tradeLog.filter((t) => t.tab === tab);
  const closedTrades = tabTrades.filter((t) => typeof t.pnl === 'number');
  const realizedPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const wins = closedTrades.filter((t) => (t.pnl ?? 0) > 0).length;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length) * 100 : null;
  const totalCount = tabTrades.length;

  const totalPnl = realizedPnl + unrealizedPnl;

  return (
    <div className="grid grid-cols-2 gap-2">
      <StatCard label="Total P&L" value={fmtSigned(totalPnl)} tone={totalPnl >= 0 ? 'up' : 'down'} />
      <StatCard label="Realized P&L" value={fmtSigned(realizedPnl)} tone={realizedPnl >= 0 ? 'up' : 'down'} />
      <StatCard label="Unrealized P&L" value={fmtSigned(unrealizedPnl)} tone={unrealizedPnl >= 0 ? 'up' : 'down'} />
      <StatCard label="Trades logged" value={totalCount.toString()} />
      <StatCard
        label="Win rate"
        value={winRate === null ? '—' : `${winRate.toFixed(0)}%`}
        hint={closedTrades.length > 0 ? `${wins}/${closedTrades.length} closed trades` : 'no closed trades yet'}
        className="col-span-2"
      />
    </div>
  );
}

function fmtSigned(n: number): string {
  const sign = n >= 0 ? '+' : '−';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function StatCard({
  label,
  value,
  tone,
  hint,
  className = '',
}: {
  label: string;
  value: string;
  tone?: 'up' | 'down';
  hint?: string;
  className?: string;
}) {
  const color = tone === 'up' ? 'var(--green)' : tone === 'down' ? 'var(--red)' : 'var(--txt-0)';
  return (
    <div className={`rounded-md border border-line bg-bg2 px-2.5 py-2 ${className}`}>
      <p className="text-[9.5px] font-mono uppercase tracking-wider text-txt2">{label}</p>
      <p className="text-sm font-mono font-semibold mt-0.5" style={{ color }}>
        {value}
      </p>
      {hint && <p className="text-[9.5px] text-txt2 mt-0.5">{hint}</p>}
    </div>
  );
}
