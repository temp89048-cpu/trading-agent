// ---------------------------------------------------------------------
// Reflections. POSTGRES-FIRST, JSON file as fallback.
//
// `reflections.trade_id` is both the PRIMARY KEY and a FOREIGN KEY to
// `trades(id)` with `ON DELETE CASCADE`. Two consequences worth knowing before
// changing anything here:
//
//  1. ONE reflection per trade, enforced by the database rather than by the
//     upsert-by-tradeId convention the JSON version relied on. A "regenerate"
//     replaces the row; it cannot accumulate duplicates even if two requests race.
//
//  2. A reflection whose trade is NOT in `trades` CANNOT be stored. That is
//     correct — a post-mortem about a trade nothing has a record of is unanchored,
//     and the cascade means deleting the trade removes its reflection rather than
//     orphaning it. But it is a real failure mode, so `saveReflection` detects the
//     FK violation specifically and says which trade is missing, instead of
//     surfacing a raw Postgres error code to a route.
//
// `sections` is `jsonb`: it is a parsed-LLM-output shape owned by
// `lib/reflectionAgent.ts` whose fields are all optional, and exploding five
// nullable text columns out of it would buy nothing.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, writeJson } from './jsonFallback.server';
import type { ReflectionSections } from './reflectionAgent';

const FILE = 'reflections.json';

export type ReflectionRecord = {
  tradeId: string;
  ts: number;
  symbol: string;
  content: string; // the model's post-mortem text, stored verbatim, read-only
  sections?: ReflectionSections | null; // parsed WHY/FAILED_SIGNAL/EARLIER_EXIT/CONFIDENCE/LESSON fields; undefined/null for older reflections predating this field, or if the model didn't follow the labeled format at all
  entryContextUsed: string | null;
  exitContextUsed: string;
  finishReason: string | null; // 'stop' | 'length' | etc — surfaced so a truncated reflection is visible, not silently trusted as complete
};

const COLUMNS = `trade_id, ts, symbol, content, sections,
                 entry_context_used, exit_context_used, finish_reason`;

type Row = {
  trade_id: string;
  ts: Date | string;
  symbol: string;
  content: string;
  sections: unknown;
  entry_context_used: string | null;
  exit_context_used: string;
  finish_reason: string | null;
};

function fromRow(r: Row): ReflectionRecord {
  return {
    tradeId: r.trade_id,
    ts: toMillis(r.ts) ?? 0,
    symbol: r.symbol,
    content: r.content,
    sections: (r.sections ?? null) as ReflectionSections | null,
    entryContextUsed: r.entry_context_used,
    exitContextUsed: r.exit_context_used,
    finishReason: r.finish_reason,
  };
}

/** Postgres foreign-key violation. */
const FK_VIOLATION = '23503';

export async function listReflections(): Promise<ReflectionRecord[]> {
  const found = await rows<Row>(`SELECT ${COLUMNS} FROM reflections ORDER BY ts DESC`);
  if (found) return found.map(fromRow);
  return readJson<ReflectionRecord[]>(FILE, []);
}

export async function getReflection(tradeId: string): Promise<ReflectionRecord | null> {
  const row = await one<Row>(`SELECT ${COLUMNS} FROM reflections WHERE trade_id = $1`, [tradeId]);
  if (row === null) {
    const all = await readJson<ReflectionRecord[]>(FILE, []);
    return all.find((r) => r.tradeId === tradeId) ?? null;
  }
  return row ? fromRow(row) : null;
}

/**
 * Upsert by trade id — a "regenerate" replaces the prior reflection.
 *
 * Throws with an explanatory message when the trade does not exist, rather than
 * letting a bare `23503` reach the caller. The route above this turns an error
 * into a 500, and "insert or update on table reflections violates foreign key
 * constraint" tells an operator nothing about what to do.
 */
export async function saveReflection(record: ReflectionRecord): Promise<ReflectionRecord> {
  try {
    const saved = await one<Row>(
      `INSERT INTO reflections (trade_id, ts, symbol, content, sections,
                               entry_context_used, exit_context_used, finish_reason)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (trade_id) DO UPDATE SET
         ts = EXCLUDED.ts,
         symbol = EXCLUDED.symbol,
         content = EXCLUDED.content,
         sections = EXCLUDED.sections,
         entry_context_used = EXCLUDED.entry_context_used,
         exit_context_used = EXCLUDED.exit_context_used,
         finish_reason = EXCLUDED.finish_reason
       RETURNING ${COLUMNS}`,
      [
        record.tradeId,
        record.ts,
        record.symbol,
        record.content,
        record.sections === undefined || record.sections === null
          ? null
          : JSON.stringify(record.sections),
        record.entryContextUsed,
        record.exitContextUsed,
        record.finishReason,
      ],
    );
    if (saved) return fromRow(saved);
  } catch (err) {
    if ((err as { code?: string }).code === FK_VIOLATION) {
      throw new Error(
        `Cannot store a reflection for trade ${record.tradeId}: no such trade exists in the ` +
          'database. A reflection is anchored to a trade by foreign key, so one about a trade ' +
          'with no record cannot be saved. If the trade lives only in .data/trades.json, run ' +
          'scripts/import_json_to_postgres.py first.',
      );
    }
    throw err;
  }

  return serialize(FILE, async () => {
    const all = await readJson<ReflectionRecord[]>(FILE, []);
    const idx = all.findIndex((r) => r.tradeId === record.tradeId);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    await writeJson(FILE, all);
    return record;
  });
}
