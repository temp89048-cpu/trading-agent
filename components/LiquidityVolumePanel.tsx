'use client';

import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { computeLiquidity } from '@/lib/liquidity';
import { computeVolumeProfile } from '@/lib/volumeProfile';

export function LiquidityVolumePanel() {
  const { watchlist } = useMarketData();
  const { getCandles } = useCandles();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {watchlist.map((item) => {
        const entry = getCandles(item.symbol, '1h');
        const candles = entry?.candles ?? [];
        const liquidity = candles.length > 0 ? computeLiquidity(candles) : null;
        const profile = candles.length > 0 ? computeVolumeProfile(candles) : null;

        const highs = liquidity?.zones.filter((z) => z.type === 'equal_highs').slice(0, 2) ?? [];
        const lows = liquidity?.zones.filter((z) => z.type === 'equal_lows').slice(0, 2) ?? [];

        return (
          <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
            <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
            {profile ? (
              <>
                <p className="text-[10px] font-mono text-amber">
                  POC {profile.poc.toFixed(2)} <span className="text-txt2">· VA {profile.val.toFixed(2)}–{profile.vah.toFixed(2)}</span>
                </p>
                {profile.highVolumeNodes.length > 1 && (
                  <p className="text-[10px] font-mono text-txt2">
                    Other HVNs: {profile.highVolumeNodes.filter((n) => Math.abs(n.price - profile.poc) > 1e-9).slice(0, 2).map((n) => n.price.toFixed(2)).join(', ')}
                  </p>
                )}
                {profile.lowVolumeNodes.length > 0 && (
                  <p className="text-[10px] font-mono text-txt2">
                    LVNs (fast zone): {profile.lowVolumeNodes.slice(0, 2).map((n) => n.price.toFixed(2)).join(', ')}
                  </p>
                )}
              </>
            ) : (
              <p className="text-[10px] font-mono text-txt2">No volume profile yet</p>
            )}
            {highs.length > 0 && (
              <p className="text-[10px] font-mono text-red">
                Liquidity above: {highs.map((h) => `${h.level.toFixed(2)}${h.size === 'large' ? '★' : ''}`).join(', ')}
              </p>
            )}
            {lows.length > 0 && (
              <p className="text-[10px] font-mono text-green">
                Liquidity below: {lows.map((l) => `${l.level.toFixed(2)}${l.size === 'large' ? '★' : ''}`).join(', ')}
              </p>
            )}
            {liquidity && liquidity.sweeps[0] && (
              <p className="text-[10px] font-mono text-txt2">
                Last sweep: {liquidity.sweeps[0].zone.type === 'equal_highs' ? 'upside' : 'downside'} @{' '}
                {liquidity.sweeps[0].zone.level.toFixed(2)}
              </p>
            )}
          </div>
        );
      })}
      <p className="text-[9.5px] text-txt2">
        POC/VA/HVN/LVN from 1h volume histogram. Liquidity zones from clustered swing highs/lows — ★ = large pool
        (3+ touches). Not guaranteed reversal points.
      </p>
    </div>
  );
}
