import { rsi, ema, type Candle } from './indicators';

// ---------------------------------------------------------------------
// Planner Agent (Level 7) — "conditional watch" plans.
//
// This is the third AgentMode alongside 'interval' and 'take-profit':
// "if BTC drops to X, then watch for RSI to recover above Y, then enter"
// style requests. Same discipline as everything else in this app: no
// condition here is ever asked of the model and trusted — every
// PlanCondition is evaluated against real indicator values already
// computed by lib/indicators.ts, on the real tick loop already driving
// lib/agentEngine.ts (components/Agent.tsx). The model only sets the
// condition's parameters once, up front; it never "watches" anything
// itself.
//
// Deliberately state-based, not edge-based: 'ema20-above-ema50' /
// 'ema20-below-ema50' describe the CURRENT relationship between the two
// averages, not a detected crossover moment. A true crossover needs
// remembered prior-tick state, which is one more thing that could get
// silently lost across reloads; a state check evaluated fresh every
// tick needs no memory and is honest about what it's actually checking.
// ---------------------------------------------------------------------

export type PlanConditionKind =
  | 'price-above'
  | 'price-below'
  | 'rsi-above'
  | 'rsi-below'
  | 'ema20-above-ema50'
  | 'ema20-below-ema50'
  | 'volume-above-average';

// `value` is required for the price/RSI kinds and ignored for the two
// EMA-relationship kinds (kept optional so callers don't need a dummy
// number for those). For 'volume-above-average', `value` is the
// multiplier of the N-bar average volume required (defaults to
// DEFAULT_VOLUME_MULTIPLIER when omitted) — also optional.
export type PlanCondition = { kind: PlanConditionKind; value?: number };

export type PlanSnapshot = {
  price: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  volumeRatio: number | null; // latest bar's volume / N-bar average volume
};

// Same lookback convention as lib/eventDetection.ts's unusual-volume
// detector, applied here as a "did this bar's volume confirm the move"
// check rather than a "this is a rare spike" check — same math, a much
// lower bar (1.5x, not 3x+) since confirmation just needs above-average
// participation, not an anomaly.
const VOLUME_LOOKBACK = 20;
const DEFAULT_VOLUME_MULTIPLIER = 1.5;

// Builds a PlanSnapshot from whatever primary-timeframe candles the
// caller already has cached (same candles strategyContext.ts uses) plus
// the live tick price. Never fetches anything itself.
export function buildPlanSnapshot(candles: Candle[], livePrice: number): PlanSnapshot {
  const closes = candles.map((c) => c.c);
  let volumeRatio: number | null = null;
  if (candles.length >= VOLUME_LOOKBACK + 1) {
    const recent = candles.slice(-(VOLUME_LOOKBACK + 1), -1);
    const avgVolume = recent.reduce((s, c) => s + c.v, 0) / recent.length;
    const last = candles[candles.length - 1];
    if (avgVolume > 0) volumeRatio = last.v / avgVolume;
  }
  return {
    price: livePrice,
    rsi14: rsi(closes),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    volumeRatio,
  };
}

// Returns true/false when the condition can be evaluated, or null when
// the data it needs isn't available yet (e.g. RSI/EMA condition but not
// enough candle history loaded) — the tick loop treats null the same as
// "not met yet," it just also skips logging anything since there's
// nothing wrong, only nothing to check yet.
export function evaluatePlanCondition(condition: PlanCondition, snapshot: PlanSnapshot): boolean | null {
  switch (condition.kind) {
    case 'price-above':
      if (condition.value === undefined) return null;
      return snapshot.price >= condition.value;
    case 'price-below':
      if (condition.value === undefined) return null;
      return snapshot.price <= condition.value;
    case 'rsi-above':
      if (condition.value === undefined || snapshot.rsi14 === null) return null;
      return snapshot.rsi14 >= condition.value;
    case 'rsi-below':
      if (condition.value === undefined || snapshot.rsi14 === null) return null;
      return snapshot.rsi14 <= condition.value;
    case 'ema20-above-ema50':
      if (snapshot.ema20 === null || snapshot.ema50 === null) return null;
      return snapshot.ema20 > snapshot.ema50;
    case 'ema20-below-ema50':
      if (snapshot.ema20 === null || snapshot.ema50 === null) return null;
      return snapshot.ema20 < snapshot.ema50;
    case 'volume-above-average':
      if (snapshot.volumeRatio === null) return null;
      return snapshot.volumeRatio >= (condition.value ?? DEFAULT_VOLUME_MULTIPLIER);
    default:
      return null;
  }
}

// Human-readable description used both in the chat confirmation message
// and the AgentPanel UI — one source of truth so the two never drift.
export function describeCondition(condition: PlanCondition): string {
  switch (condition.kind) {
    case 'price-above':
      return `price >= $${condition.value?.toLocaleString() ?? '?'}`;
    case 'price-below':
      return `price <= $${condition.value?.toLocaleString() ?? '?'}`;
    case 'rsi-above':
      return `RSI(14) >= ${condition.value ?? '?'}`;
    case 'rsi-below':
      return `RSI(14) <= ${condition.value ?? '?'}`;
    case 'ema20-above-ema50':
      return 'EMA20 above EMA50 (bullish structure)';
    case 'ema20-below-ema50':
      return 'EMA20 below EMA50 (bearish structure)';
    case 'volume-above-average':
      return `volume confirms (>= ${(condition.value ?? DEFAULT_VOLUME_MULTIPLIER).toFixed(1)}x ${VOLUME_LOOKBACK}-bar average)`;
    default:
      return 'unknown condition';
  }
}

const CONDITION_KINDS: PlanConditionKind[] = [
  'price-above',
  'price-below',
  'rsi-above',
  'rsi-below',
  'ema20-above-ema50',
  'ema20-below-ema50',
  'volume-above-average',
];

export function isValidPlanCondition(value: unknown): value is PlanCondition {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!CONDITION_KINDS.includes(v.kind as PlanConditionKind)) return false;
  if (v.kind === 'price-above' || v.kind === 'price-below' || v.kind === 'rsi-above' || v.kind === 'rsi-below') {
    return typeof v.value === 'number' && isFinite(v.value as number);
  }
  if (v.kind === 'volume-above-average') {
    return v.value === undefined || (typeof v.value === 'number' && isFinite(v.value as number) && (v.value as number) > 0);
  }
  return true; // ema conditions need no value
}
