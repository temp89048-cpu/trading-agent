// ---------------------------------------------------------------------
// Portfolio-value samples — the equity curve the analytics panels plot.
// POSTGRES ONLY; it had no JSON file, only `localStorage`.
//
// APPEND-ONLY, and the primary key is `(tab, ts)`. A second sample in the same
// millisecond is the same observation, so the key drops it rather than
// double-counting a point on the curve.
//
// `complete` IS THE POINT OF THIS TABLE. A total computed while some position had
// no price is PARTIAL, and plotting it next to complete totals draws a cliff that
// looks like a loss and never happened. The flag travels with the sample so a
// reader can exclude or mark it; it is never inferred from the value.
//
// A retention cap is applied on read rather than on write: `limit` bounds what a
// chart pulls back, and the raw history is kept. Truncating an equity curve to
// bound storage would delete the oldest points, which are exactly the ones a
// drawdown-from-peak calculation needs.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { toMillis, toNumber } from './jsonFallback.server';
import type { TradeTab } from './types';

export type PvSample = {
  tab: TradeTab;
  ts: number;
  totalValue: number;
  cash: number | null;
  positionsValue: number | null;
  /** false => some position could not be priced, so totalValue is PARTIAL. */
  complete: boolean;
};

type Row = {
  tab: string;
  ts: Date | string;
  total_value: string | number;
  cash: string | number | null;
  positions_value: string | number | null;
  complete: boolean;
};

function fromRow(r: Row): PvSample {
  return {
    tab: r.tab as TradeTab,
    ts: toMillis(r.ts) ?? 0,
    totalValue: toNumber(r.total_value) ?? 0,
    cash: toNumber(r.cash),
    positionsValue: toNumber(r.positions_value),
    complete: r.complete,
  };
}

export async function listPvHistory(tab?: TradeTab, limit = 2000): Promise<PvSample[] | null> {
  const found = await rows<Row>(
    `SELECT tab, ts, total_value, cash, positions_value, complete
       FROM pv_history
      WHERE ($1::text IS NULL OR tab = $1)
      ORDER BY ts DESC
      LIMIT $2`,
    [tab ?? null, limit],
  );
  if (found === null) return null;
  // Oldest-first for plotting; the query is newest-first so LIMIT keeps the
  // RECENT points rather than the first ones ever recorded.
  return found.map(fromRow).reverse();
}

export async function appendPvSample(sample: PvSample): Promise<boolean> {
  const saved = await one<{ ts: Date }>(
    `INSERT INTO pv_history (tab, ts, total_value, cash, positions_value, complete)
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6)
     ON CONFLICT (tab, ts) DO NOTHING
     RETURNING ts`,
    [
      sample.tab,
      sample.ts,
      sample.totalValue,
      sample.cash,
      sample.positionsValue,
      sample.complete,
    ],
  );
  // `undefined` = the conflict clause fired, which is a successful no-op, not a
  // failure. Only `null` means there was no database to write to.
  return saved !== null;
}
