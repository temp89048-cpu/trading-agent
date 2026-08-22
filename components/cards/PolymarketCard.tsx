'use client';

// ---------------------------------------------------------------------
// One prediction-market reading.
//
// The reference's `pmCard()` shows question, category, YES/NO bar, volume, 24h
// change, close date, and an "Agent Relevance" gauge. The backend supplies some of
// that and not the rest, and the difference is stated on the card rather than
// filled in:
//
//   question, category   yes — from the mapping/snapshot
//   YES probability      yes — `PredictionOutcome.price`, documented 0..1
//   close date           yes — the market's `end`
//   volume / 24h change  NO — present on the ccxt payload but NOT persisted in the
//                        snapshot store, so there is nothing to read
//   "Agent Relevance"    NO — does not exist. The backend computes
//                        `directional.confidence` (how much to trust a drift) and
//                        `eventRisk.concern` (how much to dampen conviction).
//                        Those are shown under their real names.
//
// Renaming `concern` to "relevance" would have made the card match the mockup and
// would have told the operator something false about what the number means: a
// constraint's concern is not a measure of relevance.
// ---------------------------------------------------------------------

import { Badge } from '@/components/ui/Badge';
import { Gauge } from '@/components/ui/Gauge';

export type PolymarketCardData = {
  /** The market question, or its unified handle when no title is stored. */
  question: string;
  /** Category/tag. `null` renders no chip rather than an "Unknown" one. */
  category?: string | null;
  /** YES probability, 0..1. `null` = not read this cycle. */
  yes: number | null;
  /** Unix seconds. */
  endTs?: number | null;
  /** Which role the mapping plays — the two produce different numbers. */
  role?: 'directional' | 'event_risk' | string | null;
  /** `directional.confidence`: how much to trust the drift. NOT "relevance". */
  confidence?: number | null;
  /** `eventRisk.concern`: how much to dampen conviction. NOT "relevance". */
  concern?: number | null;
  /** Whether an operator has attested this market is about this instrument. */
  confirmed?: boolean;
  observation?: string | null;
};

function closesLabel(endTs?: number | null): string {
  if (typeof endTs !== 'number' || !Number.isFinite(endTs)) return '—';
  const d = new Date(endTs * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function PolymarketCard({
  data,
  compact = false,
}: {
  data: PolymarketCardData;
  /** Compact hides the metric footer — used inside the Live Inspector, matching
   *  the reference's `pmCard(m, true)`. */
  compact?: boolean;
}) {
  const hasYes = typeof data.yes === 'number' && Number.isFinite(data.yes);
  const yesPct = hasYes ? Math.round((data.yes as number) * 100) : null;
  const noPct = yesPct === null ? null : 100 - yesPct;

  const isEventRisk = data.role === 'event_risk';
  const metricValue = isEventRisk ? data.concern : data.confidence;
  const metricLabel = isEventRisk ? 'Event-risk concern' : 'Directional confidence';
  const metricHint = isEventRisk
    ? 'From uncertainty x proximity — how much to dampen conviction. Not a measure of relevance, and it says nothing about direction.'
    : 'How much to trust the implied drift, from move size x liquidity x quote quality.';

  return (
    <div className={`${compact ? 'card-2' : 'card'} rounded p-3`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="text-[12.5px] leading-snug pr-2">{data.question}</div>
        {data.category ? (
          <span
            className="badge shrink-0"
            style={{
              background: 'color-mix(in srgb, var(--accent) 16%, transparent)',
              color: 'var(--accent)',
            }}
          >
            {data.category}
          </span>
        ) : null}
      </div>

      {hasYes ? (
        <>
          <div className="flex items-center gap-2 mb-1.5">
            <div
              className="flex-1 h-2 rounded-full overflow-hidden flex"
              style={{ background: 'var(--bg-surface-2)' }}
            >
              <div style={{ width: `${yesPct}%`, background: 'var(--positive)' }} />
              <div style={{ width: `${noPct}%`, background: 'var(--negative)' }} />
            </div>
          </div>
          <div className="flex justify-between text-[11px] mono mb-2">
            <span style={{ color: 'var(--positive)' }}>YES {yesPct}%</span>
            <span style={{ color: 'var(--negative)' }}>NO {noPct}%</span>
          </div>
        </>
      ) : (
        <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
          No probability read this cycle — the poller has not fetched this market, or the
          read failed. Not shown as 50/50, which would be a measurement.
        </div>
      )}

      <div className="flex justify-between text-[10.5px] mono gap-2" style={{ color: 'var(--text-muted)' }}>
        <span>Closes {closesLabel(data.endTs)}</span>
        {!data.confirmed ? (
          <span style={{ color: 'var(--warning)' }} title="Only a confirmed mapping feeds the panel">
            unconfirmed
          </span>
        ) : (
          <Badge state="CONFIRMED" />
        )}
      </div>

      {/* Volume and 24h change are deliberately absent. They exist on the ccxt
          payload but are not persisted in the snapshot store, so there is nothing
          honest to render — and a card that showed "Vol —" for every market would
          just be noise. Recorded in the plan's gap list instead. */}

      {!compact ? (
        <div className="mt-2 pt-2 border-t hairline">
          <Gauge
            pct={typeof metricValue === 'number' ? metricValue * 100 : null}
            color={isEventRisk ? 'var(--warning)' : 'var(--accent)'}
            label={metricLabel}
            unavailableReason={
              isEventRisk
                ? 'event-risk concern was not computed for this market this cycle'
                : 'directional confidence needs a bounded partition, a spot price and measurable quote quality'
            }
          />
          <div className="text-[10px] mt-1.5 leading-snug" style={{ color: 'var(--text-muted)' }}>
            {metricHint}
          </div>
        </div>
      ) : null}

      {data.observation && !compact ? (
        <div className="text-[10.5px] mt-2 leading-snug" style={{ color: 'var(--text-secondary)' }}>
          {data.observation}
        </div>
      ) : null}
    </div>
  );
}
