'use client';

import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { computeMtfSnapshot, MTF_TIMEFRAMES, type Trend } from '@/lib/multiTimeframe';

function trendColor(trend: Trend): string {
  return trend === 'bullish' ? 'var(--green)' : trend === 'bearish' ? 'var(--red)' : 'var(--txt-2)';
}

function trendLetter(trend: Trend): string {
  return trend === 'bullish' ? 'B' : trend === 'bearish' ? 'S' : 'N';
}

export function MTFBadges() {
  const { watchlist } = useMarketData();
  const { getCandles } = useCandles();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {watchlist.map((item) => {
        const snapshot = computeMtfSnapshot(item, getCandles);
        return (
          <div key={item.symbol} className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-txt1 shrink-0">{item.symbol}</span>
            <div className="flex items-center gap-1">
              {MTF_TIMEFRAMES.map((tf) => {
                const t = snapshot.perTimeframe.find((x) => x.timeframe === tf);
                return (
                  <span
                    key={tf}
                    title={t ? `${tf}: ${t.trend} — ${t.detail}` : `${tf}: no data yet`}
                    className="w-5 h-5 flex items-center justify-center rounded text-[9px] font-mono font-bold border"
                    style={{
                      color: t ? trendColor(t.trend) : 'var(--txt-2)',
                      borderColor: t ? trendColor(t.trend) : 'var(--line)',
                      opacity: t ? 1 : 0.4,
                    }}
                  >
                    {t ? trendLetter(t.trend) : '·'}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
      <p className="text-[9.5px] mt-1 text-txt2">
        {MTF_TIMEFRAMES.join(' · ')} left→right, per symbol. B = bullish, S = bearish, N = neutral. Hover a badge for
        detail. Dots mean that timeframe hasn&apos;t loaded enough history yet.
      </p>
    </div>
  );
}
