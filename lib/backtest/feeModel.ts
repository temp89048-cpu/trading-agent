// Real, published Binance spot fee schedule (standard, non-BNB-discount
// rates, as documented at time of writing) used as the concrete example
// exchange — fee schedules change and vary by 30-day volume/BNB balance
// in ways this app has no way to know live, so treat these numbers as
// "a real, representative schedule," not "your exact current rate."
// This is meaningfully more realistic than one constant, without
// pretending to reproduce a specific account's actual negotiated rate.

export type VipLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

const BINANCE_SPOT_SCHEDULE: Record<VipLevel, { makerBps: number; takerBps: number }> = {
  0: { makerBps: 10, takerBps: 10 },
  1: { makerBps: 9, takerBps: 10 },
  2: { makerBps: 8, takerBps: 10 },
  3: { makerBps: 7.2, takerBps: 9 },
  4: { makerBps: 6, takerBps: 8 },
  5: { makerBps: 4.8, takerBps: 7.2 },
  6: { makerBps: 3.6, takerBps: 6 },
  7: { makerBps: 3, takerBps: 5.4 },
  8: { makerBps: 2.4, takerBps: 4.8 },
  9: { makerBps: 2, takerBps: 4 },
};

export type FeeModelParams = {
  exchange?: 'binance'; // only one real schedule modeled — extend this union when a second is added, not before
  vipLevel?: VipLevel; // default 0
  isMaker?: boolean; // default false (this engine enters/exits at market-ish prices, so taker is the honest default)
  notionalUsd: number;
  // Funding/borrow only apply to perpetual futures or margin positions.
  // This engine models SPOT, long-only positions (see engine.ts) — these
  // fields exist so the fee model is complete and reusable if margin
  // support is ever added, but default to zero and are not exercised by
  // the current spot-only backtest engine.
  fundingRateBpsPer8h?: number;
  borrowRateBpsPerDay?: number;
  holdDurationHours?: number;
};

export type FeeBreakdown = {
  tradingFeeUsd: number;
  fundingCostUsd: number;
  borrowCostUsd: number;
  totalUsd: number;
  effectiveBps: number;
  note: string;
};

export function computeFee(params: FeeModelParams): FeeBreakdown {
  const vip = params.vipLevel ?? 0;
  const schedule = BINANCE_SPOT_SCHEDULE[vip];
  const bps = params.isMaker ? schedule.makerBps : schedule.takerBps;
  const tradingFeeUsd = params.notionalUsd * (bps / 10000);

  const fundingPeriods = params.fundingRateBpsPer8h && params.holdDurationHours ? params.holdDurationHours / 8 : 0;
  const fundingCostUsd = fundingPeriods > 0 ? params.notionalUsd * ((params.fundingRateBpsPer8h ?? 0) / 10000) * fundingPeriods : 0;

  const borrowDays = params.borrowRateBpsPerDay && params.holdDurationHours ? params.holdDurationHours / 24 : 0;
  const borrowCostUsd = borrowDays > 0 ? params.notionalUsd * ((params.borrowRateBpsPerDay ?? 0) / 10000) * borrowDays : 0;

  const totalUsd = tradingFeeUsd + fundingCostUsd + borrowCostUsd;
  return {
    tradingFeeUsd,
    fundingCostUsd,
    borrowCostUsd,
    totalUsd,
    effectiveBps: params.notionalUsd > 0 ? (totalUsd / params.notionalUsd) * 10000 : 0,
    note: `Binance spot, VIP ${vip}, ${params.isMaker ? 'maker' : 'taker'}: ${bps}bps${fundingCostUsd > 0 || borrowCostUsd > 0 ? ' + funding/borrow (margin/futures modeling)' : ''}. Standard schedule, not BNB-discounted — verify against your actual account tier.`,
  };
}
