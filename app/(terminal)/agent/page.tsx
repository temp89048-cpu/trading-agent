'use client';

// ---------------------------------------------------------------------
// /agent — Agent Brain.
//
// Built FIRST of the 25 routes, deliberately: it is the best-supported page in the
// backend (27 node contracts, 9 specialists, traced runs, a live WS stream), so the
// realtime plumbing gets proven on real data before pages that lean on weaker
// sources.
//
// WHAT THE REFERENCE SHOWS THAT THIS DOES NOT
//
// "Action-probability bars" and "per-model prediction cards" imply a distribution
// over actions and an ensemble of independent models. Neither exists: the
// Supervisor reports ONE `probability` (P(direction correct)) and only once enough
// resolved trades exist to measure a hit rate from — `MIN_TRADES_FOR_ACCURACY`.
// There is no per-model breakdown to card up.
//
// What replaces them is better, because it is real: the node contract table. Every
// node's declared reads/writes and whether it may call a model — which is the one
// property of this pipeline worth watching, since its safety rests on the
// decision-critical nodes staying deterministic.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';

import { FlowDiagram } from '@/components/viz/FlowDiagram';
import { LiveAgentInspectorModal } from '@/components/modals/LiveAgentInspectorModal';
import { Badge } from '@/components/ui/Badge';
import { Gauge } from '@/components/ui/Gauge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import type { GraphRun, GraphSummary, NodeContract } from '@/lib/api/graphs';
import { runNodeStatuses } from '@/lib/api/graphs';
import { useBackend, useCurrentNode, useGraphNodes } from '@/lib/realtime/useRealtime';
import { mergeNodeStates } from '@/lib/viz/flow';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const AgentOperator = dynamic(
  () => import('@/components/operator/AgentOperator').then((m) => ({ default: m.AgentOperator })),
  { ssr: false },
);

/** Graph 2's node order. The API returns nodes alphabetically (they come from a
 *  sorted registry), which would draw the pipeline out of sequence — so the
 *  display order is declared here, matching `analysis_config()`'s real edges.
 *  Any node not listed is appended, so a new backend node appears rather than
 *  silently vanishing. */
const GRAPH2_ORDER = [
  'data_validation',
  'market_analysis',
  'regime_classification',
  'technical_analysis',
  'memory_loader',
  'strategy_candidates',
  'strategy_scoring',
  'opportunity_detection',
  'specialist_market',
  'specialist_orderflow',
  'specialist_liquidity',
  'specialist_news',
  'specialist_funding',
  'specialist_prediction',
  'specialist_event_risk',
  'specialist_portfolio',
  'specialist_risk',
  'debate',
  'supervisor',
  'risk_gateway',
  'trade_thesis_narrative',
];

function orderNodes(nodes: NodeContract[]): NodeContract[] {
  const rank = new Map(GRAPH2_ORDER.map((n, i) => [n, i]));
  return [...nodes].sort(
    (a, b) => (rank.get(a.name) ?? 999) - (rank.get(b.name) ?? 999) || a.name.localeCompare(b.name),
  );
}

