// ---------------------------------------------------------------------
// Response types for the LangGraph API, transcribed from the LIVE responses
// rather than from the FastAPI source — the field names below were read off
// `/api/graphs`, `/api/graphs/nodes` and `/api/graphs/runs` with the backend
// running, which is the only way to be sure of the casing.
//
// THE CASING IS MIXED, AND THAT IS REAL.
//
// `/api/graphs/runs` returns `run_id`, `started_at`, `duration_ms` on nodes —
// snake_case straight from the trace store — alongside `durationMs` and
// `llm_budget.callsMade` in camelCase. That is what the endpoint actually sends.
// Normalising it here rather than in each component means one place to correct if
// the backend ever tidies it up, and no component quietly reading a field that is
// always `undefined`.
// ---------------------------------------------------------------------

export type GraphSummary = {
  graph: string;
  name: string;
  available: boolean;
  isLangGraph: boolean;
  nodeCount: number | null;
  nodes?: string[];
  note?: string;
};

export type NodeContract = {
  name: string;
  purpose: string;
  phase: number | null;
  reads: string[];
  writes: string[];
  deterministic: boolean;
  mayCallLlm: boolean;
};

export type RunNode = {
  node: string;
  started_at: number;
  duration_ms: number | null;
  wrote: string[];
  llm_calls: number;
  llm_tokens: number;
  error: string | null;
  unavailable: boolean;
};

export type GraphRun = {
  run_id: string;
  graph: string;
  symbol: string;
  thread_id: string;
  trigger: string;
  started_at: number;
  finished_at: number | null;
  nodes: RunNode[];
  outcome: string;
  /** Why the run produced no decision. Populated for graphs that are expected to
   *  decide, so a WAIT with no explanation is distinguishable from a run that
   *  simply exited early. */
  no_decision_reason: string | null;
  llm_budget: {
    callsMade: number;
    maxCalls: number;
    tokensUsed: number;
    maxTokens: number;
    exhausted: boolean;
    byNode?: Record<string, unknown>;
    denied?: unknown[];
  };
  /** Checks that could NOT be evaluated. Distinct from `errors`: an unavailable
   *  input is a limitation, an error is a bug. */
  unavailable: string[];
  errors: { node?: string; error?: string }[];
  durationMs: number | null;
};

/** A decision record from the Next.js store (`.data/decisions.json`). */
export type DecisionRecord = {
  id: string;
  ts: number;
  symbol: string;
  side: string;
  tab: string;
  originTag: string;
  requestedQty: number | null;
  requestedPrice: number | null;
  outcome: string;
  urgency: string;
  rejectionReasons: string[];
  conflictNotes: string[];
  cautionNotes: string[];
  /** `{ [checkName]: { ok, status, detail } }`, or `null` when the record predates
   *  the risk-check capture or the gateway never ran. `null` is NOT "all passed". */
  riskChecks: Record<string, { ok?: boolean; status?: string; detail?: string }> | null;
  stopLoss: number | null;
  takeProfit: number | null;
  recommendedQty: number | null;
  ensembleConsensus: string | null;
  ensembleConfidencePct: number | null;
  debateRecommendation: string | null;
  debateConfidencePct: number | null;
  rationale?: string | null;
};

/* ===================================================================== */
/* Derivations                                                           */
/* ===================================================================== */

/** Node statuses for one run, keyed by node name — for feeding `FlowDiagram`
 *  a historical run rather than the live stream.
 *
 *  A node with an `error` is FAILED; one flagged `unavailable` is SKIPPED (it ran
 *  and reported it could not measure something, which is not the same as failing);
 *  everything else in the trace COMPLETED, because the trace only records nodes
 *  that finished. */
export function runNodeStatuses(run: GraphRun): Record<
  string,
  { name: string; status: 'COMPLETED' | 'FAILED' | 'SKIPPED'; durationMs: number | null; detail: string | null; at: number }
> {
  const out: Record<string, ReturnType<typeof runNodeStatuses>[string]> = {};
  for (const n of run.nodes ?? []) {
    out[n.node] = {
      name: n.node,
      status: n.error ? 'FAILED' : n.unavailable ? 'SKIPPED' : 'COMPLETED',
      durationMs: typeof n.duration_ms === 'number' ? Math.round(n.duration_ms) : null,
      detail: n.error ?? (n.wrote?.length ? `wrote ${n.wrote.join(', ')}` : null),
      at: n.started_at,
    };
  }
  return out;
}

/** PASS/WARN/FAIL counts from a decision's risk checks.
 *
 *  Returns `null` when `riskChecks` is null — which is NOT "0 of 0 passed". The
 *  gateway may never have run, and reporting a count would claim it did. */
export function riskCheckSummary(
  checks: DecisionRecord['riskChecks'],
): { passed: number; total: number; failed: string[]; warned: string[] } | null {
  if (!checks || typeof checks !== 'object') return null;
  const entries = Object.entries(checks);
  if (entries.length === 0) return null;

  const failed: string[] = [];
  const warned: string[] = [];
  let passed = 0;

  for (const [name, v] of entries) {
    const status = String(v?.status ?? (v?.ok ? 'pass' : 'fail')).toLowerCase();
    if (status === 'pass') passed += 1;
    else if (status === 'warn') warned.push(name);
    // `unavailable` and `delegated` are counted as neither passed nor failed:
    // the backend draws that distinction deliberately (a check that could not run
    // did not pass), and collapsing it here would undo it.
    else if (status === 'fail' || status === 'reject') failed.push(name);
  }

  return { passed, total: entries.length, failed, warned };
}

export function outcomeBadgeState(outcome: string): string {
  const o = outcome.toLowerCase();
  if (o.includes('executed') && !o.includes('not')) return 'COMPLETED';
  if (o === 'approved-not-executed') return 'WARN';
  if (o.includes('reject')) return 'REJECTED';
  if (o.includes('pending')) return 'WAITING';
  if (o.includes('manually-approved')) return 'PASS';
  return 'INFO';
}
