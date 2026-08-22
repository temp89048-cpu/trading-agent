'use client';

// ---------------------------------------------------------------------
// /risk — equity, exposure and the risk checks.
//
// THE CHECKS ARE NOT A STANDING VALUE. `core/risk_manager.py`'s nine checks run
// INSIDE a graph run; there is no endpoint returning "current risk". So the gauges
// show the most recent run's checks, stamped with that run's timestamp — presented
// as a reading from a moment, not as the state right now.
//
// A page that showed them as current would be asserting the checks had just been
// evaluated, which is the kind of claim that gets acted on.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useMemo } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Gauge } from '@/components/ui/Gauge';
import { Card, Num, NotAvailable, SectionTitle, StatCard } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import type { DecisionRecord } from '@/lib/api/graphs';
import { riskCheckSummary } from '@/lib/api/graphs';
import { equity, exposureBySymbol, type PortfolioResponse } from '@/lib/api/portfolio';
import { useSameOrigin } from '@/lib/api/useSameOrigin';
import { useBackend, useLivePrices } from '@/lib/realtime/useRealtime';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const RiskOperator = dynamic(
  () => import('@/components/operator/RiskOperator').then((m) => ({ default: m.RiskOperator })),
  { ssr: false },
);

export default function RiskPage() {
  const portfolio = useBackend<PortfolioResponse>(BACKEND_PATHS.portfolio, { intervalMs: 15_000 });
  const admin = useBackend<{ isPaused?: boolean; emergencyStop?: boolean; exitsAllowed?: boolean }>(
    BACKEND_PATHS.adminStatus, { intervalMs: 10_000 },
  );
  const exchange = useBackend<{ liveTradingEnabled?: boolean }>(BACKEND_PATHS.exchangeStatus, { intervalMs: 30_000 });
  const decisions = useSameOrigin<{ decisions: DecisionRecord[] }>('/api/decisions', { intervalMs: 30_000 });
  const prices = useLivePrices();

  const live = exchange.data?.liveTradingEnabled === true;
  const book = live ? portfolio.data?.real : portfolio.data?.paper;
  const eq = equity(book, prices);
  const exposure = useMemo(() => exposureBySymbol(book, prices), [book, prices]);
  const exposureValue = exposure.reduce((s, r) => s + (r.value ?? 0), 0);

  // The most recent decision that actually captured risk checks. Most do not.
  const lastWithChecks = useMemo(() => {
    const rows = [...(decisions.data?.decisions ?? [])].sort((a, b) => b.ts - a.ts);
    return rows.find((d) => riskCheckSummary(d.riskChecks) !== null) ?? null;
  }, [decisions.data]);

  const checks = lastWithChecks ? Object.entries(lastWithChecks.riskChecks ?? {}) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Risk Center</h1>
        <span className="flex items-center gap-2">
          {admin.data?.emergencyStop ? <Badge state="CRITICAL" label="Emergency stop" /> : null}
          {admin.data?.isPaused ? <Badge state="PAUSED" /> : null}
          {admin.data?.exitsAllowed ? <Badge state="PASS" label="Exits allowed" /> : null}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Equity"
          value={<Num value={eq.value} prefix="$" />}
          sub={eq.complete ? 'cash + marked positions' : `partial — ${eq.unmarked} unmarked`}
          color={eq.complete ? undefined : 'var(--warning)'}
        />
        <StatCard label="Cash" value={<Num value={eq.cash} prefix="$" />} />
        <StatCard
          label="Position value"
          value={exposure.length === 0 ? <Num value={0} prefix="$" /> : <Num value={exposureValue} prefix="$" />}
          sub={exposure.some((r) => r.value === null) ? 'some positions unmarked' : undefined}
        />
        <StatCard
          label="Exposure share"
          value={eq.value && eq.value > 0 ? <Num value={(exposureValue / eq.value) * 100} digits={1} suffix="%" /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
          sub={eq.value ? 'of equity' : 'equity unknown'}
        />
      </div>

      <Card>
        <SectionTitle
          action={
            lastWithChecks ? (
              <span className="text-[10.5px] mono" style={{ color: 'var(--text-muted)' }}>
                from {new Date(lastWithChecks.ts).toLocaleString()}
              </span>
            ) : null
          }
        >
          Risk checks — last run that captured them
        </SectionTitle>
        {checks.length === 0 ? (
          <NotAvailable
            what="Risk checks"
            reason={
              'no decision record carries them. The nine checks run inside a graph run and are ' +
              'only stored when one reached the Risk Gateway — there is no endpoint returning a ' +
              'standing risk snapshot, so an empty panel here means "not recently evaluated", not "all clear".'
            }
            compact
          />
        ) : (
          <div className="space-y-2.5">
            {checks.map(([name, v]) => {
              const status = String(v?.status ?? (v?.ok ? 'pass' : 'fail')).toLowerCase();
              const measurable = status === 'pass' || status === 'warn' || status === 'fail';
              return (
                <Gauge
                  key={name}
                  pct={measurable ? (status === 'pass' ? 100 : status === 'warn' ? 60 : 20) : null}
                  color={status === 'pass' ? 'var(--positive)' : status === 'warn' ? 'var(--warning)' : 'var(--negative)'}
                  label={name}
                  value={v?.detail ?? status}
                  unavailableReason={`${name} reported ${status} — it could not be evaluated, which is not a pass`}
                />
              );
            })}
            <div className="text-[10.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              A gauge with a dashed track reported <span className="mono">unavailable</span> or{' '}
              <span className="mono">delegated</span>: the check could not run. It is neither a
              pass nor a failure, and this reading is from the timestamp above rather than now.
            </div>
          </div>
        )}
      </Card>
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <RiskOperator />
    </div>
  );
}