export default function AgentBrainPage() {
  const graphs = useBackend<{ graphs: GraphSummary[] }>(BACKEND_PATHS.graphs, { intervalMs: 60_000 });
  const nodesApi = useBackend<{ total: number; llmNodes: string[]; nodes: NodeContract[] }>(
    BACKEND_PATHS.graphNodes,
    { intervalMs: 60_000 },
  );
  const runs = useBackend<{ runs: GraphRun[]; count: number; tracingMeaning: string }>(
    `${BACKEND_PATHS.graphRuns}?limit=20`,
    { intervalMs: 15_000 },
  );

  const liveNodes = useGraphNodes();
  const currentNode = useCurrentNode();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [inspectSymbol, setInspectSymbol] = useState<string | null>(null);

  const contracts = nodesApi.data?.nodes ?? [];
  const selectedRun = runs.data?.runs.find((r) => r.run_id === selectedRunId) ?? null;

  // Graph 2's nodes only — the registry holds every graph's nodes, and drawing
  // Graph 1's and Graph 4's in the same row would be one pipeline that does not
  // exist.
  const graph2Contracts = useMemo(
    () => orderNodes(contracts.filter((c) => GRAPH2_ORDER.includes(c.name))),
    [contracts],
  );

  // Live stream by default; a selected historical run replaces it. Showing a past
  // run's nodes with the live edge animation would imply it is still executing.
  const flowNodes = useMemo(() => {
    const statuses = selectedRun ? runNodeStatuses(selectedRun) : liveNodes;
    return mergeNodeStates(
      graph2Contracts.map((c) => ({ name: c.name, mayCallLlm: c.mayCallLlm })),
      statuses,
    );
  }, [graph2Contracts, liveNodes, selectedRun]);

  const llmNodes = nodesApi.data?.llmNodes ?? [];
  const deterministicCount = contracts.filter((c) => c.deterministic).length;

  if (nodesApi.state === 'unreachable' && graphs.state === 'unreachable') {
    return (
      <div className="max-w-[820px]">
        <h1 className="text-[17px] font-semibold mb-3">Agent Brain</h1>
        <NotAvailable
          what="The LangGraph API"
          reason={
            'the FastAPI backend is not reachable. This page reads /api/graphs, ' +
            '/api/graphs/nodes and /api/graphs/runs — the reasoning layer runs in the ' +
            'Python process and has no .data/ mirror for the Next.js side to read.'
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Agent Brain</h1>
        <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
          {selectedRun ? (
            <>
              Showing run <span className="mono">{selectedRun.run_id.slice(0, 8)}</span> ·{' '}
              <button type="button" className="underline" onClick={() => setSelectedRunId(null)}>
                back to live
              </button>
            </>
          ) : (
            'Live — node states stream from the graph runner'
          )}
        </div>
      </div>

      {/* ---- Node contract summary ---- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Registered nodes" value={<Num value={nodesApi.data?.total ?? null} digits={0} />} />
        <StatCard
          label="Deterministic"
          value={<Num value={contracts.length ? deterministicCount : null} digits={0} />}
          sub={contracts.length ? `of ${contracts.length}` : undefined}
          color="var(--positive)"
        />
        <StatCard
          label="May call a model"
          value={<Num value={contracts.length ? llmNodes.length : null} digits={0} />}
          sub={llmNodes.join(', ') || undefined}
          color="var(--warning)"
        />
        <StatCard
          label="Graphs loaded"
          value={
            <Num
              value={graphs.data ? graphs.data.graphs.filter((g) => g.available).length : null}
              digits={0}
            />
          }
          sub={graphs.data ? `of ${graphs.data.graphs.length}` : undefined}
        />
      </div>

      {/* ---- Flow diagram ---- */}
      <Card>
        <SectionTitle
          action={
            <button
              type="button"
              className="btn-live"
              onClick={() => setInspectSymbol(selectedRun?.symbol ?? 'BTC/USDT')}
            >
              <span className="live-dot" aria-hidden /> Watch Live
            </button>
          }
        >
          Trade Decision pipeline — Graph 2
        </SectionTitle>
        <FlowDiagram nodes={flowNodes} currentNode={selectedRun ? null : currentNode} />
        {flowNodes.length > 0 && flowNodes.every((n) => n.status === 'IDLE') && !selectedRun ? (
          <div className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
            Every node is idle — no run is in progress. Select a run below to see how a past
            cycle executed.
          </div>
        ) : null}
      </Card>

      {/* ---- Graphs ---- */}
      <Card>
        <SectionTitle>Graphs</SectionTitle>
        <TermTable
          columns={[
            { key: 'g', label: '#' },
            { key: 'name', label: 'Graph' },
            { key: 'kind', label: 'Kind' },
            { key: 'nodes', label: 'Nodes', num: true },
            { key: 'state', label: 'State' },
          ]}
          empty="The backend returned no graphs."
        >
          {(graphs.data?.graphs ?? []).map((g) => (
            <tr key={g.graph}>
              <td className="mono">{g.graph}</td>
              <td>{g.name}</td>
              <td>
                {/* Two of the seven deliberately are not LangGraph graphs.
                    Reporting seven compiled graphs would be a nicer number and a
                    false one. */}
                <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {g.isLangGraph ? 'LangGraph' : 'plain module'}
                </span>
              </td>
              <td className="num mono">{g.nodeCount ?? '—'}</td>
              <td>
                <Badge state={g.available ? 'HEALTHY' : 'FAILED'} />
              </td>
            </tr>
          ))}
        </TermTable>
      </Card>

      {/* ---- Runs ---- */}
      <Card>
        <SectionTitle action={<span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>click a row to replay it above</span>}>
          Traced runs
        </SectionTitle>
        <TermTable
          columns={[
            { key: 'run', label: 'Run' },
            { key: 'graph', label: 'Graph' },
            { key: 'symbol', label: 'Symbol' },
            { key: 'trigger', label: 'Trigger' },
            { key: 'nodes', label: 'Nodes', num: true },
            { key: 'ms', label: 'Duration', num: true },
            { key: 'llm', label: 'LLM', num: true },
            { key: 'outcome', label: 'Outcome' },
          ]}
          empty={
            runs.state === 'loading'
              ? 'Loading runs…'
              : 'No traced runs yet. A run is recorded when a trigger fires — with no market data reaching the backend, none will.'
          }
        >
          {(runs.data?.runs ?? []).map((r) => (
            <tr
              key={r.run_id}
              onClick={() => setSelectedRunId(r.run_id)}
              className="cursor-pointer"
              style={r.run_id === selectedRunId ? { background: 'var(--bg-surface-2)' } : undefined}
            >
              <td className="mono text-[11px]">{r.run_id.slice(0, 8)}</td>
              <td className="text-[11.5px]">{r.graph}</td>
              <td className="mono text-[11.5px]">{r.symbol}</td>
              <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {r.trigger}
              </td>
              <td className="num mono">{r.nodes?.length ?? 0}</td>
              <td className="num mono">{r.durationMs !== null ? `${Math.round(r.durationMs)}ms` : '—'}</td>
              <td className="num mono">{r.llm_budget?.callsMade ?? 0}</td>
              <td>
                <Badge state={r.outcome === 'completed' ? 'COMPLETED' : r.outcome === 'failed' ? 'FAILED' : 'INFO'} />
              </td>
            </tr>
          ))}
        </TermTable>
        {runs.data?.tracingMeaning ? (
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {runs.data.tracingMeaning}
          </div>
        ) : null}
      </Card>

      {/* ---- Selected run detail ---- */}
      {selectedRun ? (
        <Card>
          <SectionTitle>Run {selectedRun.run_id.slice(0, 8)} — per-node trace</SectionTitle>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
            <StatCard label="Outcome" value={<Badge state={selectedRun.outcome === 'completed' ? 'COMPLETED' : 'FAILED'} />} mono={false} />
            <StatCard label="Duration" value={<Num value={selectedRun.durationMs} digits={0} suffix="ms" />} />
            <StatCard
              label="LLM calls"
              value={<Num value={selectedRun.llm_budget?.callsMade ?? null} digits={0} />}
              sub={`budget ${selectedRun.llm_budget?.maxCalls ?? '—'}`}
            />
            <StatCard label="Errors" value={<Num value={selectedRun.errors?.length ?? 0} digits={0} />} color={selectedRun.errors?.length ? 'var(--negative)' : undefined} />
          </div>

          {selectedRun.no_decision_reason ? (
            <div
              className="text-[12px] mb-3 p-2.5 rounded leading-relaxed"
              style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)', color: 'var(--warning)' }}
            >
              <strong>No decision:</strong> {selectedRun.no_decision_reason}
            </div>
          ) : null}

          <TermTable
            columns={[
              { key: 'node', label: 'Node' },
              { key: 'ms', label: 'ms', num: true },
              { key: 'wrote', label: 'Wrote' },
              { key: 'llm', label: 'LLM', num: true },
              { key: 'state', label: 'State' },
            ]}
          >
            {selectedRun.nodes.map((n, i) => (
              <tr key={`${n.node}-${i}`}>
                <td className="mono text-[11.5px]">{n.node}</td>
                <td className="num mono">{typeof n.duration_ms === 'number' ? Math.round(n.duration_ms) : '—'}</td>
                <td className="mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                  {n.wrote?.join(', ') || '—'}
                </td>
                <td className="num mono">{n.llm_calls || ''}</td>
                <td>
                  <Badge state={n.error ? 'FAILED' : n.unavailable ? 'SKIPPED' : 'COMPLETED'} />
                </td>
              </tr>
            ))}
          </TermTable>

          {selectedRun.unavailable?.length ? (
            <div className="mt-3">
              <div className="font-mono text-[10.5px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
                Could not be evaluated ({selectedRun.unavailable.length})
              </div>
              <ul className="space-y-1">
                {selectedRun.unavailable.map((u, i) => (
                  <li key={i} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    • {u}
                  </li>
                ))}
              </ul>
              {/* The distinction the whole backend is built on, restated where an
                  operator reads the consequence. */}
              <div className="text-[10.5px] mt-2" style={{ color: 'var(--text-muted)' }}>
                These are checks that could not run — not checks that failed, and not
                checks that passed.
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* ---- Node contracts ---- */}
      <Card>
        <SectionTitle>
          Node contracts — what each node may read and write
        </SectionTitle>
        <TermTable
          columns={[
            { key: 'name', label: 'Node' },
            { key: 'phase', label: 'Phase', num: true },
            { key: 'writes', label: 'Writes' },
            { key: 'kind', label: 'Kind' },
            { key: 'purpose', label: 'Purpose' },
          ]}
          empty="No node contracts returned."
        >
          {orderNodes(contracts).map((c) => (
            <tr key={c.name}>
              <td className="mono text-[11.5px]">{c.name}</td>
              <td className="num mono">{c.phase ?? '—'}</td>
              <td className="mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                {c.writes.join(', ')}
              </td>
              <td>
                <Badge
                  state={c.mayCallLlm ? 'WARN' : 'PASS'}
                  label={c.mayCallLlm ? 'LLM' : 'Deterministic'}
                />
              </td>
              <td className="text-[11px] whitespace-normal max-w-[420px]" style={{ color: 'var(--text-secondary)' }}>
                {c.purpose}
              </td>
            </tr>
          ))}
        </TermTable>
      </Card>

      {/* ---- What is deliberately not here ---- */}
      <Card>
        <SectionTitle>Not shown, and why</SectionTitle>
        <div className="space-y-2.5 text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
          <div>
            <strong>Action-probability bars.</strong> The Supervisor reports one{' '}
            <span className="mono">probability</span> — P(direction correct) — and only once
            enough resolved trades exist to measure this system&apos;s own hit rate from.
            There is no distribution over actions to chart.
          </div>
          <div>
            <strong>Per-model prediction cards.</strong> There is no ensemble of independent
            models to break down. The panel is nine specialists over shared state, and each
            one&apos;s contribution is already visible in the flow diagram and the run trace.
          </div>
          <div>
            <strong>Ensemble confidence gauge.</strong> Shown on <span className="mono">/decisions</span>{' '}
            instead, where it belongs to a specific decision. A standing gauge here would have
            to average across runs, and an averaged confidence describes no decision that was
            ever made.
          </div>
        </div>
        <div className="mt-3">
          <Gauge
            pct={null}
            label="Ensemble confidence (per-decision)"
            unavailableReason="not a standing value — see /decisions"
          />
        </div>
      </Card>

      <LiveAgentInspectorModal
        symbol={inspectSymbol}
        strategy={null}
        onClose={() => setInspectSymbol(null)}
      />
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <AgentOperator />
    </div>
  );
}
