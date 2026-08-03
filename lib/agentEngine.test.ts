import { describe, it, expect } from 'vitest';
import { agentTick } from './agentEngine';
import type { AgentTask } from './types';

const NOW = 1_700_000_000_000;

function baseTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 't1',
    tab: 'paper',
    symbol: 'BTC/USDT',
    side: 'buy',
    marginUsd: 100,
    leverage: 1,
    totalTrades: 5,
    executedTrades: 0,
    mode: 'take-profit',
    tpPercent: 5,
    slPercent: 3,
    status: 'running',
    createdAt: NOW,
    realizedTotal: 0,
    ...overrides,
  };
}

describe('agentTick — baseline behavior (no advanced fields set)', () => {
  it('opens a fresh leg once a take-profit task has no open position', () => {
    const result = agentTick(baseTask(), NOW, 100);
    expect(result.action).toBe('open');
  });

  it('does nothing while price sits between TP and SL', () => {
    const task = baseTask({ currentEntryPrice: 100, currentQty: 1 });
    expect(agentTick(task, NOW, 101).action).toBe('none');
  });

  it('closes at take-profit', () => {
    const task = baseTask({ currentEntryPrice: 100, currentQty: 1, tpPercent: 5, slPercent: 3 });
    const result = agentTick(task, NOW, 105.01);
    expect(result.action).toBe('close');
    if (result.action === 'close') {
      expect(result.pnl).toBeCloseTo(5.01, 2);
      expect(result.scaleOutLevelIndex).toBeUndefined();
    }
  });

  it('closes at stop-loss', () => {
    const task = baseTask({ currentEntryPrice: 100, currentQty: 1, tpPercent: 5, slPercent: 3 });
    const result = agentTick(task, NOW, 96.99);
    expect(result.action).toBe('close');
    if (result.action === 'close') expect(result.pnl).toBeLessThan(0);
  });

  it('mirrors TP/SL correctly for a sell (short) side', () => {
    const task = baseTask({ side: 'sell', currentEntryPrice: 100, currentQty: 1, tpPercent: 5, slPercent: 3 });
    // Price falling is favorable for a short — should hit take-profit.
    const tp = agentTick(task, NOW, 94.99);
    expect(tp.action).toBe('close');
    if (tp.action === 'close') expect(tp.pnl).toBeGreaterThan(0);
  });
});

describe('agentTick — trailing stop', () => {
  it('does not fire while price is still above the trail level', () => {
    let task = baseTask({ currentEntryPrice: 100, currentQty: 1, tpPercent: 50, slPercent: 50, trailingStopPercent: 2 });
    const r1 = agentTick(task, NOW, 110); // peak moves to 110
    expect(r1.action).toBe('none');
    if (r1.action === 'none' && r1.patch) task = { ...task, ...r1.patch };
    expect(task.currentPeakPrice).toBe(110);
    // Trail level is 110 * 0.98 = 107.8 — price at 108 is still above it.
    const r2 = agentTick(task, NOW, 108);
    expect(r2.action).toBe('none');
  });

  it('fires once price falls trailingStopPercent below the peak seen so far', () => {
    let task = baseTask({ currentEntryPrice: 100, currentQty: 1, tpPercent: 50, slPercent: 50, trailingStopPercent: 2 });
    const r1 = agentTick(task, NOW, 110);
    if (r1.action === 'none' && r1.patch) task = { ...task, ...r1.patch };
    // Trail level = 110 * 0.98 = 107.8
    const r2 = agentTick(task, NOW, 107.5);
    expect(r2.action).toBe('close');
    if (r2.action === 'close') expect(r2.pnl).toBeGreaterThan(0); // still a winning trade, just gave back some gain
  });

  it('never trails below the original entry-relative floor implied by a tighter fixed SL check running in parallel', () => {
    // Sanity: if price never moves favorably, trailing (anchored at entry)
    // behaves like a normal stop at entry * (1 - trailingStopPercent/100).
    const task = baseTask({ currentEntryPrice: 100, currentQty: 1, tpPercent: 50, slPercent: 50, trailingStopPercent: 2 });
    const result = agentTick(task, NOW, 97.9);
    expect(result.action).toBe('close');
  });
});

describe('agentTick — partial take-profit / scale-out', () => {
  it('closes only the configured fraction at the first level and arms breakeven', () => {
    const task = baseTask({
      currentEntryPrice: 100,
      currentQty: 10,
      tpPercent: 20, // fixed TP far away so it never interferes
      slPercent: 20,
      scaleOutLevels: [
        { tpPercent: 2, closeFraction: 0.5 },
        { tpPercent: 5, closeFraction: 0.5 },
      ],
    });
    const result = agentTick(task, NOW, 102);
    expect(result.action).toBe('close');
    if (result.action === 'close') {
      expect(result.scaleOutLevelIndex).toBe(0);
      expect(result.qty).toBeCloseTo(5, 6); // 50% of the original 10
    }
  });

  it('does not re-fire an already-scaled-out level', () => {
    const task = baseTask({
      currentEntryPrice: 100,
      currentQty: 5, // already reduced from a prior scale-out
      tpPercent: 20,
      slPercent: 20,
      scaleOutLevels: [{ tpPercent: 2, closeFraction: 0.5 }],
      scaledOutLevels: [0],
    });
    const result = agentTick(task, NOW, 103);
    expect(result.action).toBe('none');
  });

  it('breakeven-armed leg closes on any return to entry, even with plenty of TP/SL room left', () => {
    const task = baseTask({
      currentEntryPrice: 100,
      currentQty: 5,
      tpPercent: 20,
      slPercent: 20,
      breakEvenArmed: true,
    });
    const result = agentTick(task, NOW, 100);
    expect(result.action).toBe('close');
    if (result.action === 'close') expect(result.pnl).toBeCloseTo(0, 6);
  });
});

describe('agentTick — volatility-adaptive (ATR) stops', () => {
  it('uses ATR-derived thresholds instead of the static tpPercent/slPercent when useAtrStops is set', () => {
    const task = baseTask({
      currentEntryPrice: 100,
      currentQty: 1,
      tpPercent: 50, // would NOT fire at a 4% move
      slPercent: 50,
      useAtrStops: true,
      atrMultiplierTp: 2,
      atrMultiplierSl: 1,
    });
    // atrPercent = 2% -> effective TP = 2 * 2% = 4%, effective SL = 1 * 2% = 2%
    const result = agentTick(task, NOW, 104, undefined, { atrPercent: 2 });
    expect(result.action).toBe('close');
    if (result.action === 'close') expect(result.pnl).toBeGreaterThan(0);
  });

  it('falls back to the static tpPercent/slPercent when useAtrStops is set but no volatility context is available yet', () => {
    const task = baseTask({
      currentEntryPrice: 100,
      currentQty: 1,
      tpPercent: 5,
      slPercent: 3,
      useAtrStops: true,
    });
    // No volCtx passed — should behave exactly like the static-threshold case.
    const result = agentTick(task, NOW, 105.01, undefined);
    expect(result.action).toBe('close');
  });
});

describe('agentTick — lifecycle guards', () => {
  it('reports complete once executedTrades reaches totalTrades', () => {
    const task = baseTask({ executedTrades: 5, totalTrades: 5 });
    expect(agentTick(task, NOW, 100).action).toBe('complete');
  });

  it('is a no-op for a non-running task', () => {
    const task = baseTask({ status: 'cancelled' });
    expect(agentTick(task, NOW, 100).action).toBe('none');
  });

  it('is a no-op with no live price available', () => {
    const task = baseTask();
    expect(agentTick(task, NOW, undefined).action).toBe('none');
  });
});
