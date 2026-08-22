'use client';

// ---------------------------------------------------------------------
// "How the agent got here" for one decision — the 8-step horizontal walk:
//
//   Market Data -> Indicators -> Regime -> Strategy Signal
//               -> Risk Checks -> Decision -> Execution -> Outcome
//
// Used by the Decision Inspector and by the "◎ How" buttons on Positions and
// History rows.
//
// EVERY STEP CAN BE `unknown`, AND THAT IS THE WHOLE DESIGN.
//
// The reference builds all eight from one mock decision object, so each step
// always has a value and always renders PASS/WARN/FAIL. Real decisions are not
// like that: a run can exit before a thesis exists, the risk gateway may never
// have been reached, and a trade may still be open with no outcome.
//
// A step with no data renders as `unknown` — visibly distinct from PASS and from
// FAIL — because showing "PASS" for a stage that never ran would be the single
// most misleading thing this component could do. It would assert the agent
// checked something it did not.
// ---------------------------------------------------------------------

import { Badge } from '@/components/ui/Badge';
import type { JourneyState, JourneyStep } from '@/lib/viz/journey';

const STATE_CLASS: Record<JourneyState, string> = {
  ok: 'ok',
  warn: 'warn',
  fail: 'fail',
  // Deliberately no border tint: an unknown step should look inert, not judged.
  unknown: '',
};

const STATE_BADGE: Record<JourneyState, string> = {
  ok: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  unknown: 'UNAVAILABLE',
};

function Connector() {
  return (
    <div className="journey-connector" aria-hidden>
      <svg width="24" height="10">
        <line x1="0" y1="5" x2="16" y2="5" stroke="var(--border-strong)" strokeWidth="2" />
        <polygon points="16,1 24,5 16,9" fill="var(--border-strong)" />
      </svg>
    </div>
  );
}

function Step({ step }: { step: JourneyStep }) {
  const color = step.iconColor ?? 'var(--accent)';
  const dim = step.state === 'unknown';

  return (
    <div className="journey-step">
      <div className={`journey-node ${STATE_CLASS[step.state]}`} style={dim ? { opacity: 0.6 } : undefined}>
        <div
          className="journey-icon"
          style={{
            background: `color-mix(in srgb, ${color} 20%, transparent)`,
            color,
          }}
          aria-hidden
        >
          {step.icon}
        </div>

        <div className="text-[10.5px] uppercase mb-0.5" style={{ color: 'var(--text-muted)' }}>
          {step.label}
        </div>

        <div className="text-[11.5px] leading-snug mono">
          {step.lines.length > 0 ? (
            step.lines.map((l, i) => <div key={i}>{l}</div>)
          ) : (
            <div style={{ color: 'var(--text-muted)' }}>—</div>
          )}
        </div>

        <div className="mt-1.5" title={step.reason}>
          <Badge state={STATE_BADGE[step.state]} label={step.state === 'unknown' ? 'Unknown' : undefined} />
        </div>

        {step.state === 'unknown' && step.reason ? (
          <div className="text-[10px] mt-1 leading-snug" style={{ color: 'var(--text-muted)' }}>
            {step.reason}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function TradeJourney({ steps }: { steps: JourneyStep[] }) {
  return (
    <div className="journey-wrap">
      <div className="journey-row">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-start">
            <Step step={s} />
            {i < steps.length - 1 ? <Connector /> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export { buildJourney } from '@/lib/viz/journey';
export type { JourneySource, JourneyState, JourneyStep } from '@/lib/viz/journey';
