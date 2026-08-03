import { promises as fs } from 'fs';
import path from 'path';
import type { TunableParams } from './backtest/tunableStrategy';
import type { OptimizerObjective } from './backtest/optimizer';

// ---------------------------------------------------------------------
// Strategy Versioning (Production Readiness Review #7), scoped
// honestly: the live 9-agent Strategy Ensemble (lib/strategies/*.ts) is
// hardcoded with no parameters at all — there is nothing to "version"
// there without first bolting a config object onto working, tested
// agent code, which is out of scope here. The Backtest Optimizer's
// TunableParams (EMA lengths, RSI threshold, ATR multiplier, reward:
// risk ratio — lib/backtest/tunableStrategy.ts) is the one place in
// this app that genuinely has tunable, versionable parameters with real
// backtested performance attached. This store is an append-only record
// of every optimizer result a user chose to keep: win rate, drawdown,
// profit factor, and a deployment-date timestamp per version — never
// overwritten (no update/delete export below, only list + add).
// ---------------------------------------------------------------------

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

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'strategy-versions.json');

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '[]', 'utf8');
  }
}

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

async function readAll(): Promise<StrategyVersion[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as StrategyVersion[];
  } catch {
    return [];
  }
}

async function writeAll(records: StrategyVersion[]): Promise<void> {
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tmpFile, DATA_FILE);
}

export async function listStrategyVersions(symbol?: string): Promise<StrategyVersion[]> {
  const all = await readAll();
  const filtered = symbol ? all.filter((v) => v.symbol === symbol) : all;
  return filtered.sort((a, b) => b.ts - a.ts);
}

export type NewStrategyVersion = Omit<StrategyVersion, 'id' | 'ts'>;

export async function addStrategyVersion(input: NewStrategyVersion): Promise<StrategyVersion> {
  return serialize(async () => {
    const all = await readAll();
    const record: StrategyVersion = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ...input,
    };
    all.push(record); // append-only — no function in this file ever edits or removes a past version
    await writeAll(all);
    return record;
  });
}
