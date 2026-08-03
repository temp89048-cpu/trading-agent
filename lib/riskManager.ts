import type { StrategyContext } from './strategyContext';
import type { TradeLogEntry, TradeTab, WatchItem } from './types';
import { fixedFractionalSize, volatilityBasedSize, capToMaxExposure, kellyFraction, type SizingResult } from './positionSizing';
import { relevantHeadlines, type NewsItem } from './sentimentAgent';
import { getCorrelation, type CorrelationMatrix } from './portfolioIntelligence';

// ---------------------------------------------------------------------
// Dynamic Stop Loss / Take Profit
// ---------------------------------------------------------------------
// No fixed-pip/fixed-% stop. The stop distance comes from whichever of
// these is available and sane, in priority order:
//   1. The nearest swing high/low AGAINST the trade (Commit 9) — the
//      structurally meaningful level: if it breaks, the setup's thesis
//      is wrong, not just "price moved."
//   2. ATR-based distance (Commit 8's indicator stack) — used as both a
//      fallback when no swing exists AND a floor: a structural stop
//      closer than ATR_FLOOR_MULTIPLIER x ATR is almost certainly just
//      noise-distance, not a real level, so it gets widened to the ATR
//      floor instead of trusted as-is.
// Take profit is then set at a fixed reward:risk multiple of whatever
// the final stop distance is — 2R by default, a conservative, common
// default rather than anything asset-specific.
const ATR_FLOOR_MULTIPLIER = 1.2;
const ATR_FALLBACK_MULTIPLIER = 1.8; // wider than the floor, since a pure-ATR stop has no structural backing at all
const DEFAULT_REWARD_RISK_RATIO = 2;

export type StopLossTakeProfit = {
  stopLoss: number;
  takeProfit: number;
  stopDistance: number;
  method: string;
};

export function computeStopLossTakeProfit(
  ctx: StrategyContext,
  side: 'buy' | 'sell',
  rewardRiskRatio: number = DEFAULT_REWARD_RISK_RATIO,
): StopLossTakeProfit | null {
  const { price, atrValue, structure } = ctx;
  if (atrValue === null || atrValue <= 0) return null; // no volatility read at all — can't set anything defensible

  const swingLevel = side === 'buy' ? structure.lastSwingLow?.price : structure.lastSwingHigh?.price;
  const atrFloorDistance = atrValue * ATR_FLOOR_MULTIPLIER;

  let stopDistance: number;
  let method: string;

  if (swingLevel !== undefined) {
    const swingDistance = Math.abs(price - swingLevel);
    if (swingDistance >= atrFloorDistance) {
      stopDistance = swingDistance;
      method = `structural stop at nearest swing ${side === 'buy' ? 'low' : 'high'} (${swingLevel.toFixed(2)})`;
    } else {
      // Swing is real but too close to be a sane stop — widen to the
      // ATR floor rather than trust a level that's basically noise-
      // distance away (would get stopped out by normal chop).
      stopDistance = atrFloorDistance;
      method = `swing level too close (${swingDistance.toFixed(2)} < ${ATR_FLOOR_MULTIPLIER}x ATR) — widened to ATR floor`;
    }
  } else {
    stopDistance = atrValue * ATR_FALLBACK_MULTIPLIER;
    method = `no swing level available — ATR-based stop (${ATR_FALLBACK_MULTIPLIER}x ATR, no structural backing)`;
  }

  const stopLoss = side === 'buy' ? price - stopDistance : price + stopDistance;
  const takeProfit = side === 'buy' ? price + stopDistance * rewardRiskRatio : price - stopDistance * rewardRiskRatio;
  return { stopLoss, takeProfit, stopDistance, method };
}

// ---------------------------------------------------------------------
// Rejection rules
// ---------------------------------------------------------------------
export type RiskCheck = { ok: boolean; status: 'pass' | 'reject' | 'unavailable'; detail: string };

