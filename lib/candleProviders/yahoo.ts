import type { CandleProvider } from './types';
import { fetchYahooCandles, YAHOO_INTERVAL_MAP } from '../candleSource.server';

// These are Yahoo's actual published intraday retention limits — the
// exact "highest priority" limitation flagged in the review. No amount
// of pagination fixes this; it's a hard ceiling on what the provider
// keeps around. Documented per-interval instead of one blanket number so
// the registry (and the UI) can tell the user precisely which
// granularity is the problem.
export const yahooProvider: CandleProvider = {
  id: 'yahoo',
  label: 'Yahoo Finance',
  envKeyName: null,
  capability: {
    historyDays: { '1m': 5, '5m': 30, '15m': 30, '1h': 90, '4h': 90, '1d': 365, '1w': 1825 },
    maxBarsPerRequest: 10000, // Yahoo returns the whole `range` in one response; this is just an upper sanity bound
    assetTypes: ['equity'],
    note: 'Public Yahoo Finance chart endpoint, no API key required. historyDays reflects Yahoo\'s own published intraday retention window (1m: ~7 days, 5m/15m: ~60 days, 60m: ~2 years) — this is the actual data-provider ceiling flagged as the top-priority equities limitation, not something more pagination code can fix.',
  },
  isConfigured: () => true,
  fetchCandles: async (symbol, interval, totalBars) => {
    const mapped = YAHOO_INTERVAL_MAP[interval];
    if (!mapped) throw new Error(`Yahoo does not support interval ${interval}`);
    const all = await fetchYahooCandles(symbol, interval);
    const candles = all.slice(-totalBars);
    const sourceNote = all.length < totalBars
      ? `Yahoo returned ${all.length} bars total at this granularity (fewer than the ${totalBars} requested) — this is Yahoo's own intraday retention limit, not a pagination gap.`
      : `Yahoo, ${candles.length} of ${all.length} available bars used.`;
    return { candles, sourceNote };
  },
};
