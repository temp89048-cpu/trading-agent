import type { WatchItem } from './types';
import { checkCapability } from './providerCapabilities';

// ---------------------------------------------------------------------
// Raw data shapes (from /api/orderflow — Binance depth snapshot + recent
// aggregated trades). Kept separate from the computation functions below
// so the math here is pure and testable without a network call.
// ---------------------------------------------------------------------

export type DepthLevel = { price: number; qty: number };
export type AggTrade = { price: number; qty: number; time: number; buyerIsMaker: boolean };
export type RawOrderFlowData = { bids: DepthLevel[]; asks: DepthLevel[]; trades: AggTrade[] };

// ---------------------------------------------------------------------
// Bid/Ask imbalance + order book pressure
// ---------------------------------------------------------------------
// Sums resting size on both sides of the book within the top N levels
// (the levels closest to the current price — deep resting size far from
// price is less informative about immediate pressure) and expresses the
// imbalance as -1 (all ask-side) to +1 (all bid-side).

export type OrderBookPressure = {
  bidVolume: number;
  askVolume: number;
  imbalance: number; // -1..1, positive = bid-heavy
  pressure: 'buy-heavy' | 'sell-heavy' | 'balanced';
  levelsUsed: number;
  bestBid: number;
  bestAsk: number;
  spreadPct: number; // (bestAsk - bestBid) / bestBid * 100
};

const PRESSURE_BALANCED_THRESHOLD = 0.1; // |imbalance| below this reads as balanced, not a real lean
const DEFAULT_DEPTH_LEVELS = 20;

export function computeOrderBookPressure(bids: DepthLevel[], asks: DepthLevel[], levels: number = DEFAULT_DEPTH_LEVELS): OrderBookPressure | null {
  if (bids.length === 0 || asks.length === 0) return null;
  const topBids = bids.slice(0, levels);
  const topAsks = asks.slice(0, levels);
  const bidVolume = topBids.reduce((s, b) => s + b.qty, 0);
  const askVolume = topAsks.reduce((s, a) => s + a.qty, 0);
  const total = bidVolume + askVolume;
  if (total === 0) return null;
  const imbalance = (bidVolume - askVolume) / total;
  const pressure: OrderBookPressure['pressure'] =
    imbalance > PRESSURE_BALANCED_THRESHOLD ? 'buy-heavy' : imbalance < -PRESSURE_BALANCED_THRESHOLD ? 'sell-heavy' : 'balanced';
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
  return { bidVolume, askVolume, imbalance, pressure, levelsUsed: Math.min(topBids.length, levels), bestBid, bestAsk, spreadPct };
}

// ---------------------------------------------------------------------
// Aggressive buyer/seller flow
// ---------------------------------------------------------------------
// Binance's aggTrades `m` field (buyerIsMaker) tells you which side
// initiated the trade: if the buyer was the MAKER (resting order that
// got filled), the SELLER was the one who crossed the spread — i.e. the
// seller was aggressive. If buyerIsMaker is false, the buyer crossed the
// spread — the buyer was aggressive. This is the standard, unambiguous
// way to read aggressor side from Binance's trade stream.

export type AggressiveFlow = {
  aggressiveBuyVolume: number;
  aggressiveSellVolume: number;
  ratio: number; // -1..1, positive = buyers more aggressive
  dominant: 'buyers' | 'sellers' | 'balanced';
  tradeCount: number;
};

export function computeAggressiveFlow(trades: AggTrade[]): AggressiveFlow | null {
  if (trades.length === 0) return null;
  let aggressiveBuyVolume = 0;
  let aggressiveSellVolume = 0;
  for (const t of trades) {
    if (t.buyerIsMaker) aggressiveSellVolume += t.qty;
    else aggressiveBuyVolume += t.qty;
  }
  const total = aggressiveBuyVolume + aggressiveSellVolume;
  if (total === 0) return null;
  const ratio = (aggressiveBuyVolume - aggressiveSellVolume) / total;
  const dominant: AggressiveFlow['dominant'] = ratio > PRESSURE_BALANCED_THRESHOLD ? 'buyers' : ratio < -PRESSURE_BALANCED_THRESHOLD ? 'sellers' : 'balanced';
  return { aggressiveBuyVolume, aggressiveSellVolume, ratio, dominant, tradeCount: trades.length };
}

// ---------------------------------------------------------------------
// Large market order detection
// ---------------------------------------------------------------------
// A trade is "large" if its size is a real outlier versus the recent
// average, not just modestly above it — a fixed multiplier on the mean
// trade size in the sample, auditable back to that one number.