const MAX_RISK_PCT_PER_TRADE = 0.02;
const MAX_DAILY_LOSS_PCT = 0.05;
const MAX_DRAWDOWN_PCT = 0.15;
const MAX_SPREAD_PCT = 0.5;
const MIN_BOOK_DEPTH_MULTIPLE = 3; // visible top-of-book depth should be at least this multiple of the requested size
// A stop-distance-to-liquidation buffer: with leverage L, roughly a
// 100/L% adverse move wipes out margin. If the stop-loss distance
// (as % of price) is wider than that threshold, the position can get
// liquidated by the exchange before your OWN stop-loss ever fires —
// the stop becomes decorative. This multiplier requires the stop to sit
// safely inside the liquidation distance, not right up against it.
const LIQUIDATION_SAFETY_BUFFER = 1.5;
const MAX_PORTFOLIO_EXPOSURE_PCT = 0.75; // total value of ALL open positions (existing + this one), vs a single position's own cap
const CORRELATION_REJECT_THRESHOLD_DEFAULT = 0.75;
const CORRELATION_EXPOSURE_LIMIT_PCT_DEFAULT = 0.4;

// Human-in-the-loop configurable risk limits (Production Readiness
// Review #17). Every field here defaults to the exact hardcoded values
// above/below, so a caller that never supplies a RiskConfig gets
// identical behavior to before this was configurable. Values live in
// components/TradingControls.tsx (a small localStorage-backed provider,
// separate from the main Config/Settings object since it needs to be
// readable from Supervisor.tsx, which sits above AppStateProvider in the
// component tree — see that file's own comment for why).
export type RiskConfig = {
  maxRiskPctPerTrade: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  maxSpreadPct: number;
  minBookDepthMultiple: number;
  liquidationSafetyBuffer: number;
  maxPortfolioExposurePct: number;
  correlationRejectThreshold: number;
  correlationExposureLimitPct: number;
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxRiskPctPerTrade: MAX_RISK_PCT_PER_TRADE,
  maxDailyLossPct: MAX_DAILY_LOSS_PCT,
  maxDrawdownPct: MAX_DRAWDOWN_PCT,
  maxSpreadPct: MAX_SPREAD_PCT,
  minBookDepthMultiple: MIN_BOOK_DEPTH_MULTIPLE,
  liquidationSafetyBuffer: LIQUIDATION_SAFETY_BUFFER,
  maxPortfolioExposurePct: MAX_PORTFOLIO_EXPOSURE_PCT,
  correlationRejectThreshold: CORRELATION_REJECT_THRESHOLD_DEFAULT,
  correlationExposureLimitPct: CORRELATION_EXPOSURE_LIMIT_PCT_DEFAULT,
};

export function checkPositionRisk(
  equityUsd: number | null,
  requestedQty: number,
  entryPrice: number,
  stopLoss: number,
  maxRiskPctPerTrade: number = DEFAULT_RISK_CONFIG.maxRiskPctPerTrade,
): RiskCheck {
  if (equityUsd === null) {
    return { ok: true, status: 'unavailable', detail: 'Real-tab positions have no tracked cash/equity in this app — risk-as-%-of-equity can\'t be computed. Sizing and SL/TP are still enforced; this one check is skipped honestly rather than guessed.' };
  }
  const riskUsd = requestedQty * Math.abs(entryPrice - stopLoss);
  const riskPct = equityUsd > 0 ? riskUsd / equityUsd : Infinity;
  if (riskPct > maxRiskPctPerTrade) {
    return { ok: false, status: 'reject', detail: `Requested size risks $${riskUsd.toFixed(2)} (${(riskPct * 100).toFixed(1)}% of equity) — exceeds the ${(maxRiskPctPerTrade * 100).toFixed(0)}% max risk per trade` };
  }
  return { ok: true, status: 'pass', detail: `Risk $${riskUsd.toFixed(2)} (${(riskPct * 100).toFixed(2)}% of equity) — within the ${(maxRiskPctPerTrade * 100).toFixed(0)}% limit` };
}

// Daily loss / drawdown are both derived from the REALIZED P&L already
// recorded in the trade log (TradeLogEntry.pnl), reconstructed into a
// simple running-equity curve anchored at the paper account's starting
// cash. This intentionally does not include unrealized P&L on currently
// open positions — a documented approximation, not a silent one.
export const PAPER_STARTING_EQUITY = 25000;

// Exported so live performance analytics (Production Readiness Review
// #12) can reuse the exact same realized-equity reconstruction that
// feeds the daily-loss/drawdown checks, rather than re-deriving equity
// from the trade log a second, possibly-inconsistent way.
export function buildRealizedEquityCurve(tradeLog: TradeLogEntry[], tab: TradeTab): { ts: number; equity: number }[] {
  const closedSorted = tradeLog
    .filter((t) => t.tab === tab && typeof t.pnl === 'number')
    .sort((a, b) => a.ts - b.ts);
  let running = PAPER_STARTING_EQUITY;
  const curve = [{ ts: 0, equity: running }];
  for (const t of closedSorted) {
    running += t.pnl as number;
    curve.push({ ts: t.ts, equity: running });
  }
  return curve;
}

