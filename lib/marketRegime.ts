import type { Candle } from './indicators';
import { atr } from './indicators';
import { classifyRegimes, type Regime, type TrendRegime, type VolRegime } from './backtest/regime';

// ---------------------------------------------------------------------
// Live Market Regime Classifier (roadmap Phase 34, and the thing
// Section 11.3's "market regime fit" field is meaningless without).
//
// The backtester has classified regimes per-bar since Commit ~22
// (lib/backtest/regime.ts) so historical performance could be broken out
// per regime. But nothing classified the CURRENT regime, which means
// nothing could act on it — every strategy in the ensemble voted on
// every symbol regardless of whether its conditions were present. A
// mean-reversion agent voting during a strong trend isn't adding a
// perspective, it's adding noise the ensemble then has to average away.
//
// This module deliberately REUSES classifyRegimes() rather than
// re-deriving trend/vol thresholds, so live classification and
// backtested attribution can never silently disagree about what "bull,
// high-vol" means. Two additional dimensions the backtest form doesn't
// carry are added on top, because strategy selection genuinely needs
// them:
//
//   - compression: range contracting (a breakout precondition, and a
//     reason to stand down on mean reversion)
//   - directionalStrength: how decisively trending, so "weak bull" and
//     "strong bull" can gate differently
//
// Pure and deterministic — no I/O, no LLM. Same discipline as
// lib/opportunityScanner.ts.
// ---------------------------------------------------------------------

export type { Regime, TrendRegime, VolRegime };

/** Coarse label used for strategy gating. */
export type RegimeLabel =
  | 'strong-bull'
  | 'weak-bull'
  | 'strong-bear'
  | 'weak-bear'
  | 'ranging'
  | 'compression' // range tightening — breakout setup forming
  | 'unknown';

export type MarketRegime = {
  label: RegimeLabel;
  trend: TrendRegime | 'unknown';
  vol: VolRegime | 'unknown';
  /** 0..1 — how decisively directional. 0 for ranging. */
  directionalStrength: number;
  /** True when recent true range is contracting vs its own baseline. */
  compressing: boolean;
  /** Plain-language justification. Every field above traces to real numbers. */
  reasons: string[];
  /** 0..1 confidence in this classification, driven by how much data backed it. */
  confidence: number;
};

const MIN_CANDLES = 60; // below this, the EMA50-based trend read isn't meaningful
const STRONG_TREND_SEPARATION_PCT = 1.5; // fast/slow EMA separation that distinguishes strong from weak
const COMPRESSION_LOOKBACK = 10;
const COMPRESSION_BASELINE = 30;
const COMPRESSION_RATIO = 0.75; // recent ATR below 75% of its baseline = compressing

export const UNKNOWN_REGIME: MarketRegime = {
  label: 'unknown',
  trend: 'unknown',
  vol: 'unknown',
  directionalStrength: 0,
  compressing: false,
  reasons: ['Not enough candle history to classify a regime.'],
  confidence: 0,
};

