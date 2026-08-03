import { promises as fs } from 'fs';
import path from 'path';
import type { DebateRecord } from './debate/types';

// Same persistence pattern and caveat as every other .data/-backed store
// in this app (tradeStore, memoryStore, reflectionStore): a JSON file on
// local disk, genuinely persistent for local/self-hosted use, NOT
// persistent on Vercel or other ephemeral serverless filesystems.
//
// A DebateRecord starts with outcome/tradeId both null (a prediction,
// not yet a result). It only becomes useful for calibration/reputation
// once linked to a trade that has since closed — see
// components/Debate.tsx for the linkage, which watches tradeLog for a
// close matching this record's tradeId and calls updateOutcome().

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'debate-records.json');

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

async function readAll(): Promise<DebateRecord[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as DebateRecord[];
  } catch {
    return [];
  }
}

async function writeAll(records: DebateRecord[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
}

// Soft cap so this file doesn't grow forever on an active account —
// keeps the most recent N records, which is also all calibration and
// reputation need (recent behavior matters more than ancient history
// for both).
const MAX_RECORDS = 2000;

export async function listDebateRecords(symbol?: string): Promise<DebateRecord[]> {
  const all = await readAll();
  return symbol ? all.filter((r) => r.symbol === symbol) : all;
}

export async function saveDebateRecord(record: DebateRecord): Promise<DebateRecord> {
  return serialize(async () => {
    const all = await readAll();
    all.push(record);
    const trimmed = all.length > MAX_RECORDS ? all.slice(all.length - MAX_RECORDS) : all;
    await writeAll(trimmed);
    return record;
  });
}

export async function linkDebateToTrade(debateId: string, tradeId: string): Promise<DebateRecord | null> {
  return serialize(async () => {
    const all = await readAll();
    const idx = all.findIndex((r) => r.id === debateId);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], tradeId };
    await writeAll(all);
    return all[idx];
  });
}

export async function updateDebateOutcomeByTradeId(tradeId: string, outcome: 'win' | 'loss', pnlUsd: number): Promise<DebateRecord | null> {
  return serialize(async () => {
    const all = await readAll();
    const idx = all.findIndex((r) => r.tradeId === tradeId);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], outcome, outcomePnlUsd: pnlUsd };
    await writeAll(all);
    return all[idx];
  });
}
