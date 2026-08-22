'use client';

// ---------------------------------------------------------------------
// /replay — was BLOCKED, now backed by `/api/catalog/replay`.
//
// A replay here STEPS A RECORDED TRACE. It does not re-execute the graph, and the
// page says so: re-execution would re-fetch market data and reason over a different
// market than the original decision, so the "replay" would silently diverge from
// the run it claims to reproduce.
//
// So the scrubber walks recorded nodes. There is no speed control, because there is
// nothing running to speed up — a 2x button on a static trace would be theatre.
// ---------------------------------------------------------------------

import { useEffect, useState } from 'react';

import { FlowDiagram } from '@/components/viz/FlowDiagram';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import type { GraphRun } from '@/lib/api/graphs';
import type { NodeStatus } from '@/lib/realtime/store';
import { useBackend } from '@/lib/realtime/useRealtime';
import { mergeNodeStates } from '@/lib/viz/flow';

type ReplayRun = {
  runId: string; graph: string; symbol: string; trigger: string;
  startedAt: number; outcome: string; stepCount: number;
  durationMs: number | null; noDecisionReason: string | null;
};

export default function ReplayPage() {
  const list = useBackend<{ runs: ReplayRun[]; count: number; replayMeaning: string }>(
    BACKEND_PATHS.catalogReplay, { intervalMs: 60_000 },
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const detail = useBackend<GraphRun>(runId ? `${BACKEND_PATHS.graphRuns}/${runId}` : null);

  // Reset the scrubber when the run changes, or step N of a short run would point
  // past the end of a longer one.
  useEffect(() => setStep(0), [runId]);

  const nodes = detail.data?.nodes ?? [];
  const visible = nodes.slice(0, step + 1);

  const flowNodes = mergeNodeStates(
    nodes.map((n) => ({ name: n.node })),
    Object.fromEntries(
      visible.map((n) => [
        n.node,
        {
          name: n.node,
          // Recorded outcomes only — a stepped trace has no RUNNING node.
          status: (n.error ? 'FAILED' : n.unavailable ? 'SKIPPED' : 'COMPLETED') as NodeStatus,
          durationMs: typeof n.duration_ms === 'number' ? Math.round(n.duration_ms) : null,
          detail: n.error ?? (n.wrote?.length ? `wrote ${n.wrote.join(', ')}` : null),
          at: n.started_at,
        },
      ]),
    ),
  );

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Agent Replay</h1>

      <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {list.data?.replayMeaning ?? 'Steps a recorded trace; does not re-execute the graph.'}
      </div>

      <Card>
        <SectionTitle>Recorded runs</SectionTitle>
        <TermTable
          columns={[
            { key: 'r', label: 'Run' }, { key: 'g', label: 'Graph' }, { key: 's', label: 'Symbol' },
            { key: 'n', label: 'Steps', num: true }, { key: 'o', label: 'Outcome' },
          ]}
          empty={list.state === 'unreachable' ? 'The catalog endpoint did not respond.' : 'No traced runs recorded.'}
        >
          {(list.data?.runs ?? []).map((r) => (
            <tr key={r.runId} className="cursor-pointer" onClick={() => setRunId(r.runId)}
                style={r.runId === runId ? { background: 'var(--bg-surface-2)' } : undefined}>
              <td className="mono text-[11px]">{r.runId?.slice(0, 8)}</td>
              <td className="text-[11.5px]">{r.graph}</td>
              <td className="mono text-[11.5px]">{r.symbol}</td>
              <td className="num mono">{r.stepCount}</td>
              <td><Badge state={r.outcome === 'completed' ? 'COMPLETED' : 'FAILED'} /></td>
            </tr>
          ))}
        </TermTable>
      </Card>

      {runId && nodes.length > 0 ? (
        <Card>
          <SectionTitle
            action={
              <span className="flex items-center gap-2">
                <button type="button" className="chip" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>◀</button>
                <span className="mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {step + 1} / {nodes.length}
                </span>
                <button type="button" className="chip" onClick={() => setStep((s) => Math.min(nodes.length - 1, s + 1))} disabled={step >= nodes.length - 1}>▶</button>
                <button type="button" className="chip" onClick={() => setStep(nodes.length - 1)}>End</button>
              </span>
            }
          >
            Stepping {runId.slice(0, 8)}
          </SectionTitle>

          <input
            type="range"
            min={0}
            max={Math.max(0, nodes.length - 1)}
            value={step}
            onChange={(e) => setStep(Number(e.target.value))}
            className="w-full mb-3"
            aria-label="Replay step"
          />

          <FlowDiagram nodes={flowNodes} currentNode={null} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            <StatCard label="Node" value={nodes[step]?.node ?? '—'} mono />
            <StatCard label="Duration" value={<Num value={nodes[step]?.duration_ms ?? null} digits={0} suffix="ms" />} />
            <StatCard label="Wrote" value={nodes[step]?.wrote?.join(', ') || '—'} mono={false} />
            <StatCard label="LLM calls" value={<Num value={nodes[step]?.llm_calls ?? null} digits={0} />} />
          </div>

          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            No play/pause or speed control: there is nothing running to speed up. The trace is
            static, so a 2x button would be theatre.
          </div>
        </Card>
      ) : runId ? (
        <NotAvailable what="Run detail" reason="the run has no recorded nodes, or the detail endpoint did not respond." />
      ) : null}
    </div>
  );
}
