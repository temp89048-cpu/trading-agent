// ---------------------------------------------------------------------
// Debate records. POSTGRES-FIRST, JSON file as fallback.
//
// `opinions`, `moderator` and `regime` are `jsonb`. `opinions` is an array of
// per-agent positions and `moderator` is the full decision summary — both are
// shapes owned by `lib/debate/types.ts`, and flattening them would mean a schema
// change every time an agent gains a field.
//
// `trade_id` REFERENCES `trades(id) ON DELETE SET NULL`. So linking a debate to a
// trade that does not exist fails, and `linkDebateToTrade` reports that rather
// than appearing to succeed — a debate silently unlinked from the trade it
// produced is how "Act on this" becomes untraceable.
//
// `risk_level` is CHECK-constrained to Low/Medium/High and `outcome` to win/loss.
// The outcome is deliberately nullable: a debate whose trade has not closed yet
// has no outcome, which is different from a debate that lost.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, toNumber, writeJson } from './jsonFallback.server';
import type { DebateRecord } from './debate/types';

const FILE = 'debate-records.json';

const COLUMNS = `id, ts, symbol, opinions, moderator, regime, calibrated_confidence,
                 risk_level, suggested_position_pct, trade_id, outcome, outcome_pnl_usd`;

type Row = {
  id: string;
  ts: Date | string;
  symbol: string;
  opinions: unknown;
  moderator: unknown;
  regime: unknown;
  calibrated_confidence: string | number | null;
  risk_level: string;
  suggested_position_pct: string | number | null;
  trade_id: string | null;
  outcome: string | null;
  outcome_pnl_usd: string | number | null;
};

function fromRow(r: Row): DebateRecord {
  return {
    id: r.id,
    ts: toMillis(r.ts) ?? 0,
    symbol: r.symbol,
    opinions: (r.opinions ?? []) as DebateRecord['opinions'],
    moderator: r.moderator as DebateRecord['moderator'],
    regime: r.regime as DebateRecord['regime'],
    // null, not 0. An uncalibrated confidence is not zero confidence — the
    // Debate panel shows "not calibrated" for the first and a hard NO for a 0.
    calibratedConfidence: toNumber(r.calibrated_confidence),
    riskLevel: r.risk_level as DebateRecord['riskLevel'],
    suggestedPositionPct: toNumber(r.suggested_position_pct),
    tradeId: r.trade_id,
    outcome: r.outcome as DebateRecord['outcome'],
    outcomePnlUsd: toNumber(r.outcome_pnl_usd),
  };
}

const FK_VIOLATION = '23503';

export async function listDebateRecords(symbol?: string): Promise<DebateRecord[]> {
  const found = await rows<Row>(
    `SELECT ${COLUMNS} FROM debate_records
      WHERE ($1::text IS NULL OR symbol = $1)
      ORDER BY ts DESC`,
    [symbol ?? null],
  );
  if (found) return found.map(fromRow);

  const all = await readJson<DebateRecord[]>(FILE, []);
  const filtered = symbol ? all.filter((d) => d.symbol === symbol) : all;
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

export async function saveDebateRecord(record: DebateRecord): Promise<DebateRecord> {
  const SQL = `INSERT INTO debate_records (${COLUMNS})
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4::jsonb, $5::jsonb, $6::jsonb,
             $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO UPDATE SET
       opinions = EXCLUDED.opinions,
       moderator = EXCLUDED.moderator,
       regime = EXCLUDED.regime,
       calibrated_confidence = EXCLUDED.calibrated_confidence,
       risk_level = EXCLUDED.risk_level,
       suggested_position_pct = EXCLUDED.suggested_position_pct,
       trade_id = EXCLUDED.trade_id,
       outcome = EXCLUDED.outcome,
       outcome_pnl_usd = EXCLUDED.outcome_pnl_usd
     RETURNING ${COLUMNS}`;

  const params = (tradeId: string | null) => [
    record.id,
    record.ts,
    record.symbol,
    JSON.stringify(record.opinions ?? []),
    JSON.stringify(record.moderator ?? {}),
    record.regime === null || record.regime === undefined ? null : JSON.stringify(record.regime),
    record.calibratedConfidence,
    record.riskLevel,
    record.suggestedPositionPct,
    tradeId,
    record.outcome,
    record.outcomePnlUsd,
  ];

  try {
    const saved = await one<Row>(SQL, params(record.tradeId ?? null));
    if (saved) return fromRow(saved);
  } catch (err) {
    if ((err as { code?: string }).code === FK_VIOLATION && record.tradeId) {
      // Keep the debate, drop the dangling link. The reasoning record is the
      // valuable artefact; losing it because its trade link is stale would
      // remove the only evidence of why a decision was made.
      console.warn(
        `[debates] trade_id ${record.tradeId} does not exist; storing the debate unlinked.`,
      );
      const saved = await one<Row>(SQL, params(null));
      if (saved) return fromRow(saved);
    } else {
      throw err;
    }
  }

  return serialize(FILE, async () => {
    const all = await readJson<DebateRecord[]>(FILE, []);
    const idx = all.findIndex((d) => d.id === record.id);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    await writeJson(FILE, all);
    return record;
  });
}

export async function linkDebateToTrade(debateId: string, tradeId: string): Promise<boolean> {
  try {
    const updated = await rows<{ id: string }>(
      'UPDATE debate_records SET trade_id = $2 WHERE id = $1 RETURNING id',
      [debateId, tradeId],
    );
    if (updated !== null) return updated.length > 0;
  } catch (err) {
    if ((err as { code?: string }).code === FK_VIOLATION) {
      // Reported, not swallowed: the caller asked for a link and did not get one.
      console.error(
        `[debates] cannot link debate ${debateId} to trade ${tradeId}: no such trade.`,
      );
      return false;
    }
    throw err;
  }

  return serialize(FILE, async () => {
    const all = await readJson<DebateRecord[]>(FILE, []);
    const idx = all.findIndex((d) => d.id === debateId);
    if (idx < 0) return false;
    all[idx] = { ...all[idx], tradeId };
    await writeJson(FILE, all);
    return true;
  });
}

export async function updateDebateOutcomeByTradeId(
  tradeId: string,
  outcome: 'win' | 'loss',
  pnlUsd: number,
): Promise<boolean> {
  const updated = await rows<{ id: string }>(
    `UPDATE debate_records
        SET outcome = $2, outcome_pnl_usd = $3
      WHERE trade_id = $1
      RETURNING id`,
    [tradeId, outcome, pnlUsd],
  );
  if (updated !== null) return updated.length > 0;

  return serialize(FILE, async () => {
    const all = await readJson<DebateRecord[]>(FILE, []);
    let changed = false;
    for (let i = 0; i < all.length; i += 1) {
      if (all[i].tradeId === tradeId) {
        all[i] = { ...all[i], outcome, outcomePnlUsd: pnlUsd };
        changed = true;
      }
    }
    if (changed) await writeJson(FILE, all);
    return changed;
  });
}
