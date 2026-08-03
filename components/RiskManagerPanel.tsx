'use client';

import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useTradingControls } from './TradingControls';
import { buildStrategyContext } from '@/lib/strategyContext';
import { computeStopLossTakeProfit, checkDailyLoss, checkDrawdown, checkPortfolioExposure, computeKellyRiskCap } from '@/lib/riskManager';
import { fixedFractionalSize, capToMaxExposure } from '@/lib/positionSizing';

export function RiskManagerPanel() {
  const { watchlist } = useMarketData();
  const { portfolio, tradeLog } = usePortfolio();
  const { getCandles } = useCandles();
  const { getOrderFlow } = useOrderFlow();
  // Reads the LIVE operator-configured limits (Trading Controls panel),
  // not the hardcoded defaults — so this display never silently drifts
  // from what's actually being enforced by Supervisor.tsx.
  const { riskConfig } = useTradingControls();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  const dailyLoss = checkDailyLoss(tradeLog, 'paper', Date.now(), riskConfig.maxDailyLossPct);
  const drawdown = checkDrawdown(tradeLog, 'paper', riskConfig.maxDrawdownPct);
  const equityUsd = portfolio.paper.cash + portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (p.avgCost ?? 0), 0);
  const existingExposureUsd = portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (p.avgCost ?? 0), 0);
  const kellyCap = computeKellyRiskCap(tradeLog, 'paper', riskConfig.maxRiskPctPerTrade);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <p className={`text-[10px] font-mono ${dailyLoss.ok ? 'text-txt2' : 'text-red font-bold'}`}>{dailyLoss.detail}</p>
        <p className={`text-[10px] font-mono ${drawdown.ok ? 'text-txt2' : 'text-red font-bold'}`}>{drawdown.detail}</p>
      </div>
      <div className="border-t border-line pt-2 flex flex-col gap-2">
        {watchlist.map((item) => {
          const primary = getCandles(item.symbol, '1h');
          const ctx = primary && primary.candles.length > 0 ? buildStrategyContext(item, primary.candles, getCandles, getOrderFlow(item.symbol)) : null;
          const slTp = ctx ? computeStopLossTakeProfit(ctx, 'buy') : null;
          const sizing = slTp ? fixedFractionalSize(equityUsd, kellyCap.riskPct, ctx!.price, slTp.stopLoss) : null;
          const sized = sizing ? capToMaxExposure(sizing.qty, ctx!.price, equityUsd) : null;
          const maxSafeLeverage = slTp ? 100 / ((slTp.stopDistance / ctx!.price) * 100 * riskConfig.liquidationSafetyBuffer) : null;
          const portfolioExp = sized ? checkPortfolioExposure(existingExposureUsd, sized.qty * ctx!.price, equityUsd, riskConfig.maxPortfolioExposurePct) : null;

          return (
            <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
              <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
              {slTp ? (
                <>
                  <p className="text-[10px] font-mono text-txt2">
                    SL <span className="text-red">{slTp.stopLoss.toFixed(2)}</span> / TP <span className="text-green">{slTp.takeProfit.toFixed(2)}</span>
                  </p>
                  <p className="text-[9.5px] font-mono text-txt2">{slTp.method}</p>
                  {sized && <p className="text-[9.5px] font-mono text-amber">Suggested size: ~{sized.qty.toFixed(4)} ({(kellyCap.riskPct * 100).toFixed(2)}% risk{kellyCap.riskPct < riskConfig.maxRiskPctPerTrade ? ', Kelly-capped' : ''})</p>}
                  {maxSafeLeverage && <p className="text-[9.5px] font-mono text-txt2">Max safe leverage: ~{maxSafeLeverage.toFixed(1)}x</p>}
                  {portfolioExp && !portfolioExp.ok && <p className="text-[9.5px] font-mono text-red">{portfolioExp.detail}</p>}
                </>
              ) : (
                <p className="text-[10px] font-mono text-txt2">Not enough data yet</p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[9.5px] text-txt2">
        SL/TP from ATR + swing structure (long-side shown; shorts mirror it). Correlation and news-incoming checks
        aren&apos;t built yet — always shown as a caveat in chat, never silently skipped. This is a real gate on
        execution, not just a display.
      </p>
    </div>
  );
}
