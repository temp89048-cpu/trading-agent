// =====================================================================
// Mission Planner — Phase 22
//
// Strategic mission layer: instead of reacting to markets, the AI plans.
// Every trade should contribute to an active mission. A mission is a
// high-level strategic objective with measurable targets, a time
// horizon, and constraints that shape trading behavior toward a goal.
//
// This sits ABOVE individual trade plans (lib/plannerAgent.ts handles
// per-trade conditional logic). Mission planning is portfolio-level
// strategic direction.
// =====================================================================

// ---- Mission Types --------------------------------------------------

export type MissionType =
  | 'growth'
  | 'capital-preservation'
  | 'event-reduction'
  | 'accumulation'
  | 'cash-allocation';

export type MissionStatus = 'active' | 'paused' | 'completed' | 'failed' | 'expired';

// ---- Mission Targets ------------------------------------------------

export type GrowthTarget = {
  type: 'growth';
  targetPct: number; // e.g. 5 for "grow 5%"
  timeframeDays: number;
};

export type CapitalPreservationTarget = {
  type: 'capital-preservation';
  maxDrawdownPct: number; // e.g. 3 for "max 3% drawdown"
  timeframeDays: number;
};

export type EventReductionTarget = {
  type: 'event-reduction';
  targetExposurePct: number; // e.g. 20 for "reduce to 20% exposure"
  deadline: number; // timestamp
};

export type AccumulationTarget = {
  type: 'accumulation';
  symbol: string;
  targetQty: number;
  maxAvgCost: number; // max average entry price
};

export type CashAllocationTarget = {
  type: 'cash-allocation';
  targetCashPct: number; // e.g. 60 for "60% cash"
  timeframeDays: number;
};

export type MissionTarget =
  | GrowthTarget
  | CapitalPreservationTarget
  | EventReductionTarget
  | AccumulationTarget
  | CashAllocationTarget;

// ---- Mission Constraints --------------------------------------------

export type MissionConstraint =
  | { kind: 'max-position-size-pct'; value: number }
  | { kind: 'max-total-exposure-pct'; value: number }
  | { kind: 'min-cash-reserve-pct'; value: number }
  | { kind: 'allowed-sides'; sides: ('buy' | 'sell')[] }
  | { kind: 'allowed-symbols'; symbols: string[] }
  | { kind: 'max-trades-per-day'; value: number }
  | { kind: 'max-leverage'; value: number };

// ---- Mission Checkpoint (progress snapshot) -------------------------

export type MissionCheckpoint = {
  ts: number;
  progressPct: number;
  note: string;
};

// ---- Mission Progress -----------------------------------------------

export type MissionProgressStatus = 'on-track' | 'ahead' | 'behind' | 'at-risk';

export type MissionProgress = {
  currentPct: number; // 0-100, how much of the target is achieved
  status: MissionProgressStatus;
  lastEvaluatedAt: number;
  detail: string; // human-readable progress description
};

// ---- Mission --------------------------------------------------------

export type Mission = {
  id: string;
  type: MissionType;
  name: string;
  description: string;
  status: MissionStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null; // null = no expiry
  target: MissionTarget;
  progress: MissionProgress;
  constraints: MissionConstraint[];
  checkpoints: MissionCheckpoint[];
};

// ---- Portfolio Context for Mission Evaluation -----------------------

export type MissionPortfolioContext = {
  cashUsd: number;
  totalEquityUsd: number;
  positions: { symbol: string; qty: number; valueUsd: number; avgCost: number }[];
  todayTradeCount: number;
  startEquityUsd: number; // equity at mission creation
  peakEquityUsd: number; // highest equity since mission creation
  troughEquityUsd: number; // lowest equity since mission creation
};

// ---- Mission Evaluation ---------------------------------------------

/**
 * Evaluates a mission's progress against its target using the current
 * portfolio state. Returns updated progress.
 */
