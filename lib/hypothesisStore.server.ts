import { promises as fs } from 'fs';
import path from 'path';

// Same persistence pattern and caveat as lib/reflectionStore.server.ts:
// a JSON file on local disk (./.data/hypotheses.json). Genuinely
// persistent for local/self-hosted use, NOT persistent on Vercel or
// other ephemeral serverless filesystems.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'hypotheses.json');

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

async function readAll(): Promise<HypothesisRecord[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as HypothesisRecord[];
  } catch {
    return [];
  }
}

async function writeAll(records: HypothesisRecord[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
}

export async function listHypotheses(): Promise<HypothesisRecord[]> {
  return readAll();
}

export async function getHypothesisByTradeId(tradeId: string): Promise<HypothesisRecord | null> {
  const all = await readAll();
  return all.find((h) => h.tradeId === tradeId) ?? null;
}

// Upsert by tradeId, same convention as saveReflection — a trade only
// ever has one active hypothesis at a time in this simple model.
export async function saveHypothesis(record: HypothesisRecord): Promise<HypothesisRecord> {
  return serialize(async () => {
    const all = await readAll();
    const idx = all.findIndex((h) => h.tradeId === record.tradeId);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    await writeAll(all);
    return record;
  });
}

export async function updateHypothesisStatus(id: string, status: HypothesisStatus, reviewNote: string | null): Promise<HypothesisRecord | null> {
  return serialize(async () => {
    const all = await readAll();
    const idx = all.findIndex((h) => h.id === id);
    if (idx < 0) return null;
    all[idx] = { ...all[idx], status, reviewNote, updatedAt: Date.now() };
    await writeAll(all);
    return all[idx];
  });
}
