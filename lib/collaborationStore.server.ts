import { promises as fs } from 'fs';
import path from 'path';
import type { CollaborationOpinion } from './collaborationAgent';

// Same persistence pattern as every other *.server.ts store in this
// app: a JSON file on local disk (./.data/collaboration.json). Append-
// only, same rationale as lib/decisionStore.server.ts — a record of
// every second-opinion request/response actually made, not something
// later edits should be allowed to rewrite.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'collaboration.json');

export type CollaborationRecord = {
  id: string;
  ts: number;
  symbol: string;
  side: 'buy' | 'sell';
  ownConfidencePct: number;
  triggerReason: string; // why the second opinion was requested
  provider: string; // second-opinion Provider.id, for the audit record
  model: string;
  opinion: CollaborationOpinion | null; // null = request failed or response didn't parse
  error: string | null;
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

async function readAll(): Promise<CollaborationRecord[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as CollaborationRecord[];
  } catch {
    return [];
  }
}

async function writeAll(records: CollaborationRecord[]): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(records, null, 2), 'utf8');
}

export async function listCollaborationRecords(): Promise<CollaborationRecord[]> {
  return readAll();
}

export async function appendCollaborationRecord(record: CollaborationRecord): Promise<CollaborationRecord> {
  return serialize(async () => {
    const all = await readAll();
    all.push(record);
    await writeAll(all);
    return record;
  });
}
