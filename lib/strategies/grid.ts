import type { PlannedAgentStatus } from '../strategyEnsemble';
import type { StrategyContext, StrategySignal } from '../strategyContext';

// Grid Strategy Agent — Status: Planned, not "unsupported."
//
// Correction from the original scoping: grid trading does NOT inherently
// need multi-exchange data. A grid bot works entirely on one exchange
// (Binance, already integrated for candles/order flow in this app) —
// what it actually needs is execution infrastructure this app doesn't
// have yet: persistent order placement/tracking, fill monitoring, and
// position management, not more market data sources.
export const GRID_STRATEGY_STATUS: PlannedAgentStatus = {
  agent: 'Grid Strategy',
  status: 'planned',
  reason:
    'Requires persistent live market data, exchange order execution, order tracking, and position management. ' +
    'The current application does not yet include the execution infrastructure needed for an automated grid ' +
    'trading engine — this is an execution-layer gap, not a data-source gap.',
  requiredComponents: [
    'Live WebSocket price streams (this app currently polls REST for candles, not a persistent stream)',
    'Real-time order execution against an exchange API',
    'Open order tracking',
    'Order fill monitoring',
    'Position management',
    'Exchange fee calculation',
    'Grid persistence (a real database — this app currently keeps trades in a flat file)',
    'Automatic restart after crashes',
    'Partial fill handling',
  ],
  complexity: 'High',
  plannedVersion: 'v2 / Future Release',
  recommendedProviders: ['Binance (already integrated in this app for candles + order flow — no new exchange needed)'],
};

// Real, non-fake informational signal so Grid actually casts a vote in
// the ensemble (Level 2's "each agent can independently produce a trade
// idea") rather than being silently excluded. It can genuinely assess
// whether CONDITIONS favor a grid (range-bound, no confirmed trend, real
// volatility to harvest) using the same structure/ATR data every other
// agent reads — what it can NOT do is actually place the grid's ladder
// of orders, so it always votes HOLD (zero weight in the BUY/SELL
// consensus) rather than fabricating a directional call it can't act on.
export function runGridAgent(ctx: StrategyContext): StrategySignal {
  const noTrend = ctx.structure.currentTrend === 'undefined';
  const atrPct = ctx.atrValue !== null && ctx.price > 0 ? (ctx.atrValue / ctx.price) * 100 : null;
  const hasVolatility = atrPct !== null && atrPct >= 0.5; // enough real range to harvest between grid levels

  if (noTrend && hasVolatility) {
    return {
      agent: 'Grid Strategy',
      signal: 'HOLD',
      confidence: 0.5,
      reason: `Conditions look grid-favorable (no confirmed trend, ATR ~${atrPct!.toFixed(2)}% of price) — but this app has no order-execution infrastructure to actually run a grid (Status: Planned), so no directional call is made.`,
    };
  }
  if (!noTrend) {
    return {
      agent: 'Grid Strategy',
      signal: 'HOLD',
      confidence: 0.5,
      reason: `Structure shows a confirmed ${ctx.structure.currentTrend} trend — not grid-favorable conditions (a trending market runs through grid levels instead of oscillating). Execution infrastructure is also still Status: Planned.`,
    };
  }
  return {
    agent: 'Grid Strategy',
    signal: 'HOLD',
    confidence: 0.5,
    reason: `No confirmed trend, but realized volatility is too low (ATR ~${atrPct !== null ? atrPct.toFixed(2) : 'n/a'}% of price) for grid levels to be worth harvesting. Execution infrastructure is also still Status: Planned.`,
  };
}
