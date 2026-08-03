import { atr, type Candle } from './indicators';
import type { WatchItem } from './types';

// ---------------------------------------------------------------------
// Event Detection (Level 16).
//
// Everything below is computed from data this app already has flowing
// by Commit 22: candles (Commit 8), and Binance Futures' funding-rate
// and open-interest HISTORY endpoints (new fetches, but the same free,
// no-key Binance Futures host already used for the current-snapshot
// derivatives data since Commit 18 — see app/api/eventdata/route.ts).
//
// Deliberately NOT included: whale-transfer and exchange-inflow/outflow
// detection. Both need real on-chain, address-level data — which
// wallets are exchange-owned, and how much actually moves in/out of
// them — that no free/no-key API this app uses provides. Faking that
// from price/volume data would be presenting a guess as an on-chain
// fact, which is exactly the thing this app's honesty discipline exists
// to prevent. See PLANNED_EVENT_TYPES below for what closing this gap
// for real would actually require.
// ---------------------------------------------------------------------

export type EventSeverity = 'medium' | 'high';
export type EventKind = 'funding-spike' | 'oi-delta' | 'volatility-explosion' | 'unusual-volume' | 'gap-opening';

export type MarketEvent = {
  kind: EventKind;
  symbol: string;
  severity: EventSeverity;
  detail: string;
  ts: number;
};

// ---------------------------------------------------------------------
// Volatility Explosion — latest bar's true range vs the CURRENT ATR(14)
// itself (ATR already IS the rolling-average true range, so comparing
// today's actual range to it is the standard, well-known metric — no
// separate ATR series needed).
// ---------------------------------------------------------------------
const VOL_EXPLOSION_RATIO = 2.5;
const VOL_EXPLOSION_HIGH_RATIO = 4;

export function detectVolatilityExplosion(symbol: string, candles: Candle[]): MarketEvent | null {
  if (candles.length < 16) return null;
  const atrValue = atr(candles, 14);
  if (atrValue === null || atrValue <= 0) return null;
  const last = candles[candles.length - 1];
  const prevClose = candles[candles.length - 2].c;
  const trueRange = Math.max(last.h - last.l, Math.abs(last.h - prevClose), Math.abs(last.l - prevClose));
  const ratio = trueRange / atrValue;
  if (ratio < VOL_EXPLOSION_RATIO) return null;
  return {
    kind: 'volatility-explosion',
    symbol,
    severity: ratio >= VOL_EXPLOSION_HIGH_RATIO ? 'high' : 'medium',
    detail: `Latest bar's true range (${trueRange.toFixed(4)}) is ${ratio.toFixed(1)}x the current ATR(14) (${atrValue.toFixed(4)}) — a real volatility expansion, not typical chop.`,
    ts: last.t,
  };
}

// ---------------------------------------------------------------------
// Unusual Volume — latest bar's volume vs the trailing N-bar average,
// excluding the latest bar from its own baseline.
// ---------------------------------------------------------------------
const VOLUME_LOOKBACK = 20;
const VOLUME_RATIO_THRESHOLD = 3;
const VOLUME_RATIO_HIGH = 5;

export function detectUnusualVolume(symbol: string, candles: Candle[]): MarketEvent | null {
  if (candles.length < VOLUME_LOOKBACK + 1) return null;
  const recent = candles.slice(-(VOLUME_LOOKBACK + 1), -1);
  const avgVolume = recent.reduce((s, c) => s + c.v, 0) / recent.length;
  if (avgVolume <= 0) return null;
  const last = candles[candles.length - 1];
  const ratio = last.v / avgVolume;
  if (ratio < VOLUME_RATIO_THRESHOLD) return null;
  return {
    kind: 'unusual-volume',
    symbol,
    severity: ratio >= VOLUME_RATIO_HIGH ? 'high' : 'medium',
    detail: `Latest bar's volume (${last.v.toLocaleString()}) is ${ratio.toFixed(1)}x the ${VOLUME_LOOKBACK}-bar average (${avgVolume.toFixed(2)}).`,
    ts: last.t,
  };
}

// ---------------------------------------------------------------------
// Gap Opening — latest bar's open vs the prior bar's close. Crypto
// trades 24/7, so a "gap" on a crypto candle boundary is mostly just
// noise, not a real session gap the way an equity open after an
// overnight close is — flagged at a meaningfully higher threshold for
// crypto to compensate, not treated identically.
// ---------------------------------------------------------------------
const GAP_THRESHOLD_PCT: Record<'crypto' | 'equity', number> = { crypto: 1.5, equity: 0.5 };

