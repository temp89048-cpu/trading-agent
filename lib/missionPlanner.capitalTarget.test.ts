// Reproduces and pins the reported bug: creating a capital-target Mission showed
// it as COMPLETED immediately.
//
// TWO INDEPENDENT CAUSES, and each is enough on its own:
//
//  1. Two disagreeing "starting paper equity" constants. `DEFAULT_PORTFOLIO`
//     (lib/types.ts) opened the paper book with 1,000,000 while
//     `PAPER_STARTING_EQUITY` (lib/riskManager.ts) said 25,000 — and the mission
//     form defaults to 25,000 -> 30,000. So with the form's OWN defaults, equity
//     was already 975,000 past the declared start: progress 100%, and
//     `checkMissionExpiry` promotes a capital-target at >=100% straight to
//     'completed'. The mission was finished before it began.
//
//  2. Progress compared LIVE equity against a USER-DECLARED start. Even with the
//     constants reconciled, declaring "$100 -> $1,000" while actually holding
//     $25,000 gives instant 100%. The declared start is a statement of intent; it
//     is not an observation of the book, and subtracting one from the other
//     produces a number that means nothing.
//
// The fix measures the gain actually made SINCE THE MISSION STARTED, from a
// baseline captured at creation, so progress is 0% at creation no matter what was
// declared — and says so when the declared start disagrees with the real book.

import { describe, expect, it } from 'vitest';

import {
  checkMissionExpiry,
  evaluateMission,
  type Mission,
  type MissionPortfolioContext,
} from './missionPlanner';
import { PAPER_STARTING_EQUITY } from './riskManager';
import { DEFAULT_PORTFOLIO } from './types';

function capitalMission(startUsd: number, targetUsd: number, baseline?: number): Mission {
  const now = Date.now();
  return {
    id: 'm1',
    type: 'capital-target',
    name: 'Grow the account',
    description: '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    target: { type: 'capital-target', startEquityUsd: startUsd, targetEquityUsd: targetUsd },
    progress: { currentPct: 0, status: 'on-track', lastEvaluatedAt: now, detail: '' },
    constraints: [],
    checkpoints: [],
    ...(baseline === undefined ? {} : { baselineEquityUsd: baseline }),
  } as Mission;
}

function ctx(equityUsd: number, baseline = equityUsd): MissionPortfolioContext {
  return {
    cashUsd: equityUsd,
    totalEquityUsd: equityUsd,
    positions: [],
    todayTradeCount: 0,
    startEquityUsd: baseline,
    peakEquityUsd: Math.max(equityUsd, baseline),
    troughEquityUsd: Math.min(equityUsd, baseline),
  };
}

describe('the two starting-equity constants', () => {
  it('agree, so the mission form default is not already past its target', () => {
    // This is cause #1. While these disagreed, every fresh paper book started
    // 40x above the figure every drawdown and return metric measured against.
    expect(DEFAULT_PORTFOLIO.paper.cash).toBe(PAPER_STARTING_EQUITY);
  });
});

