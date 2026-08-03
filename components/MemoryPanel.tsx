'use client';

import { usePortfolio } from './Portfolio';
import { useMemory } from './Memory';
import { computeOverallStats, computeFavoriteAssets, computeActiveHours, inferRiskPreference, type RiskPreference } from '@/lib/memoryStats';

const OPTIONS: { value: RiskPreference | null; label: string }[] = [
  { value: null, label: 'Auto' },
  { value: 'conservative', label: 'Conservative' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'aggressive', label: 'Aggressive' },
];

export function MemoryPanel() {
  const { tradeLog, tradeLogLoaded } = usePortfolio();
  const { riskPreference, setRiskPreference } = useMemory();

  if (!tradeLogLoaded) {
    return <p className="text-[11px] text-txt2">Loading trade journal…</p>;
  }
  if (tradeLog.length === 0) {
    return <p className="text-[11px] text-txt2">No trade history yet — stats fill in as trades are logged.</p>;
  }

  const overall = computeOverallStats(tradeLog);
  const favorites = computeFavoriteAssets(tradeLog);
  const activeHours = computeActiveHours(tradeLog);
  const inferred = inferRiskPreference(tradeLog);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        {overall.winRate !== null ? (
          <p className="text-[11px] font-mono text-txt1">
            <span className={overall.winRate >= 0.5 ? 'text-green' : 'text-red'}>{(overall.winRate * 100).toFixed(0)}%</span> win rate
            <span className="text-txt2"> · {overall.closedCount} closed ({overall.wins}W/{overall.losses}L)</span>
          </p>
        ) : (
          <p className="text-[11px] font-mono text-txt2">{overall.totalTrades} trade(s) logged, none closed yet</p>
        )}
        {overall.winRate !== null && (
          <p className={`text-[10px] font-mono ${overall.totalPnl >= 0 ? 'text-green' : 'text-red'}`}>
            Total realized P&amp;L: {overall.totalPnl >= 0 ? '+' : ''}
            {overall.totalPnl.toFixed(2)}
          </p>
        )}
      </div>

      <div className="border-t border-line pt-2 flex flex-col gap-1">
        {favorites.mostTraded && (
          <p className="text-[10px] font-mono text-txt2">
            Most traded: <span className="text-txt1">{favorites.mostTraded.symbol}</span> ({favorites.mostTraded.trades})
          </p>
        )}
        {favorites.bestPerforming ? (
          <p className="text-[10px] font-mono text-txt2">
            Best performer: <span className="text-txt1">{favorites.bestPerforming.symbol}</span> ({favorites.bestPerforming.totalPnl >= 0 ? '+' : ''}
            {favorites.bestPerforming.totalPnl.toFixed(2)})
          </p>
        ) : (
          <p className="text-[10px] font-mono text-txt2">Best performer: need 2+ closed trades on one symbol</p>
        )}
        <p className="text-[10px] font-mono text-txt2">
          Active hours: {activeHours.peakWindowUtc ?? 'not enough history yet'}
        </p>
      </div>

      <div className="border-t border-line pt-2 flex flex-col gap-1.5">
        <p className="text-[10px] font-mono text-txt2">
          Risk preference{riskPreference ? '' : inferred.preference ? ` — auto: ${inferred.preference}` : ''}
        </p>
        <div className="flex gap-1 flex-wrap">
          {OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setRiskPreference(opt.value)}
              className={`tabbtn text-[10px] font-mono ${riskPreference === opt.value ? 'bg-bg3 text-amber' : 'text-txt2'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {!riskPreference && (
          <p className="text-[9.5px] text-txt2">
            {inferred.preference ? `Auto-inferred from ${inferred.reason}.` : inferred.reason} Pick one above to override.
          </p>
        )}
      </div>
    </div>
  );
}
