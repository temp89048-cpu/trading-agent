// ---------------------------------------------------------------------
// Flow-diagram and execution-cycle logic — pure, no JSX. See `journey.ts` for
// why the split exists.
// ---------------------------------------------------------------------

import type { GraphNodeState, NodeStatus } from '../realtime/store';

export type FlowNode = {
  name: string;
  status: NodeStatus;
  /** One line on what the node produced. `null` when the stream did not say. */
  detail?: string | null;
  durationMs?: number | null;
  /** From the node contract. Surfaced because "which node may call a model" is the
   *  single most important property of this pipeline — the deterministic/LLM ratio
   *  is the number this project watches for drift. */
  mayCallLlm?: boolean;
};

/** Merge a declared node list with live statuses from the store.
 *
 *  WHY A DECLARED TOPOLOGY RATHER THAN ONLY THE NODES SEEN SO FAR
 *
 *  Rendering only nodes the stream has mentioned would make the diagram grow as a
 *  run progresses and vanish between runs — so a quiet system would look like a
 *  system with no pipeline. `/api/graphs/nodes` returns the full registered list
 *  with contracts, so the shape is known up front and statuses fill in.
 *
 *  A node the stream has said nothing about is IDLE, which is true, rather than
 *  absent, which is misleading. */
export function mergeNodeStates(
  declared: { name: string; mayCallLlm?: boolean }[],
  live: Record<string, GraphNodeState>,
): FlowNode[] {
  return declared.map((d) => {
    const l = live[d.name];
    return {
      name: d.name,
      status: l?.status ?? 'IDLE',
      detail: l?.detail ?? null,
      durationMs: l?.durationMs ?? null,
      mayCallLlm: d.mayCallLlm,
    };
  });
}

/* ===================================================================== */
/* Execution cycle                                                       */
/* ===================================================================== */

// The REAL pipeline. The reference's `execCycle()` uses six invented labels —
// Scan, Detect, Validate, Size, Fill, Settle — which are not stages this system
// has. Keeping them would have been easier and would have described a system that
// does not exist: an operator reading "Size" would look for a sizing stage, and
// sizing happens inside Validate. That matters, because the Risk Gateway is the
// only place in the reasoning layer that sizes.
export const EXEC_STAGES = [
  { key: 'trigger', label: 'Trigger', detail: 'a change passed the debounce and rate gate' },
  { key: 'analyse', label: 'Analyse', detail: 'regime, strategy, 9 specialists, debate' },
  { key: 'decide', label: 'Decide', detail: "the Supervisor's ten answers" },
  { key: 'validate', label: 'Validate', detail: 'Risk Gateway sizes, then validates' },
  { key: 'submit', label: 'Submit', detail: 'approved plan becomes a TAR for the CRO' },
  { key: 'fill', label: 'Fill', detail: 'ExecutionAgent — simulated unless live' },
] as const;

export type ExecStageKey = (typeof EXEC_STAGES)[number]['key'];

/** Map the routed store's current node onto a stage.
 *
 *  Kept in one place so "which stage is this node in?" is answerable without
 *  reading a component. */
export function stageForNode(node: string | null): ExecStageKey | null {
  if (!node) return null;
  if (node === 'supervisor' || node === 'trade_thesis_narrative') return 'decide';
  if (node === 'risk_gateway') return 'validate';
  return 'analyse';
}