describe('a capital-target mission at the moment it is created', () => {
  it('reads 0%, not 100% — the reported bug', () => {
    // The exact reproduction: the form's own defaults (25,000 -> 30,000) against
    // a freshly opened paper book.
    const equity = DEFAULT_PORTFOLIO.paper.cash;
    const mission = capitalMission(25_000, 30_000, equity);

    const progress = evaluateMission(mission, ctx(equity));

    expect(progress.currentPct).toBe(0);
    expect(checkMissionExpiry({ ...mission, progress })).toBe('active');
  });

  it('reads 0% even when the declared start is nowhere near the real book', () => {
    // Cause #2 on its own. Someone says "turn $100 into $1,000" while holding
    // $25,000. Nothing has been achieved yet, so progress must be 0 — and the
    // detail has to admit the declared start does not match the book, because the
    // target means something different than the user thinks it does.
    const equity = 25_000;
    const mission = capitalMission(100, 1_000, equity);

    const progress = evaluateMission(mission, ctx(equity));

    expect(progress.currentPct).toBe(0);
    expect(checkMissionExpiry({ ...mission, progress })).toBe('active');
    expect(progress.detail.toLowerCase()).toContain('declared');
  });

  it('does not complete on creation for any plausible start/target pair', () => {
    const equity = DEFAULT_PORTFOLIO.paper.cash;
    for (const [start, target] of [
      [25_000, 30_000],
      [100, 1_000],
      [1_000, 1_000_000],
      [0.01, 0.02],
      [50_000, 60_000],
    ] as const) {
      const mission = capitalMission(start, target, equity);
      const progress = evaluateMission(mission, ctx(equity));
      expect(progress.currentPct, `${start} -> ${target}`).toBe(0);
      expect(checkMissionExpiry({ ...mission, progress }), `${start} -> ${target}`).toBe('active');
    }
  });
});

describe('a capital-target mission as equity moves', () => {
  it('reports the fraction of the declared journey actually travelled', () => {
    const baseline = 25_000;
    const mission = capitalMission(25_000, 30_000, baseline);
    // +2,500 of a 5,000 journey.
    const progress = evaluateMission(mission, ctx(27_500, baseline));
    expect(progress.currentPct).toBeCloseTo(50, 5);
  });

  it('completes only once the gain covers the declared journey', () => {
    const baseline = 25_000;
    const mission = capitalMission(25_000, 30_000, baseline);
    const progress = evaluateMission(mission, ctx(30_000, baseline));
    expect(progress.currentPct).toBe(100);
    expect(checkMissionExpiry({ ...mission, progress })).toBe('completed');
  });

  it('does not go negative when equity falls below the baseline', () => {
    // A losing mission is at 0% progress, not at -40%: the bar has nowhere below
    // empty to go, and a negative percentage would render as a filled bar.
    const baseline = 25_000;
    const mission = capitalMission(25_000, 30_000, baseline);
    const progress = evaluateMission(mission, ctx(23_000, baseline));
    expect(progress.currentPct).toBe(0);
    expect(progress.status).not.toBe('ahead');
  });

  it('never reports progress from an equity change that predates the mission', () => {
    // The heart of the fix: the baseline is what the book held when the mission
    // began, so gains made BEFORE it cannot be claimed by it.
    const mission = capitalMission(1_000, 2_000, 50_000);
    const progress = evaluateMission(mission, ctx(50_000, 50_000));
    expect(progress.currentPct).toBe(0);
  });
});

describe('a degenerate declared journey', () => {
  it('treats start === target as unmeasurable rather than instantly complete', () => {
    // Zero-length journey: any division is meaningless, so it must not report a
    // confident 100%.
    const mission = capitalMission(25_000, 25_000, 25_000);
    const progress = evaluateMission(mission, ctx(25_000, 25_000));
    expect(progress.currentPct).toBe(0);
    expect(progress.detail.toLowerCase()).toMatch(/no distance|unmeasurable|same/);
  });

  it('handles a target below the start without inverting the percentage', () => {
    const mission = capitalMission(30_000, 25_000, 30_000);
    const progress = evaluateMission(mission, ctx(30_000, 30_000));
    expect(Number.isFinite(progress.currentPct)).toBe(true);
    expect(progress.currentPct).toBeGreaterThanOrEqual(0);
    expect(progress.currentPct).toBeLessThanOrEqual(100);
  });
});

describe('a mission with no recorded baseline (created before the fix)', () => {
  it('falls back to the context baseline rather than the declared start', () => {
    // Stored missions have no `baselineEquityUsd`. They must not resurrect the
    // bug: the fallback is the observed equity, never `target.startEquityUsd`.
    const mission = capitalMission(100, 1_000, undefined);
    const progress = evaluateMission(mission, ctx(25_000, 25_000));
    expect(progress.currentPct).toBe(0);
  });
});
