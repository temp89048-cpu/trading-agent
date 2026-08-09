import { promises as fs } from 'fs';
import path from 'path';

// Same persistence pattern as every other *.server.ts store in this app:
// a JSON file on local disk (./.data/autonomous-cycles.json). Genuinely
// persistent for local/self-hosted use, NOT persistent on Vercel or
// other ephemeral serverless filesystems.
//
// Append-only with a rolling cap: this records EVERY autonomous cycle
// including the ones that decided not to trade, which is the point — a
// no-trade decision with stated reasons is itself a decision worth
// journaling (spec Section 14's continuous-monitoring questions). But
// that also means it grows on a fixed interval forever, so unlike the
// other stores it trims to MAX_RECORDS rather than accumulating without
// bound.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'autonomous-cycles.json');
const MAX_RECORDS = 500;

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

async function readAll(): Promise<AutonomousCycleRecord[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as AutonomousCycleRecord[];
  } catch {
    return [];
  }
}

async function writeAll(records: AutonomousCycleRecord[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
}

export async function listAutonomousCycles(): Promise<AutonomousCycleRecord[]> {
  return readAll();
}

export async function appendAutonomousCycle(record: AutonomousCycleRecord): Promise<AutonomousCycleRecord> {
  return serialize(async () => {
    const all = await readAll();
    all.push(record);
    // Trim oldest-first, keeping the most recent MAX_RECORDS.
    const trimmed = all.length > MAX_RECORDS ? all.slice(all.length - MAX_RECORDS) : all;
    await writeAll(trimmed);
    return record;
  });
}
