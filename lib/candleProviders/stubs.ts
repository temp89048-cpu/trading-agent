import type { CandleProvider } from './types';

// None of these four are wired to a real fetch implementation yet — no
// API key is configured for any of them in this deployment, and this
// app doesn't fabricate market data. Each is included so the registry
// (and the UI) can see them, know what they'd offer if configured, and
// explain honestly why they're being skipped, exactly like the
// unconfigured News API providers in lib/newsProviders.ts.
//
// To actually enable one: implement its fetchCandles against the real
// API (not done here) and set the corresponding env var. Capability
// numbers below are each provider's own published free/starter-tier
// limits at time of writing — verify against your actual plan before
// relying on them; these change.

function unconfiguredFetch(providerLabel: string, envKeyName: string): CandleProvider['fetchCandles'] {
  return async () => {
    throw new Error(`${providerLabel} is not configured (no fetch implementation wired up yet, and ${envKeyName} isn't set) — this app does not fabricate candle data. Skipping.`);
  };
}

export const polygonProvider: CandleProvider = {
  id: 'polygon',
  label: 'Polygon.io',
  envKeyName: 'POLYGON_API_KEY',
  capability: {
    historyDays: { '1m': 730, '5m': 730, '15m': 730, '1h': 730, '4h': 730, '1d': 3650, '1w': 3650 },
    maxBarsPerRequest: 50000,
    assetTypes: ['equity', 'crypto'],
    note: 'Published free-tier limit is 5 requests/minute with 2 years of historical aggregates on the paid Starter tier and above — the free tier itself is end-of-day only for stocks. Verify current terms before relying on this.',
  },
  isConfigured: () => !!process.env.POLYGON_API_KEY,
  fetchCandles: unconfiguredFetch('Polygon.io', 'POLYGON_API_KEY'),
};

export const alpacaProvider: CandleProvider = {
  id: 'alpaca',
  label: 'Alpaca Markets',
  envKeyName: 'ALPACA_API_KEY',
  capability: {
    historyDays: { '1m': 1825, '5m': 1825, '15m': 1825, '1h': 1825, '4h': 1825, '1d': 3650, '1w': 3650 },
    maxBarsPerRequest: 10000,
    assetTypes: ['equity'],
    note: 'US equities only (IEX or SIP feed depending on plan). Free IEX-feed accounts get several years of minute-bar history — SIP (full consolidated tape) requires a paid subscription. Verify current terms before relying on this.',
  },
  isConfigured: () => !!process.env.ALPACA_API_KEY,
  fetchCandles: unconfiguredFetch('Alpaca Markets', 'ALPACA_API_KEY'),
};

export const twelveDataProvider: CandleProvider = {
  id: 'twelvedata',
  label: 'TwelveData',
  envKeyName: 'TWELVEDATA_API_KEY',
  capability: {
    historyDays: { '1m': 30, '5m': 90, '15m': 180, '1h': 730, '4h': 730, '1d': 3650, '1w': 3650 },
    maxBarsPerRequest: 5000,
    assetTypes: ['equity', 'crypto'],
    note: 'Free tier: 800 requests/day, 8 requests/minute, multi-asset (equities, crypto, forex). Intraday history depth on the free tier is more limited than paid plans. Verify current terms before relying on this.',
  },
  isConfigured: () => !!process.env.TWELVEDATA_API_KEY,
  fetchCandles: unconfiguredFetch('TwelveData', 'TWELVEDATA_API_KEY'),
};

export const alphaVantageProvider: CandleProvider = {
  id: 'alphavantage',
  label: 'Alpha Vantage',
  envKeyName: 'ALPHAVANTAGE_API_KEY',
  capability: {
    historyDays: { '1m': 30, '5m': 30, '15m': 30, '1h': 730, '4h': null, '1d': 7300, '1w': 7300 },
    maxBarsPerRequest: 20000,
    assetTypes: ['equity', 'crypto'],
    note: 'Free tier: 25 requests/day, 5 requests/minute — very restrictive for backtesting use. Extended intraday history is available via paginated "slices" on paid tiers. Verify current terms before relying on this.',
  },
  isConfigured: () => !!process.env.ALPHAVANTAGE_API_KEY,
  fetchCandles: unconfiguredFetch('Alpha Vantage', 'ALPHAVANTAGE_API_KEY'),
};

export const STUB_PROVIDERS: CandleProvider[] = [polygonProvider, alpacaProvider, twelveDataProvider, alphaVantageProvider];