// Kelly-derived risk cap: an evidence-based cross-check on top of the
// fixed MAX_RISK_PCT_PER_TRADE ceiling. Kelly can only ever SHRINK the
// per-trade risk %, never grow it past the app's existing hard cap —
// consistent with every other check in this file (a computed edge
// estimate governs sizing down, it does not get to override the
// fixed governance rule upward, no matter how good the trade history
// looks).
export function computeKellyRiskCap(
  tradeLog: TradeLogEntry[],
  tab: TradeTab,
  maxRiskPctPerTrade: number = DEFAULT_RISK_CONFIG.maxRiskPctPerTrade,
): { riskPct: number; detail: string } {
  const closed = tradeLog.filter((t) => t.tab === tab && typeof t.pnl === 'number' && isFinite(t.pnl as number));
  const wins = closed.filter((t) => (t.pnl as number) > 0);
  const losses = closed.filter((t) => (t.pnl as number) < 0);
  if (wins.length === 0 || losses.length === 0) {
    return { riskPct: maxRiskPctPerTrade, detail: 'Kelly Criterion: not enough win/loss history yet — using the fixed max-risk-per-trade cap.' };
  }
  const winRate = wins.length / closed.length;
  const avgWinUsd = wins.reduce((sum, t) => sum + (t.pnl as number), 0) / wins.length;
  const avgLossUsd = Math.abs(losses.reduce((sum, t) => sum + (t.pnl as number), 0) / losses.length);
  const kelly = kellyFraction(closed.length, winRate, avgWinUsd, avgLossUsd);
  if (!kelly) {
    return { riskPct: maxRiskPctPerTrade, detail: `Kelly Criterion: no positive edge detected across ${closed.length} closed trades (win rate ${(winRate * 100).toFixed(0)}%) — using the fixed max-risk-per-trade cap rather than sizing up.` };
  }
  if (kelly.fraction < maxRiskPctPerTrade) {
    return { riskPct: kelly.fraction, detail: `Kelly Criterion: half-Kelly implies ${(kelly.fraction * 100).toFixed(2)}% risk/trade (win rate ${(winRate * 100).toFixed(0)}%, payoff ${(avgWinUsd / avgLossUsd).toFixed(2)}:1 across ${closed.length} closed trades) — tighter than the fixed cap, so sizing is reduced to match the real edge.` };
  }
  return { riskPct: maxRiskPctPerTrade, detail: `Kelly Criterion: half-Kelly implies ${(kelly.fraction * 100).toFixed(2)}% risk/trade — looser than the fixed ${(maxRiskPctPerTrade * 100).toFixed(0)}% cap, so the fixed cap still governs (Kelly can only shrink sizing, never grow it).` };
}

export function checkDailyLoss(
  tradeLog: TradeLogEntry[],
  tab: TradeTab,
  nowMs: number = Date.now(),
  maxDailyLossPct: number = DEFAULT_RISK_CONFIG.maxDailyLossPct,
): RiskCheck {
  if (tab !== 'paper') {
    return { ok: true, status: 'unavailable', detail: 'Daily loss tracking needs a starting equity baseline, which only the paper tab has — skipped for real.' };
  }
  const curve = buildRealizedEquityCurve(tradeLog, tab);
  const currentEquity = curve[curve.length - 1].equity;
  const startOfDayMs = new Date(nowMs).setHours(0, 0, 0, 0);
  const beforeToday = [...curve].reverse().find((p) => p.ts > 0 && p.ts < startOfDayMs);
  const startOfDayEquity = beforeToday?.equity ?? curve[0].equity;
  const todayPnl = currentEquity - startOfDayEquity;

  if (startOfDayEquity <= 0) {
    // No meaningful baseline to measure a percentage loss against (the
    // account was already at or below zero at the start of the day) —
    // 'unavailable' is the honest answer here, not a silent 'pass' that
    // would let the daily-loss breaker go permanently inert the moment
    // equity ever touches zero.
    return { ok: true, status: 'unavailable', detail: `Start-of-day equity was $${startOfDayEquity.toFixed(2)} — no positive baseline to measure a daily loss percentage against.` };
  }
  if (todayPnl < 0) {
    const lossPct = -todayPnl / startOfDayEquity;
    if (lossPct > maxDailyLossPct) {
      return { ok: false, status: 'reject', detail: `Today's realized loss is $${(-todayPnl).toFixed(2)} (${(lossPct * 100).toFixed(1)}% of start-of-day equity) — exceeds the ${(maxDailyLossPct * 100).toFixed(0)}% daily loss limit` };
    }
  }
  return { ok: true, status: 'pass', detail: `Today's realized P&L: ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(2)}` };
}

