import { promises as fs } from 'fs';
import path from 'path';
import type { RiskPreference } from './memoryStats';

// Same persistence pattern and caveat as lib/tradeStore.server.ts: a JSON
// file on local disk (./.data/memory-prefs.json). Genuinely persistent
// for local/self-hosted use, NOT persistent on Vercel or other ephemeral
// serverless filesystems. Swap for a real datastore if this ever deploys
// there — the route calling this module doesn't need to change.
//
// This file only stores the one thing that can't be derived from the
// trade log: the user's *explicitly stated* risk preference. Everything
// else surfaced by "memory" (win rate, favorite assets, active hours,
// inferred risk appetite) is computed live from lib/tradeStore.server.ts's
// trade history in lib/memoryStats.ts — no duplicated/stale copy of it
// gets written here.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'memory-prefs.json');

type StoredPrefs = {
  riskPreference: RiskPreference | null;
  updatedAt: number | null;
};

const DEFAULT_PREFS: StoredPrefs = { riskPreference: null, updatedAt: null };

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify(DEFAULT_PREFS), 'utf8');
  }
}

// Same lightweight in-process write queue as tradeStore.server.ts — good
// enough for a personal-scale app, not a real concurrency-control layer.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

async function read(): Promise<StoredPrefs> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    return {
      riskPreference: parsed.riskPreference === 'conservative' || parsed.riskPreference === 'moderate' || parsed.riskPreference === 'aggressive' ? parsed.riskPreference : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function getStoredRiskPreference(): Promise<StoredPrefs> {
  return read();
}

export async function setStoredRiskPreference(pref: RiskPreference | null): Promise<StoredPrefs> {
  return serialize(async () => {
    const next: StoredPrefs = { riskPreference: pref, updatedAt: Date.now() };
    await fs.writeFile(DATA_FILE, JSON.stringify(next, null, 2), 'utf8');
    return next;
  });
}
