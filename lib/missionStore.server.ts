// ---------------------------------------------------------------------
// Missions. POSTGRES-FIRST, JSON file as fallback.
//
// `target`, `progress`, `constraints` and `checkpoints` are stored as `jsonb`
// rather than exploded into columns. They are versioned, discriminated-union
// shapes owned by `lib/missionPlanner.ts` — a `capital-target` target has
// different fields from a `growth` one — and flattening them would mean a schema
// migration every time a mission type gains a field. The one field that IS a
// column is `baseline_equity_usd`, because it is a plain number every mission has
// and it is the anchor progress is measured from.
//
// `checkpoints` is capped by the caller at 100 entries (see
// `components/MissionPlanner.tsx`). Worth knowing before someone stores a
// per-tick history in it: a jsonb column rewrites the whole document on every
// update, so an unbounded array turns each evaluation into a progressively larger
// write.
// ---------------------------------------------------------------------

import { one, rows } from './db.server';
import { readJson, serialize, toMillis, toNumber, writeJson } from './jsonFallback.server';
import type { Mission } from './missionPlanner';

const FILE = 'missions.json';

const COLUMNS = `id, type, name, description, status, created_at, updated_at,
                 expires_at, target, progress, constraints, checkpoints,
                 baseline_equity_usd`;

type Row = {
  id: string;
  type: string;
  name: string;
  description: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string | null;
  target: unknown;
  progress: unknown;
  constraints: unknown;
  checkpoints: unknown;
  baseline_equity_usd: string | number | null;
};

function fromRow(r: Row): Mission {
  const baseline = toNumber(r.baseline_equity_usd);
  return {
    id: r.id,
    type: r.type as Mission['type'],
    name: r.name,
    description: r.description,
    status: r.status as Mission['status'],
    createdAt: toMillis(r.created_at) ?? 0,
    updatedAt: toMillis(r.updated_at) ?? 0,
    expiresAt: toMillis(r.expires_at),
    target: r.target as Mission['target'],
    progress: r.progress as Mission['progress'],
    constraints: (r.constraints ?? []) as Mission['constraints'],
    checkpoints: (r.checkpoints ?? []) as Mission['checkpoints'],
    // ABSENT, not 0, when unset. `evaluateMission` treats a missing baseline as
    // "fall back to the observed context equity"; a 0 would make it measure
    // progress from an account that held nothing, which is how a capital-target
    // mission came to report 100% at creation in the first place.
    ...(baseline === null ? {} : { baselineEquityUsd: baseline }),
  };
}

export async function getMissions(): Promise<Mission[]> {
  const found = await rows<Row>(`SELECT ${COLUMNS} FROM missions ORDER BY created_at ASC`);
  if (found) return found.map(fromRow);
  return readJson<Mission[]>(FILE, []);
}

export async function saveMission(mission: Mission): Promise<Mission[]> {
  const upserted = await one<{ id: string }>(
    `INSERT INTO missions (id, type, name, description, status, created_at, updated_at,
                           expires_at, target, progress, constraints, checkpoints,
                           baseline_equity_usd)
     VALUES ($1, $2, $3, $4, $5,
             to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0),
             CASE WHEN $8::bigint IS NULL THEN NULL ELSE to_timestamp($8 / 1000.0) END,
             $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13)
     ON CONFLICT (id) DO UPDATE SET
       type = EXCLUDED.type,
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at,
       expires_at = EXCLUDED.expires_at,
       target = EXCLUDED.target,
       progress = EXCLUDED.progress,
       constraints = EXCLUDED.constraints,
       checkpoints = EXCLUDED.checkpoints,
       -- COALESCE so a PATCH that omits the baseline cannot erase it. The
       -- provider's status writes send a partial mission, and losing the anchor
       -- would silently re-measure progress from wherever equity happens to be.
       baseline_equity_usd = COALESCE(EXCLUDED.baseline_equity_usd, missions.baseline_equity_usd)
     RETURNING id`,
    [
      mission.id,
      mission.type,
      mission.name,
      mission.description,
      mission.status,
      mission.createdAt,
      mission.updatedAt,
      mission.expiresAt,
      JSON.stringify(mission.target),
      JSON.stringify(mission.progress),
      JSON.stringify(mission.constraints ?? []),
      JSON.stringify(mission.checkpoints ?? []),
      mission.baselineEquityUsd ?? null,
    ],
  );

  if (upserted !== null) return getMissions();

  return serialize(FILE, async () => {
    const all = await readJson<Mission[]>(FILE, []);
    const idx = all.findIndex((m) => m.id === mission.id);
    if (idx >= 0) all[idx] = mission;
    else all.push(mission);
    await writeJson(FILE, all);
    return all;
  });
}

export async function deleteMission(id: string): Promise<Mission[]> {
  const deleted = await rows<{ id: string }>('DELETE FROM missions WHERE id = $1 RETURNING id', [id]);
  if (deleted) return getMissions();

  return serialize(FILE, async () => {
    const all = await readJson<Mission[]>(FILE, []);
    const filtered = all.filter((m) => m.id !== id);
    await writeJson(FILE, filtered);
    return filtered;
  });
}