export function checkDrawdown(
  tradeLog: TradeLogEntry[],
  tab: TradeTab,
  maxDrawdownPct: number = DEFAULT_RISK_CONFIG.maxDrawdownPct,
): RiskCheck {
  if (tab !== 'paper') {
    return { ok: true, status: 'unavailable', detail: 'Drawdown tracking needs an equity baseline, which only the paper tab has — skipped for real.' };
  }
  const curve = buildRealizedEquityCurve(tradeLog, tab);
  const peak = Math.max(...curve.map((p) => p.equity));
  const current = curve[curve.length - 1].equity;
  const drawdownPct = peak > 0 ? (peak - current) / peak : 0;
  if (drawdownPct > maxDrawdownPct) {
    return { ok: false, status: 'reject', detail: `Current drawdown from peak equity ($${peak.toFixed(2)}) is ${(drawdownPct * 100).toFixed(1)}% — exceeds the ${(maxDrawdownPct * 100).toFixed(0)}% max drawdown limit` };
  }
  return { ok: true, status: 'pass', detail: `Drawdown from peak: ${(drawdownPct * 100).toFixed(2)}%` };
}

export function checkLiquidity(
  ctx: StrategyContext,
  requestedQty: number,
  minBookDepthMultiple: number = DEFAULT_RISK_CONFIG.minBookDepthMultiple,
): RiskCheck {
  if (!ctx.orderFlow || !ctx.orderFlow.pressure) {
    return { ok: true, status: 'unavailable', detail: 'No order book data for this asset (see DATA CAPABILITIES) — liquidity relative to position size can\'t be checked.' };
  }
  const visibleDepth = ctx.orderFlow.pressure.bidVolume + ctx.orderFlow.pressure.askVolume;
  if (requestedQty * minBookDepthMultiple > visibleDepth) {
    return { ok: false, status: 'reject', detail: `Requested size (${requestedQty.toFixed(4)}) is too large relative to visible top-of-book depth (${visibleDepth.toFixed(4)}) — would likely move the book` };
  }
  return { ok: true, status: 'pass', detail: `Visible book depth ${visibleDepth.toFixed(4)} comfortably covers the requested size` };
}

export function checkSpread(ctx: StrategyContext, maxSpreadPct: number = DEFAULT_RISK_CONFIG.maxSpreadPct): RiskCheck {
  if (!ctx.orderFlow || !ctx.orderFlow.pressure) {
    return { ok: true, status: 'unavailable', detail: 'No order book data for this asset — spread can\'t be checked.' };
  }
  const spreadPct = ctx.orderFlow.pressure.spreadPct;
  if (spreadPct > maxSpreadPct) {
    return { ok: false, status: 'reject', detail: `Spread is ${spreadPct.toFixed(3)}% — exceeds the ${maxSpreadPct}% max spread threshold` };
  }
  return { ok: true, status: 'pass', detail: `Spread ${spreadPct.toFixed(3)}% is within the ${maxSpreadPct}% threshold` };
}

