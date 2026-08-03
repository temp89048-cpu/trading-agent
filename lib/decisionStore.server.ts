import { promises as fs } from 'fs';
import path from 'path';
import type { DecisionRecord } from './types';

// Complete Audit Trail (Production Readiness Review #9) — same file-
// backed JSON pattern as lib/tradeStore.server.ts (atomic tmp+rename
// write, in-process write queue), just for a different record: every
// Supervisor decision, not just the ones that became a logged trade.
// Same ephemeral-filesystem caveat as tradeStore.server.ts applies here.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'decisions.json');

// A bare audit log with no retention cap grows forever. This app's
// scale (a single operator, a few trades/decisions a day at most) means
// a five-figure cap is effectively "never" in practice, while still
// bounding worst-case file size if something loops. Oldest are dropped
// first — the newest records are the ones actually useful day to day.
const MAX_RECORDS = 20_000;

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

async function readAll(): Promise<DecisionRecord[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as DecisionRecord[];
  } catch {
    return [];
  }
}

async function writeAll(records: DecisionRecord[]): Promise<void> {
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tmpFile, DATA_FILE);
}

export async function listDecisions(filter?: { symbol?: string; tab?: string; outcome?: string }): Promise<DecisionRecord[]> {
  const all = await readAll();
  const filtered = all.filter(
    (d) =>
      (!filter?.symbol || d.symbol === filter.symbol) &&
      (!filter?.tab || d.tab === filter.tab) &&
      (!filter?.outcome || d.outcome === filter.outcome),
  );
  return filtered.sort((a, b) => b.ts - a.ts);
}

export async function getDecision(id: string): Promise<DecisionRecord | null> {
  const all = await readAll();
  return all.find((d) => d.id === id) ?? null;
}

export type NewDecisionRecord = Omit<DecisionRecord, 'id' | 'ts'>;

export async function addDecision(input: NewDecisionRecord): Promise<DecisionRecord> {
  return serialize(async () => {
    const all = await readAll();
    const record: DecisionRecord = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ...input,
    };
    all.push(record);
    const trimmed = all.length > MAX_RECORDS ? all.slice(all.length - MAX_RECORDS) : all;
    await writeAll(trimmed);
    return record;
  });
}
