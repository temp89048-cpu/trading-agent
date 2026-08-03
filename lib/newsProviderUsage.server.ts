import { promises as fs } from 'fs';
import path from 'path';

// Same persistence pattern and same caveat as lib/tradeStore.server.ts:
// genuinely persistent on local/self-hosted disk, NOT persistent on
// Vercel or other ephemeral-filesystem serverless platforms. If this
// ever moves there, swap this file's internals for a real datastore —
// callers don't need to change.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'news-usage.json');

type UsageFile = { date: string; counts: Record<string, number> };

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, JSON.stringify({ date: todayUtc(), counts: {} }), 'utf8');
  }
}

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

async function readUsage(): Promise<UsageFile> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw) as UsageFile;
    // Free-tier limits are daily — if the stored date isn't today (UTC),
    // every provider's count resets, same as the real limits would.
    if (parsed.date !== todayUtc()) return { date: todayUtc(), counts: {} };
    return parsed;
  } catch {
    return { date: todayUtc(), counts: {} };
  }
}

async function writeUsage(usage: UsageFile): Promise<void> {
  await fs.writeFile(DATA_FILE, JSON.stringify(usage, null, 2), 'utf8');
}

export async function getUsageToday(): Promise<Record<string, number>> {
  const usage = await readUsage();
  return usage.counts;
}

export async function incrementUsage(providerId: string): Promise<void> {
  return serialize(async () => {
    const usage = await readUsage();
    usage.counts[providerId] = (usage.counts[providerId] ?? 0) + 1;
    await writeUsage(usage);
  });
}