// Volatility-based leverage cap: derives the max leverage that still
// leaves LIQUIDATION_SAFETY_BUFFER of room between the stop-loss and the
// point the position would actually get liquidated. Wider stops (more
// volatile assets) => lower safe leverage; tighter stops => more
// leverage tolerable. This is what actually answers "how much leverage"
// rather than treating it as an unchecked input.
export function checkLeverage(
  entryPrice: number,
  stopLoss: number,
  requestedLeverage: number,
  liquidationSafetyBuffer: number = DEFAULT_RISK_CONFIG.liquidationSafetyBuffer,
): RiskCheck {
  if (requestedLeverage <= 1) {
    return { ok: true, status: 'pass', detail: 'No leverage requested (1x) — liquidation-distance check not applicable' };
  }
  const stopDistancePct = (Math.abs(entryPrice - stopLoss) / entryPrice) * 100;
  if (stopDistancePct <= 0) {
    return { ok: false, status: 'reject', detail: 'Stop distance is zero — cannot safely apply leverage' };
  }
  const maxSafeLeverage = 100 / (stopDistancePct * liquidationSafetyBuffer);
  if (requestedLeverage > maxSafeLeverage) {
    return {
      ok: false,
      status: 'reject',
      detail: `${requestedLeverage}x leverage with a ${stopDistancePct.toFixed(2)}% stop distance leaves less than the required ${liquidationSafetyBuffer}x safety buffer before liquidation — the stop-loss could get liquidated through before it ever fires. Max safe leverage here is ~${maxSafeLeverage.toFixed(1)}x.`,
    };
  }
  return { ok: true, status: 'pass', detail: `${requestedLeverage}x leverage leaves a ${(maxSafeLeverage / requestedLeverage).toFixed(1)}x safety buffer before liquidation given the ${stopDistancePct.toFixed(2)}% stop distance` };
}

// Portfolio exposure: distinct from capToMaxExposure (which caps ONE
// position's size). This checks the TOTAL value of every open position
// plus the one being requested against equity — a person can pass the
// single-position cap on every individual trade and still end up
// massively over-exposed in aggregate across many small positions.
export function checkPortfolioExposure(
  existingExposureUsd: number | null,
  newPositionValueUsd: number,
  equityUsd: number | null,
  maxPortfolioExposurePct: number = DEFAULT_RISK_CONFIG.maxPortfolioExposurePct,
): RiskCheck {
  if (existingExposureUsd === null || equityUsd === null) {
    return { ok: true, status: 'unavailable', detail: 'Portfolio exposure needs a tracked equity/position baseline, which only the paper tab has — skipped for real.' };
  }
  const totalExposure = existingExposureUsd + newPositionValueUsd;
  const exposurePct = equityUsd > 0 ? totalExposure / equityUsd : Infinity;
  if (exposurePct > maxPortfolioExposurePct) {
    return {
      ok: false,
      status: 'reject',
      detail: `Total portfolio exposure would be $${totalExposure.toFixed(2)} (${(exposurePct * 100).toFixed(0)}% of equity) — exceeds the ${(maxPortfolioExposurePct * 100).toFixed(0)}% max portfolio exposure limit, even though this single position alone may be within its own cap`,
    };
  }
  return { ok: true, status: 'pass', detail: `Total portfolio exposure would be ${(exposurePct * 100).toFixed(1)}% of equity — within the ${(maxPortfolioExposurePct * 100).toFixed(0)}% limit` };
}

// Real implementation, replacing the earlier honest stub now that
// Commit 14 wires up actual news data. Deliberately does NOT hard-reject
// a trade on breaking news the way the other checks do — it reduces the
// recommended size instead, per the exact behavior asked for: high-
// importance news in the event window → Risk: Increase, Action: reduce
// position size by 40%, not "block the trade outright." A crude keyword
// scan for importance, not real NLP — documented as exactly that, same
// as the sentiment agent's keyword scan.
const NEWS_EVENT_WINDOW_MINUTES = 90;
const NEWS_SIZE_REDUCTION_MULTIPLIER = 0.6; // "reduce position size by 40%"
const HIGH_IMPORTANCE_KEYWORDS = [
  'hack', 'exploit', 'hacked', 'sec charges', 'lawsuit', 'halt', 'bankrupt', 'bankruptcy',
  'emergency', 'regulation', 'banned', 'delist', 'investigation', 'rejected', 'etf approval', 'approved',
];

export type NewsCheck = RiskCheck & { sizeMultiplier: number; matchedHeadline: string | null };

