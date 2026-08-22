'use client';

// ---------------------------------------------------------------------
// /learning — what the system has learned, and what it cannot claim yet.
//
// The meta-learning endpoint answers six questions and reports each as answered or
// NOT, with a sample-size reason. That structure is rendered as-is: an unanswered
// question shows its `reasonUnanswered` rather than being hidden, because "we do
// not have enough resolved trades to distinguish a bias from a losing streak" is
// the single most useful thing this page can say early on.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useSameOrigin } from '@/lib/api/useSameOrigin';
import { useBackend } from '@/lib/realtime/useRealtime';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const LearningOperator = dynamic(
  () => import('@/components/operator/LearningOperator').then((m) => ({ default: m.LearningOperator })),
  { ssr: false },
);

type Finding = {
  question: string; answered: boolean; finding: string | null;
  evidence: string[]; sampleSize: number; reasonUnanswered: string | null;
};

export default function LearningPage() {
  const meta = useBackend<{
    findings: Finding[]; questionsTotal: number; questionsAnswered: number;
    tracesAvailable: number; tradesAvailable: number; deploymentMeaning: string; sampleMeaning: string;
  }>(BACKEND_PATHS.metaLearning, { intervalMs: 60_000 });
  const memory = useBackend<{ stats?: Record<string, unknown> }>(BACKEND_PATHS.memoryStats, { intervalMs: 60_000 });
  const reflections = useSameOrigin<{ reflections?: Record<string, unknown>[] }>('/api/reflections', { intervalMs: 60_000 });
  const hypotheses = useSameOrigin<{ hypotheses?: Record<string, unknown>[] }>('/api/hypotheses', { intervalMs: 60_000 });

  const refl = reflections.data?.reflections ?? [];
  const hyps = hypotheses.data?.hypotheses ?? [];

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Learning Center</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Reflections" value={<Num value={refl.length} digits={0} />} />
        <StatCard label="Hypotheses" value={<Num value={hyps.length} digits={0} />} sub={`${hyps.filter((h) => h.status === 'proposed').length} proposed`} />
        <StatCard label="Traces available" value={<Num value={meta.data?.tracesAvailable ?? null} digits={0} />} />
        <StatCard
          label="Meta questions answered"
          value={<Num value={meta.data?.questionsAnswered ?? null} digits={0} />}
          sub={meta.data ? `of ${meta.data.questionsTotal}` : undefined}
          color={meta.data?.questionsAnswered === 0 ? 'var(--warning)' : undefined}
        />
      </div>

      <Card>
        <SectionTitle>Meta-learning — six questions</SectionTitle>
        {meta.state === 'unreachable' ? (
          <NotAvailable what="Meta-learning" reason="the backend did not respond" compact />
        ) : (
          <div className="space-y-3">
            {(meta.data?.findings ?? []).map((f) => (
              <div key={f.question}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="mono text-[11.5px]">{f.question}</span>
                  <Badge state={f.answered ? 'PASS' : 'UNAVAILABLE'} label={f.answered ? 'Answered' : 'Not yet'} />
                </div>
                <div className="text-[11.5px] leading-relaxed" style={{ color: f.answered ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                  {f.answered ? f.finding : f.reasonUnanswered}
                </div>
                {f.evidence.length > 0 ? (
                  <ul className="mt-1 space-y-0.5">
                    {f.evidence.map((e, i) => (
                      <li key={i} className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>• {e}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {meta.data?.deploymentMeaning ? (
          <div className="text-[10.5px] mt-3 pt-2 border-t hairline leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {meta.data.deploymentMeaning}
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Hypotheses</SectionTitle>
        <TermTable
          columns={[{ key: 's', label: 'Symbol' }, { key: 'c', label: 'Claim' }, { key: 'st', label: 'Status' }]}
          empty="No hypotheses recorded. One is proposed per reflection."
        >
          {hyps.slice(0, 25).map((h, i) => (
            <tr key={String(h.id ?? i)}>
              <td className="mono text-[11.5px]">{String(h.symbol ?? '—')}</td>
              <td className="text-[11px] whitespace-normal max-w-[560px]" style={{ color: 'var(--text-secondary)' }}>{String(h.claim ?? '—')}</td>
              <td><Badge state={String(h.status ?? 'INFO').toUpperCase()} label={String(h.status ?? '—')} /></td>
            </tr>
          ))}
        </TermTable>
        <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          A hypothesis reaching <span className="mono">validated</span> or{' '}
          <span className="mono">applied</span> requires an explicit human action — nothing
          here can promote its own claim, and no automated path leads from a lesson to a live
          configuration change.
        </div>
      </Card>

      {memory.data?.stats ? (
        <Card>
          <SectionTitle>Memory</SectionTitle>
          <TermTable columns={[{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value', num: true }]}>
            {Object.entries(memory.data.stats).map(([k, v]) => (
              <tr key={k}>
                <td className="mono text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>{k}</td>
                <td className="num mono text-[11.5px]">{typeof v === 'number' ? v : String(v)}</td>
              </tr>
            ))}
          </TermTable>
        </Card>
      ) : null}
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <LearningOperator />
    </div>
  );
}
