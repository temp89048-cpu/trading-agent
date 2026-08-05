import { promises as fs } from 'fs';
import path from 'path';
import type { Mission } from './missionPlanner';

// Same persistence pattern as lib/memoryStore.server.ts and
// lib/tradeStore.server.ts: a JSON file on local disk. Genuinely
// persistent for local/self-hosted use, NOT persistent on Vercel or
// other ephemeral serverless filesystems.

const DATA_DIR = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, 'missions.json');

async function ensureFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.writeFile(DATA_FILE, '[]', 'utf8');
  }
}

// Lightweight in-process write queue — same pattern as memoryStore.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

async function readAll(): Promise<Mission[]> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  try {
    return JSON.parse(raw) as Mission[];
  } catch {
    return [];
  }
}

async function writeAll(missions: Mission[]): Promise<void> {
  await ensureFile();
  const tmpFile = DATA_FILE + '.tmp';
  await fs.writeFile(tmpFile, JSON.stringify(missions, null, 2), 'utf8');
  await fs.rename(tmpFile, DATA_FILE);
}

export async function getMissions(): Promise<Mission[]> {
  return readAll();
}

export async function saveMission(mission: Mission): Promise<Mission[]> {
  return serialize(async () => {
    const missions = await readAll();
    const idx = missions.findIndex((m) => m.id === mission.id);
    if (idx >= 0) {
      missions[idx] = mission;
    } else {
      missions.push(mission);
    }
    await writeAll(missions);
    return missions;
  });
}

export async function deleteMission(id: string): Promise<Mission[]> {
  return serialize(async () => {
    const missions = await readAll();
    const filtered = missions.filter((m) => m.id !== id);
    await writeAll(filtered);
    return filtered;
  });
}
