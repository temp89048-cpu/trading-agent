import { describe, it, expect } from 'vitest';
import {
  checkPositionRisk,
  checkDailyLoss,
  checkDrawdown,
  checkLiquidity,
  checkSpread,
  checkLeverage,
  checkPortfolioExposure,
  checkCorrelation,
  computeStopLossTakeProfit,
  DEFAULT_RISK_CONFIG,
  buildRealizedEquityCurve,
} from './riskManager';
import type { StrategyContext } from './strategyContext';
import type { TradeLogEntry } from './types';

function fakeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    symbol: 'BTC/USDT',
    price: 100,
    candles: [],
    rsiValue: null,
    macdValue: null,
    ema20: null,
    ema50: null,
    bb: null,
    atrValue: 2,
    vwapValue: null,
    mtf: {} as StrategyContext['mtf'],
    structure: { lastSwingLow: undefined, lastSwingHigh: undefined } as unknown as StrategyContext['structure'],
    liquidity: {} as StrategyContext['liquidity'],
    volumeProfile: null,
    orderFlow: {
      pressure: { bidVolume: 100, askVolume: 100, spreadPct: 0.05, imbalance: 0, pressure: 'balanced', levelsUsed: 5, bestBid: 99.9, bestAsk: 100.1 },
    } as unknown as StrategyContext['orderFlow'],
    ...overrides,
  };
}

function tradeEntry(overrides: Partial<TradeLogEntry> = {}): TradeLogEntry {
  return { id: 'x', ts: Date.now(), tab: 'paper', symbol: 'BTC/USDT', side: 'sell', qty: 1, price: 100, ...overrides };
}

describe('computeStopLossTakeProfit', () => {
  it('returns null with no ATR reading', () => {
    expect(computeStopLossTakeProfit(fakeCtx({ atrValue: null }), 'buy')).toBeNull();
  });

  it('places a long stop below price and target above it, at the requested reward:risk ratio', () => {
    const result = computeStopLossTakeProfit(fakeCtx({ price: 100, atrValue: 2 }), 'buy', 2);
    expect(result).not.toBeNull();
    expect(result!.stopLoss).toBeLessThan(100);
    expect(result!.takeProfit).toBeGreaterThan(100);
    const risk = 100 - result!.stopLoss;
    const reward = result!.takeProfit - 100;
    expect(reward / risk).toBeCloseTo(2, 6);
  });

  it('mirrors direction for a short', () => {
    const result = computeStopLossTakeProfit(fakeCtx({ price: 100, atrValue: 2 }), 'sell', 2);
    expect(result!.stopLoss).toBeGreaterThan(100);
    expect(result!.takeProfit).toBeLessThan(100);
  });
});

describe('checkPositionRisk', () => {
  it('rejects a position risking more than the configured max %', () => {
    // Risking $50 on $1000 equity = 5%, over the default 2% cap.
    const result = checkPositionRisk(1000, 5, 100, 90);
    expect(result.status).toBe('reject');
  });

  it('passes within the cap, and honors a custom maxRiskPctPerTrade override', () => {
    const result = checkPositionRisk(1000, 5, 100, 99, 0.1); // 5% risk, 10% cap
    expect(result.status).toBe('pass');
  });

  it('is honestly unavailable with no tracked equity (real tab)', () => {
    expect(checkPositionRisk(null, 1, 100, 90).status).toBe('unavailable');
  });
});

describe('checkDailyLoss / checkDrawdown', () => {
  it('is unavailable for the real tab (no tracked equity baseline)', () => {
    expect(checkDailyLoss([], 'real').status).toBe('unavailable');
    expect(checkDrawdown([], 'real').status).toBe('unavailable');
  });

  it('rejects once realized losses today exceed the configured daily-loss limit', () => {
    const now = new Date('2024-06-01T12:00:00Z').getTime();
    const startOfToday = new Date('2024-06-01T00:00:00Z').getTime();
    const log = [tradeEntry({ ts: startOfToday + 1000, pnl: -2000 })]; // big loss vs a 25k starting balance
    const result = checkDailyLoss(log, 'paper', now);
    expect(result.status).toBe('reject');
  });

  it('a custom (looser) maxDailyLossPct can turn the same loss into a pass', () => {
    const now = new Date('2024-06-01T12:00:00Z').getTime();
    const startOfToday = new Date('2024-06-01T00:00:00Z').getTime();
    const log = [tradeEntry({ ts: startOfToday + 1000, pnl: -2000 })];
    const result = checkDailyLoss(log, 'paper', now, 0.5); // 50% allowed
    expect(result.status).toBe('pass');
  });
});