export function detectGapOpening(symbol: string, candles: Candle[], assetType: 'crypto' | 'equity'): MarketEvent | null {
  if (candles.length < 2) return null;
  const last = candles[candles.length - 1];
  const prevClose = candles[candles.length - 2].c;
  if (prevClose <= 0) return null;
  const gapPct = ((last.o - prevClose) / prevClose) * 100;
  const threshold = GAP_THRESHOLD_PCT[assetType];
  if (Math.abs(gapPct) < threshold) return null;
  return {
    kind: 'gap-opening',
    symbol,
    severity: Math.abs(gapPct) >= threshold * 2 ? 'high' : 'medium',
    detail:
      `Bar opened ${gapPct >= 0 ? '+' : ''}${gapPct.toFixed(2)}% ${gapPct >= 0 ? 'above' : 'below'} the prior bar's close` +
      (assetType === 'crypto'
        ? ' (crypto trades 24/7 — this is a candle-boundary gap, not a real session gap, and is flagged at a higher threshold to compensate).'
        : ' (a real session gap).'),
    ts: last.t,
  };
}

// ---------------------------------------------------------------------
// Funding Rate Spike — needs real HISTORY (a series of past
// settlements), not just the current snapshot lib/sentimentAgent.ts
// already caches. A "spike" is a deviation from the recent trend, not
// just being elevated in isolation (which sentimentAgent's
// FUNDING_ELEVATED_THRESHOLD already covers separately). Fed by a new
// history fetch — see app/api/eventdata/route.ts.
// ---------------------------------------------------------------------
export type FundingRatePoint = { rate: number; time: number };

const FUNDING_SPIKE_STDEV_MULTIPLIER = 2.5;
const FUNDING_SPIKE_HIGH_MULTIPLIER = 4;
const MIN_FUNDING_HISTORY = 8;

export function detectFundingRateSpike(symbol: string, history: FundingRatePoint[]): MarketEvent | null {
  if (history.length < MIN_FUNDING_HISTORY) return null;
  const sorted = [...history].sort((a, b) => a.time - b.time);
  const latest = sorted[sorted.length - 1];
  const prior = sorted.slice(0, -1);
  const mean = prior.reduce((s, p) => s + p.rate, 0) / prior.length;
  const variance = prior.reduce((s, p) => s + (p.rate - mean) ** 2, 0) / prior.length;
  const stdev = Math.sqrt(variance);
  if (stdev <= 0) return null; // flat history — no meaningful deviation to measure
  const z = (latest.rate - mean) / stdev;
  if (Math.abs(z) < FUNDING_SPIKE_STDEV_MULTIPLIER) return null;
  return {
    kind: 'funding-spike',
    symbol,
    severity: Math.abs(z) >= FUNDING_SPIKE_HIGH_MULTIPLIER ? 'high' : 'medium',
    detail: `Latest funding rate ${(latest.rate * 100).toFixed(4)}% is ${Math.abs(z).toFixed(1)} standard deviations from the ${prior.length}-settlement trailing average (${(mean * 100).toFixed(4)}%) — a real shift in positioning, not just an elevated level.`,
    ts: latest.time,
  };
}

// ---------------------------------------------------------------------
// Open Interest Delta — used as a liquidation-cascade PROXY, not a
// direct liquidation feed (Binance's real-time forced-liquidation order
// stream is a separate, much noisier websocket this app doesn't
// consume). A sharp OI DROP is the signal: positions are being closed
// (forced or not) faster than new ones open. An OI rise is just new
// positioning, not a cascade, so it's never flagged here.
// ---------------------------------------------------------------------
export type OiPoint = { oi: number; time: number };

const OI_DROP_THRESHOLD_PCT = 5;
const OI_DROP_HIGH_PCT = 10;

export function detectOiDelta(symbol: string, history: OiPoint[], priceChangePctOverSameWindow: number | null): MarketEvent | null {
  if (history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.time - b.time);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first.oi <= 0) return null;
  const deltaPct = ((last.oi - first.oi) / first.oi) * 100;
  if (deltaPct > -OI_DROP_THRESHOLD_PCT) return null;

  const direction =
    priceChangePctOverSameWindow === null
      ? 'unknown direction (no matching price data over this window)'
      : priceChangePctOverSameWindow < 0
        ? 'downward — consistent with long liquidations'
        : priceChangePctOverSameWindow > 0
          ? 'upward — consistent with short liquidations'
          : 'flat — direction unclear';

  return {
    kind: 'oi-delta',
    symbol,
    severity: deltaPct <= -OI_DROP_HIGH_PCT ? 'high' : 'medium',
    detail: `Open interest dropped ${deltaPct.toFixed(1)}% over the tracked window — a PROXY for a liquidation cascade (forced position closures), not a direct on-chain/exchange liquidation feed. Price moved ${direction} over the same window.`,
    ts: last.time,
  };
}

