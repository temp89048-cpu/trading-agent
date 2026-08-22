'use client';

// ---------------------------------------------------------------------
// The LangGraph pipeline, as nodes and edges.
//
// THE FLOWING DOT IS DRIVEN BY A REAL EVENT, NOT A GUESS.
//
// The reference animates `.flow-edge.active` from a CSS keyframe keyed off a
// status it derived client-side. The brief is explicit that this must instead be
// "driven by the actual current-node event from the LangGraph run stream".
//
// So `active` comes from the routed store's `currentNode` — set by
// `GRAPH_NODE_STARTED` and cleared by that same node completing. An edge animates
// only when the node before it has completed AND the node after it is the one
// actually running. No timer, no interval, no `Math.random()`.
//
// WHY IT RENDERS A DECLARED TOPOLOGY, NOT JUST THE NODES SEEN SO FAR
//
// Only rendering nodes the stream has mentioned would make the diagram grow as a
// run progresses and vanish between runs — so a quiet system would look like a
// system with no pipeline. `/api/graphs/nodes` returns the full registered node
// list with contracts, so the shape is known up front and each node's status is
// filled in from the stream. A node the stream has said nothing about is IDLE,
// which is true, rather than absent.
// ---------------------------------------------------------------------

import { Badge } from '@/components/ui/Badge';
import type { NodeStatus } from '@/lib/realtime/store';
import type { FlowNode } from '@/lib/viz/flow';

const ICON: Record<NodeStatus, string> = {
  COMPLETED: '✓',
  RUNNING: '●',
  WAITING: '⏳',
  IDLE: '·',
  SKIPPED: '—',
  FAILED: '✕',
};

const COLOR: Record<NodeStatus, string> = {
  COMPLETED: 'var(--positive)',
  RUNNING: 'var(--accent)',
  WAITING: 'var(--warning)',
  IDLE: 'var(--text-muted)',
  SKIPPED: 'var(--text-muted)',
  FAILED: 'var(--negative)',
};

function FlowEdge({ active, done }: { active: boolean; done: boolean }) {
  return (
    <div className={`flow-edge${active ? ' active' : ''}${done ? ' done' : ''}`}>
      <svg width="34" height="16" aria-hidden>
        <line className="line" x1="0" y1="8" x2="26" y2="8" />
        <polygon points="26,3 34,8 26,13" fill={done ? 'var(--positive)' : 'var(--border-strong)'} />
        <circle className="flowdot" cx="8" cy="8" r="3" />
      </svg>
    </div>
  );
}

export function FlowDiagram({
  nodes,
  currentNode,
}: {
  nodes: FlowNode[];
  /** From the realtime store. `null` = nothing is running, so no edge animates. */
  currentNode: string | null;
}) {
  if (nodes.length === 0) {
    return (
      <div className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
        No graph nodes registered. The backend serves the node list from{' '}
        <span className="mono">/api/graphs/nodes</span> — an empty list means it is not
        reachable rather than that the pipeline is empty.
      </div>
    );
  }

  return (
    <div className="flow-wrap">
      <div className="flow-row">
        {nodes.map((n, i) => {
          const next = nodes[i + 1];
          const done = n.status === 'COMPLETED';
          // Animate only on a real transition: this node finished and the NEXT
          // one is the node the stream says is running.
          const active = done && next != null && next.name === currentNode;

          return (
            <div key={n.name} className="flex items-stretch">
              <div className={`flow-node st-${n.status}`}>
                <div className="flex items-center justify-between mb-1.5 gap-1">
                  <span className="mono text-[11px] font-semibold" style={{ color: COLOR[n.status] }}>
                    {ICON[n.status]}
                  </span>
                  <Badge state={n.status} />
                </div>

                <div className="mono text-[11.5px] mb-1 leading-tight break-words">{n.name}</div>

                <div className="text-[10.5px] leading-snug" style={{ color: 'var(--text-secondary)' }}>
                  {n.detail ?? '—'}
                </div>

                <div className="flex items-center justify-between mt-1 gap-1">
                  {/* Only rendered when the event carried a duration. `0ms` would
                      be a claim about how long the node took. */}
                  {typeof n.durationMs === 'number' ? (
                    <span className="mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {n.durationMs}ms
                    </span>
                  ) : (
                    <span />
                  )}
                  {n.mayCallLlm ? (
                    <span
                      className="text-[9px] uppercase tracking-wider px-1 rounded"
                      style={{
                        background: 'color-mix(in srgb, var(--warning) 16%, transparent)',
                        color: 'var(--warning)',
                      }}
                      title="This node may call a language model. Every other node is deterministic."
                    >
                      LLM
                    </span>
                  ) : null}
                </div>
              </div>

              {next ? <FlowEdge active={active} done={done} /> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export { mergeNodeStates } from '@/lib/viz/flow';
export type { FlowNode } from '@/lib/viz/flow';
