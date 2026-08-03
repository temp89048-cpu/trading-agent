import type { WatchItem } from './types';

// ---------------------------------------------------------------------
// Provider Manager: a capability registry, not a router. The rest of
// the app doesn't talk to Binance or Yahoo directly to ask "can I do X
// here" — it asks this module. Adding a real equities order-book
// provider later (Polygon, Alpaca, IBKR) means updating ONE entry here,
// not hunting down every "if (item.type === 'crypto')" check scattered
// through the codebase.
//
// This mirrors the "Provider Manager" pattern: a market data request
// goes through capability lookup first, and every agent that depends on
// a capability the current provider doesn't have reports that plainly
// instead of estimating or fabricating a number.
// ---------------------------------------------------------------------

export type Capability =
  | 'price'
  | 'candles'
  | 'volume'
  | 'technicalIndicators'
  | 'news'
  | 'orderBook'
  | 'trades'
  | 'bidAskDepth'
  | 'aggressiveFlow'
  | 'largeOrders'
  | 'fundingRate'
  | 'openInterest';

export type ProviderDescriptor = {
  id: string;
  name: string;
  assetClass: 'crypto' | 'equity';
  supports: Record<Capability, boolean>;
};

const BINANCE_PROVIDER: ProviderDescriptor = {
  id: 'binance',
  name: 'Binance',
  assetClass: 'crypto',
  supports: {
    price: true,
    candles: true,
    volume: true,
    technicalIndicators: true,
    news: false, // news comes from the separate RSS agent, not Binance, for either asset class
    orderBook: true,
    trades: true,
    bidAskDepth: true,
    aggressiveFlow: true,
    largeOrders: true,
    // Commit 14: Binance Futures public endpoints (premiumIndex,
    // openInterest) are wired up in /api/marketintel — these were
    // correctly false before that existed; flipped now that they're real.
    fundingRate: true,
    openInterest: true,
  },
};

const YAHOO_PROVIDER: ProviderDescriptor = {
  id: 'yahoo',
  name: 'Yahoo Finance',
  assetClass: 'equity',
  supports: {
    price: true,
    candles: true,
    volume: true,
    technicalIndicators: true,
    news: false,
    orderBook: false,
    trades: false,
    bidAskDepth: false,
    aggressiveFlow: false,
    largeOrders: false,
    fundingRate: false,
    openInterest: false,
  },
};

export function getProviderForAsset(item: WatchItem): ProviderDescriptor {
  return item.type === 'crypto' ? BINANCE_PROVIDER : YAHOO_PROVIDER;
}

export type CapabilityCheck = {
  supported: boolean;
  provider: ProviderDescriptor;
  reason?: string;
  recommendation?: string;
};

// Providers that DO expose a given capability for equities, purely for
// the recommendation message — this app doesn't integrate them, but
// naming real options is more useful than a generic "get better data."
const EQUITY_L2_ALTERNATIVES = 'Polygon.io, Alpaca, Interactive Brokers, or Finnhub';

export function checkCapability(item: WatchItem, capability: Capability): CapabilityCheck {
  const provider = getProviderForAsset(item);
  const supported = provider.supports[capability];
  if (supported) return { supported: true, provider };

  const reason = `${provider.name} does not expose ${capability} for ${provider.assetClass} assets.`;
  const recommendation =
    provider.assetClass === 'equity' && ['orderBook', 'trades', 'bidAskDepth', 'aggressiveFlow', 'largeOrders'].includes(capability)
      ? `Connect ${EQUITY_L2_ALTERNATIVES} to enable this for equities.`
      : provider.assetClass === 'crypto' && (capability === 'fundingRate' || capability === 'openInterest')
        ? 'Wire up Binance Futures endpoints (separate from the spot data this app currently uses) to enable this.'
        : undefined;

  return { supported: false, provider, reason, recommendation };
}

// ---------------------------------------------------------------------
// Chat context injection: a compact capability matrix per watchlist
// symbol, computed once so the model knows up front what it can and
// can't ask for — matching what a person would see if they asked
// "what data do you actually have access to for this symbol."
// ---------------------------------------------------------------------

const DISPLAY_CAPABILITIES: { key: Capability; label: string }[] = [
  { key: 'price', label: 'Price' },
  { key: 'candles', label: 'Candles' },
  { key: 'technicalIndicators', label: 'Indicators' },
  { key: 'orderBook', label: 'Order Book' },
  { key: 'trades', label: 'Trade Tape' },
  { key: 'aggressiveFlow', label: 'Aggressive Flow' },
];

export function buildCapabilityContext(watchlist: WatchItem[]): string {
  if (watchlist.length === 0) return 'DATA CAPABILITIES: no watchlist symbols to check.';

  const lines = watchlist.map((item) => {
    const provider = getProviderForAsset(item);
    const marks = DISPLAY_CAPABILITIES.map((d) => `${d.label} ${provider.supports[d.key] ? '✓' : '✗'}`).join(', ');
    return `  ${item.symbol} (${provider.name}): ${marks}`;
  });

  return `DATA CAPABILITIES (what's actually available per symbol, so you don't ask for or assume data that doesn't exist for a given asset class):\n${lines.join(
    '\n',
  )}\n\n✗ means genuinely unavailable from the current provider, not "not checked yet." Never estimate or infer a value for a ✗ capability — say plainly it isn't available, same as any other honest data gap.`;
}