// ---------------------------------------------------------------------
// Combined detector — runs every applicable check given whatever data
// is actually available, honestly skipping (not fabricating) checks
// whose inputs weren't supplied.
// ---------------------------------------------------------------------
export function detectMarketEvents(params: {
  symbol: string;
  assetType: 'crypto' | 'equity';
  candles: Candle[];
  fundingHistory?: FundingRatePoint[];
  oiHistory?: OiPoint[];
  priceChangePctOverOiWindow?: number | null;
}): MarketEvent[] {
  const events: MarketEvent[] = [];
  const vol = detectVolatilityExplosion(params.symbol, params.candles);
  if (vol) events.push(vol);
  const volume = detectUnusualVolume(params.symbol, params.candles);
  if (volume) events.push(volume);
  const gap = detectGapOpening(params.symbol, params.candles, params.assetType);
  if (gap) events.push(gap);
  // Funding rate and open interest are futures-market concepts — no
  // equivalent exists for equities, same crypto-only gating already
  // established for funding/OI in providerCapabilities.ts.
  if (params.assetType === 'crypto') {
    if (params.fundingHistory) {
      const f = detectFundingRateSpike(params.symbol, params.fundingHistory);
      if (f) events.push(f);
    }
    if (params.oiHistory) {
      const o = detectOiDelta(params.symbol, params.oiHistory, params.priceChangePctOverOiWindow ?? null);
      if (o) events.push(o);
    }
  }
  return events;
}

// ---------------------------------------------------------------------
// Explicitly out of scope — same PlannedAgentStatus-style honesty
// pattern as Grid/Arbitrage in lib/strategies/, applied to event types
// instead of strategy agents.
// ---------------------------------------------------------------------
export type PlannedEventType = {
  eventType: string;
  status: 'planned';
  reason: string;
  requiredComponents: string[];
  complexity: 'Low' | 'Medium' | 'High';
  plannedVersion: string;
  recommendedProviders: string[];
};

export const WHALE_TRANSFER_STATUS: PlannedEventType = {
  eventType: 'Whale Transfer Detection',
  status: 'planned',
  reason:
    'Detecting large on-chain transfers needs a real on-chain data provider — there is no free, no-key way to watch wallet-to-wallet transfers at the volume or reliability this would need. Faking it from price/volume data would be presenting a guess as an on-chain fact.',
  requiredComponents: [
    'A paid on-chain data provider subscription (Whale Alert, Nansen, Arkham, or similar)',
    'Real-time chain indexing or a provider webhook/API feed',
    'Threshold tuning per asset (a "whale" transfer size means something different for BTC vs a low-cap alt)',
  ],
  complexity: 'High',
  plannedVersion: 'v2 / Future Release (needs a funded data provider decision)',
  recommendedProviders: ['Whale Alert', 'Nansen', 'Arkham Intelligence'],
};

export const EXCHANGE_FLOW_STATUS: PlannedEventType = {
  eventType: 'Exchange Inflow/Outflow Detection',
  status: 'planned',
  reason:
    'Same root cause as Whale Transfer Detection: this needs real address-level on-chain data (which wallets are exchange-owned, and how much moves in/out of them) that no free/no-key API this app uses provides. The exchange REST endpoints already wired up (Binance, Bybit, OKX, Kraken, Coinbase — Commit 21) only expose market data, not their own wallet balances or on-chain flows.',
  requiredComponents: [
    'A paid on-chain data provider (same options as Whale Transfer Detection)',
    'Known exchange wallet address lists per venue',
    'A historical baseline of exchange balances to compute a meaningful "in/outflow," not just a raw balance snapshot',
  ],
  complexity: 'High',
  plannedVersion: 'v2 / Future Release (needs a funded data provider decision)',
  recommendedProviders: ['Glassnode', 'CryptoQuant', 'Nansen'],
};

export const PLANNED_EVENT_TYPES: PlannedEventType[] = [WHALE_TRANSFER_STATUS, EXCHANGE_FLOW_STATUS];

function formatPlannedEventType(p: PlannedEventType): string {
  return (
    `  ${p.eventType} — Status: Planned\n` +
    `    Reason: ${p.reason}\n` +
    `    Required: ${p.requiredComponents.join('; ')}\n` +
    `    Recommended providers: ${p.recommendedProviders.join('; ')}\n` +
    `    Complexity: ${p.complexity}. Target: ${p.plannedVersion}.`
  );
}

// ---------------------------------------------------------------------
// Chat context injection.
// ---------------------------------------------------------------------
export function buildEventDetectionContext(eventsBySymbol: Record<string, MarketEvent[]>, watchlist: WatchItem[]): string {
  if (watchlist.length === 0) return 'EVENT DETECTION: no watchlist symbols to analyze.';

  const lines = watchlist.map((item) => {
    const events = eventsBySymbol[item.symbol] ?? [];
    if (events.length === 0) return `  ${item.symbol}: no events currently flagged`;
    return `  ${item.symbol}:\n${events.map((e) => `    [${e.severity.toUpperCase()}] ${e.kind}: ${e.detail}`).join('\n')}`;
  });

  const plannedBlock = PLANNED_EVENT_TYPES.map(formatPlannedEventType).join('\n');

  return `EVENT DETECTION (funding-rate spikes, OI deltas as a liquidation-cascade PROXY, ATR-based volatility explosions, unusual volume, gap opens — all computed from real data already flowing, nothing fabricated):\n${lines.join(
    '\n',
  )}\n\nNOT YET DETECTED (roadmap, not a gap to guess around):\n${plannedBlock}\n\nThese events often precede significant moves but are not trade signals on their own — still apply the same confidence gating (<0.5 → don't act) and risk checks as everything else.`;
}