export function evaluateMission(mission: Mission, ctx: MissionPortfolioContext): MissionProgress {
  const now = Date.now();
  const target = mission.target;

  switch (target.type) {
    case 'growth': {
      const growthPct = ctx.startEquityUsd > 0
        ? ((ctx.totalEquityUsd - ctx.startEquityUsd) / ctx.startEquityUsd) * 100
        : 0;
      const progressPct = Math.min(100, Math.max(0, (growthPct / target.targetPct) * 100));
      const elapsedDays = (now - mission.createdAt) / (1000 * 60 * 60 * 24);
      const expectedPct = (elapsedDays / target.timeframeDays) * 100;
      const status = getProgressStatus(progressPct, expectedPct);
      return {
        currentPct: progressPct,
        status,
        lastEvaluatedAt: now,
        detail: `${growthPct >= 0 ? '+' : ''}${growthPct.toFixed(2)}% growth (target: ${target.targetPct}%) — ${Math.max(0, target.timeframeDays - Math.floor(elapsedDays))} days remaining`,
      };
    }

    case 'capital-preservation': {
      const drawdownPct = ctx.peakEquityUsd > 0
        ? ((ctx.peakEquityUsd - ctx.troughEquityUsd) / ctx.peakEquityUsd) * 100
        : 0;
      const currentDrawdown = ctx.peakEquityUsd > 0
        ? ((ctx.peakEquityUsd - ctx.totalEquityUsd) / ctx.peakEquityUsd) * 100
        : 0;
      // Progress = how much of the timeframe has passed WITHOUT exceeding drawdown
      const elapsedDays = (now - mission.createdAt) / (1000 * 60 * 60 * 24);
      const progressPct = Math.min(100, (elapsedDays / target.timeframeDays) * 100);
      const withinLimit = currentDrawdown <= target.maxDrawdownPct;
      const status: MissionProgressStatus = !withinLimit ? 'at-risk' : progressPct >= 90 ? 'ahead' : 'on-track';
      return {
        currentPct: progressPct,
        status,
        lastEvaluatedAt: now,
        detail: `Current drawdown: ${currentDrawdown.toFixed(2)}% (max allowed: ${target.maxDrawdownPct}%) — max seen: ${drawdownPct.toFixed(2)}%`,
      };
    }

    case 'event-reduction': {
      const exposurePct = ctx.totalEquityUsd > 0
        ? ((ctx.totalEquityUsd - ctx.cashUsd) / ctx.totalEquityUsd) * 100
        : 0;
      const targetExposure = target.targetExposurePct;
      // Progress = how close we are to the target exposure
      // If we started at 80% exposure and target is 20%, going to 50% is 50% progress
      const startExposure = 100; // assume worst case
      const delta = Math.max(0, startExposure - targetExposure);
      const achieved = Math.max(0, startExposure - exposurePct);
      const progressPct = delta > 0 ? Math.min(100, (achieved / delta) * 100) : 100;
      const timeRemaining = Math.max(0, target.deadline - now);
      const hoursRemaining = Math.floor(timeRemaining / (1000 * 60 * 60));
      const status: MissionProgressStatus = exposurePct <= targetExposure ? 'ahead' : hoursRemaining < 6 ? 'at-risk' : 'on-track';
      return {
        currentPct: progressPct,
        status,
        lastEvaluatedAt: now,
        detail: `Current exposure: ${exposurePct.toFixed(1)}% (target: ≤${targetExposure}%) — ${hoursRemaining}h remaining`,
      };
    }

    case 'accumulation': {
      const position = ctx.positions.find((p) => p.symbol === target.symbol);
      const currentQty = position?.qty ?? 0;
      const avgCost = position?.avgCost ?? 0;
      const progressPct = Math.min(100, (currentQty / target.targetQty) * 100);
      const costOk = avgCost <= target.maxAvgCost || currentQty === 0;
      const status: MissionProgressStatus = !costOk ? 'at-risk' : progressPct >= 90 ? 'ahead' : progressPct >= 40 ? 'on-track' : 'behind';
      return {
        currentPct: progressPct,
        status,
        lastEvaluatedAt: now,
        detail: `Accumulated ${currentQty.toFixed(6)} / ${target.targetQty.toFixed(6)} ${target.symbol} (avg cost: $${avgCost.toLocaleString()}, max: $${target.maxAvgCost.toLocaleString()})`,
      };
    }

    case 'cash-allocation': {
      const cashPct = ctx.totalEquityUsd > 0 ? (ctx.cashUsd / ctx.totalEquityUsd) * 100 : 100;
      const progressPct = Math.min(100, (cashPct / target.targetCashPct) * 100);
      const elapsedDays = (now - mission.createdAt) / (1000 * 60 * 60 * 24);
      const expectedPct = (elapsedDays / target.timeframeDays) * 100;
      const status = getProgressStatus(progressPct, expectedPct);
      return {
        currentPct: progressPct,
        status,
        lastEvaluatedAt: now,
        detail: `Cash: ${cashPct.toFixed(1)}% of portfolio (target: ${target.targetCashPct}%) — ${Math.max(0, target.timeframeDays - Math.floor(elapsedDays))} days remaining`,
      };
    }
  }
}

function getProgressStatus(progressPct: number, expectedPct: number): MissionProgressStatus {
  if (progressPct >= 100) return 'ahead';
  if (progressPct >= expectedPct * 0.9) return 'on-track';
  if (progressPct >= expectedPct * 0.5) return 'behind';
  return 'at-risk';
}