describe('checkLiquidity / checkSpread', () => {
  it('rejects an order too large for visible book depth', () => {
    const ctx = fakeCtx({ orderFlow: { pressure: { bidVolume: 1, askVolume: 1, spreadPct: 0.05 } } as unknown as StrategyContext['orderFlow'] });
    expect(checkLiquidity(ctx, 100).status).toBe('reject');
  });

  it('passes when the book comfortably covers the requested size', () => {
    const ctx = fakeCtx({ orderFlow: { pressure: { bidVolume: 1000, askVolume: 1000, spreadPct: 0.05 } } as unknown as StrategyContext['orderFlow'] });
    expect(checkLiquidity(ctx, 1).status).toBe('pass');
  });

  it('is unavailable with no order-book data at all', () => {
    const ctx = fakeCtx({ orderFlow: null });
    expect(checkLiquidity(ctx, 1).status).toBe('unavailable');
    expect(checkSpread(ctx).status).toBe('unavailable');
  });

  it('rejects a spread wider than the configured max', () => {
    const ctx = fakeCtx({ orderFlow: { pressure: { bidVolume: 100, askVolume: 100, spreadPct: 1.5 } } as unknown as StrategyContext['orderFlow'] });
    expect(checkSpread(ctx).status).toBe('reject');
    expect(checkSpread(ctx, 2).status).toBe('pass'); // widened override tolerates it
  });
});

describe('checkLeverage', () => {
  it('passes 1x with no liquidation-distance math applied', () => {
    expect(checkLeverage(100, 90, 1).status).toBe('pass');
  });

  it('rejects leverage that leaves less than the safety buffer before liquidation', () => {
    // 10% stop distance, 20x leverage — liquidation happens at ~5% adverse move.
    expect(checkLeverage(100, 90, 20).status).toBe('reject');
  });

  it('a smaller safety buffer override can permit higher leverage on the same stop', () => {
    const result = checkLeverage(100, 95, 5, 1.0); // 5% stop, 1x safety buffer instead of the 1.5x default
    expect(result.status).toBe('pass');
  });
});

describe('checkPortfolioExposure', () => {
  it('rejects when total exposure (existing + new) exceeds the configured cap', () => {
    expect(checkPortfolioExposure(700, 200, 1000).status).toBe('reject'); // 90% > 75% default
  });

  it('passes within the cap', () => {
    expect(checkPortfolioExposure(300, 100, 1000).status).toBe('pass'); // 40%
  });
});

describe('checkCorrelation', () => {
  it('is unavailable with no inputs supplied', () => {
    expect(checkCorrelation('BTC/USDT', 100, null).status).toBe('unavailable');
  });

  it('passes when no existing holding correlates above the reject threshold', () => {
    const result = checkCorrelation('BTC/USDT', 100, { matrix: {}, existingPositions: [], equityUsd: 1000 });
    expect(result.status).toBe('pass');
  });
});

describe('DEFAULT_RISK_CONFIG', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_RISK_CONFIG.maxRiskPctPerTrade).toBeCloseTo(0.02, 6);
    expect(DEFAULT_RISK_CONFIG.maxDailyLossPct).toBeCloseTo(0.05, 6);
    expect(DEFAULT_RISK_CONFIG.maxDrawdownPct).toBeCloseTo(0.15, 6);
    expect(DEFAULT_RISK_CONFIG.maxPortfolioExposurePct).toBeCloseTo(0.75, 6);
  });
});

describe('buildRealizedEquityCurve', () => {
  it('anchors at the paper starting balance and accumulates realized P&L in order', () => {
    const curve = buildRealizedEquityCurve(
      [tradeEntry({ ts: 200, pnl: 100 }), tradeEntry({ ts: 100, pnl: -50 })], // out of order on purpose
      'paper',
    );
    expect(curve[0].equity).toBeGreaterThan(0);
    expect(curve[curve.length - 1].equity).toBe(curve[0].equity + 50); // -50 then +100, applied in ts order
  });

  it('ignores trades from the other tab', () => {
    const curve = buildRealizedEquityCurve([tradeEntry({ tab: 'real', pnl: -9999 })], 'paper');
    expect(curve.length).toBe(1); // only the synthetic anchor point
  });
});
