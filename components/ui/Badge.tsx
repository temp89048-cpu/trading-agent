// ---------------------------------------------------------------------
// ONE Badge for the whole app.
//
// The reference's `badge()` maps a status word to a colour and a label. Every
// page uses the same vocabulary — PASS/WARN/FAIL, RUNNING/COMPLETED/WAITING/
// IDLE/SKIPPED/FAILED — and the replacement brief is explicit that this must be
// one shared component rather than reimplemented per page, because a status word
// that renders green on one screen and amber on another is worse than no colour
// at all.
//
// TINTS USE `color-mix()`, NOT CONCATENATED HEX+ALPHA.
//
// The reference fixed that bug deliberately. `var(--accent) + '18'` only works
// when the variable happens to hold a 6-digit hex; Aurora and Platinum would
// silently produce an invalid colour and fall back to transparent. `color-mix`
// works against any colour value, so a theme can change representation without
// breaking every badge in the app.
// ---------------------------------------------------------------------

export type BadgeState =
  // positive
  | 'PASS' | 'HEALTHY' | 'ACTIVE' | 'FILLED' | 'COMPLETED' | 'CONFIRMED'
  // accent
  | 'OPEN' | 'RUNNING'
  // warning
  | 'WARN' | 'DEGRADED' | 'WATCH' | 'WAITING' | 'WARNING' | 'PARTIAL'
  // negative
  | 'FAIL' | 'DOWN' | 'REJECTED' | 'FAILED' | 'CRITICAL' | 'ERROR' | 'BLOCKED'
  // neutral
  | 'IDLE' | 'SKIPPED' | 'PAUSED' | 'INFO' | 'SCANNING' | 'UNAVAILABLE';

type Entry = { color: string; label: string };

const MAP: Record<string, Entry> = {
  PASS: { color: 'var(--positive)', label: 'Pass' },
  HEALTHY: { color: 'var(--positive)', label: 'Healthy' },
  ACTIVE: { color: 'var(--positive)', label: 'Active' },
  FILLED: { color: 'var(--positive)', label: 'Filled' },
  COMPLETED: { color: 'var(--positive)', label: 'Completed' },
  CONFIRMED: { color: 'var(--positive)', label: 'Confirmed' },

  OPEN: { color: 'var(--accent)', label: 'Open' },
  RUNNING: { color: 'var(--accent)', label: 'Running' },

  WARN: { color: 'var(--warning)', label: 'Warn' },
  DEGRADED: { color: 'var(--warning)', label: 'Degraded' },
  WATCH: { color: 'var(--warning)', label: 'Watch' },
  WAITING: { color: 'var(--warning)', label: 'Waiting' },
  WARNING: { color: 'var(--warning)', label: 'Warning' },
  PARTIAL: { color: 'var(--warning)', label: 'Partial' },

  FAIL: { color: 'var(--negative)', label: 'Fail' },
  DOWN: { color: 'var(--negative)', label: 'Down' },
  REJECTED: { color: 'var(--negative)', label: 'Rejected' },
  FAILED: { color: 'var(--negative)', label: 'Failed' },
  CRITICAL: { color: 'var(--negative)', label: 'Critical' },
  ERROR: { color: 'var(--negative)', label: 'Error' },
  BLOCKED: { color: 'var(--negative)', label: 'Blocked' },

  IDLE: { color: 'var(--text-muted)', label: 'Idle' },
  SKIPPED: { color: 'var(--text-muted)', label: 'Skipped' },
  PAUSED: { color: 'var(--text-muted)', label: 'Paused' },
  INFO: { color: 'var(--text-secondary)', label: 'Info' },
  SCANNING: { color: 'var(--text-secondary)', label: 'Scanning' },
  // Not in the reference's map. Added because this backend distinguishes
  // "measured and found nothing" from "could not measure", and that distinction
  // is load-bearing across the whole system — a badge that collapsed them would
  // undo it at the last step.
  UNAVAILABLE: { color: 'var(--text-muted)', label: 'Unavailable' },
};

// Only these animate, matching the reference: a pulsing badge should mean
// "work is happening right now", so applying it to a settled state would make
// the signal meaningless.
const ANIMATED = new Set(['RUNNING', 'SCANNING']);

export function Badge({
  state,
  label,
  title,
}: {
  state: BadgeState | string;
  /** Override the mapped label. The colour still comes from `state`. */
  label?: string;
  title?: string;
}) {
  const key = String(state ?? '').toUpperCase();
  // Unknown states render in secondary text with the raw value shown, rather
  // than silently picking a colour — an unmapped status is a real thing to fix,
  // and colouring it green would hide it.
  const entry = MAP[key] ?? { color: 'var(--text-secondary)', label: String(state) };

  return (
    <span
      className="badge"
      title={title}
      style={{
        background: `color-mix(in srgb, ${entry.color} 18%, transparent)`,
        color: entry.color,
      }}
    >
      <span
        className={`dot${ANIMATED.has(key) ? ' pulse' : ''}`}
        style={{ background: entry.color }}
        aria-hidden
      />
      {label ?? entry.label}
    </span>
  );
}

/** The colour a state maps to, for callers that need it outside a badge
 *  (gauge fills, journey node borders). Keeps one source of truth. */
export function stateColor(state: string): string {
  return MAP[String(state ?? '').toUpperCase()]?.color ?? 'var(--text-secondary)';
}
