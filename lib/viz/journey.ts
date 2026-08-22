// ---------------------------------------------------------------------
// Trade Journey types and builder — pure, no JSX.
//
// Split out of `components/viz/TradeJourney.tsx` for two reasons, in order of
// importance:
//
//   1. CLAUDE.md's convention: pure logic lives apart from the component that
//      renders it. `buildJourney` decides what the agent is asserted to have
//      done, which is the part worth testing and reviewing on its own.
//
//   2. It is testable without a JSX transform. `tsconfig.json` sets
//      `jsx: "preserve"` because Next.js does its own transform, and vitest's
//      importer then refuses a `.tsx` file outright ("content contains invalid JS
//      syntax"). Overriding `esbuild.jsx` in `vitest.config.ts` does not win over
//      tsconfig, and the alternative was adding a React plugin as a dependency
//      to a machine that already runs the build at a raised heap limit.
//
// EVERY STEP CAN BE `unknown`, AND THAT IS THE WHOLE DESIGN.
//
// The reference builds all eight steps from one mock decision, so each always has
// a value and always renders PASS/WARN/FAIL. Real runs are not like that: a run
// can exit before a thesis exists, the risk gateway may never be reached, and an
// open trade has no outcome.
//
// A step with no data is `unknown` — visually distinct from PASS and from FAIL —
// because showing PASS for a stage that never ran asserts the agent checked
// something it did not. That is the single most misleading thing an
// explainability view can do.
// ---------------------------------------------------------------------

export type JourneyState = 'ok' | 'warn' | 'fail' | 'unknown';

export type JourneyStep = {
  icon: string;
  label: string;
  /** Short lines, rendered stacked. Replaces the reference's `\n` -> `<br>`. */
  lines: string[];
  state: JourneyState;
  /** Why this step is `unknown`. Always set when it is — an unexplained gap in an
   *  explainability view defeats the view. */
  reason?: string;
  iconColor?: string;
};

/** All-optional by design: a real run can stop at any stage. */
export type JourneySource = {
  symbol?: string | null;
  price?: number | null;
  indicators?: { rsi?: number | null; atr?: number | null } | null;
  regime?: { regime?: string | null; confidence?: number | null } | null;
  strategy?: string | null;
  confidencePct?: number | null;
  risk?: { approved?: boolean | null; passed?: number | null; total?: number | null } | null;
  decision?: { action?: string | null; direction?: string | null } | null;
  execution?: { submitted?: boolean | null; status?: string | null } | null;
  outcome?: { pnl?: number | null; status?: string | null } | null;
};

/** Visual warn threshold for the signal step, mirroring the reference. The
 *  DECISION is gated by the backend's own `MIN_CONFIDENCE_TO_TRADE`, not by this —
 *  this only colours a box. */
const SIGNAL_WARN_BELOW_PCT = 60;

