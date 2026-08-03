'use client';

import { useMarketData } from './MarketData';
import { useEventDetection } from './EventDetection';
import { PLANNED_EVENT_TYPES } from '@/lib/eventDetection';

const KIND_LABEL: Record<string, string> = {
  'funding-spike': 'Funding Spike',
  'oi-delta': 'OI Delta (liquidation proxy)',
  'volatility-explosion': 'Volatility Explosion',
  'unusual-volume': 'Unusual Volume',
  'gap-opening': 'Gap Opening',
};

export function EventDetectionPanel() {
  const { watchlist } = useMarketData();
  const { getAllEvents, refreshing } = useEventDetection();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  const allEvents = getAllEvents();
  const anyEvents = Object.values(allEvents).some((evts) => evts.length > 0);

  return (
    <div className="flex flex-col gap-3">
      {anyEvents ? (
        watchlist.map((item) => {
          const events = allEvents[item.symbol] ?? [];
          if (events.length === 0) return null;
          return (
            <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
              <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
              <div className="flex flex-col gap-1">
                {events.map((e, i) => (
                  <p key={i} className={`text-[9.5px] font-mono ${e.severity === 'high' ? 'text-red' : 'text-amber'}`}>
                    [{e.severity.toUpperCase()}] {KIND_LABEL[e.kind] ?? e.kind}: {e.detail}
                  </p>
                ))}
              </div>
            </div>
          );
        })
      ) : (
        <p className="text-[10px] font-mono text-txt2">{refreshing ? 'Checking for events…' : 'No events currently flagged across the watchlist.'}</p>
      )}

      <div className="pt-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Not yet detected</p>
        {PLANNED_EVENT_TYPES.map((p) => (
          <p key={p.eventType} className="text-[9.5px] font-mono text-txt2 mb-1">
            {p.eventType} — <span className="italic">Status: Planned</span> (needs a paid on-chain data provider, e.g. {p.recommendedProviders[0]})
          </p>
        ))}
      </div>

      <p className="text-[9.5px] text-txt2">
        Funding-rate spikes and OI deltas are crypto-only (futures concepts). Volatility, volume, and gap checks apply to both. Events precede moves, they
        aren&apos;t signals on their own — the same confidence gate and risk checks still apply.
      </p>
    </div>
  );
}
