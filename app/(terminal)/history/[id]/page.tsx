'use client';

// ---------------------------------------------------------------------
// /history/[id] — one trade, its reflection, its hypothesis, and delete.
//
// The replacement for the old `/log/[id]`, and it exists because that route was
// NOT covered by anything else in the new design. It carried four things the
// history table does not: the structured reflection (why / failed signal / earlier
// exit / confidence / lesson), the Generate-Regenerate control, the per-trade
// HypothesisPanel, and the delete. Deleting `app/log/` without this would have
// removed all four while the migration ledger claimed `/history` replaced `/log`.
//
// The reflection comes from `useReflection()`, and `regenerate()` makes a real LLM
// call. It is advisory: nothing on this page can feed a lesson back into execution,
// and Apply on the hypothesis is the only path to production — by an explicit human
// click, never automatically.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { usePortfolio } from '@/components/Portfolio';
import { useReflection } from '@/components/Reflection';
import { OperatorSection } from '@/components/operator/OperatorSection';
import { TradeJourney } from '@/components/viz/TradeJourney';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard } from '@/components/ui/primitives';
import { buildJourney } from '@/lib/viz/journey';

// Code-split: HypothesisPanel is shown only after a row is selected, and it pulls
// in the hypothesis provider and the LLM path. Eager-importing it doubled this
// route's first load for a panel most visits never open.
const HypothesisPanel = dynamic(
  () => import('@/components/HypothesisPanel').then((m) => ({ default: m.HypothesisPanel })),
  { ssr: false, loading: () => <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>Loading…</p> },
);

