'use client';

import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { usePortfolio } from './Portfolio';
import { computeCorrelationMatrix, computeVolatilities, getCorrelation, tagCategory, findConcentrationRisk, suggestRiskParityWeights } from '@/lib/portfolioIntelligence';

export function PortfolioIntelligencePanel() {
  const { watchlist, ticks } = useMarketData();
  const { getCandles } = useCandles();
  const { portfolio } = usePortfolio();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  const priceHistories: Record<string, number[]> = {};
  for (const item of watchlist) {
    const c = getCandles(item.symbol, '1h');
    if (c && c.candles.length > 0) priceHistories[item.symbol] = c.candles.map((k) => k.c);
  }
  const matrix = computeCorrelationMatrix(priceHistories);
  const equityUsd = portfolio.paper.cash + portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  const positions = portfolio.paper.positions.map((p) => ({ symbol: p.symbol, valueUsd: p.qty * (ticks[p.symbol]?.price ?? p.avgCost) }));
  const flags = findConcentrationRisk(matrix, positions, equityUsd);
  const riskParity = suggestRiskParityWeights(computeVolatilities(priceHistories));

  const pairs: { a: string; b: string; corr: number }[] = [];
  for (let i = 0; i < watchlist.length; i++) {
    for (let j = i + 1; j < watchlist.length; j++) {
      const corr = getCorrelation(matrix, watchlist[i].symbol, watchlist[j].symbol);
      if (corr !== null) pairs.push({ a: watchlist[i].symbol, b: watchlist[j].symbol, corr });
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Categories (approximate)</p>
        <div className="flex flex-col gap-0.5">
          {watchlist.map((item) => {
            const tag = tagCategory(item);
            return (
              <div key={item.symbol} className="flex justify-between text-[10px] font-mono">
                <span className="text-txt1">{item.symbol}</span>
                <span className="text-txt2">{tag.category}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Pairwise correlation</p>
        {pairs.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {pairs.map((p) => (
              <div key={`${p.a}-${p.b}`} className="flex justify-between text-[10px] font-mono">
                <span className="text-txt2">{p.a} &lt;&gt; {p.b}</span>
                <span className={Math.abs(p.corr) >= 0.75 ? 'text-amber' : 'text-txt0'}>{p.corr.toFixed(2)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] font-mono text-txt2">Not enough overlapping history yet (30+ bars needed per pair)</p>
        )}
      </div>

      {flags.length > 0 && (
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Concentration risk</p>
          {flags.map((f, i) => (
            <p key={i} className="text-[9.5px] font-mono text-red">
              ⚠ {f.symbolA} &amp; {f.symbolB}: corr {f.correlation.toFixed(2)}, combined ${f.combinedExposureUsd.toFixed(2)} ({f.combinedExposurePct.toFixed(0)}% of equity)
            </p>
          ))}
        </div>
      )}

      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Suggested risk-parity allocation</p>
        {riskParity.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {riskParity.map((r) => (
              <div key={r.symbol} className="flex justify-between text-[10px] font-mono">
                <span className="text-txt1">{r.symbol}</span>
                <span className="text-txt2">{r.weightPct.toFixed(1)}% <span className="text-txt2/70">(vol {r.volatilityPct.toFixed(2)}%/bar)</span></span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] font-mono text-txt2">Not enough overlapping history yet (30+ bars needed per symbol)</p>
        )}
      </div>

      <p className="text-[9.5px] text-txt2">
        Correlation from cached 1h candle returns. Categories are a small hardcoded reference list, not a licensed sector-classification feed. Risk-parity
        weights are an inverse-volatility heuristic (ignores cross-correlation), not a full covariance optimizer. This feeds the real correlation check in
        the Risk Manager.
      </p>
    </div>
  );
}
