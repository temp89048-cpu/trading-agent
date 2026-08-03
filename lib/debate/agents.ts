import type { StrategyContext } from '../strategyContext';
import type { SentimentResult } from '../sentimentAgent';
import { runTrendFollowingAgent } from '../strategies/trendFollowing';
import { runMomentumAgent as computeMomentumSignal } from '../strategies/momentum';
import { runMeanReversionAgent as computeMeanReversionSignal } from '../strategies/meanReversion';
import { runBreakoutAgent as computeBreakoutSignal } from '../strategies/breakout';
import { AGENT_LABELS, type AgentOpinion } from './types';

// Each function below reuses the EXISTING Commit 12 strategy function for
// the actual signal + confidence (no re-deriving that math), then builds
// a fresh, richer evidence list straight from the same StrategyContext
// fields that strategy already looked at — the one-line "reason" string
// those agents return is fine for a quick log line, but a debate needs
// several concrete, independently-checkable bullets.

export function runTrendDebateAgent(ctx: StrategyContext): AgentOpinion {
  const signal = runTrendFollowingAgent(ctx);
  const evidence: string[] = [];
  if (ctx.ema20 !== null && ctx.ema50 !== null) {
    evidence.push(`EMA20 ${ctx.ema20 > ctx.ema50 ? 'above' : 'below'} EMA50 (${ctx.ema20.toFixed(2)} vs ${ctx.ema50.toFixed(2)})`);
  }
  evidence.push(`Market structure trend: ${ctx.structure.currentTrend}`);
  if (ctx.structure.events.length > 0) {
    const last = ctx.structure.events[ctx.structure.events.length - 1];
    evidence.push(`Last structure event: ${last.type} (${last.direction})`);
  }
  const mtfAgreeing = ctx.mtf.perTimeframe.filter((t) => t.trend === (ctx.ema20 !== null && ctx.ema50 !== null && ctx.ema20 > ctx.ema50 ? 'bullish' : 'bearish')).length;
  if (ctx.mtf.perTimeframe.length > 0) evidence.push(`${mtfAgreeing}/${ctx.mtf.perTimeframe.length} timeframes agree with this direction`);
  if (evidence.length === 0) evidence.push('Insufficient indicator history to point to specific evidence yet.');

  return { agent: 'trend', label: AGENT_LABELS.trend, recommendation: signal.signal, confidence: signal.confidence, evidence };
}

export function runMomentumDebateAgent(ctx: StrategyContext): AgentOpinion {
  const signal = computeMomentumSignal(ctx);
  const evidence: string[] = [];
  if (ctx.rsiValue !== null) evidence.push(`RSI at ${ctx.rsiValue.toFixed(1)}${ctx.rsiValue > 55 ? ' (rising momentum)' : ctx.rsiValue < 45 ? ' (weak momentum)' : ' (neutral)'}`);
  if (ctx.macdValue) evidence.push(`MACD histogram ${ctx.macdValue.histogram >= 0 ? 'positive' : 'negative'} (${ctx.macdValue.histogram.toFixed(3)})`);
  if (ctx.candles.length >= 10) {
    const recentVol = ctx.candles.slice(-5).reduce((s, c) => s + c.v, 0) / 5;
    const priorVol = ctx.candles.slice(-10, -5).reduce((s, c) => s + c.v, 0) / 5;
    if (priorVol > 0) evidence.push(`Volume ${recentVol > priorVol ? 'increasing' : 'decreasing'} (${(((recentVol - priorVol) / priorVol) * 100).toFixed(0)}% vs prior 5 bars)`);
  }
  if (evidence.length === 0) evidence.push('Insufficient indicator history to point to specific evidence yet.');

  return { agent: 'momentum', label: AGENT_LABELS.momentum, recommendation: signal.signal, confidence: signal.confidence, evidence };
}

export function runMeanReversionDebateAgent(ctx: StrategyContext): AgentOpinion {
  const signal = computeMeanReversionSignal(ctx);
  const evidence: string[] = [];
  if (ctx.bb) {
    const pctB = (ctx.price - ctx.bb.lower) / (ctx.bb.upper - ctx.bb.lower || 1);
    evidence.push(`Price at ${(pctB * 100).toFixed(0)}% of Bollinger range${pctB > 0.9 ? ' (near upper band)' : pctB < 0.1 ? ' (near lower band)' : ''}`);
  }
  if (ctx.rsiValue !== null) evidence.push(`RSI ${ctx.rsiValue.toFixed(1)}${ctx.rsiValue > 70 ? ' (overbought)' : ctx.rsiValue < 30 ? ' (oversold)' : ''}`);
  if (evidence.length === 0) evidence.push('Insufficient indicator history to point to specific evidence yet.');

  return { agent: 'meanReversion', label: AGENT_LABELS.meanReversion, recommendation: signal.signal, confidence: signal.confidence, evidence };
}

export function runBreakoutDebateAgent(ctx: StrategyContext): AgentOpinion {
  const signal = computeBreakoutSignal(ctx);
  const evidence: string[] = [];
  if (ctx.structure.events.length > 0) {
    const last = ctx.structure.events[ctx.structure.events.length - 1];
    evidence.push(`Recent ${last.type} (${last.direction})`);
  }
  if (ctx.liquidity.zones.length > 0) {
    const nearest = ctx.liquidity.zones.reduce((a, b) => (Math.abs(a.level - ctx.price) < Math.abs(b.level - ctx.price) ? a : b));
    evidence.push(`Nearest liquidity zone at ${nearest.level.toFixed(2)} (${nearest.type})`);
  }
  if (ctx.volumeProfile) evidence.push(`POC ${ctx.volumeProfile.poc.toFixed(2)}, price ${ctx.price > ctx.volumeProfile.vah ? 'above VAH' : ctx.price < ctx.volumeProfile.val ? 'below VAL' : 'inside value area'}`);
  if (evidence.length === 0) evidence.push('Insufficient structure/volume history to point to specific evidence yet.');

  return { agent: 'breakout', label: AGENT_LABELS.breakout, recommendation: signal.signal, confidence: signal.confidence, evidence };
}

