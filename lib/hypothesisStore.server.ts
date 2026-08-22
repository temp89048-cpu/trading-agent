// ---------------------------------------------------------------------
// Hypotheses. POSTGRES-FIRST, JSON file as fallback.
//
// `hypotheses` has `id` as its primary key and a separate `UNIQUE (trade_id)`,
// plus a foreign key to `trades(id)` with `ON DELETE CASCADE`. So the
// one-hypothesis-per-trade rule the JSON version enforced by convention is now
// enforced by the database — `saveHypothesis` upserts on `trade_id`, and two racing
// requests cannot produce two rows for one trade.
//
// A hypothesis for a trade that is not in `trades` cannot be stored, for the same
// reason a reflection cannot: it would be a claim derived from a trade nothing has
// a record of. The FK violation is caught and explained rather than surfaced as a
// Postgres error code.
//
// `status` is CHECK-constrained to the five values in `HypothesisStatus`. Adding a
// sixth needs a line in the `COLUMN ADDITIONS` section of `db/schema.sql` as well
// as here, or the write fails at run time — which is what happened when the
// supervisor wrote `outcome="declined"` against a constraint that did not list it,
// and every refusal was silently dropped from the audit trail.
//
// NOTHING HERE SETS 'applied'. That status records that a HUMAN changed the
// relevant config themselves. No code path in this file or `lib/hypothesisAgent.ts`
// writes production config, and `Loss -> AI rewrites strategy -> Live` must remain
// impossible.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, writeJson } from './jsonFallback.server';

// proposed  -> the Hypothesis Agent generated this, no human action yet
// dismissed -> a human decided this isn't worth testing
// validated -> a human tested it (backtest/paper trading) and it held up
// rejected  -> a human tested it and it did NOT hold up
// applied   -> a human, having validated it, manually changed the
//              relevant existing config themselves. This status records
//              that a human did it — nothing in this codebase ever sets
//              it automatically, and nothing here writes config on its
//              own behalf. See lib/hypothesisAgent.ts's header comment.
export type HypothesisStatus = 'proposed' | 'dismissed' | 'validated' | 'rejected' | 'applied';

export type HypothesisRecord = {
  id: string;
  tradeId: string; // the closed trade whose reflection produced this
  ts: number;
  symbol: string;
  claim: string;
  suggestedTest: string;
  status: HypothesisStatus;
  reviewNote: string | null; // the human's own note when changing status
  updatedAt: number;
};

const FILE = 'hypotheses.json';

const COLUMNS = `id, trade_id, ts, symbol, claim, suggested_test,
                 status, review_note, updated_at`;

type Row = {
  id: string;
  trade_id: string;
  ts: Date | string;
  symbol: string;
  claim: string;
  suggested_test: string;
  status: string;
  review_note: string | null;
  updated_at: Date | string;
};

function fromRow(r: Row): HypothesisRecord {
  return {
    id: r.id,
    tradeId: r.trade_id,
    ts: toMillis(r.ts) ?? 0,
    symbol: r.symbol,
    claim: r.claim,
    suggestedTest: r.suggested_test,
    status: r.status as HypothesisStatus,
    reviewNote: r.review_note,
    updatedAt: toMillis(r.updated_at) ?? 0,
  };
}

const FK_VIOLATION = '23503';

export async function listHypotheses(): Promise<HypothesisRecord[]> {
  const found = await rows<Row>(`SELECT ${COLUMNS} FROM hypotheses ORDER BY ts DESC`);
  if (found) return found.map(fromRow);
  return readJson<HypothesisRecord[]>(FILE, []);
}

export async function getHypothesisByTradeId(tradeId: string): Promise<HypothesisRecord | null> {
  const row = await one<Row>(`SELECT ${COLUMNS} FROM hypotheses WHERE trade_id = $1`, [tradeId]);
  if (row === null) {
    const all = await readJson<HypothesisRecord[]>(FILE, []);
    return all.find((h) => h.tradeId === tradeId) ?? null;
  }
  return row ? fromRow(row) : null;
}

/** Upsert on trade_id — a trade has at most one hypothesis in this model. */
export async function saveHypothesis(record: HypothesisRecord): Promise<HypothesisRecord> {
  try {
    const saved = await one<Row>(
      `INSERT INTO hypotheses (id, trade_id, ts, symbol, claim, suggested_test,
                               status, review_note, updated_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0), $4, $5, $6, $7, $8, to_timestamp($9 / 1000.0))
       ON CONFLICT (trade_id) DO UPDATE SET
         -- id is intentionally NOT updated: the row keeps the identity it was
         -- created with, so a link to it stays valid across a regenerate.
         -- (No backticks in this comment: it lives inside a JS template literal,
         --  where a backtick would terminate the string mid-SQL.)
         ts = EXCLUDED.ts,
         symbol = EXCLUDED.symbol,
         claim = EXCLUDED.claim,
         suggested_test = EXCLUDED.suggested_test,
         status = EXCLUDED.status,
         review_note = EXCLUDED.review_note,
         updated_at = EXCLUDED.updated_at
       RETURNING ${COLUMNS}`,
      [
        record.id,
        record.tradeId,
        record.ts,
        record.symbol,
        record.claim,
        record.suggestedTest,
        record.status,
        record.reviewNote,
        record.updatedAt,
      ],
    );
    if (saved) return fromRow(saved);
  } catch (err) {
    if ((err as { code?: string }).code === FK_VIOLATION) {
      throw new Error(
        `Cannot store a hypothesis for trade ${record.tradeId}: no such trade exists in the ` +
          'database. A hypothesis is anchored to the trade whose reflection produced it. If ' +
          'that trade lives only in .data/trades.json, run scripts/import_json_to_postgres.py.',
      );
    }
    throw err;
  }

  return serialize(FILE, async () => {
    const all = await readJson<HypothesisRecord[]>(FILE, []);
    const idx = all.findIndex((h) => h.tradeId === record.tradeId);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    await writeJson(FILE, all);
    return record;
  });
}

export async function updateHypothesisStatus(
  id: string,
  status: HypothesisStatus,
  reviewNote: string | null,
): Promise<HypothesisRecord | null> {
  const updated = await rows<Row>(
    `UPDATE hypotheses
        SET status = $2, review_note = $3, updated_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, status, reviewNote],
  );
  // `null` means no database; an empty array means the database looked and there
  // is no such hypothesis. Only the second is a legitimate "not found".
  if (updated !== null) return updated.length > 0 ? fromRow(updated[0]) : null;

  return serialize(FILE, async () => {
    const all = await readJson<HypothesisRecord[]>(FILE, []);
    const idx = all.findIndex((h) => h.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], status, reviewNote, updatedAt: Date.now() };
    await writeJson(FILE, all);
    return all[idx];
  });
}
