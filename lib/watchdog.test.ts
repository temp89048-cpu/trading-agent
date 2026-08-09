import { describe, it, expect } from 'vitest';
import {
  assessLoop,
  assessWatchdog,
  describeSilentRisk,
  backoffDelayMs,
  shouldRetry,
  DEFAULT_BACKOFF,
  type MonitoredLoop,
} from './watchdog';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function loop(overrides: Partial<MonitoredLoop> = {}): MonitoredLoop {
  return {
    id: 'autonomous-trader',
    label: 'Autonomous Trader',
    lastHeartbeatAt: NOW,
    expectedIntervalMs: MINUTE,
    enabled: true,
    ...overrides,
  };
}

describe('assessLoop', () => {
  it('reports a disabled loop as ok, not as a fault', () => {
    const f = assessLoop(loop({ enabled: false, lastHeartbeatAt: null }), NOW);
    expect(f.severity).toBe('ok');
    expect(f.message).toContain('intentionally stopped');
  });

  it('warns when an enabled loop has never completed a cycle', () => {
    const f = assessLoop(loop({ lastHeartbeatAt: null }), NOW);
    expect(f.severity).toBe('warning');
    expect(f.staleForMs).toBeNull();
  });

  it('reports a fresh heartbeat as healthy', () => {
    expect(assessLoop(loop({ lastHeartbeatAt: NOW - 1000 }), NOW).severity).toBe('ok');
  });

  it('tolerates a single late cycle without alerting', () => {
    // Browsers throttle background timers; alerting on one late tick
    // would train the operator to ignore the warning.
    expect(assessLoop(loop({ lastHeartbeatAt: NOW - 2 * MINUTE }), NOW).severity).toBe('ok');
  });

  it('warns after several missed cycles', () => {
    const f = assessLoop(loop({ lastHeartbeatAt: NOW - 4 * MINUTE }), NOW);
    expect(f.severity).toBe('warning');
    expect(f.message).toContain('running late');
  });

  it('escalates to critical once the loop has effectively stopped', () => {
    const f = assessLoop(loop({ lastHeartbeatAt: NOW - 15 * MINUTE }), NOW);
    expect(f.severity).toBe('critical');
    expect(f.message).toContain('effectively stopped');
  });

  it('scales thresholds to the loop own interval, not a fixed wall-clock', () => {
    // A 15-minute loop 4 minutes late is fine; a 1-minute loop 4 minutes
    // late is not.
    const slow = assessLoop(loop({ expectedIntervalMs: 15 * MINUTE, lastHeartbeatAt: NOW - 4 * MINUTE }), NOW);
    const fast = assessLoop(loop({ expectedIntervalMs: MINUTE, lastHeartbeatAt: NOW - 4 * MINUTE }), NOW);
    expect(slow.severity).toBe('ok');
    expect(fast.severity).toBe('warning');
  });

  it('never reports negative staleness from clock skew', () => {
    const f = assessLoop(loop({ lastHeartbeatAt: NOW + 5000 }), NOW);
    expect(f.staleForMs).toBe(0);
  });

  it('does not divide by zero on a zero interval', () => {
    const f = assessLoop(loop({ expectedIntervalMs: 0, lastHeartbeatAt: NOW - MINUTE }), NOW);
    expect(f.severity).toBe('ok');
  });
});

describe('assessWatchdog', () => {
  it('is ok when everything is healthy', () => {
    const report = assessWatchdog({ loops: [loop()], openPositionCount: 0, nowMs: NOW });
    expect(report.overall).toBe('ok');
    expect(report.silentWithOpenRisk).toBe(false);
  });

  it('reports the worst severity across loops', () => {
    const report = assessWatchdog({
      loops: [loop({ id: 'a' }), loop({ id: 'b', lastHeartbeatAt: NOW - 20 * MINUTE })],
      openPositionCount: 0,
      nowMs: NOW,
    });
    expect(report.overall).toBe('critical');
  });

  it('escalates a merely-late loop to critical when positions are open', () => {
    // This is the spec's worst case: nothing is watching a stop-loss
    // that only exists as this app's intent.
    const report = assessWatchdog({
      loops: [loop({ lastHeartbeatAt: NOW - 4 * MINUTE })],
      openPositionCount: 1,
      nowMs: NOW,
    });
    expect(report.findings[0].severity).toBe('warning'); // the loop itself is only late
    expect(report.silentWithOpenRisk).toBe(true);
    expect(report.overall).toBe('critical'); // but the combination is critical
  });

  it('does not flag silent risk when nothing is open', () => {
    const report = assessWatchdog({
      loops: [loop({ lastHeartbeatAt: NOW - 20 * MINUTE })],
      openPositionCount: 0,
      nowMs: NOW,
    });
    expect(report.silentWithOpenRisk).toBe(false);
  });

  it('does not flag silent risk when the loop is deliberately off', () => {
    // An operator who stopped the loop and holds a position has made a
    // choice; that is not a silent failure.
    const report = assessWatchdog({
      loops: [loop({ enabled: false, lastHeartbeatAt: null })],
      openPositionCount: 2,
      nowMs: NOW,
    });
    expect(report.silentWithOpenRisk).toBe(false);
    expect(report.overall).toBe('ok');
  });

  it('handles an empty loop list', () => {
    const report = assessWatchdog({ loops: [], openPositionCount: 0, nowMs: NOW });
    expect(report.overall).toBe('ok');
    expect(report.findings).toEqual([]);
  });
});

describe('describeSilentRisk', () => {
  it('states plainly that stops are not resting exchange orders', () => {
    // The whole value of this message is that it does not soften the
    // actual exposure.
    const text = describeSilentRisk(2);
    expect(text).toContain('2 position(s)');
    expect(text).toContain('NOT resting orders');
    expect(text).toContain('manually');
  });
});

describe('backoffDelayMs', () => {
  it('makes the first attempt immediate', () => {
    expect(backoffDelayMs(1)).toBe(0);
  });

  it('grows exponentially', () => {
    expect(backoffDelayMs(2)).toBe(500);
    expect(backoffDelayMs(3)).toBe(1000);
    expect(backoffDelayMs(4)).toBe(2000);
  });

  it('caps at maxDelayMs', () => {
    expect(backoffDelayMs(20)).toBe(DEFAULT_BACKOFF.maxDelayMs);
  });

  it('applies caller-supplied jitter', () => {
    expect(backoffDelayMs(2, DEFAULT_BACKOFF, 0.5)).toBe(750);
  });

  it('is deterministic for the same inputs', () => {
    expect(backoffDelayMs(3, DEFAULT_BACKOFF, 0.25)).toBe(backoffDelayMs(3, DEFAULT_BACKOFF, 0.25));
  });
});

describe('shouldRetry', () => {
  it('allows retries below the attempt cap', () => {
    expect(shouldRetry(1)).toBe(true);
    expect(shouldRetry(2)).toBe(true);
  });

  it('stops at the cap', () => {
    expect(shouldRetry(3)).toBe(false);
    expect(shouldRetry(99)).toBe(false);
  });
});
