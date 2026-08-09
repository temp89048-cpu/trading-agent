import { describe, it, expect } from 'vitest';
import { classifyCurrentRegime, describeRegime, buildRegimeContext, UNKNOWN_REGIME } from './marketRegime';
import {
  STRATEGY_PROFILES,
  PLANNED_STRATEGIES,
  getStrategyProfile,
  isStrategyActiveInRegime,
  strategiesActiveIn,
  profileCompleteness,
} from './strategyProfiles';
import { runStrategyEnsemble } from './strategyEnsemble';
import type { Candle } from './indicators';

// Deterministic synthetic candles — no randomness, so regime
// classification is reproducible run to run.
function makeCandles(count: number, priceAt: (i: number) => number, rangePct = 0.5): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = priceAt(i);
    const halfRange = (close * rangePct) / 100;
    out.push({ t: i * 3_600_000, o: close, h: close + halfRange, l: close - halfRange, c: close, v: 1000 });
  }
  return out;
}

describe('classifyCurrentRegime', () => {
  it('returns unknown with too little history, stating why', () => {
    const r = classifyCurrentRegime(makeCandles(10, () => 100));
    expect(r.label).toBe('unknown');
    expect(r.confidence).toBe(0);
    expect(r.reasons[0]).toContain('candles available');
  });

  it('classifies a sustained uptrend as bullish', () => {
    const r = classifyCurrentRegime(makeCandles(200, (i) => 100 + i * 0.8));
    expect(r.trend).toBe('bull');
    expect(['strong-bull', 'weak-bull']).toContain(r.label);
  });

  it('classifies a sustained downtrend as bearish', () => {
    const r = classifyCurrentRegime(makeCandles(200, (i) => 300 - i * 0.8));
    expect(r.trend).toBe('bear');
    expect(['strong-bear', 'weak-bear']).toContain(r.label);
  });

  it('does not call a flat market a trend', () => {
    const r = classifyCurrentRegime(makeCandles(200, () => 100));
    expect(r.trend).toBe('sideways');
    expect(['ranging', 'compression']).toContain(r.label);
    expect(r.directionalStrength).toBeLessThan(0.2);
  });

  it('rates a steep trend as more directionally decisive than a shallow one', () => {
    const steep = classifyCurrentRegime(makeCandles(200, (i) => 100 * Math.pow(1.01, i)));
    const shallow = classifyCurrentRegime(makeCandles(200, (i) => 100 + i * 0.02));
    expect(steep.directionalStrength).toBeGreaterThan(shallow.directionalStrength);
  });

  it('scales classification confidence with available history', () => {
    const short = classifyCurrentRegime(makeCandles(80, (i) => 100 + i * 0.5));
    const long = classifyCurrentRegime(makeCandles(400, (i) => 100 + i * 0.5));
    expect(long.confidence).toBeGreaterThan(short.confidence);
    expect(long.confidence).toBeLessThanOrEqual(1);
  });

  it('detects range compression when recent volatility contracts', () => {
    // Wide swings early, then a tight tail.
    const candles: Candle[] = [];
    for (let i = 0; i < 200; i++) {
      const wide = i < 160;
      const close = 100 + (i % 2 === 0 ? 1 : -1) * (wide ? 3 : 0.05);
      const halfRange = wide ? 4 : 0.05;
      candles.push({ t: i * 3_600_000, o: close, h: close + halfRange, l: close - halfRange, c: close, v: 1000 });
    }
    expect(classifyCurrentRegime(candles).compressing).toBe(true);
  });

  it('always supplies at least one reason', () => {
    expect(classifyCurrentRegime(makeCandles(200, (i) => 100 + i)).reasons.length).toBeGreaterThan(0);
    expect(classifyCurrentRegime(makeCandles(5, () => 100)).reasons.length).toBeGreaterThan(0);
  });
});

describe('describeRegime / buildRegimeContext', () => {
  it('describes a regime in plain language', () => {
    expect(describeRegime(classifyCurrentRegime(makeCandles(200, (i) => 100 + i)))).toContain('Trend');
  });

  it('says plainly when nothing is classified', () => {
    expect(buildRegimeContext({})).toContain('no symbols classified');
  });

  it('surfaces an unknown regime with its reason rather than hiding it', () => {
    const text = buildRegimeContext({ 'BTC/USDT': UNKNOWN_REGIME });
    expect(text).toContain('unknown');
  });

  it('explains that gating is in effect', () => {
    const text = buildRegimeContext({ 'BTC/USDT': classifyCurrentRegime(makeCandles(200, (i) => 100 + i)) });
    expect(text).toContain('gated by regime');
  });
});