const unknownStep = (
  icon: string,
  label: string,
  reason: string,
  iconColor?: string,
): JourneyStep => ({ icon, label, lines: [], state: 'unknown', reason, iconColor });

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function buildJourney(src: JourneySource): JourneyStep[] {
  const steps: JourneyStep[] = [];

  // 1. Market data
  steps.push(
    src.symbol && isNum(src.price)
      ? {
          icon: '◧',
          label: 'Market Data',
          lines: [src.symbol, src.price.toLocaleString()],
          state: 'ok',
          iconColor: 'var(--accent)',
        }
      : unknownStep('◧', 'Market Data', 'no snapshot recorded for this run', 'var(--accent)'),
  );

  // 2. Indicators
  const ind = src.indicators;
  steps.push(
    ind && (isNum(ind.rsi) || isNum(ind.atr))
      ? {
          icon: '∿',
          label: 'Indicators',
          lines: [
            isNum(ind.rsi) ? `RSI ${ind.rsi.toFixed(1)}` : '',
            isNum(ind.atr) ? `ATR ${ind.atr.toFixed(2)}` : '',
          ].filter(Boolean),
          state: 'ok',
          iconColor: 'var(--accent)',
        }
      : unknownStep('∿', 'Indicators', 'not computed — usually too few candles', 'var(--accent)'),
  );

  // 3. Regime
  steps.push(
    src.regime?.regime
      ? {
          icon: '◈',
          label: 'Regime',
          lines: [
            src.regime.regime,
            isNum(src.regime.confidence) ? `coverage ${(src.regime.confidence * 100).toFixed(0)}%` : '',
          ].filter(Boolean),
          state: 'ok',
          iconColor: 'var(--accent)',
        }
      : unknownStep('◈', 'Regime', 'could not be classified', 'var(--accent)'),
  );

  // 4. Strategy signal
  steps.push(
    src.strategy
      ? {
          icon: '⚡',
          label: 'Strategy Signal',
          lines: [
            src.strategy.split(' ').slice(0, 2).join(' '),
            isNum(src.confidencePct) ? `conf ${src.confidencePct.toFixed(0)}%` : '',
          ].filter(Boolean),
          state: isNum(src.confidencePct) && src.confidencePct < SIGNAL_WARN_BELOW_PCT ? 'warn' : 'ok',
          iconColor: 'var(--positive)',
        }
      : unknownStep('⚡', 'Strategy Signal', 'no strategy was selected', 'var(--positive)'),
  );

  // 5. Risk checks
  const risk = src.risk;
  steps.push(
    risk && typeof risk.approved === 'boolean'
      ? {
          icon: '⛊',
          label: 'Risk Checks',
          lines: [
            isNum(risk.passed) && isNum(risk.total)
              ? `${risk.passed}/${risk.total} passed`
              : risk.approved
                ? 'approved'
                : 'not approved',
          ],
          state: risk.approved ? 'ok' : 'fail',
          iconColor: 'var(--warning)',
        }
      : unknownStep('⛊', 'Risk Checks', 'the gateway was not reached', 'var(--warning)'),
  );

  // 6. Decision
  steps.push(
    src.decision?.action
      ? {
          icon: '◎',
          label: 'Decision',
          lines: [src.decision.action, src.decision.direction ?? ''].filter(Boolean),
          state:
            src.decision.action === 'TRADE' || src.decision.action === 'EXIT'
              ? 'ok'
              : src.decision.action === 'DO_NOT_TRADE'
                ? 'fail'
                : 'warn',
          iconColor: 'var(--accent)',
        }
      : unknownStep('◎', 'Decision', 'the run ended before a decision', 'var(--accent)'),
  );

  // 7. Execution
  const exec = src.execution;
  steps.push(
    exec && typeof exec.submitted === 'boolean'
      ? {
          icon: '⇄',
          label: 'Execution',
          lines: [exec.submitted ? (exec.status ?? 'submitted') : 'not submitted'],
          state: exec.submitted ? 'ok' : 'warn',
          iconColor: 'var(--positive)',
        }
      : unknownStep('⇄', 'Execution', 'nothing was submitted', 'var(--positive)'),
  );

  // 8. Outcome — `unknown` for an OPEN position, which is the common case and must
  // not read as a flat result. A P&L of exactly 0 IS a measurement and renders as
  // one; only absence is unknown.
  const out = src.outcome;
  steps.push(
    out && isNum(out.pnl)
      ? {
          icon: '◉',
          label: 'Outcome',
          lines: [`${out.pnl >= 0 ? '+' : ''}${out.pnl.toFixed(2)}`, out.status ?? ''].filter(Boolean),
          state: out.pnl >= 0 ? 'ok' : 'fail',
          iconColor: out.pnl >= 0 ? 'var(--positive)' : 'var(--negative)',
        }
      : unknownStep(
          '◉',
          'Outcome',
          out?.status === 'OPEN' ? 'still open — no realised result yet' : 'no result recorded',
          'var(--text-muted)',
        ),
  );

  return steps;
}