export function checkNews(headlines: NewsItem[], symbol: string, nowMs: number = Date.now(), windowMinutes: number = NEWS_EVENT_WINDOW_MINUTES): NewsCheck {
  if (headlines.length === 0) {
    return { ok: true, status: 'unavailable', detail: 'No news feed data loaded yet — breaking-news event window can\'t be checked.', sizeMultiplier: 1, matchedHeadline: null };
  }

  const relevant = relevantHeadlines(symbol, headlines);
  const windowMs = windowMinutes * 60_000;
  const recentImportant = relevant.find((h) => {
    if (!h.pubDate) return false;
    const age = nowMs - Date.parse(h.pubDate);
    if (Number.isNaN(age) || age < 0 || age > windowMs) return false;
    const title = h.title.toLowerCase();
    return HIGH_IMPORTANCE_KEYWORDS.some((k) => title.includes(k));
  });

  if (recentImportant) {
    return {
      ok: true,
      status: 'pass',
      detail: `Breaking news within the last ${windowMinutes} min: "${recentImportant.title}" (${recentImportant.source}). Importance: High. Risk: Increase. Action: recommended size reduced ${((1 - NEWS_SIZE_REDUCTION_MULTIPLIER) * 100).toFixed(0)}%.`,
      sizeMultiplier: NEWS_SIZE_REDUCTION_MULTIPLIER,
      matchedHeadline: recentImportant.title,
    };
  }
  return { ok: true, status: 'pass', detail: `No high-importance breaking news for this symbol within the last ${windowMinutes} minutes`, sizeMultiplier: 1, matchedHeadline: null };
}

// Real implementation, replacing the earlier honest Commit 13 stub now
// that Commit 21 wires up lib/portfolioIntelligence.ts's correlation
// matrix. Still fails honestly to 'unavailable' when the inputs it
// actually needs aren't supplied (a matrix, an equity baseline) — same
// standard as every other "not yet computable" check in this file,
// not a silent pass.
export type CorrelationInputs = {
  matrix: CorrelationMatrix;
  // Existing open positions EXCLUDING the symbol being traded — adding
  // to an already-held position is a sizing question (checkPositionRisk,
  // checkPortfolioExposure), not a diversification-via-correlation one.
  existingPositions: { symbol: string; valueUsd: number }[];
  equityUsd: number | null;
};

export function checkCorrelation(
  symbol: string,
  newPositionValueUsd: number,
  inputs?: CorrelationInputs | null,
  correlationRejectThreshold: number = DEFAULT_RISK_CONFIG.correlationRejectThreshold,
  correlationExposureLimitPct: number = DEFAULT_RISK_CONFIG.correlationExposureLimitPct,
): RiskCheck {
  if (!inputs || inputs.equityUsd === null || inputs.equityUsd <= 0) {
    return { ok: true, status: 'unavailable', detail: 'Correlation check needs a cross-asset correlation matrix and a tracked equity baseline (only the paper tab has both, and only once enough watchlist price history is cached) — skipped honestly rather than guessed.' };
  }
  const { matrix, existingPositions, equityUsd } = inputs;
  const correlatedHoldings = existingPositions
    .map((p) => ({ ...p, correlation: getCorrelation(matrix, symbol, p.symbol) }))
    .filter((p): p is typeof p & { correlation: number } => p.correlation !== null && p.correlation >= correlationRejectThreshold);

  if (correlatedHoldings.length === 0) {
    return { ok: true, status: 'pass', detail: `No existing position correlates highly (>= ${correlationRejectThreshold}) with ${symbol} given available price history.` };
  }

  const combinedExisting = correlatedHoldings.reduce((sum, p) => sum + p.valueUsd, 0);
  const combinedPct = (combinedExisting + newPositionValueUsd) / equityUsd;
  if (combinedPct > correlationExposureLimitPct) {
    const names = correlatedHoldings.map((p) => `${p.symbol} (corr ${p.correlation.toFixed(2)})`).join(', ');
    return {
      ok: false,
      status: 'reject',
      detail: `This position would bring combined exposure to highly-correlated holdings (${names}) to ${(combinedPct * 100).toFixed(0)}% of equity — exceeds the ${(correlationExposureLimitPct * 100).toFixed(0)}% concentrated-correlation limit.`,
    };
  }
  return {
    ok: true,
    status: 'pass',
    detail: `Correlated holdings exist but combined exposure (${(combinedPct * 100).toFixed(1)}%) is within the ${(correlationExposureLimitPct * 100).toFixed(0)}% limit.`,
  };
}

// ---------------------------------------------------------------------
// Combined validation — the single gate every execution call site
// routes through.
// ---------------------------------------------------------------------
export type RiskValidation = {
  approved: boolean;
  stopLossTakeProfit: StopLossTakeProfit | null;
  recommendedSize: SizingResult | null;
  checks: Record<string, RiskCheck>;
  rejectionReasons: string[];
  cautionNotes: string[]; // 'unavailable' checks — visible, not blocking
};

