import { describe, it, expect } from 'vitest';
import { computeFee } from './feeModel';

describe('computeFee', () => {
  it('charges the taker rate by default (isMaker unset)', () => {
    const fee = computeFee({ notionalUsd: 10_000 });
    expect(fee.tradingFeeUsd).toBeGreaterThan(0);
    expect(fee.note.toLowerCase()).toContain('taker');
  });

  it('a maker fills cheaper than a taker at the same VIP level', () => {
    const taker = computeFee({ notionalUsd: 10_000, isMaker: false });
    const maker = computeFee({ notionalUsd: 10_000, isMaker: true });
    expect(maker.tradingFeeUsd).toBeLessThanOrEqual(taker.tradingFeeUsd);
  });

  it('scales linearly with notional', () => {
    const small = computeFee({ notionalUsd: 1_000 });
    const large = computeFee({ notionalUsd: 10_000 });
    expect(large.tradingFeeUsd).toBeCloseTo(small.tradingFeeUsd * 10, 6);
  });

  it('adds funding cost only when both a funding rate and a hold duration are supplied', () => {
    const noFunding = computeFee({ notionalUsd: 10_000 });
    const withFunding = computeFee({ notionalUsd: 10_000, fundingRateBpsPer8h: 1, holdDurationHours: 24 });
    expect(noFunding.fundingCostUsd).toBe(0);
    expect(withFunding.fundingCostUsd).toBeGreaterThan(0);
    expect(withFunding.totalUsd).toBeGreaterThan(withFunding.tradingFeeUsd);
  });

  it('never produces a negative fee', () => {
    const fee = computeFee({ notionalUsd: 500 });
    expect(fee.totalUsd).toBeGreaterThanOrEqual(0);
  });
});
