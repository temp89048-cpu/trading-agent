// ---------------------------------------------------------------------
// The decision audit trail. POSTGRES-FIRST, JSON file as fallback.
//
// SHARES THE `decisions` TABLE WITH THE PYTHON SUPERVISOR, which has ~11,000 rows
// in it. That is the point of the migration: `/decisions` used to read a JSON file
// with a handful of browser-side records while the agent's refusals — the majority
// of all decisions, and the ones that answer "why didn't it act on that setup?" —
// were in Postgres and invisible to the page.
//
// `origin_tag` separates the two writers. This module writes browser-originated
// decisions; the agent writes 'agent-plan' and friends from Python.
//
// TWO CONSTRAINTS THAT BITE
//
//  1. `outcome` is CHECK-constrained to six literals. `db/schema.sql` is the
//     authority and `tests/test_decision_audit.py` asserts every value the code
//     writes is one the schema accepts — because the supervisor once wrote
//     "declined", which the constraint rejected, so EVERY refusal was silently
//     dropped from the audit trail while the code logged success.
//  2. `trade_log_entry_id` REFERENCES `trades(id) ON DELETE SET NULL`. A decision
//     linked to a trade that does not exist cannot be inserted, so the link is
//     dropped (with a warning) rather than failing the whole write — losing the
//     audit record entirely would be worse than losing its link to a trade.
//
// NO RETENTION CAP HERE. The JSON version trimmed to 20,000 rows because a file
// rewrite is O(n). A table is not, and truncating an audit trail to bound a file
// size was a storage workaround, not a policy. If a cap is ever wanted it should
// be a deliberate retention decision with a documented reason.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, toNumber, writeJson } from './jsonFallback.server';
import type { DecisionRecord } from './types';

const FILE = 'decisions.json';

// Kept for the JSON fallback only — see the header on why the table has no cap.
const MAX_RECORDS = 20_000;

const COLUMNS = `id, ts, symbol, side, tab, origin_tag, requested_qty, requested_price,
                 outcome, urgency, rejection_reasons, conflict_notes, caution_notes,
                 risk_checks, stop_loss, take_profit, recommended_qty,
                 ensemble_consensus, ensemble_confidence_pct,
                 debate_recommendation, debate_confidence_pct, rationale,
                 trade_log_entry_id`;

type Row = {
  id: string;
  ts: Date | string;
  symbol: string;
  side: string;
  tab: string;
  origin_tag: string;
  requested_qty: string | number;
  requested_price: string | number;
  outcome: string;
  urgency: string;
  rejection_reasons: unknown;
  conflict_notes: unknown;
  caution_notes: unknown;
  risk_checks: unknown;
  stop_loss: string | number | null;
  take_profit: string | number | null;
  recommended_qty: string | number | null;
  ensemble_consensus: string | null;
  ensemble_confidence_pct: string | number | null;
  debate_recommendation: string | null;
  debate_confidence_pct: string | number | null;
  rationale: string | null;
  trade_log_entry_id: string | null;
};