export function buildRiskContext(
  watchlist: WatchItem[],
  lookup: (item: WatchItem) => StrategyContext | null,
  tab: TradeTab,
  equityUsd: number | null,
  tradeLog: TradeLogEntry[],
  existingExposureUsd: number | null = null,
  newsHeadlines: NewsItem[] = [],
  correlationMatrix: CorrelationMatrix | null = null,
  existingPositions: { symbol: string; valueUsd: number }[] = [],
  riskConfig: Partial<RiskConfig> = {},
): string {
  if (watchlist.length === 0) return 'RISK MANAGER: no watchlist symbols to analyze.';
  const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...riskConfig };

  // Account-level checks apply to the whole tab, not a specific symbol —
  // computed once rather than repeated per symbol. News AND correlation
  // are symbol-specific (see per-symbol lines below), not shown here.
  const dailyLoss = checkDailyLoss(tradeLog, tab, Date.now(), cfg.maxDailyLossPct);
  const drawdown = checkDrawdown(tradeLog, tab, cfg.maxDrawdownPct);
  const accountLines = [dailyLoss, drawdown].map((c) => `  ${c.status.toUpperCase()}: ${c.detail}`);

  const symbolLines: string[] = [];
  for (const item of watchlist) {
    const ctx = lookup(item);
    if (!ctx) {
      symbolLines.push(`  ${item.symbol}: not enough data yet`);
      continue;
    }
    const slTp = computeStopLossTakeProfit(ctx, 'buy');
    if (!slTp) {
      symbolLines.push(`  ${item.symbol}: no ATR available yet — can't compute a dynamic stop`);
      continue;
    }
    const kellyCap = computeKellyRiskCap(tradeLog, tab, cfg.maxRiskPctPerTrade);
    const sizing = equityUsd !== null ? (fixedFractionalSize(equityUsd, kellyCap.riskPct, ctx.price, slTp.stopLoss) ?? undefined) : undefined;
    const sized = sizing ? capToMaxExposure(sizing.qty, ctx.price, equityUsd as number) : null;
    const spread = checkSpread(ctx, cfg.maxSpreadPct);
    const liquidity = checkLiquidity(ctx, sized?.qty ?? 0, cfg.minBookDepthMultiple);
    const portfolioExp = sized ? checkPortfolioExposure(existingExposureUsd, sized.qty * ctx.price, equityUsd, cfg.maxPortfolioExposurePct) : null;
    const news = checkNews(newsHeadlines, item.symbol);
    const correlation = correlationMatrix
      ? checkCorrelation(
          item.symbol,
          sized ? sized.qty * ctx.price : 0,
          { matrix: correlationMatrix, existingPositions: existingPositions.filter((p) => p.symbol !== item.symbol), equityUsd },
          cfg.correlationRejectThreshold,
          cfg.correlationExposureLimitPct,
        )
      : checkCorrelation(item.symbol, 0, null, cfg.correlationRejectThreshold, cfg.correlationExposureLimitPct);
    const stopDistancePct = (slTp.stopDistance / ctx.price) * 100;
    const maxSafeLeverage = 100 / (stopDistancePct * cfg.liquidationSafetyBuffer);
    symbolLines.push(
      `  ${item.symbol}: long-side SL ${slTp.stopLoss.toFixed(2)} / TP ${slTp.takeProfit.toFixed(2)} (${slTp.method}); ` +
        `${sized ? `recommended size ~${(sized.qty * news.sizeMultiplier).toFixed(4)} (${sizing?.method}${news.sizeMultiplier < 1 ? ', reduced for breaking news' : ''}${kellyCap.riskPct < cfg.maxRiskPctPerTrade ? ', Kelly-capped' : ''})` : 'no equity baseline — size not computed'}; ` +
        `max safe leverage ~${maxSafeLeverage.toFixed(1)}x (before the stop risks being liquidated through); ` +
        `spread: ${spread.detail}; liquidity: ${liquidity.detail}; news: ${news.detail}; correlation: ${correlation.detail}` +
        (portfolioExp ? `; portfolio exposure: ${portfolioExp.detail}` : ''),
    );
  }

  return `RISK MANAGER (dynamic SL/TP from ATR + swing structure, sizing from real equity, leverage capped by liquidation distance — not fixed percentages):\nAccount-level (${tab}):\n${accountLines.join(
    '\n',
  )}\nPer-symbol:\n${symbolLines.join(
    '\n',
  )}\n\nShort-side stops mirror the long-side ones shown (swing high instead of swing low). "Max safe leverage" is a ceiling, not a target — using less is always more conservative. This is a real gate, not a suggestion the model can override — actual execution is checked against these same rules regardless of what's said in chat.`;
}

