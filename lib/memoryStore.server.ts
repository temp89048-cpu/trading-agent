// ---------------------------------------------------------------------
// The one stated risk preference. POSTGRES-FIRST, JSON file as fallback.
//
// This store holds the ONE thing that cannot be derived from the trade log: the
// user's *explicitly stated* risk preference. Everything else "memory" surfaces —
// win rate, favourite assets, active hours, inferred risk appetite — is computed
// live from the trade history in `lib/memoryStats.ts`. No duplicated or stale copy
// of any of it is written here, and none should be added: a second copy of a
// derived figure is a second answer that can disagree with the first.
//
// A SINGLE ROW, `id = 'default'`, seeded by `db/schema.sql`. `risk_preference` is
// CHECK-constrained to the three values, so a typo fails at write time rather than
// being stored and silently ignored by every reader.
//
// `null` means NOT STATED, and that is different from 'moderate'. The prompt layer
// treats an unstated preference as "do not claim to know the user's risk appetite";
// defaulting it to moderate would put words in their mouth.
// ---------------------------------------------------------------------

import { one } from './db.server';
import { readJson, serialize, toMillis, writeJson } from './jsonFallback.server';
import type { RiskPreference } from './memoryStats';

const FILE = 'memory-prefs.json';

type StoredPrefs = {
  riskPreference: RiskPreference | null;
  updatedAt: number | null;
};

const DEFAULT_PREFS: StoredPrefs = { riskPreference: null, updatedAt: null };

function isRiskPreference(value: unknown): value is RiskPreference {
  return value === 'conservative' || value === 'moderate' || value === 'aggressive';
}

export async function getStoredRiskPreference(): Promise<StoredPrefs> {
  const row = await one<{ risk_preference: string | null; updated_at: Date | string | null }>(
    "SELECT risk_preference, updated_at FROM memory_prefs WHERE id = 'default'",
  );

  if (row !== null) {
    // `undefined` = the table exists but the seed row is absent. Report "not
    // stated" rather than throwing: an unseeded row is the same information as an
    // unset preference.
    if (!row) return { ...DEFAULT_PREFS };
    return {
      riskPreference: isRiskPreference(row.risk_preference) ? row.risk_preference : null,
      updatedAt: toMillis(row.updated_at),
    };
  }

  const parsed = await readJson<Partial<StoredPrefs>>(FILE, DEFAULT_PREFS);
  return {
    riskPreference: isRiskPreference(parsed.riskPreference) ? parsed.riskPreference : null,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
  };
}

export async function setStoredRiskPreference(pref: RiskPreference | null): Promise<StoredPrefs> {
  const saved = await one<{ risk_preference: string | null; updated_at: Date | string | null }>(
    `INSERT INTO memory_prefs (id, risk_preference, updated_at)
     VALUES ('default', $1, now())
     ON CONFLICT (id) DO UPDATE SET
       -- Overwrite unconditionally, including with NULL: clearing the preference
       -- is a real action the user can take, and a COALESCE here would make
       -- "I'd rather not say" impossible to express once anything was set.
       risk_preference = EXCLUDED.risk_preference,
       updated_at = EXCLUDED.updated_at
     RETURNING risk_preference, updated_at`,
    [pref],
  );

  if (saved) {
    return {
      riskPreference: isRiskPreference(saved.risk_preference) ? saved.risk_preference : null,
      updatedAt: toMillis(saved.updated_at),
    };
  }

  return serialize(FILE, async () => {
    const next: StoredPrefs = { riskPreference: pref, updatedAt: Date.now() };
    await writeJson(FILE, next);
    return next;
  });
}
