'use client';

import { useMarketData } from './MarketData';
import { useMultiExchange } from './MultiExchange';
import { computeSpread, EXCHANGE_LABELS } from '@/lib/multiExchange';
import { detectArbitrageOpportunity, formatArbitrageOpportunity } from '@/lib/strategies/arbitrage';

export function MultiExchangePanel() {
  const { watchlist } = useMarketData();
  const { getSnapshot, refreshing } = useMultiExchange();

  const cryptoItems = watchlist.filter((w) => w.type === 'crypto');
  if (cryptoItems.length === 0) {
    return <p className="text-[11px] text-txt2">No crypto watchlist symbols — this feature is crypto-only (Coinbase/Kraken/Bybit/OKX/Crypto.com have no equivalent equities coverage).</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {cryptoItems.map((item) => {
        const snap = getSnapshot(item.symbol);
        if (!snap) {
          return (
            <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
              <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
              <p className="text-[10px] font-mono text-txt2">not fetched yet</p>
            </div>
          );
        }
        const spread = computeSpread(snap);
        const opp = detectArbitrageOpportunity(snap);
        return (
          <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
            <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
            <div className="flex flex-col gap-0.5">
              {snap.quotes.map((q) => (
                <div key={q.exchange} className="flex justify-between text-[10px] font-mono">
                  <span className="text-txt2">{EXCHANGE_LABELS[q.exchange]}</span>
                  <span className={q.ok ? 'text-txt0' : 'text-txt2'}>{q.ok ? `$${q.price.toLocaleString()}` : 'unavailable'}</span>
                </div>
              ))}
            </div>
            {spread && (
              <p className="text-[10px] font-mono text-amber mt-1">
                Spread {spread.spreadPct.toFixed(3)}% ({EXCHANGE_LABELS[spread.maxPrice.exchange]} high / {EXCHANGE_LABELS[spread.minPrice.exchange]} low)
              </p>
            )}
            {opp && <p className="text-[9.5px] font-mono text-green mt-0.5">{formatArbitrageOpportunity(opp)}</p>}
          </div>
        );
      })}
      <p className="text-[9.5px] text-txt2">
        {refreshing ? 'Refreshing…' : 'Idle.'} Binance, Bybit, OKX, Kraken, Coinbase, Crypto.com — public REST, no keys. Coinbase is USD-quoted; the rest USDT-quoted, so a
        small basis difference is expected and not itself a signal. Refreshed every 5 minutes.
      </p>
    </div>
  );
}