export function validateTrade(params: {
  ctx: StrategyContext;
  side: 'buy' | 'sell';
  requestedQty: number;
  equityUsd: number | null;
  tradeLog: TradeLogEntry[];
  tab: TradeTab;
  requestedLeverage?: number; // defaults to 1 (no leverage) if omitted
  existingExposureUsd?: number | null; // total value of already-open positions in this tab, for the portfolio-exposure check
  newsHeadlines?: NewsItem[]; // defaults to [] (news check reads as 'unavailable') if omitted
  correlationInputs?: CorrelationInputs | null; // defaults to null (correlation check reads as 'unavailable') if omitted
  riskConfig?: Partial<RiskConfig>; // operator-configurable overrides (Production Readiness Review #17) — merged over DEFAULT_RISK_CONFIG
}): RiskValidation {
  const { ctx, side, requestedQty, equityUsd, tradeLog, tab } = params;
  const cfg: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...params.riskConfig };
  const slTp = computeStopLossTakeProfit(ctx, side);
  const newsCheck = checkNews(params.newsHeadlines ?? [], ctx.symbol);
  const kellyCap = computeKellyRiskCap(tradeLog, tab, cfg.maxRiskPctPerTrade);

  let recommendedSize: SizingResult | null = null;
  if (slTp && equityUsd !== null) {
    const sized = fixedFractionalSize(equityUsd, kellyCap.riskPct, ctx.price, slTp.stopLoss) ?? volatilityBasedSize(equityUsd, kellyCap.riskPct, ctx.price, ctx.atrValue ?? 0);
    const capped = sized ? capToMaxExposure(sized.qty, ctx.price, equityUsd).qty : null;
    // Breaking news reduces the recommended size directly — this is the
    // one check that adjusts sizing rather than approving/rejecting.
    recommendedSize = capped !== null && sized ? { ...sized, qty: capped * newsCheck.sizeMultiplier, method: `${sized.method}; ${kellyCap.detail}` } : null;
  }

  const checks: Record<string, RiskCheck> = {
    positionRisk: slTp ? checkPositionRisk(equityUsd, requestedQty, ctx.price, slTp.stopLoss, cfg.maxRiskPctPerTrade) : { ok: true, status: 'unavailable', detail: 'No stop-loss computed (missing ATR) — risk sizing check skipped.' },
    dailyLoss: checkDailyLoss(tradeLog, tab, Date.now(), cfg.maxDailyLossPct),
    drawdown: checkDrawdown(tradeLog, tab, cfg.maxDrawdownPct),
    liquidity: checkLiquidity(ctx, requestedQty, cfg.minBookDepthMultiple),
    spread: checkSpread(ctx, cfg.maxSpreadPct),
    leverage: slTp ? checkLeverage(ctx.price, slTp.stopLoss, params.requestedLeverage ?? 1, cfg.liquidationSafetyBuffer) : { ok: true, status: 'unavailable', detail: 'No stop-loss computed — leverage safety check skipped.' },
    portfolioExposure: checkPortfolioExposure(params.existingExposureUsd ?? null, requestedQty * ctx.price, equityUsd, cfg.maxPortfolioExposurePct),
    correlation: checkCorrelation(ctx.symbol, requestedQty * ctx.price, params.correlationInputs ?? null, cfg.correlationRejectThreshold, cfg.correlationExposureLimitPct),
    news: newsCheck,
  };

  const rejectionReasons = Object.values(checks).filter((c) => c.status === 'reject').map((c) => c.detail);
  const cautionNotes = Object.values(checks).filter((c) => c.status === 'unavailable').map((c) => c.detail);
  if (newsCheck.sizeMultiplier < 1) cautionNotes.push(newsCheck.detail); // advisory, not blocking, but still visible — never silently absorbed
  if (kellyCap.riskPct < cfg.maxRiskPctPerTrade) cautionNotes.push(kellyCap.detail); // Kelly shrank sizing below the fixed cap — visible, not blocking

  return { approved: rejectionReasons.length === 0, stopLossTakeProfit: slTp, recommendedSize, checks, rejectionReasons, cautionNotes };
}