// ---- Trade Alignment Scoring ----------------------------------------

export type MissionAlignment = 'aligned' | 'neutral' | 'misaligned';

export type MissionAlignmentResult = {
  alignment: MissionAlignment;
  reasons: string[];
};

/**
 * Scores how well a proposed trade aligns with the active mission.
 * Does NOT block — only informs. The Supervisor uses this to add
 * caution notes, not to reject.
 */
export function scoreMissionAlignment(
  mission: Mission,
  trade: { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; leverage?: number },
  ctx: MissionPortfolioContext,
): MissionAlignmentResult {
  const reasons: string[] = [];
  let alignment: MissionAlignment = 'neutral';

  const target = mission.target;

  // Type-specific alignment
  switch (target.type) {
    case 'growth':
      // Buys are generally aligned with growth, sells need context
      if (trade.side === 'buy') {
        alignment = 'aligned';
        reasons.push('Buy contributes to growth target.');
      }
      break;

    case 'capital-preservation':
      // Buys increase risk — misaligned unless small
      if (trade.side === 'buy') {
        const notional = trade.qty * trade.price;
        const pctOfEquity = ctx.totalEquityUsd > 0 ? (notional / ctx.totalEquityUsd) * 100 : 100;
        if (pctOfEquity > 5) {
          alignment = 'misaligned';
          reasons.push(`New buy (${pctOfEquity.toFixed(1)}% of equity) increases risk during a capital-preservation mission.`);
        }
      } else {
        alignment = 'aligned';
        reasons.push('Sell reduces exposure, aligned with capital-preservation.');
      }
      break;

    case 'event-reduction':
      if (trade.side === 'buy') {
        alignment = 'misaligned';
        reasons.push('Buy increases exposure during an event-reduction mission.');
      } else {
        alignment = 'aligned';
        reasons.push('Sell reduces exposure toward target.');
      }
      break;

    case 'accumulation':
      if (trade.symbol === target.symbol && trade.side === 'buy') {
        if (trade.price <= target.maxAvgCost) {
          alignment = 'aligned';
          reasons.push(`Buy of ${target.symbol} at $${trade.price.toLocaleString()} is within the max avg cost target.`);
        } else {
          alignment = 'misaligned';
          reasons.push(`Buy price $${trade.price.toLocaleString()} exceeds max avg cost $${target.maxAvgCost.toLocaleString()}.`);
        }
      } else if (trade.symbol === target.symbol && trade.side === 'sell') {
        alignment = 'misaligned';
        reasons.push(`Selling ${target.symbol} works against the accumulation mission.`);
      }
      break;

    case 'cash-allocation':
      if (trade.side === 'sell') {
        alignment = 'aligned';
        reasons.push('Sell increases cash allocation toward target.');
      } else {
        alignment = 'misaligned';
        reasons.push('Buy decreases cash allocation during a cash-allocation mission.');
      }
      break;
  }

  // Constraint-based alignment checks
  for (const constraint of mission.constraints) {
    switch (constraint.kind) {
      case 'allowed-sides':
        if (!constraint.sides.includes(trade.side)) {
          alignment = 'misaligned';
          reasons.push(`Trade side '${trade.side}' is not allowed by mission constraint (allowed: ${constraint.sides.join(', ')}).`);
        }
        break;

      case 'allowed-symbols':
        if (!constraint.symbols.includes(trade.symbol)) {
          alignment = 'misaligned';
          reasons.push(`Symbol '${trade.symbol}' is not in the mission's allowed symbols: ${constraint.symbols.join(', ')}.`);
        }
        break;

      case 'max-leverage':
        if ((trade.leverage ?? 1) > constraint.value) {
          alignment = 'misaligned';
          reasons.push(`Leverage ${trade.leverage ?? 1}x exceeds mission max ${constraint.value}x.`);
        }
        break;

      case 'max-trades-per-day':
        if (ctx.todayTradeCount >= constraint.value) {
          alignment = 'misaligned';
          reasons.push(`Daily trade limit (${constraint.value}) reached.`);
        }
        break;

      case 'max-position-size-pct': {
        const notional = trade.qty * trade.price;
        const pctOfEquity = ctx.totalEquityUsd > 0 ? (notional / ctx.totalEquityUsd) * 100 : 100;
        if (trade.side === 'buy' && pctOfEquity > constraint.value) {
          alignment = 'misaligned';
          reasons.push(`Position size ${pctOfEquity.toFixed(1)}% exceeds mission max ${constraint.value}%.`);
        }
        break;
      }

      case 'max-total-exposure-pct': {
        const currentExposurePct = ctx.totalEquityUsd > 0
          ? ((ctx.totalEquityUsd - ctx.cashUsd) / ctx.totalEquityUsd) * 100
          : 0;
        if (trade.side === 'buy' && currentExposurePct > constraint.value) {
          alignment = 'misaligned';
          reasons.push(`Total exposure ${currentExposurePct.toFixed(1)}% already exceeds mission max ${constraint.value}%.`);
        }
        break;
      }

      case 'min-cash-reserve-pct': {
        const notional = trade.qty * trade.price;
        const cashAfterTrade = trade.side === 'buy' ? ctx.cashUsd - notional : ctx.cashUsd + notional;
        const cashPctAfter = ctx.totalEquityUsd > 0 ? (cashAfterTrade / ctx.totalEquityUsd) * 100 : 0;
        if (trade.side === 'buy' && cashPctAfter < constraint.value) {
          alignment = 'misaligned';
          reasons.push(`Cash after trade would be ${cashPctAfter.toFixed(1)}%, below mission minimum ${constraint.value}%.`);
        }
        break;
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push('No specific alignment or conflict with the active mission.');
  }

  return { alignment, reasons };
}

// ---- Mission Expiry Check -------------------------------------------

/**
 * Checks if a mission has expired. Returns the new status if changed.
 */
export function checkMissionExpiry(mission: Mission): MissionStatus {
  if (mission.status !== 'active') return mission.status;

  const now = Date.now();

  // Check explicit expiry
  if (mission.expiresAt !== null && now >= mission.expiresAt) {
    return 'expired';
  }

  // Check timeframe-based expiry for time-bounded missions
  const target = mission.target;
  if ('timeframeDays' in target) {
    const deadlineMs = mission.createdAt + target.timeframeDays * 24 * 60 * 60 * 1000;
    if (now >= deadlineMs) {
      return mission.progress.currentPct >= 100 ? 'completed' : 'expired';
    }
  }

  // Check deadline-based expiry
  if (target.type === 'event-reduction' && now >= target.deadline) {
    return mission.progress.currentPct >= 100 ? 'completed' : 'expired';
  }

  return 'active';
}

// ---- Default Constraints per Mission Type ---------------------------

/**
 * Returns sensible default constraints for a mission type.
 * Users can customize these after creation.
 */
export function getDefaultConstraints(type: MissionType): MissionConstraint[] {
  switch (type) {
    case 'growth':
      return [
        { kind: 'max-position-size-pct', value: 15 },
        { kind: 'max-leverage', value: 5 },
      ];
    case 'capital-preservation':
      return [
        { kind: 'max-position-size-pct', value: 5 },
        { kind: 'max-total-exposure-pct', value: 40 },
        { kind: 'min-cash-reserve-pct', value: 60 },
        { kind: 'max-leverage', value: 2 },
      ];
    case 'event-reduction':
      return [
        { kind: 'allowed-sides', sides: ['sell'] },
        { kind: 'max-leverage', value: 1 },
      ];
    case 'accumulation':
      return [
        { kind: 'max-position-size-pct', value: 20 },
        { kind: 'max-leverage', value: 1 },
      ];
    case 'cash-allocation':
      return [
        { kind: 'allowed-sides', sides: ['sell'] },
        { kind: 'min-cash-reserve-pct', value: 30 },
      ];
  }
}

// ---- Human-readable Descriptions ------------------------------------

export const MISSION_TYPE_LABELS: Record<MissionType, string> = {
  growth: '📈 Growth',
  'capital-preservation': '🛡️ Capital Preservation',
  'event-reduction': '⚡ Event Reduction',
  accumulation: '🏦 Accumulation',
  'cash-allocation': '💵 Cash Allocation',
};

export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  expired: 'Expired',
};

export function describeMissionTarget(target: MissionTarget): string {
  switch (target.type) {
    case 'growth':
      return `Grow account ${target.targetPct}% in ${target.timeframeDays} days`;
    case 'capital-preservation':
      return `Keep drawdown under ${target.maxDrawdownPct}% for ${target.timeframeDays} days`;
    case 'event-reduction':
      return `Reduce exposure to ${target.targetExposurePct}% by ${new Date(target.deadline).toLocaleDateString()}`;
    case 'accumulation':
      return `Accumulate ${target.targetQty} ${target.symbol} below $${target.maxAvgCost.toLocaleString()}`;
    case 'cash-allocation':
      return `Increase cash to ${target.targetCashPct}% within ${target.timeframeDays} days`;
  }
}
