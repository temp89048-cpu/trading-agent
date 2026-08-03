import type { PlannedAgentStatus } from '../strategyEnsemble';
import { computeSpread, EXCHANGE_LABELS, type ExchangeId, type MultiExchangeSnapshot } from '../multiExchange';
import type { StrategyContext, StrategySignal } from '../strategyContext';
import type { WatchItem } from '../types';

// Arbitrage Agent — detection is now real (Commit 21), execution
// remains Status: Planned.
//
// Correction from the original Commit 12 scoping note: multi-exchange
// price data (lib/multiExchange.ts) genuinely unlocks OPPORTUNITY
// DETECTION — spotting a real cross-venue price discrepancy is now
// possible with real data, not fabricated. But detection and execution
// are separate problems, and this app still can't act on a detected
// spread: that needs capital already positioned on multiple exchanges,
// real order execution on each, and fee/transfer-time accounting this
// app doesn't have. Closing the detection half honestly doesn't mean
// pretending the execution half is closed too.
export const ARBITRAGE_STRATEGY_STATUS: PlannedAgentStatus = {
  agent: 'Arbitrage',
  status: 'planned',
  reason:
    'Commit 21 added real multi-exchange price feeds (lib/multiExchange.ts), which unlocks gross-spread OPPORTUNITY DETECTION below. Still Status: Planned for execution: capturing a real arbitrage needs capital already positioned across venues, simultaneous order execution on each, withdrawal/transfer-time accounting, and real fee netting — none of which this app has. Detection and execution are genuinely separate problems; this closes the first one, not both.',
  requiredComponents: [
    'Order execution on multiple exchanges simultaneously',
    'Capital already allocated/positioned across venues (no instant cross-exchange transfer exists)',
    'Withdrawal/deposit cost modeling and transfer time accounting',
    'Per-exchange fee calculation netted against the detected spread',
    'Latency measurement between venues',
    'Position synchronization across exchanges',
  ],
  complexity: 'High',
  plannedVersion: 'v2 / Future Release',
  recommendedProviders: ['Binance + Bybit + OKX + Kraken + Coinbase — all now wired for price via lib/multiExchange.ts'],
};

export type ArbitrageOpportunity = {
  symbol: string;
  buyExchange: ExchangeId;
  sellExchange: ExchangeId;
  buyPrice: number;
  sellPrice: number;
  grossSpreadPct: number;
};

// Purely a DETECTOR — surfaces a gross price discrepancy across venues
// that crosses `minSpreadPct`. "Gross" is the operative word: this is
// the spread BEFORE real trading fees, withdrawal fees, and transfer
// time on either leg, all of which typically erase most of a small
// spread. No execution ever follows from this — see
// ARBITRAGE_STRATEGY_STATUS above for exactly why not.
const DEFAULT_MIN_SPREAD_PCT = 0.3;

export function detectArbitrageOpportunity(snapshot: MultiExchangeSnapshot, minSpreadPct: number = DEFAULT_MIN_SPREAD_PCT): ArbitrageOpportunity | null {
  const spread = computeSpread(snapshot);
  if (!spread || spread.spreadPct < minSpreadPct) return null;
  return {
    symbol: snapshot.symbol,
    buyExchange: spread.minPrice.exchange,
    sellExchange: spread.maxPrice.exchange,
    buyPrice: spread.minPrice.price,
    sellPrice: spread.maxPrice.price,
    grossSpreadPct: spread.spreadPct,
  };
}

// Real, non-fake informational signal so Arbitrage actually casts a vote
// in the ensemble rather than being silently excluded — detection is
// genuinely real (Commit 21's multi-exchange feeds), even though
// execution remains Status: Planned (see above). The "trade idea" this
// agent can honestly offer is cross-exchange mean-reversion: if THIS
// context's own tracked price is the cheapest venue by >= minSpreadPct,
// that's a real (if weak/single-symbol) signal it may converge upward
// toward the other venues, and vice versa for the most expensive venue.
// Confidence is capped low and scales with the gross spread — this is
// one input among many, not a claim that the spread is tradeable after
// fees. Returns HOLD (never fabricates a call) whenever no snapshot is
// available at all.
const MAX_ARBITRAGE_CONFIDENCE = 0.4;

export function runArbitrageAgent(ctx: StrategyContext, snapshot: MultiExchangeSnapshot | null | undefined): StrategySignal {
  if (!snapshot) {
    return { agent: 'Arbitrage', signal: 'HOLD', confidence: 0.3, reason: 'No multi-exchange price snapshot loaded for this symbol yet — cross-venue spread can\'t be assessed.' };
  }
  const opp = detectArbitrageOpportunity(snapshot);
  if (!opp) {
    return { agent: 'Arbitrage', signal: 'HOLD', confidence: 0.3, reason: `No gross cross-exchange spread above ${DEFAULT_MIN_SPREAD_PCT}% detected across current venues.` };
  }
  const confidence = Math.min(MAX_ARBITRAGE_CONFIDENCE, 0.2 + opp.grossSpreadPct / 10);
  if (opp.buyPrice === ctx.price || Math.abs(opp.buyPrice - ctx.price) < Math.abs(opp.sellPrice - ctx.price)) {
    return {
      agent: 'Arbitrage',
      signal: 'BUY',
      confidence,
      reason: `${formatArbitrageOpportunity(opp)} This venue is on the cheap side — weak mean-reversion signal toward the other venues' price, not a claim the gross spread survives fees.`,
    };
  }
  return {
    agent: 'Arbitrage',
    signal: 'SELL',
    confidence,
    reason: `${formatArbitrageOpportunity(opp)} This venue is on the expensive side — weak mean-reversion signal toward the other venues' price, not a claim the gross spread survives fees.`,
  };
}

export function formatArbitrageOpportunity(opp: ArbitrageOpportunity): string {
  return `${opp.symbol}: buy on ${EXCHANGE_LABELS[opp.buyExchange]} ($${opp.buyPrice.toLocaleString()}), sell on ${EXCHANGE_LABELS[opp.sellExchange]} ($${opp.sellPrice.toLocaleString()}) — ${opp.grossSpreadPct.toFixed(3)}% GROSS spread (before fees/withdrawal/transfer time — detection only, no execution path exists in this app).`;
}

// ---------------------------------------------------------------------
// Chat context injection.
// ---------------------------------------------------------------------
export function buildArbitrageContext(snapshots: Record<string, MultiExchangeSnapshot | undefined>, watchlist: WatchItem[]): string {
  const cryptoItems = watchlist.filter((w) => w.type === 'crypto');
  if (cryptoItems.length === 0) return 'ARBITRAGE DETECTOR: no crypto watchlist symbols (crypto-only feature).';

  const opportunities: string[] = [];
  for (const item of cryptoItems) {
    const snap = snapshots[item.symbol];
    if (!snap) continue;
    const opp = detectArbitrageOpportunity(snap);
    if (opp) opportunities.push(`  ${formatArbitrageOpportunity(opp)}`);
  }

  return `ARBITRAGE DETECTOR (gross cross-exchange spread >= ${DEFAULT_MIN_SPREAD_PCT}%, detection only — see roadmap below for why this never executes):\n${
    opportunities.length > 0 ? opportunities.join('\n') : '  no gross spread above threshold detected across current venues'
  }`;
}
