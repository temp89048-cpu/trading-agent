// ---------------------------------------------------------------------
// The trade log. POSTGRES-FIRST, with the JSON file as a fallback.
//
// This file's original comment asked for exactly this change:
//
//   "If this ever gets deployed there, swap this file for a real datastore
//    (Vercel KV, Postgres, etc.) — the GET/POST/DELETE routes that call this
//    module don't need to change, only this file's internals."
//
// So the exported API is unchanged and no route or component was edited. What
// changed is where the rows live.
//
// IT WRITES THE SAME `trades` TABLE THE PYTHON AGENT WRITES. That is the point:
// there were two trade logs, and `/orders` showed the browser's four rows while
// the agent had recorded 2,620. `origin_tag` is what separates them —
// `manual-click` for a human, `agent-plan`/`debate`/`chat-trade-action` for the
// agent — so one table can hold both without either being mistaken for the other.
//
// NUMERIC COMES BACK AS A STRING. `qty`, `price` and `pnl` are Postgres
// `numeric`, which node-postgres returns as text to avoid losing precision to a
// float. Every read goes through `toNumber` — without it `qty` arrives as
// `"0.05"` and arithmetic on it concatenates instead of adding.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, toNumber, writeJson } from './jsonFallback.server';
import type { TradeLogEntry, TradeTab, TradeSide } from './types';

const FILE = 'trades.json';

/** Columns in the order every SELECT here uses. */
const COLUMNS = `id, ts, tab, symbol, side, qty, price, note, pnl,
                 entry_context, debate_id, origin_tag, exchange_order_id`;

type Row = {
  id: string;
  ts: Date | string;
  tab: string;
  symbol: string;
  side: string;
  qty: string | number;
  price: string | number;
  note: string | null;
  pnl: string | number | null;
  entry_context: string | null;
  debate_id: string | null;
  origin_tag: string | null;
  exchange_order_id: string | null;
};

function fromRow(r: Row): TradeLogEntry {
  return {
    id: r.id,
    // A row whose timestamp will not parse is still a real trade, so it is kept
    // and stamped 0 rather than dropped — losing a trade record silently is
    // worse than one sorting to the end of the list.
    ts: toMillis(r.ts) ?? 0,
    tab: r.tab as TradeTab,
    symbol: r.symbol,
    side: r.side as TradeSide,
    qty: toNumber(r.qty) ?? 0,
    price: toNumber(r.price) ?? 0,
    ...(r.note === null ? {} : { note: r.note }),
    // `pnl` stays ABSENT when null, not 0. `realised()` and every win-rate
    // calculation in lib/api/portfolio.ts test `typeof pnl === 'number'` to
    // decide whether a trade can contribute — a 0 would silently enter those
    // averages as a break-even trade that never happened.
    ...(toNumber(r.pnl) === null ? {} : { pnl: toNumber(r.pnl) as number }),
    ...(r.entry_context === null ? {} : { entryContext: r.entry_context }),
    ...(r.debate_id === null ? {} : { debateId: r.debate_id }),
    ...(r.origin_tag === null ? {} : { originTag: r.origin_tag as TradeLogEntry['originTag'] }),
    ...(r.exchange_order_id === null ? {} : { exchangeOrderId: r.exchange_order_id }),
  };
}

export async function listTrades(tab?: TradeTab): Promise<TradeLogEntry[]> {
  const found = await rows<Row>(
    `SELECT ${COLUMNS} FROM trades
      WHERE ($1::text IS NULL OR tab = $1)
      ORDER BY ts DESC`,
    [tab ?? null],
  );
  if (found) return found.map(fromRow);

  // No database configured — fall back to the file.
  const all = await readJson<TradeLogEntry[]>(FILE, []);
  const filtered = tab ? all.filter((t) => t.tab === tab) : all;
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

export async function getTrade(id: string): Promise<TradeLogEntry | null> {
  const row = await one<Row>(`SELECT ${COLUMNS} FROM trades WHERE id = $1`, [id]);
  if (row === null) {
    const all = await readJson<TradeLogEntry[]>(FILE, []);
    return all.find((t) => t.id === id) ?? null;
  }
  return row ? fromRow(row) : null;
}

export type NewTrade = {
  tab: TradeTab;
  symbol: string;
  side: TradeSide;
  qty: number;
  price: number;
  note?: string;
  pnl?: number;
  entryContext?: string;
  debateId?: string;
  originTag?: TradeLogEntry['originTag'];
  exchangeOrderId?: string;
};

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function addTrade(input: NewTrade): Promise<TradeLogEntry> {
  const entry: TradeLogEntry = { id: newId(), ts: Date.now(), ...input };

  const inserted = await one<Row>(
    `INSERT INTO trades (id, ts, tab, symbol, side, qty, price, note, pnl,
                         entry_context, debate_id, origin_tag, exchange_order_id)
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${COLUMNS}`,
    [
      entry.id,
      entry.ts,
      entry.tab,
      entry.symbol,
      entry.side,
      entry.qty,
      entry.price,
      entry.note ?? null,
      entry.pnl ?? null,
      entry.entryContext ?? null,
      entry.debateId ?? null,
      // Defaults to 'manual-click': a trade arriving through this module came
      // from the browser. The schema CHECKs this column, so an unlisted value
      // would be rejected at write time — the agent's own tags come from Python.
      entry.originTag ?? 'manual-click',
      entry.exchangeOrderId ?? null,
    ],
  );
  if (inserted) return fromRow(inserted);

  // Fallback: append to the file under the same write queue as before.
  return serialize(FILE, async () => {
    const all = await readJson<TradeLogEntry[]>(FILE, []);
    all.push(entry);
    await writeJson(FILE, all);
    return entry;
  });
}

export async function deleteTrade(id: string): Promise<boolean> {
  const deleted = await rows<{ id: string }>('DELETE FROM trades WHERE id = $1 RETURNING id', [id]);
  if (deleted) return deleted.length > 0;

  return serialize(FILE, async () => {
    const all = await readJson<TradeLogEntry[]>(FILE, []);
    const next = all.filter((t) => t.id !== id);
    const removed = next.length !== all.length;
    if (removed) await writeJson(FILE, next);
    return removed;
  });
}
