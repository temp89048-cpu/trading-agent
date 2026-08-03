// ---------------------------------------------------------------------
// Provider-based candle sourcing. Each provider advertises what it can
// actually deliver (which intervals, how much history, how many bars
// per request) so the registry can pick the best real option for a
// request, or warn honestly when the request exceeds every configured
// provider's limits — instead of always going to Binance/Yahoo and
// silently truncating.
//
// History-depth numbers below are the provider's PUBLISHED free-tier
// limits as documented at the time this was written. Providers change
// their tiers; treat these as "verify against your actual plan," not a
// guarantee — same epistemic honesty as everywhere else in this app.
// ---------------------------------------------------------------------

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export const SUPPORTED_INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type SupportedInterval = (typeof SUPPORTED_INTERVALS)[number];

export type AssetType = 'crypto' | 'equity';

// historyDays[interval] = how many days of lookback are realistically
// available at that granularity. null = interval not supported at all
// by this provider. undefined = provider doesn't cover this interval
// (same practical effect as null, kept distinct for clarity in code
// that's asking "did they even try to answer this").
export type ProviderCapability = {
  historyDays: Partial<Record<SupportedInterval, number | null>>;
  maxBarsPerRequest: number;
  assetTypes: AssetType[];
  note: string; // where these numbers come from / how confident to be in them
};

export type ProviderFetchResult = { candles: Candle[]; sourceNote: string };

export type CandleProvider = {
  id: string;
  label: string;
  envKeyName: string | null; // null = never needs a key (Binance/Yahoo public endpoints)
  capability: ProviderCapability;
  isConfigured: () => boolean;
  fetchCandles: (symbol: string, interval: SupportedInterval, totalBars: number) => Promise<ProviderFetchResult>;
};

// Given a requested (interval, totalBars), how many days of history does
// that actually represent? Used to compare a request against a
// provider's historyDays ceiling.
const INTERVAL_MS: Record<SupportedInterval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

export function requestedDaysOfHistory(interval: SupportedInterval, totalBars: number): number {
  return (INTERVAL_MS[interval] * totalBars) / (24 * 60 * 60_000);
}