export function runNewsDebateAgent(sentiment: SentimentResult | null): AgentOpinion {
  if (!sentiment) {
    return { agent: 'news', label: AGENT_LABELS.news, recommendation: 'HOLD', confidence: 0.5, evidence: ['No news/sentiment data loaded yet for this symbol.'] };
  }
  const recommendation = sentiment.sentiment === 'Bullish' ? 'BUY' : sentiment.sentiment === 'Bearish' ? 'SELL' : 'HOLD';
  const evidence = sentiment.reasons.length > 0 ? [...sentiment.reasons] : ['No specific bullish/bearish signals found in current headlines.'];
  if (sentiment.riskNote) evidence.push(sentiment.riskNote);
  return { agent: 'news', label: AGENT_LABELS.news, recommendation, confidence: sentiment.confidence / 100, evidence };
}

// No dedicated Commit-12 strategy exists for volatility specifically —
// this is new logic, kept simple and honest: it reads current volatility
// (ATR relative to price) and Bollinger-band position to flag when
// conditions favor a FADE (price stretched to a band extreme while
// volatility is elevated) versus just describing the current regime
// when nothing stretched is happening. It does not invent a trend
// opinion — trend is the Trend Agent's job.
export function runVolatilityDebateAgent(ctx: StrategyContext): AgentOpinion {
  const evidence: string[] = [];
  if (ctx.atrValue === null || ctx.price <= 0) {
    return { agent: 'volatility', label: AGENT_LABELS.volatility, recommendation: 'HOLD', confidence: 0.5, evidence: ['ATR not available yet — insufficient candle history.'] };
  }
  const atrPct = (ctx.atrValue / ctx.price) * 100;
  evidence.push(`ATR is ${atrPct.toFixed(2)}% of price`);

  let recommendation: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
  let confidence = 0.5;
  if (ctx.bb) {
    const pctB = (ctx.price - ctx.bb.lower) / (ctx.bb.upper - ctx.bb.lower || 1);
    const elevated = atrPct > 2;
    if (elevated && pctB > 0.95) {
      recommendation = 'SELL';
      confidence = 0.6;
      evidence.push('Price stretched to the upper Bollinger band during elevated volatility — fade risk.');
    } else if (elevated && pctB < 0.05) {
      recommendation = 'BUY';
      confidence = 0.6;
      evidence.push('Price stretched to the lower Bollinger band during elevated volatility — fade risk.');
    } else {
      evidence.push(elevated ? 'Volatility elevated but price not at a band extreme — no fade setup.' : 'Volatility within a normal range.');
    }
  } else {
    evidence.push('Bollinger Bands not available yet to assess band-extreme conditions.');
  }

  return { agent: 'volatility', label: AGENT_LABELS.volatility, recommendation, confidence, evidence };
}

export function runOrderFlowDebateAgent(ctx: StrategyContext): AgentOpinion {
  if (!ctx.orderFlow) {
    return { agent: 'orderFlow', label: AGENT_LABELS.orderFlow, recommendation: 'HOLD', confidence: 0.5, evidence: ['Order flow data not available for this asset (equities have no free L2 feed — see Commit 11 scoping).'] };
  }
  const evidence: string[] = [];
  let buySignals = 0;
  let sellSignals = 0;

  if (ctx.orderFlow.pressure) {
    const p = ctx.orderFlow.pressure;
    evidence.push(`Order book ${p.pressure} (imbalance ${(p.imbalance * 100).toFixed(0)}%)`);
    if (p.pressure === 'buy-heavy') buySignals++;
    else if (p.pressure === 'sell-heavy') sellSignals++;
  }
  if (ctx.orderFlow.flow) {
    const f = ctx.orderFlow.flow;
    evidence.push(`Aggressive flow dominated by ${f.dominant} (ratio ${(f.ratio * 100).toFixed(0)}%, ${f.tradeCount} trades)`);
    if (f.dominant === 'buyers') buySignals++;
    else if (f.dominant === 'sellers') sellSignals++;
  }
  if (ctx.orderFlow.largeOrders.length > 0) {
    const buys = ctx.orderFlow.largeOrders.filter((o) => o.side === 'buy').length;
    const sells = ctx.orderFlow.largeOrders.length - buys;
    evidence.push(`${ctx.orderFlow.largeOrders.length} large order(s) recently: ${buys} buy-side, ${sells} sell-side`);
  }
  if (evidence.length === 0) evidence.push('Order flow data present but empty (no recent depth/trade snapshot).');

  const recommendation: 'BUY' | 'SELL' | 'HOLD' = buySignals > sellSignals ? 'BUY' : sellSignals > buySignals ? 'SELL' : 'HOLD';
  const confidence = buySignals === sellSignals ? 0.5 : 0.5 + Math.min(0.25, Math.abs(buySignals - sellSignals) * 0.125);

  return { agent: 'orderFlow', label: AGENT_LABELS.orderFlow, recommendation, confidence, evidence };
}

export function runAllDebateAgents(ctx: StrategyContext, sentiment: SentimentResult | null): AgentOpinion[] {
  return [
    runTrendDebateAgent(ctx),
    runMomentumDebateAgent(ctx),
    runMeanReversionDebateAgent(ctx),
    runBreakoutDebateAgent(ctx),
    runNewsDebateAgent(sentiment),
    runVolatilityDebateAgent(ctx),
    runOrderFlowDebateAgent(ctx),
  ];
}
