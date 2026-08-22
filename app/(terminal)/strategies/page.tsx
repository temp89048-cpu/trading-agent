'use client';

// ---------------------------------------------------------------------
// /strategies — was BLOCKED, now backed by `/api/catalog/strategies`.
//
// PER-STRATEGY PERFORMANCE IS NOT SHOWN, and that is the whole point of the page's
// honesty. Trade records carry no strategy tag, so a win rate computed here would
// attribute one strategy's results to another. `historicalSuccessRate` comes
// straight from the profile, whose own dataclass documents `None = not
// established` — so null means unestablished, not zero.
//
// PLANNED strategies are listed with the reason each is unbuilt. A strategy that
// silently does not exist is indistinguishable from one that exists and never fires.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useBackend } from '@/lib/realtime/useRealtime';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const StrategiesOperator = dynamic(
  () => import('@/components/operator/StrategiesOperator').then((m) => ({ default: m.StrategiesOperator })),
  { ssr: false },
);

type Strategy = {
  name: string; agent: string; bestConditions: string; worstConditions: string;
  expectedHoldingTime: string; riskProfile: string; indicatorsUsed: string[];
  entryLogic: string; exitLogic: string; positionSizingRule: string;
  activeRegimes: string[]; historicalSuccessRate: number | null;
  confidenceRules: string; portfolioRules: string; failureModes: string[]; selfEvaluation: string;
};

export default function StrategiesPage() {
  const data = useBackend<{
    strategies: Strategy[]; planned: { name: string; reasonNotImplemented: string }[];
    implementedCount: number; plannedCount: number;
    successRateMeaning: string; plannedMeaning: string; reasonUnavailable: string | null;
  }>(BACKEND_PATHS.catalogStrategies, { intervalMs: 120_000 });

  const [open, setOpen] = useState<string | null>(null);
  const rows = data.data?.strategies ?? [];
  const selected = rows.find((s) => s.name === open) ?? null;

  if (data.state === 'unreachable') {
    return (
      <div className="max-w-[820px]">
        <h1 className="text-[17px] font-semibold mb-3">Strategy Center</h1>
        <NotAvailable what="The strategy catalog" reason="the backend did not respond." />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Strategy Center</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Implemented" value={<Num value={data.data?.implementedCount ?? null} digits={0} />} />
        <StatCard label="Planned" value={<Num value={data.data?.plannedCount ?? null} digits={0} />} sub="with reasons" color="var(--warning)" />
        <StatCard label="With a success rate" value={<Num value={rows.filter((s) => s.historicalSuccessRate !== null).length} digits={0} />} sub="null = not established" />
        <StatCard label="Live performance" value={<span style={{ color: 'var(--text-muted)' }}>n/a</span>} sub="trades carry no strategy tag" mono={false} />
      </div>

      <Card>
        <SectionTitle action={<span className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>click a row for the full profile</span>}>
          Implemented strategies
        </SectionTitle>
        <TermTable
          columns={[
            { key: 'n', label: 'Strategy' }, { key: 'a', label: 'Agent' },
            { key: 'r', label: 'Active regimes' }, { key: 'k', label: 'Risk' },
            { key: 'h', label: 'Hold' }, { key: 's', label: 'Success rate', num: true },
          ]}
          empty={data.data?.reasonUnavailable ?? 'No strategies returned.'}
        >
          {rows.map((s) => (
            <tr key={s.name} className="cursor-pointer" onClick={() => setOpen(s.name)}
                style={s.name === open ? { background: 'var(--bg-surface-2)' } : undefined}>
              <td className="text-[11.5px]">{s.name}</td>
              <td className="mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>{s.agent}</td>
              <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{s.activeRegimes.join(', ') || 'any'}</td>
              <td className="text-[11px]">{s.riskProfile}</td>
              <td className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{s.expectedHoldingTime}</td>
              <td className="num">
                {s.historicalSuccessRate === null
                  ? <Badge state="UNAVAILABLE" label="not established" />
                  : <Num value={s.historicalSuccessRate * 100} digits={1} suffix="%" />}
              </td>
            </tr>
          ))}
        </TermTable>
        {data.data?.successRateMeaning ? (
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{data.data.successRateMeaning}</div>
        ) : null}
      </Card>

      {selected ? (
        <Card>
          <SectionTitle action={<button type="button" className="chip" onClick={() => setOpen(null)}>Close</button>}>
            {selected.name}
          </SectionTitle>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-[11.5px] leading-relaxed">
            {([
              ['Best conditions', selected.bestConditions],
              ['Worst conditions', selected.worstConditions],
              ['Entry logic', selected.entryLogic],
              ['Exit logic', selected.exitLogic],
              ['Position sizing', selected.positionSizingRule],
              ['Confidence rules', selected.confidenceRules],
              ['Portfolio rules', selected.portfolioRules],
              ['Self-evaluation', selected.selfEvaluation],
            ] as const).map(([label, value]) => (
              <div key={label}>
                <div className="font-mono text-[10px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>{label}</div>
                <div style={{ color: 'var(--text-secondary)' }}>{value}</div>
              </div>
            ))}
          </div>
          {selected.failureModes.length > 0 ? (
            <div className="mt-3 pt-3 border-t hairline">
              <div className="font-mono text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--negative)' }}>
                Known failure modes
              </div>
              <ul className="space-y-1">
                {selected.failureModes.map((f, i) => (
                  <li key={i} className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>• {f}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {selected.indicatorsUsed.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {selected.indicatorsUsed.map((i) => (
                <span key={i} className="chip" style={{ cursor: 'default' }}>{i}</span>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card>
        <SectionTitle>Planned but not implemented</SectionTitle>
        <TermTable columns={[{ key: 'n', label: 'Strategy' }, { key: 'w', label: 'Why not' }]} empty="Nothing planned.">
          {(data.data?.planned ?? []).map((p) => (
            <tr key={p.name}>
              <td className="text-[11.5px]">{p.name}</td>
              <td className="text-[11px] whitespace-normal max-w-[620px]" style={{ color: 'var(--text-secondary)' }}>{p.reasonNotImplemented}</td>
            </tr>
          ))}
        </TermTable>
        {data.data?.plannedMeaning ? (
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{data.data.plannedMeaning}</div>
        ) : null}
      </Card>
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <StrategiesOperator />
    </div>
  );
}
