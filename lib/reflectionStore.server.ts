import { promises as fs } from 'fs';
import path from 'path';
import type { ReflectionSections } from './reflectionAgent';

// Same persistence pattern and caveat as lib/tradeStore.server.ts and
// lib/memoryStore.server.ts: a JSON file on local disk
// (./.data/reflections.json). Genuinely persistent for local/self-hosted
// use, NOT persistent on Vercel or other ephemeral serverless
// filesystems.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'reflections.json');

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

async function readAll(): Promise<ReflectionRecord[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as ReflectionRecord[];
  } catch {
    return [];
  }
}

async function writeAll(records: ReflectionRecord[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
}

export async function listReflections(): Promise<ReflectionRecord[]> {
  return readAll();
}

export async function getReflection(tradeId: string): Promise<ReflectionRecord | null> {
  const all = await readAll();
  return all.find((r) => r.tradeId === tradeId) ?? null;
}

// Upsert by tradeId — a manual "regenerate" replaces the prior record
// for that trade rather than accumulating duplicates.
export async function saveReflection(record: ReflectionRecord): Promise<ReflectionRecord> {
  return serialize(async () => {
    const all = await readAll();
    const idx = all.findIndex((r) => r.tradeId === record.tradeId);
    if (idx >= 0) all[idx] = record;
    else all.push(record);
    await writeAll(all);
    return record;
  });
}