describe('strategy profiles (spec Section 11.3)', () => {
  it('every declared profile has all required fields filled in', () => {
    // The spec's "no strategy goes live without every field" rule, made
    // checkable instead of aspirational.
    expect(profileCompleteness()).toEqual([]);
  });

  it('never claims a historical success rate, since there is no live track record', () => {
    // A backtest number pasted here would be presented as something it
    // is not. null means "not established", never "zero".
    for (const p of STRATEGY_PROFILES) {
      expect(p.historicalSuccessRate, `${p.agent} must not claim a success rate`).toBeNull();
    }
  });

  it('documents at least one failure mode per strategy', () => {
    for (const p of STRATEGY_PROFILES) {
      expect(p.failureModes.length, `${p.agent} failureModes`).toBeGreaterThan(0);
    }
  });

  it('has a profile for every strategy id, with no duplicates', () => {
    const agents = STRATEGY_PROFILES.map((p) => p.agent);
    expect(new Set(agents).size).toBe(agents.length);
  });

  it('EVERY strategy the ensemble actually runs has a declared profile', () => {
    // The invariant that makes regime gating trustworthy: an agent with
    // no profile is never gated (isStrategyActiveInRegime returns true by
    // design, to avoid silently disabling an unprofiled strategy). So a
    // missing profile means that strategy quietly votes in every regime —
    // exactly the behavior gating exists to prevent. Asserted against the
    // ensemble's real output rather than a hand-maintained list.
    const ctx = {
      symbol: 'BTC/USDT',
      price: 100,
      candles: makeCandles(200, (i) => 100 + i * 0.3),
      rsiValue: 55,
      macdValue: null,
      ema20: 100,
      ema50: 99,
      bb: null,
      atrValue: 2,
      vwapValue: 100,
      mtf: { symbol: 'BTC/USDT', perTimeframe: [], overall: null },
      structure: { swings: [], events: [], currentTrend: 'bullish', lastSwingHigh: null, lastSwingLow: null },
      liquidity: { zones: [], sweeps: [] },
      volumeProfile: null,
      orderFlow: null,
    } as unknown as Parameters<typeof runStrategyEnsemble>[0];

    const result = runStrategyEnsemble(ctx);
    const missing = result.signals.map((s) => s.agent).filter((agent) => getStrategyProfile(agent) === undefined);
    expect(missing, `strategies running without a profile: ${missing.join(', ')}`).toEqual([]);
  });

  it('marks strategies this app cannot actually execute as advisory-only', () => {
    // Grid and Arbitrage can vote but their mechanics are unexecutable
    // here — claiming otherwise would misrepresent the system.
    expect(getStrategyProfile('Grid Strategy')?.executionStatus).toBe('advisory-only');
    expect(getStrategyProfile('Arbitrage')?.executionStatus).toBe('advisory-only');
  });

  it('lists unimplemented spec strategies with a concrete blocker each', () => {
    expect(PLANNED_STRATEGIES.length).toBeGreaterThan(0);
    for (const s of PLANNED_STRATEGIES) {
      expect(s.blocker.length, `${s.name} blocker`).toBeGreaterThan(0);
      expect(s.wouldRequire.length, `${s.name} wouldRequire`).toBeGreaterThan(0);
    }
  });
});

describe('regime gating', () => {
  it('bars mean reversion from strong trends', () => {
    // The single most important gate: fading a strong trend has
    // unbounded loss potential against a bounded target.
    expect(isStrategyActiveInRegime('Mean Reversion', 'strong-bull')).toBe(false);
    expect(isStrategyActiveInRegime('Mean Reversion', 'strong-bear')).toBe(false);
    expect(isStrategyActiveInRegime('Mean Reversion', 'ranging')).toBe(true);
  });

  it('bars trend following from ranging markets', () => {
    expect(isStrategyActiveInRegime('Trend Following', 'ranging')).toBe(false);
    expect(isStrategyActiveInRegime('Trend Following', 'strong-bull')).toBe(true);
  });

  it('activates breakout in compression', () => {
    expect(isStrategyActiveInRegime('Breakout', 'compression')).toBe(true);
  });

  it('permits everything when the regime is unknown', () => {
    // Refusing to trade because classification is uninformative would be
    // an unjustified behavior change.
    for (const p of STRATEGY_PROFILES) {
      expect(isStrategyActiveInRegime(p.agent, 'unknown')).toBe(true);
    }
  });

  it('does not gate off a strategy that has no declared profile', () => {
    expect(isStrategyActiveInRegime('Some Future Strategy', 'ranging')).toBe(true);
  });

  it('leaves at least one strategy active in every real regime', () => {
    // A regime that silences every strategy would make the system
    // permanently inert in that condition — a real bug, so it's asserted.
    for (const regime of ['strong-bull', 'weak-bull', 'strong-bear', 'weak-bear', 'ranging', 'compression'] as const) {
      expect(strategiesActiveIn(regime).length, `regime ${regime}`).toBeGreaterThan(0);
    }
  });
});
