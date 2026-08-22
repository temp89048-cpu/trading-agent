// ---------------------------------------------------------------------
// Autonomous-cycle log. POSTGRES-FIRST, JSON file as fallback.
//
// `considered` is jsonb: the full ranked slate a cycle looked at, best-first, so a
// later reader can see not just what was chosen but what it was chosen OVER. That
// is the whole value of the record and it is an array of objects — a table of its
// own would need a join for every read of a log that is only ever read whole.
//
// `mission_id` REFERENCES `missions(id) ON DELETE SET NULL`. A cycle whose mission
// has been deleted keeps its record and loses the link, which is right: the cycle
// happened whether or not the mission still exists. A dangling id at write time is
// reported and dropped rather than failing the append — losing the log entry would
// remove the only account of what the autonomous loop did.
//
// APPEND-ONLY. There is no update path, because a cycle is a historical fact.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, toNumber, writeJson } from './jsonFallback.server';

export type AutonomousCycleOutcome = 'traded' | 'no-trade' | 'error';

export type AutonomousCycleRecord = {
  id: string;
  ts: number;
  outcome: AutonomousCycleOutcome;
  // The full ranked slate this cycle considered, best-first — so a later
  // reader can see not just what was chosen but what it was chosen over.
  considered: {
    symbol: string;
    side: 'buy' | 'sell';
    score: number;
    actionable: boolean;
    reasons: string[];
    blockers: string[];
  }[];
  // Set when outcome === 'traded'.
  actedSymbol: string | null;
  actedSide: 'buy' | 'sell' | null;
  actedMarginUsd: number | null;
  actedLeverage: number | null;
  agentTaskId: string | null;
  // Why this cycle ended the way it did — always populated, including
  // for no-trade cycles ("nothing cleared the floor", "already at max
  // concurrent positions", "trading paused", etc).
  decisionSummary: string;
  missionId: string | null;
  missionProgressPct: number | null;
};

const FILE = 'autonomous-cycles.json';

const COLUMNS = `id, ts, outcome, considered, acted_symbol, acted_side,
                 acted_margin_usd, acted_leverage, agent_task_id,
                 decision_summary, mission_id, mission_progress_pct`;

type Row = {
  id: string;
  ts: Date | string;
  outcome: string;
  considered: unknown;
  acted_symbol: string | null;
  acted_side: string | null;
  acted_margin_usd: string | number | null;
  acted_leverage: string | number | null;
  agent_task_id: string | null;
  decision_summary: string;
  mission_id: string | null;
  mission_progress_pct: string | number | null;
};

function fromRow(r: Row): AutonomousCycleRecord {
  return {
    id: r.id,
    ts: toMillis(r.ts) ?? 0,
    outcome: r.outcome as AutonomousCycleOutcome,
    considered: (r.considered ?? []) as AutonomousCycleRecord['considered'],
    actedSymbol: r.acted_symbol,
    actedSide: r.acted_side as AutonomousCycleRecord['actedSide'],
    // null, not 0: a no-trade cycle did not stake zero dollars at zero leverage,
    // it staked nothing at all, and averaging a 0 in would understate real sizing.
    actedMarginUsd: toNumber(r.acted_margin_usd),
    actedLeverage: toNumber(r.acted_leverage),
    agentTaskId: r.agent_task_id,
    decisionSummary: r.decision_summary,
    missionId: r.mission_id,
    missionProgressPct: toNumber(r.mission_progress_pct),
  };
}

const FK_VIOLATION = '23503';

export async function listAutonomousCycles(): Promise<AutonomousCycleRecord[]> {
  const found = await rows<Row>(`SELECT ${COLUMNS} FROM autonomous_cycles ORDER BY ts DESC`);
  if (found) return found.map(fromRow);
  return readJson<AutonomousCycleRecord[]>(FILE, []);
}

export async function appendAutonomousCycle(
  record: AutonomousCycleRecord,
): Promise<AutonomousCycleRecord> {
  const SQL = `INSERT INTO autonomous_cycles (${COLUMNS})
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (id) DO NOTHING
     RETURNING ${COLUMNS}`;

  const params = (missionId: string | null) => [
    record.id,
    record.ts,
    record.outcome,
    JSON.stringify(record.considered ?? []),
    record.actedSymbol,
    record.actedSide,
    record.actedMarginUsd,
    record.actedLeverage,
    record.agentTaskId,
    record.decisionSummary,
    missionId,
    record.missionProgressPct,
  ];

  try {
    const saved = await one<Row>(SQL, params(record.missionId ?? null));
    // `undefined` here means ON CONFLICT DO NOTHING fired: the id already exists,
    // so the append is a no-op and the caller's record is the truth.
    if (saved) return fromRow(saved);
    if (saved === undefined) return record;
  } catch (err) {
    if ((err as { code?: string }).code === FK_VIOLATION && record.missionId) {
      console.warn(
        `[cycles] mission_id ${record.missionId} does not exist; storing the cycle unlinked.`,
      );
      const saved = await one<Row>(SQL, params(null));
      if (saved) return fromRow(saved);
      if (saved === undefined) return record;
    } else {
      throw err;
    }
  }

  return serialize(FILE, async () => {
    const all = await readJson<AutonomousCycleRecord[]>(FILE, []);
    all.push(record);
    await writeJson(FILE, all);
    return record;
  });
}
