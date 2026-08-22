'use client';

// ---------------------------------------------------------------------
// The execution cycle as a stepper.
//
// The reference's `execCycle(activeIdx)` uses six invented labels — Scan, Detect,
// Validate, Size, Fill, Settle — with the active index hardcoded. Those are not
// stages this system has.
//
// THE REAL PIPELINE, which the stages below name instead:
//
//   Trigger    a TriggerReason admitted by the debounce/rate gate
//   Analyse    Graph 2 — market state, strategy, opportunity, 9 specialists, debate
//   Decide     the Supervisor's ten answers -> TRADE | WAIT | EXIT | DO_NOT_TRADE
//   Validate   the Risk Gateway sizes THEN validates; produces an inert plan
//   Submit     execution_service turns an approved plan into a TAR the CRO reviews
//   Fill       ExecutionAgent — simulated unless LIVE_TRADING is on
//
// Keeping the reference's six labels would have been easier and would have
// described a system that does not exist. An operator reading "Size" would look
// for a sizing stage; sizing happens inside Validate, and that matters because
// the gateway is the only place in the reasoning layer that sizes.
// ---------------------------------------------------------------------

import { EXEC_STAGES, type ExecStageKey } from '@/lib/viz/flow';

export function ExecCycleStepper({
  activeKey,
  reachedKeys = [],
}: {
  /** The stage in progress. `null` = idle, and nothing is highlighted — an idle
   *  system should not appear to be mid-cycle. */
  activeKey: ExecStageKey | null;
  /** Stages already completed this cycle. */
  reachedKeys?: ExecStageKey[];
}) {
  const reached = new Set(reachedKeys);

  return (
    <div>
      <div className="stepper-row">
        {EXEC_STAGES.map((stage, i) => {
          const active = stage.key === activeKey;
          const done = reached.has(stage.key) && !active;

          return (
            <div key={stage.key} className="flex items-center">
              <div
                className={`step-pill${active ? ' active' : ''}`}
                style={done ? { opacity: 0.55 } : undefined}
                title={stage.detail}
              >
                <div
                  className="step-num"
                  style={
                    done
                      ? { background: 'var(--positive)', borderColor: 'var(--positive)', color: '#fff' }
                      : undefined
                  }
                >
                  {done ? '✓' : String(i + 1).padStart(2, '0')}
                </div>
                <div className="text-[11px]">{stage.label}</div>
              </div>
              {i < EXEC_STAGES.length - 1 ? <div className="step-connector" /> : null}
            </div>
          );
        })}
      </div>

      {activeKey === null ? (
        <div className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
          Idle — no cycle in progress. Stages light up from the live event stream.
        </div>
      ) : null}
    </div>
  );
}

export { EXEC_STAGES, stageForNode } from '@/lib/viz/flow';
export type { ExecStageKey } from '@/lib/viz/flow';
