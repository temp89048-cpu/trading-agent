'use client';

import { useMarketData } from './MarketData';
import { useOrderFlow } from './OrderFlow';
import { computeOrderFlow } from '@/lib/orderFlow';
import { checkCapability } from '@/lib/providerCapabilities';

export function OrderFlowPanel() {
  const { watchlist } = useMarketData();
  const { getOrderFlow } = useOrderFlow();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {watchlist.map((item) => {
        const check = checkCapability(item, 'orderBook');
        if (!check.supported) {
          return (
            <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
              <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
              <p className="text-[10px] font-mono text-txt2">
                Status: <span className="text-red">Unsupported</span> — {check.reason}
              </p>
            </div>
          );
        }

        const raw = getOrderFlow(item.symbol);
        const snap = raw ? computeOrderFlow(raw) : null;

        return (
          <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
            <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
            {snap?.pressure ? (
              <p className={`text-[10px] font-mono ${snap.pressure.pressure === 'buy-heavy' ? 'text-green' : snap.pressure.pressure === 'sell-heavy' ? 'text-red' : 'text-txt2'}`}>
                Book: {snap.pressure.pressure} ({(snap.pressure.imbalance * 100).toFixed(0)}%)
              </p>
            ) : (
              <p className="text-[10px] font-mono text-txt2">Loading book depth…</p>
            )}
            {snap?.flow ? (
              <p className={`text-[10px] font-mono ${snap.flow.dominant === 'buyers' ? 'text-green' : snap.flow.dominant === 'sellers' ? 'text-red' : 'text-txt2'}`}>
                Flow: {snap.flow.dominant} aggressive ({snap.flow.tradeCount} trades)
              </p>
            ) : (
              <p className="text-[10px] font-mono text-txt2">Loading trade tape…</p>
            )}
            {snap && snap.largeOrders.length > 0 && (
              <p className="text-[10px] font-mono text-amber">
                Large: {snap.largeOrders.slice(0, 2).map((o) => `${o.side} ${o.qty.toFixed(2)}`).join(', ')}
              </p>
            )}
          </div>
        );
      })}
      <p className="text-[9.5px] text-txt2">
        Book pressure + aggressive flow from real Binance depth/trades. Crypto only — equities show Unsupported
        rather than an estimate, since Yahoo has no order book or trade-tape data.
      </p>
    </div>
  );
}
