// ---------------------------------------------------------------------
// Watchdog (engineering spec Section 22.8).
//
// The spec states the design target bluntly: "Assume the worst case is
// not 'the bot makes a bad trade' but 'the bot goes silent while holding
// a leveraged position' — design against that specifically."
//
// That failure mode is REAL in this app and worth being precise about,
// because the honest version is uncomfortable: every loop here is a
// client-side setInterval. If the browser tab is closed, backgrounded
// hard enough for the browser to throttle timers, the machine sleeps, or
// the process crashes, the loops stop — while any open position stays
// open on the exchange, with its stop-loss existing only as a number
// this app intends to act on, NOT as a resting order the exchange holds.
//
// This module cannot fix that. Fixing it properly requires either
// server-side execution or exchange-native stop orders, both of which
// are substantial separate pieces of work (see the Gaps section below).
// What it CAN do — and what silence-detection is actually for — is make
// the condition loud instead of invisible: detect that a loop has stopped
// heartbeating, and state plainly what is at risk because of it.
//
// Pure and deterministic so it can be unit-tested against fabricated
// clocks rather than by waiting in real time.
// ---------------------------------------------------------------------

export type WatchdogSeverity = 'ok' | 'warning' | 'critical';

export type MonitoredLoop = {
  id: string;
  label: string;
  /** Last successful heartbeat. null = never ran since load. */
  lastHeartbeatAt: number | null;
  /** How often this loop is SUPPOSED to run. */
  expectedIntervalMs: number;
  /** Whether the loop is meant to be running at all right now. */
  enabled: boolean;
};

export type WatchdogFinding = {
  loopId: string;
  label: string;
  severity: WatchdogSeverity;
  staleForMs: number | null;
  message: string;
};

export type WatchdogReport = {
  overall: WatchdogSeverity;
  findings: WatchdogFinding[];
  /**
   * True when at least one loop is stale AND there is unprotected
   * exposure — the specific combination the spec says to design against.
   */
  silentWithOpenRisk: boolean;
};

// A loop is only "stale" once it has missed several cycles, not one.
// Browsers legitimately throttle timers in background tabs, and a single
// late tick is normal — alerting on that would train the operator to
// ignore the warning, which is worse than not having it.
const WARNING_MISSED_CYCLES = 3;
const CRITICAL_MISSED_CYCLES = 10;

export function assessLoop(loop: MonitoredLoop, nowMs: number): WatchdogFinding {
  if (!loop.enabled) {
    return {
      loopId: loop.id,
      label: loop.label,
      severity: 'ok',
      staleForMs: null,
      message: `${loop.label} is intentionally stopped — not a fault.`,
    };
  }
  if (loop.lastHeartbeatAt === null) {
    return {
      loopId: loop.id,
      label: loop.label,
      severity: 'warning',
      staleForMs: null,
      message: `${loop.label} is enabled but has not completed a cycle yet since this page loaded.`,
    };
  }

  const staleForMs = Math.max(0, nowMs - loop.lastHeartbeatAt);
  const missedCycles = loop.expectedIntervalMs > 0 ? staleForMs / loop.expectedIntervalMs : 0;

  if (missedCycles >= CRITICAL_MISSED_CYCLES) {
    return {
      loopId: loop.id,
      label: loop.label,
      severity: 'critical',
      staleForMs,
      message: `${loop.label} has not run for ${formatDuration(staleForMs)} (expected every ${formatDuration(loop.expectedIntervalMs)}). It has effectively stopped.`,
    };
  }
  if (missedCycles >= WARNING_MISSED_CYCLES) {
    return {
      loopId: loop.id,
      label: loop.label,
      severity: 'warning',
      staleForMs,
      message: `${loop.label} is running late — last cycle ${formatDuration(staleForMs)} ago, expected every ${formatDuration(loop.expectedIntervalMs)}. Browsers throttle timers in background tabs, so this may be benign.`,
    };
  }
  return {
    loopId: loop.id,
    label: loop.label,
    severity: 'ok',
    staleForMs,
    message: `${loop.label} healthy — last cycle ${formatDuration(staleForMs)} ago.`,
  };
}

export function assessWatchdog(params: {
  loops: MonitoredLoop[];
  /** Open positions whose stop-loss depends on a loop actually running. */
  openPositionCount: number;
  nowMs: number;
}): WatchdogReport {
  const findings = params.loops.map((l) => assessLoop(l, params.nowMs));
  const worst: WatchdogSeverity = findings.some((f) => f.severity === 'critical')
    ? 'critical'
    : findings.some((f) => f.severity === 'warning')
      ? 'warning'
      : 'ok';

  // The combination that actually matters. A stalled loop with no open
  // position is an inconvenience; a stalled loop WITH open exposure means
  // nothing is watching a stop-loss that exists only in this app's
  // intent, and that deserves to be escalated on its own.
  const anyStale = findings.some((f) => f.severity !== 'ok');
  const silentWithOpenRisk = anyStale && params.openPositionCount > 0;

  return {
    overall: silentWithOpenRisk ? 'critical' : worst,
    findings,
    silentWithOpenRisk,
  };
}

/**
 * The operator-facing warning for the spec's worst case. Deliberately
 * concrete about what is and isn't protected rather than a generic
 * "connection issue" message.
 */
export function describeSilentRisk(openPositionCount: number): string {
  return (
    `${openPositionCount} position(s) are open while a monitoring loop has stopped. ` +
    `Stop-losses in this app are enforced by that loop evaluating live prices — they are NOT resting orders held by the exchange, ` +
    `so while the loop is stopped nothing will close a position if it moves against you. ` +
    `Keep this tab open and awake, or close the exposure manually.`
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

// ---------------------------------------------------------------------
// Retry with exponential backoff (spec Section 22.8: "retry with
// exponential backoff", Production Readiness Review #1).
//
// Deliberately NOT applied to order placement. Retrying a write whose
// response was lost is exactly how duplicate fills happen; that path is
// protected by the idempotency key in lib/executionQuality.ts instead,
// and a retry there must reuse the same key rather than rely on backoff.
// This is for READ paths (candles, quotes, balances) where a transient
// failure is safe to repeat.
// ---------------------------------------------------------------------

export type BackoffConfig = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_BACKOFF: BackoffConfig = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 };

/**
 * Delay before attempt N (1-indexed). Pure, so backoff schedules are
 * unit-testable without sleeping. `jitterFraction` (0..1) should be
 * supplied by the caller from its own randomness source — this function
 * stays deterministic so tests can pin it.
 */
export function backoffDelayMs(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF, jitterFraction = 0): number {
  if (attempt <= 1) return 0; // first attempt is immediate
  const exponential = config.baseDelayMs * Math.pow(2, attempt - 2);
  const capped = Math.min(exponential, config.maxDelayMs);
  // Jitter spreads retries so several failing calls don't resynchronize
  // into a thundering herd against a rate-limited endpoint.
  return Math.round(capped * (1 + jitterFraction));
}

export function shouldRetry(attempt: number, config: BackoffConfig = DEFAULT_BACKOFF): boolean {
  return attempt < config.maxAttempts;
}
