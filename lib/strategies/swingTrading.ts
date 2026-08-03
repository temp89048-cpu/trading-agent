import type { StrategyContext, StrategySignal } from '../strategyContext';

// Swing Trading Agent: works off 4h/1d — wants to enter a confirmed
// higher-timeframe trend specifically on a pullback or a recovery from
// one (Commit 8's "Pullback"/"Momentum Returning" states), not chase it
// while already extended. That's the classic swing entry: trend intact,
// price has come back to a better price within it.
export function runSwingTradingAgent(ctx: StrategyContext): StrategySignal {
  const fourHour = ctx.mtf.perTimeframe.find((t) => t.timeframe === '4h');
  const daily = ctx.mtf.perTimeframe.find((t) => t.timeframe === '1d');
  const higherTf = fourHour ?? daily;

  if (!higherTf) {
    return { agent: 'Swing Trading', signal: 'HOLD', confidence: 0.5, reason: '4h/1d data not available yet' };
  }

  const goodBullishEntry = higherTf.trend === 'bullish' && /Pullback|Momentum Returning/.test(higherTf.detail);
  const goodBearishEntry = higherTf.trend === 'bearish' && /Relief Bounce|Breakdown Resuming/.test(higherTf.detail);

  if (goodBullishEntry) {
    return {
      agent: 'Swing Trading',
      signal: 'BUY',
      confidence: 0.65,
      reason: `${higherTf.timeframe} trend bullish and currently "${higherTf.detail}" — a pullback entry within an intact uptrend, not chasing an extended move`,
    };
  }
  if (goodBearishEntry) {
    return {
      agent: 'Swing Trading',
      signal: 'SELL',
      confidence: 0.65,
      reason: `${higherTf.timeframe} trend bearish and currently "${higherTf.detail}" — a relief-bounce entry within an intact downtrend`,
    };
  }
  return {
    agent: 'Swing Trading',
    signal: 'HOLD',
    confidence: 0.5,
    reason: `${higherTf.timeframe} trend is ${higherTf.trend} but currently "${higherTf.detail}" — not the pullback/recovery entry this agent waits for`,
  };
}
