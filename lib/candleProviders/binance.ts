import type { CandleProvider } from './types';
import { fetchBinanceCandlesDeep } from '../candleSource.server';

// Binance's own klines endpoint has no real depth ceiling worth
// documenting here (thousands of days available for major pairs) — the
// practical ceiling is this app's own pagination cap in
// candleSource.server.ts (10,000 bars/request), not the exchange.
export const binanceProvider: CandleProvider = {
  id: 'binance',
  label: 'Binance',
  envKeyName: null,
  capability: {
    historyDays: { '1m': 90, '5m': 400, '15m': 1200, '1h': 4800, '4h': 19000, '1d': null, '1w': null }, // 1d/1w: null = no practical ceiling worth stating, effectively "as far back as the pair has traded"
    maxBarsPerRequest: 10000,
    assetTypes: ['crypto'],
    note: 'Public Binance klines endpoint, no API key required. historyDays above reflect this app\'s own 10,000-bar pagination cap at each interval, not an exchange-side limit.',
  },
  isConfigured: () => true,
  fetchCandles: async (symbol, interval, totalBars) => {
    const candles = await fetchBinanceCandlesDeep(symbol, interval, totalBars);
    const sourceNote = candles.length < totalBars
      ? `Binance returned ${candles.length} bars (fewer than the ${totalBars} requested — that's all the history available at this granularity).`
      : `Binance, ${candles.length} bars.`;
    return { candles, sourceNote };
  },
};
