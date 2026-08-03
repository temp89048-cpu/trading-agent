import { promises as fs } from 'fs';
import path from 'path';
import type { TradeLogEntry, TradeTab, TradeSide } from './types';

// IMPORTANT — read this before assuming this scales to production:
// This stores trades in a JSON file on local disk (./.data/trades.json).
// That's genuinely persistent for local use and any self-hosted server
// with a normal filesystem. It is NOT persistent on Vercel or most
// serverless platforms — their filesystems are ephemeral per invocation,
// so writes can vanish the moment a new instance spins up. If this ever
// gets deployed there, swap this file for a real datastore (Vercel KV,
// Postgres, etc.) — the GET/POST/DELETE routes that call this module
// don't need to change, only this file's internals.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'trades.json');

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '[]', 'utf8');
  }
}

// Simple in-process write queue — good enough for a personal-scale app
// hit by a handful of clients, not a real concurrency-control mechanism.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

async function readAll(): Promise<TradeLogEntry[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as TradeLogEntry[];
  } catch {
    return [];
  }
}

async function writeAll(entries: TradeLogEntry[]): Promise<void> {
  // Write to a temp file and rename over the real one rather than
  // fs.writeFile(DATA_FILE, ...) directly. A direct write truncates the
  // file before the new content lands, so a GET arriving concurrently
  // (listTrades/getTrade call readAll() directly, not through the
  // `serialize` queue below) could read a half-written file, fail
  // JSON.parse, and silently get back `[]` instead of the real trade
  // list. rename() is atomic — a reader always sees either the complete
  // old file or the complete new one, never a partial write.
  const tmpFile = `${DATA_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpFile, JSON.stringify(entries, null, 2), 'utf8');
  await fs.rename(tmpFile, DATA_FILE);
}

export async function listTrades(tab?: TradeTab): Promise<TradeLogEntry[]> {
  const all = await readAll();
  const filtered = tab ? all.filter((t) => t.tab === tab) : all;
  return filtered.sort((a, b) => b.ts - a.ts);
}

export async function getTrade(id: string): Promise<TradeLogEntry | null> {
  const all = await readAll();
  return all.find((t) => t.id === id) ?? null;
}

export type NewTrade = {
  tab: TradeTab;
  symbol: string;
  side: TradeSide;
  qty: number;
  price: number;
  note?: string;
  pnl?: number;
  entryContext?: string;
  debateId?: string;
  originTag?: TradeLogEntry['originTag'];
  exchangeOrderId?: string;
};

export async function addTrade(input: NewTrade): Promise<TradeLogEntry> {
  return serialize(async () => {
    const all = await readAll();
    const entry: TradeLogEntry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      ...input,
    };
    all.push(entry);
    await writeAll(all);
    return entry;
  });
}

export async function deleteTrade(id: string): Promise<boolean> {
  return serialize(async () => {
    const all = await readAll();
    const next = all.filter((t) => t.id !== id);
    const removed = next.length !== all.length;
    if (removed) await writeAll(next);
    return removed;
  });
}
