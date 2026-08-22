'use client';

// ---------------------------------------------------------------------
// One asset: price, change, sparkline, and the agent's read on it.
//
// The reference's `marketCard()` renders 8 fields per asset from mock data, all
// always present. Real fields are frequently absent, and the two that matter most
// are absent in a specific, non-obvious way:
//
//   * FUNDING and OPEN INTEREST are fetched for BTCUSDT only
//     (`sentiment_agent.fetch_macro_data` queries that symbol specifically), so
//     showing them under "SOL" would attribute a BTC number to SOL. They are
//     rendered only when `macroSymbol` says they belong to this asset, and
//     labelled with the symbol they came from otherwise.
//
//   * `agentStatus`/`confidence` come from the last decision the stream reported.
//     With no decision yet, that is IDLE with no confidence — not 0%.
// ---------------------------------------------------------------------

import { Badge } from '@/components/ui/Badge';
import { Sparkline } from '@/components/ui/Sparkline';
import { Num } from '@/components/ui/primitives';

export type MarketCardData = {
  symbol: string;
  price: number | null;
  /** Percent change. `null` when no reference point exists yet. */
  changePct?: number | null;
  /** Recent closes for the sparkline, oldest first. */
  history?: (number | null)[];
  /** Last decision/status the stream reported for this symbol. */
  agentStatus?: string | null;
  confidencePct?: number | null;
  /** Which symbol the funding/OI numbers actually describe. When it differs from
   *  `symbol`, they are labelled rather than silently attributed. */
  macroSymbol?: string | null;
  fundingRate?: number | null;
  openInterest?: number | null;
};

export function MarketCard({
  data,
  onSelect,
  selected = false,
}: {
  data: MarketCardData;
  onSelect?: (symbol: string) => void;
  selected?: boolean;
}) {
  const up = typeof data.changePct === 'number' ? data.changePct >= 0 : null;
  const macroIsThis = !data.macroSymbol || data.macroSymbol === data.symbol;

  return (
    <div
      className={`card p-3${onSelect ? ' cursor-pointer' : ''}`}
      style={selected ? { borderColor: 'var(--accent)' } : undefined}
      onClick={onSelect ? () => onSelect(data.symbol) : undefined}
      role={onSelect ? 'button' : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(data.symbol);
              }
            }
          : undefined
      }
    >
      <div className="flex justify-between items-start mb-1 gap-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{data.symbol}</div>
          <div className="mono text-[15px]">
            {/* 4 decimals under $1 — a sub-dollar asset at 2dp loses the price. */}
            <Num
              value={data.price}
              prefix="$"
              digits={typeof data.price === 'number' && data.price < 1 ? 4 : 2}
            />
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="mono text-[12px]" style={{ color: up === null ? 'var(--text-muted)' : up ? 'var(--positive)' : 'var(--negative)' }}>
            {up === null ? '—' : `${up ? '▲' : '▼'} ${Math.abs(data.changePct as number).toFixed(2)}%`}
          </div>
          <Sparkline
            values={data.history ?? []}
            width={90}
            height={28}
            color={up === null ? 'var(--border-strong)' : up ? 'var(--positive)' : 'var(--negative)'}
          />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t hairline">
        <Badge state={data.agentStatus ?? 'IDLE'} />
        <span className="mono text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          {typeof data.confidencePct === 'number' ? (
            `conf ${data.confidencePct.toFixed(0)}%`
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>no decision yet</span>
          )}
        </span>
      </div>

      {(typeof data.fundingRate === 'number' || typeof data.openInterest === 'number') && (
        <div className="grid grid-cols-2 gap-1 text-[10.5px] mono mt-2" style={{ color: 'var(--text-secondary)' }}>
          <span>
            <span style={{ color: 'var(--text-muted)' }}>Funding </span>
            {typeof data.fundingRate === 'number' ? `${(data.fundingRate * 100).toFixed(4)}%` : '—'}
          </span>
          <span className="text-right">
            <span style={{ color: 'var(--text-muted)' }}>OI </span>
            {typeof data.openInterest === 'number' ? data.openInterest.toLocaleString() : '—'}
          </span>
          {!macroIsThis ? (
            // The whole reason this component takes `macroSymbol`. A BTC funding
            // rate shown unlabelled under SOL is a wrong number, not a rounding.
            <span className="col-span-2 text-[9.5px]" style={{ color: 'var(--warning)' }}>
              funding/OI are {data.macroSymbol} readings — this backend fetches them for
              that symbol only
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