export function classifyCurrentRegime(candles: Candle[]): MarketRegime {
  if (candles.length < MIN_CANDLES) {
    return {
      ...UNKNOWN_REGIME,
      reasons: [`Only ${candles.length} candles available; ${MIN_CANDLES} needed for a meaningful trend/volatility read.`],
    };
  }

  // Reuse the backtester's own per-bar classification and take the most
  // recent non-null bar — identical thresholds to how history was judged.
  const series = classifyRegimes(candles);
  let latest: Regime | null = null;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null) {
      latest = series[i];
      break;
    }
  }
  if (!latest) {
    return { ...UNKNOWN_REGIME, reasons: ['Regime classification produced no result for any recent bar.'] };
  }

  const reasons: string[] = [`Trend regime: ${latest.trend}; volatility regime: ${latest.vol} (same thresholds the backtester attributes historical performance with).`];

  // --- Directional strength from EMA separation.
  const closes = candles.map((c) => c.c);
  const emaFast = simpleEma(closes, 20);
  const emaSlow = simpleEma(closes, 50);
  let directionalStrength = 0;
  if (emaFast !== null && emaSlow !== null && emaSlow > 0) {
    const separationPct = (Math.abs(emaFast - emaSlow) / emaSlow) * 100;
    directionalStrength = Math.min(1, separationPct / STRONG_TREND_SEPARATION_PCT);
    reasons.push(`EMA20/EMA50 separation ${separationPct.toFixed(2)}% (${STRONG_TREND_SEPARATION_PCT}% counts as fully decisive).`);
  } else {
    reasons.push('EMA separation not computable — directional strength treated as 0.');
  }

  // --- Compression: recent ATR vs its own longer baseline.
  const recentAtr = atr(candles.slice(-COMPRESSION_LOOKBACK - 14), 14);
  const baselineAtr = atr(candles.slice(-COMPRESSION_BASELINE - 14), 14);
  let compressing = false;
  if (recentAtr !== null && baselineAtr !== null && baselineAtr > 0) {
    const ratio = recentAtr / baselineAtr;
    compressing = ratio < COMPRESSION_RATIO;
    reasons.push(
      `Recent ATR is ${(ratio * 100).toFixed(0)}% of its ${COMPRESSION_BASELINE}-bar baseline${compressing ? ' — range is compressing' : ''}.`,
    );
  } else {
    reasons.push('ATR compression not computable from available history.');
  }

  // --- Label. Compression is reported as its own regime only when the
  // market isn't decisively trending — a compressing pullback inside a
  // strong trend is still a trend, and mislabelling it would gate the
  // trend strategies off at exactly the wrong moment.
  const isTrending = latest.trend === 'bull' || latest.trend === 'bear';
  const strong = directionalStrength >= 0.6;
  let label: RegimeLabel;
  if (isTrending && strong) {
    label = latest.trend === 'bull' ? 'strong-bull' : 'strong-bear';
  } else if (isTrending) {
    label = latest.trend === 'bull' ? 'weak-bull' : 'weak-bear';
  } else if (compressing) {
    label = 'compression';
  } else {
    label = 'ranging';
  }

  // Confidence scales with how much history backed the call — an honest
  // 60-candle classification is weaker than a 500-candle one.
  const confidence = Math.min(1, candles.length / 200);

  return { label, trend: latest.trend, vol: latest.vol, directionalStrength, compressing, reasons, confidence };
}

// Local EMA over the full series, returning only the final value. The
// exported ema() in lib/indicators.ts already does exactly this; kept as
// a thin wrapper here purely so this module reads self-contained at the
// call sites above.
function simpleEma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let value = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) value = closes[i] * mult + value * (1 - mult);
  return value;
}

export const REGIME_LABELS: Record<RegimeLabel, string> = {
  'strong-bull': 'Strong Bull Trend',
  'weak-bull': 'Weak Bull Trend',
  'strong-bear': 'Strong Bear Trend',
  'weak-bear': 'Weak Bear Trend',
  ranging: 'Ranging / Sideways',
  compression: 'Compression (range tightening)',
  unknown: 'Unknown',
};

export function describeRegime(regime: MarketRegime): string {
  const vol = regime.vol === 'unknown' ? '' : `, ${regime.vol}`;
  return `${REGIME_LABELS[regime.label]}${vol}`;
}

// ---------------------------------------------------------------------
// Chat context injection — same pattern as every other build*Context.
// ---------------------------------------------------------------------
export function buildRegimeContext(regimeBySymbol: Record<string, MarketRegime>): string {
  const entries = Object.entries(regimeBySymbol);
  if (entries.length === 0) return 'MARKET REGIME: no symbols classified yet.';
  const lines = entries.map(([symbol, r]) => {
    if (r.label === 'unknown') return `  ${symbol}: unknown — ${r.reasons[0]}`;
    return `  ${symbol}: ${describeRegime(r)} (directional strength ${(r.directionalStrength * 100).toFixed(0)}%, classification confidence ${(r.confidence * 100).toFixed(0)}%)`;
  });
  return `MARKET REGIME (live classification using the same trend/volatility thresholds the backtester attributes historical performance with, so live and historical regime labels mean the same thing):\n${lines.join(
    '\n',
  )}\n\nStrategies are gated by regime — one unsuited to the current regime abstains rather than voting noise into the ensemble. See the Strategy Ensemble panel for which are active.`;
}