/** jsonb arrays come back parsed, but a legacy row could hold a scalar. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  return [];
}

function fromRow(r: Row): DecisionRecord {
  return {
    id: r.id,
    ts: toMillis(r.ts) ?? 0,
    symbol: r.symbol,
    side: r.side as DecisionRecord['side'],
    tab: r.tab as DecisionRecord['tab'],
    originTag: r.origin_tag as DecisionRecord['originTag'],
    requestedQty: toNumber(r.requested_qty) ?? 0,
    requestedPrice: toNumber(r.requested_price) ?? 0,
    outcome: r.outcome as DecisionRecord['outcome'],
    urgency: r.urgency,
    rejectionReasons: asStringArray(r.rejection_reasons),
    conflictNotes: asStringArray(r.conflict_notes),
    cautionNotes: asStringArray(r.caution_notes),
    riskChecks: (r.risk_checks ?? null) as DecisionRecord['riskChecks'],
    // These stay null rather than 0. A decision with no stop is not a decision
    // with a stop at zero — `riskCheckSummary` and the /risk page both branch on
    // null to say "not evaluated" instead of showing a number that looks real.
    stopLoss: toNumber(r.stop_loss),
    takeProfit: toNumber(r.take_profit),
    recommendedQty: toNumber(r.recommended_qty),
    ensembleConsensus: r.ensemble_consensus,
    ensembleConfidencePct: toNumber(r.ensemble_confidence_pct),
    debateRecommendation: r.debate_recommendation,
    debateConfidencePct: toNumber(r.debate_confidence_pct),
    ...(r.rationale === null ? {} : { rationale: r.rationale }),
    ...(r.trade_log_entry_id === null ? {} : { tradeLogEntryId: r.trade_log_entry_id }),
  };
}

export async function listDecisions(filter?: {
  symbol?: string;
  tab?: string;
  outcome?: string;
}): Promise<DecisionRecord[]> {
  const found = await rows<Row>(
    `SELECT ${COLUMNS} FROM decisions
      WHERE ($1::text IS NULL OR symbol = $1)
        AND ($2::text IS NULL OR tab = $2)
        AND ($3::text IS NULL OR outcome = $3)
      ORDER BY ts DESC`,
    [filter?.symbol ?? null, filter?.tab ?? null, filter?.outcome ?? null],
  );
  if (found) return found.map(fromRow);

  const all = await readJson<DecisionRecord[]>(FILE, []);
  return all
    .filter(
      (d) =>
        (!filter?.symbol || d.symbol === filter.symbol) &&
        (!filter?.tab || d.tab === filter.tab) &&
        (!filter?.outcome || d.outcome === filter.outcome),
    )
    .sort((a, b) => b.ts - a.ts);
}

export async function getDecision(id: string): Promise<DecisionRecord | null> {
  const row = await one<Row>(`SELECT ${COLUMNS} FROM decisions WHERE id = $1`, [id]);
  if (row === null) {
    const all = await readJson<DecisionRecord[]>(FILE, []);
    return all.find((d) => d.id === id) ?? null;
  }
  return row ? fromRow(row) : null;
}

export type NewDecisionRecord = Omit<DecisionRecord, 'id' | 'ts'>;

const FK_VIOLATION = '23503';

export async function addDecision(input: NewDecisionRecord): Promise<DecisionRecord> {
  const record: DecisionRecord = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    ...input,
  };

  const params = (tradeLink: string | null) => [
    record.id,
    record.ts,
    record.symbol,
    record.side,
    record.tab,
    record.originTag,
    record.requestedQty,
    record.requestedPrice,
    record.outcome,
    record.urgency,
    JSON.stringify(record.rejectionReasons ?? []),
    JSON.stringify(record.conflictNotes ?? []),
    JSON.stringify(record.cautionNotes ?? []),
    record.riskChecks === null || record.riskChecks === undefined
      ? null
      : JSON.stringify(record.riskChecks),
    record.stopLoss,
    record.takeProfit,
    record.recommendedQty,
    record.ensembleConsensus,
    record.ensembleConfidencePct,
    record.debateRecommendation,
    record.debateConfidencePct,
    record.rationale ?? null,
    tradeLink,
  ];

  const SQL = `INSERT INTO decisions (${COLUMNS})
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7, $8, $9, $10,
             $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb,
             $15, $16, $17, $18, $19, $20, $21, $22, $23)
     RETURNING ${COLUMNS}`;

  try {
    const saved = await one<Row>(SQL, params(record.tradeLogEntryId ?? null));
    if (saved) return fromRow(saved);
  } catch (err) {
    if ((err as { code?: string }).code === FK_VIOLATION && record.tradeLogEntryId) {
      // Retry WITHOUT the link. The audit record is the valuable part; a decision
      // that vanishes because its trade link dangles is a hole in the trail, and
      // holes in this trail are exactly what the schema CHECK incident created.
      console.warn(
        `[decisions] trade_log_entry_id ${record.tradeLogEntryId} does not exist; ` +
          'storing the decision without the link rather than dropping the record.',
      );
      const saved = await one<Row>(SQL, params(null));
      if (saved) return fromRow(saved);
    } else {
      throw err;
    }
  }

  return serialize(FILE, async () => {
    const all = await readJson<DecisionRecord[]>(FILE, []);
    all.push(record);
    const trimmed = all.length > MAX_RECORDS ? all.slice(all.length - MAX_RECORDS) : all;
    await writeJson(FILE, trimmed);
    return record;
  });
}
