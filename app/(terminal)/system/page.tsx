'use client';

// ---------------------------------------------------------------------
// /system — service health.
//
// THE REFERENCE SHOWS EIGHT NAMED SERVICES with latency, error count and uptime.
// None of that telemetry exists: `/api/monitoring` returns ONE check plus per-agent
// heartbeats. So this renders exactly what is real — the checks that exist and the
// agents that report — and names the eight-service table as absent rather than
// filling it with plausible numbers.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useBackend, useRealtimeConnected, useStreamAge } from '@/lib/realtime/useRealtime';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const SystemOperator = dynamic(
  () => import('@/components/operator/SystemOperator').then((m) => ({ default: m.SystemOperator })),
  { ssr: false },
);

type Agent = {
  agentId: string; lastHeartbeat: number; lastError: string | null;
  consecutiveErrors: number; totalTicks: number; totalErrors: number; status: string;
};

export default function SystemPage() {
  const monitoring = useBackend<{
    overall: string; scheduler_running: boolean;
    agents: Agent[]; checks: { label: string; ok: boolean }[];
  }>(BACKEND_PATHS.monitoring, { intervalMs: 10_000 });
  const exchange = useBackend<Record<string, unknown>>(BACKEND_PATHS.exchangeStatus, { intervalMs: 30_000 });
  const graphs = useBackend<{ graphs: { name: string; available: boolean }[] }>(BACKEND_PATHS.graphs, { intervalMs: 60_000 });
  const connected = useRealtimeConnected();
  const age = useStreamAge();

  const agents = monitoring.data?.agents ?? [];
  const stale = agents.filter((a) => !a.lastHeartbeat || Date.now() - a.lastHeartbeat > 120_000);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">System Health</h1>
        {monitoring.data ? <Badge state={monitoring.data.overall === 'healthy' ? 'HEALTHY' : 'DEGRADED'} /> : null}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Scheduler" value={<Badge state={monitoring.data?.scheduler_running ? 'RUNNING' : 'DOWN'} />} mono={false} />
        <StatCard label="Agents registered" value={<Num value={agents.length || null} digits={0} />} />
        <StatCard label="Stale heartbeats" value={<Num value={agents.length ? stale.length : null} digits={0} />} sub={stale.length ? 'no beat in 2 min' : undefined} color={stale.length ? 'var(--warning)' : undefined} />
        <StatCard
          label="Event stream"
          value={<Badge state={connected ? 'HEALTHY' : 'DOWN'} label={connected ? 'Live' : 'Offline'} />}
          sub={connected && age !== null ? `last event ${age}s ago` : undefined}
          mono={false}
        />
      </div>

      <Card>
        <SectionTitle>Checks</SectionTitle>
        <TermTable columns={[{ key: 'l', label: 'Check' }, { key: 's', label: 'State' }]} empty="No checks reported.">
          {(monitoring.data?.checks ?? []).map((c) => (
            <tr key={c.label}>
              <td className="text-[11.5px]">{c.label}</td>
              <td><Badge state={c.ok ? 'PASS' : 'FAIL'} /></td>
            </tr>
          ))}
        </TermTable>
      </Card>

      <Card>
        <SectionTitle>Agents</SectionTitle>
        <TermTable
          columns={[
            { key: 'a', label: 'Agent' }, { key: 't', label: 'Ticks', num: true },
            { key: 'e', label: 'Errors', num: true }, { key: 'c', label: 'Consecutive', num: true },
            { key: 'h', label: 'Last beat' }, { key: 's', label: 'Status' },
          ]}
          empty={monitoring.state === 'unreachable' ? 'The backend did not respond.' : 'No agents registered.'}
        >
          {agents.map((a) => (
            <tr key={a.agentId}>
              <td className="mono text-[11.5px]">{a.agentId}</td>
              <td className="num mono">{a.totalTicks}</td>
              <td className="num mono" style={a.totalErrors ? { color: 'var(--negative)' } : undefined}>{a.totalErrors}</td>
              <td className="num mono">{a.consecutiveErrors}</td>
              <td className="mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {a.lastHeartbeat ? new Date(a.lastHeartbeat).toTimeString().slice(0, 8) : 'never'}
              </td>
              <td><Badge state={a.status === 'running' ? 'RUNNING' : a.lastError ? 'ERROR' : 'IDLE'} /></td>
            </tr>
          ))}
        </TermTable>
      </Card>

      <Card>
        <SectionTitle>Graphs</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {(graphs.data?.graphs ?? []).map((g) => (
            <span key={g.name} className="flex items-center gap-1.5 text-[11.5px]">
              <Badge state={g.available ? 'HEALTHY' : 'FAILED'} label={g.name} />
            </span>
          ))}
          {graphs.state === 'unreachable' ? (
            <span className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>backend unreachable</span>
          ) : null}
        </div>
      </Card>

      {exchange.data ? (
        <Card>
          <SectionTitle>Exchange</SectionTitle>
          <TermTable columns={[{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value' }]}>
            {Object.entries(exchange.data)
              .filter(([k]) => k !== 'status')
              .map(([k, v]) => (
                <tr key={k}>
                  <td className="mono text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>{k}</td>
                  <td className="text-[11px] whitespace-normal max-w-[560px]">{String(v)}</td>
                </tr>
              ))}
          </TermTable>
        </Card>
      ) : null}

      <NotAvailable
        what="Per-service latency, error rate and uptime"
        reason={
          'no per-service telemetry exists. /api/monitoring returns one check plus agent ' +
          'heartbeats — there is no instrumentation recording round-trip latency or uptime for ' +
          'the orchestrator, database, cache, REST or websocket. The reference shows eight such ' +
          'rows; filling them with plausible numbers would make an uninstrumented system look ' +
          'monitored.'
        }
      />
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <SystemOperator />
    </div>
  );
}