export default function TradeDetailPage({ params }: { params: { id: string } }) {
  const { tradeLog, tradeLogLoaded, deleteTradeLogEntry } = usePortfolio();
  const { getReflection, isGenerating, regenerate } = useReflection();
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);

  const trade = tradeLog.find((t) => t.id === params.id);
  const reflection = trade ? getReflection(trade.id) : undefined;
  const generating = trade ? isGenerating(trade.id) : false;

  if (!trade) {
    return (
      <div className="max-w-[820px] space-y-3">
        <h1 className="text-[17px] font-semibold">Trade Detail</h1>
        <NotAvailable
          what="This trade"
          reason={
            tradeLogLoaded
              ? 'no trade in the log carries that id. Trade ids are per-store, so a link from another machine will not resolve here.'
              : 'the trade log has not finished loading.'
          }
        />
        <button type="button" className="chip" onClick={() => router.push('/history')}>
          Back to trade history
        </button>
      </div>
    );
  }

  const sections = reflection?.sections;
  const hasSections =
    sections &&
    (sections.whyOutcome ||
      sections.failedSignal ||
      sections.earlierExit ||
      sections.confidenceAssessment ||
      sections.lesson);

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">
          <span className="mono">{trade.symbol}</span>{' '}
          <span
            className="mono text-[13px]"
            style={{ color: trade.side === 'buy' ? 'var(--positive)' : 'var(--negative)' }}
          >
            {trade.side.toUpperCase()}
          </span>
        </h1>
        <Badge
          state={trade.tab === 'real' ? 'CRITICAL' : 'INFO'}
          label={trade.tab === 'real' ? 'Real ledger' : 'Paper'}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Quantity" value={<Num value={trade.qty} digits={8} />} />
        <StatCard label="Price" value={<Num value={trade.price} prefix="$" />} />
        <StatCard label="Notional" value={<Num value={trade.qty * trade.price} prefix="$" />} />
        <StatCard
          label="Realised P&L"
          value={
            typeof trade.pnl === 'number' ? (
              <Num value={trade.pnl} prefix="$" colored signed />
            ) : (
              <span style={{ color: 'var(--text-muted)' }}>&mdash;</span>
            )
          }
          sub={typeof trade.pnl === 'number' ? undefined : 'not recorded on this row'}
        />
      </div>

      <Card>
        <SectionTitle>Record</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[11.5px]">
          <Field label="Timestamp" value={new Date(trade.ts).toLocaleString()} />
          <Field label="Trade id" value={trade.id} mono />
          {trade.note ? <Field label="Note" value={trade.note} /> : null}
        </div>
      </Card>

      <Card>
        <SectionTitle>How this trade happened</SectionTitle>
        <TradeJourney
          steps={buildJourney({
            symbol: trade.symbol,
            price: trade.price,
            execution: { submitted: true, status: 'filled' },
            outcome: typeof trade.pnl === 'number' ? { pnl: trade.pnl } : { status: 'unknown' },
          })}
        />
        <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The middle steps are unknown because a trade record stores no link to the decision
          that produced it. Only the entry and the outcome are real here.
        </div>
      </Card>

      {typeof trade.pnl === 'number' ? (
        <OperatorSection
          title="AI reflection"
          note="Advisory analysis of this trade's entry and exit. It is read by the chat system prompt and never re-fed into execution."
          action={
            <button type="button" className="chip" onClick={() => regenerate(trade.id)} disabled={generating}>
              {generating ? 'Generating…' : reflection ? 'Regenerate' : 'Generate'}
            </button>
          }
        >
          {reflection ? (
            <div className="space-y-2">
              {hasSections ? (
                <>
                  {sections?.whyOutcome ? <Labelled label="Why" text={sections.whyOutcome} /> : null}
                  {sections?.failedSignal ? (
                    <Labelled label="Failed signal" text={sections.failedSignal} />
                  ) : null}
                  {sections?.earlierExit ? (
                    <Labelled label="Earlier exit?" text={sections.earlierExit} />
                  ) : null}
                  {sections?.confidenceAssessment ? (
                    <Labelled label="Confidence too high?" text={sections.confidenceAssessment} />
                  ) : null}
                  {sections?.lesson ? <Labelled label="Lesson" text={sections.lesson} accent /> : null}
                </>
              ) : (
                <p className="text-[12px] whitespace-pre-wrap" style={{ color: 'var(--text-secondary)' }}>
                  {reflection.content}
                </p>
              )}

              {reflection.finishReason === 'length' ? (
                <p className="text-[10.5px] mono" style={{ color: 'var(--warning)' }}>
                  Cut off at the model&apos;s token limit — this reflection may be incomplete.
                </p>
              ) : null}

              <details className="text-[10.5px] mono" style={{ color: 'var(--text-muted)' }}>
                <summary className="cursor-pointer">Context used</summary>
                <p className="mt-1">Entry: {reflection.entryContextUsed ?? 'not captured for this trade'}</p>
                <p className="mt-1">Exit: {reflection.exitContextUsed}</p>
              </details>
            </div>
          ) : generating ? (
            <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              Analysing this trade&apos;s entry and exit context…
            </p>
          ) : (
            <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              No reflection yet. One is generated automatically for a closed trade; Generate
              runs it now.
            </p>
          )}
        </OperatorSection>
      ) : (
        <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          No reflection or hypothesis for this row: both need a realised P&amp;L to reason
          about, and this record carries none.
        </div>
      )}

      {typeof trade.pnl === 'number' ? (
        <OperatorSection
          title="Hypothesis"
          note="Apply is the only path from a lesson to production, and it is a human click. Nothing here can write to risk config or strategy selection on its own."
        >
          <HypothesisPanel tradeId={trade.id} />
        </OperatorSection>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="chip" onClick={() => router.push('/history')}>
          ← Trade history
        </button>
        {confirming ? (
          <>
            <span className="text-[11.5px]" style={{ color: 'var(--negative)' }}>
              Delete this {trade.side} {trade.symbol} entry? Every derived figure changes and
              this cannot be undone.
            </span>
            <button
              type="button"
              className="chip"
              style={{ color: 'var(--negative)', borderColor: 'var(--negative)' }}
              onClick={async () => {
                await deleteTradeLogEntry(trade.id);
                router.push('/history');
              }}
            >
              Delete
            </button>
            <button type="button" className="chip" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="chip" onClick={() => setConfirming(true)}>
            Delete entry
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div
        className="font-mono text-[10px] uppercase tracking-wider mb-0.5"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </div>
      <div className={mono ? 'mono text-[11px] break-all' : ''} style={{ color: 'var(--text-secondary)' }}>
        {value}
      </div>
    </div>
  );
}

function Labelled({ label, text, accent }: { label: string; text: string; accent?: boolean }) {
  return (
    <p
      className="text-[12px] leading-relaxed"
      style={{ color: accent ? 'var(--accent)' : 'var(--text-secondary)' }}
    >
      <span
        className="font-mono text-[10px] uppercase tracking-wider mr-1.5"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </span>
      {text}
    </p>
  );
}
