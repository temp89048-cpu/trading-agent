// ---------------------------------------------------------------------
// Optimizer output history. POSTGRES-FIRST, JSON file as fallback.
//
// `params`, `train_metrics` and `test_metrics` are jsonb — `TunableParams` is
// whatever the optimizer's search space currently is, and pinning it to columns
// would mean a schema change every time a strategy gains a knob.
//
// `test_metrics` IS THE HONEST NUMBER. It is out-of-sample; `train_metrics` is
// what the parameters were fitted on and will always look better. Both are stored
// and both are nullable, because a run that did not hold out a test fold has no
// out-of-sample result — which is not the same as one that scored zero.
//
// RECORDING A VERSION HERE DEPLOYS NOTHING. This is a log of optimizer runs. A
// parameter set reaching production requires an explicit human change on the Risk
// page; nothing in this module writes strategy selection or risk config.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, toNumber, writeJson } from './jsonFallback.server';
import type { OptimizerObjective } from './backtest/optimizer';
import type { TunableParams } from './backtest/tunableStrategy';

// The ORIGINAL shape, recovered from git rather than re-guessed. An earlier draft
// of this file invented `sharpeApprox`/`expectancyUsd`/`trades`, which typechecked
// against nothing and broke OptimizerPanel — the metrics object is stored as jsonb
// and passed straight through, so a wrong type here is not caught by the database.
export type StrategyVersionMetrics = {
  tradeCount: number;
  winRate: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number;
  totalReturnPct: number;
};

export type StrategyVersion = {
  id: string;
  ts: number; // deployment date = when this version was recorded
  symbol: string;
  assetType: 'crypto' | 'equity';
  interval: string;
  objective: OptimizerObjective;
  algorithm: string;
  params: TunableParams;
  trainMetrics: StrategyVersionMetrics | null;
  testMetrics: StrategyVersionMetrics | null; // out-of-sample — the honest number to trust over trainMetrics
  stabilityScore: number | null;
  note?: string;
};

const FILE = 'strategy-versions.json';

const COLUMNS = `id, ts, symbol, asset_type, interval, objective, algorithm,
                 params, train_metrics, test_metrics, stability_score, note`;

type Row = {
  id: string;
  ts: Date | string;
  symbol: string;
  asset_type: string;
  interval: string;
  objective: string;
  algorithm: string;
  params: unknown;
  train_metrics: unknown;
  test_metrics: unknown;
  stability_score: string | number | null;
  note: string | null;
};

function fromRow(r: Row): StrategyVersion {
  return {
    id: r.id,
    ts: toMillis(r.ts) ?? 0,
    symbol: r.symbol,
    assetType: r.asset_type as StrategyVersion['assetType'],
    interval: r.interval,
    objective: r.objective as OptimizerObjective,
    algorithm: r.algorithm,
    params: (r.params ?? {}) as TunableParams,
    trainMetrics: (r.train_metrics ?? null) as StrategyVersionMetrics | null,
    testMetrics: (r.test_metrics ?? null) as StrategyVersionMetrics | null,
    // null, not 0. A stability score of 0 means "held up on none of the folds",
    // which is a damning result; an absent one means it was never measured.
    stabilityScore: toNumber(r.stability_score),
    ...(r.note === null ? {} : { note: r.note }),
  };
}

export async function listStrategyVersions(symbol?: string): Promise<StrategyVersion[]> {
  const found = await rows<Row>(
    `SELECT ${COLUMNS} FROM strategy_versions
      WHERE ($1::text IS NULL OR symbol = $1)
      ORDER BY ts DESC`,
    [symbol ?? null],
  );
  if (found) return found.map(fromRow);

  const all = await readJson<StrategyVersion[]>(FILE, []);
  const filtered = symbol ? all.filter((v) => v.symbol === symbol) : all;
  return [...filtered].sort((a, b) => b.ts - a.ts);
}

export type NewStrategyVersion = Omit<StrategyVersion, 'id' | 'ts'>;

export async function addStrategyVersion(input: NewStrategyVersion): Promise<StrategyVersion> {
  const record: StrategyVersion = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    ...input,
  };

  const saved = await one<Row>(
    `INSERT INTO strategy_versions (${COLUMNS})
     VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5, $6, $7,
             $8::jsonb, $9::jsonb, $10::jsonb, $11, $12)
     RETURNING ${COLUMNS}`,
    [
      record.id,
      record.ts,
      record.symbol,
      record.assetType,
      record.interval,
      record.objective,
      record.algorithm,
      JSON.stringify(record.params ?? {}),
      record.trainMetrics === null ? null : JSON.stringify(record.trainMetrics),
      record.testMetrics === null ? null : JSON.stringify(record.testMetrics),
      record.stabilityScore,
      record.note ?? null,
    ],
  );
  if (saved) return fromRow(saved);

  return serialize(FILE, async () => {
    const all = await readJson<StrategyVersion[]>(FILE, []);
    all.push(record);
    await writeJson(FILE, all);
    return record;
  });
}