export type LargeOrder = { price: number; qty: number; time: number; side: 'buy' | 'sell' };

// A trade at MULTIPLIER-times the *median* trade size in the sample
// counts as "large." Median, not mean — the mean gets dragged up by the
// very outliers this is trying to detect, which is self-defeating in a
// small sample: one or two big prints inflate the average enough that
// they (or genuinely large trades near them) stop looking like outliers
// at all. Median stays anchored to "what a typical trade looks like"
// regardless of how many large prints are mixed in.
const LARGE_ORDER_MULTIPLIER = 5;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export function detectLargeOrders(trades: AggTrade[], multiplier: number = LARGE_ORDER_MULTIPLIER): LargeOrder[] {
  if (trades.length === 0) return [];
  const medianQty = median(trades.map((t) => t.qty));
  if (medianQty === 0) return [];
  return trades
    .filter((t) => t.qty >= medianQty * multiplier)
    .map((t) => ({ price: t.price, qty: t.qty, time: t.time, side: (t.buyerIsMaker ? 'sell' : 'buy') as 'buy' | 'sell' }))
    .sort((a, b) => b.time - a.time);
}

// ---------------------------------------------------------------------
// Combined snapshot + chat context injection
// ---------------------------------------------------------------------

export type OrderFlowSnapshot = {
  pressure: OrderBookPressure | null;
  flow: AggressiveFlow | null;
  largeOrders: LargeOrder[];
};

export function computeOrderFlow(data: RawOrderFlowData): OrderFlowSnapshot {
  return {
    pressure: computeOrderBookPressure(data.bids, data.asks),
    flow: computeAggressiveFlow(data.trades),
    largeOrders: detectLargeOrders(data.trades),
  };
}

export type OrderFlowLookup = (symbol: string) => RawOrderFlowData | undefined;

export function buildOrderFlowContext(watchlist: WatchItem[], lookup: OrderFlowLookup): string {
  if (watchlist.length === 0) return 'ORDER FLOW: no watchlist symbols to analyze.';

  const blocks: string[] = [];
  for (const item of watchlist) {
    const check = checkCapability(item, 'orderBook');
    if (!check.supported) {
      // Exactly the honest, explicit "Unsupported" shape — no estimate,
      // no fabricated number, just the reason and what would fix it.
      blocks.push(
        `${item.symbol}: Status: Unsupported. Reason: ${check.reason} ${check.recommendation ?? ''}`.trim(),
      );
      continue;
    }

    const raw = lookup(item.symbol);
    if (!raw) {
      blocks.push(`${item.symbol}: order flow data not loaded yet`);
      continue;
    }

    const snap = computeOrderFlow(raw);
    const parts: string[] = [];
    if (snap.pressure) {
      parts.push(
        `book pressure: ${snap.pressure.pressure} (bid ${snap.pressure.bidVolume.toFixed(2)} vs ask ${snap.pressure.askVolume.toFixed(2)} over top ${snap.pressure.levelsUsed} levels, imbalance ${(snap.pressure.imbalance * 100).toFixed(1)}%, spread ${snap.pressure.spreadPct.toFixed(3)}%)`,
      );
    } else {
      parts.push('book pressure: no depth data');
    }
    if (snap.flow) {
      parts.push(
        `aggressive flow: ${snap.flow.dominant} (buy vol ${snap.flow.aggressiveBuyVolume.toFixed(2)} vs sell vol ${snap.flow.aggressiveSellVolume.toFixed(2)} over last ${snap.flow.tradeCount} trades)`,
      );
    } else {
      parts.push('aggressive flow: no recent trade data');
    }
    if (snap.largeOrders.length > 0) {
      const top = snap.largeOrders.slice(0, 3);
      parts.push(`large orders detected: ${top.map((o) => `${o.side} ${o.qty.toFixed(3)} @ ${o.price.toFixed(2)}`).join(', ')}`);
    }
    blocks.push(`${item.symbol}: ${parts.join('; ')}`);
  }

  return `ORDER FLOW (real Binance depth snapshot + recent aggregated trades — crypto only, see DATA CAPABILITIES for why equities can't do this):\n${blocks.join(
    '\n',
  )}\n\n"Book pressure" is resting order imbalance (can vanish before it's ever hit). "Aggressive flow" is who's actually crossing the spread and paying to trade — the more informative of the two. Neither is a standalone signal.`;
}
