// ---------------------------------------------------------------------
// News-provider call counts. POSTGRES-FIRST, JSON file as fallback.
//
// A single row (`id = 'default'`) holding today's UTC date and a `counts` object.
// It exists to respect free-tier daily limits, so the DATE RESET is the whole
// behaviour: when the stored date is not today, every count is zero again — the
// same way the real limits reset.
//
// THE RESET IS DONE IN SQL, not by reading, comparing and writing back. A
// read-modify-write across two round trips can lose an increment when two requests
// interleave, and the failure mode is silent: the app believes it has made fewer
// calls than it has and gets a 429 it did not expect. `incrementUsage` is one
// statement that resets and increments atomically.
//
// `date` is a real `date` column, not text, so the comparison is against the
// database's own notion of today in UTC rather than the app server's clock.
// ---------------------------------------------------------------------

import { one } from './db.server';
import { readJson, serialize, writeJson } from './jsonFallback.server';

const FILE = 'news-usage.json';

type UsageFile = { date: string; counts: Record<string, number> };

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

export async function getUsageToday(): Promise<Record<string, number>> {
  const row = await one<{ counts: unknown; is_today: boolean }>(
    `SELECT counts, (date = (now() AT TIME ZONE 'utc')::date) AS is_today
       FROM news_provider_usage WHERE id = 'default'`,
  );

  if (row !== null) {
    // A stale row reads as zero counts WITHOUT writing. A read must not have the
    // side effect of resetting the row — two concurrent readers would both reset
    // and one increment could be lost between them.
    if (!row || !row.is_today) return {};
    return (row.counts ?? {}) as Record<string, number>;
  }

  const usage = await readJson<UsageFile>(FILE, { date: todayUtc(), counts: {} });
  // Free-tier limits are daily — if the stored date isn't today (UTC), every
  // provider's count resets, same as the real limits would.
  if (usage.date !== todayUtc()) return {};
  return usage.counts ?? {};
}

export async function incrementUsage(providerId: string): Promise<void> {
  const bumped = await one<{ id: string }>(
    `INSERT INTO news_provider_usage (id, date, counts)
     VALUES ('default', (now() AT TIME ZONE 'utc')::date, jsonb_build_object($1::text, 1))
     ON CONFLICT (id) DO UPDATE SET
       date = (now() AT TIME ZONE 'utc')::date,
       counts = CASE
         -- A new UTC day: discard yesterday's counts and start this provider at 1.
         WHEN news_provider_usage.date <> (now() AT TIME ZONE 'utc')::date
           THEN jsonb_build_object($1::text, 1)
         -- Same day: bump just this provider, leaving the others untouched.
         ELSE jsonb_set(
                news_provider_usage.counts,
                ARRAY[$1::text],
                to_jsonb(COALESCE((news_provider_usage.counts ->> $1)::int, 0) + 1),
                true
              )
       END
     RETURNING id`,
    [providerId],
  );
  if (bumped !== null) return;

  await serialize(FILE, async () => {
    const usage = await readJson<UsageFile>(FILE, { date: todayUtc(), counts: {} });
    const current = usage.date === todayUtc() ? (usage.counts ?? {}) : {};
    current[providerId] = (current[providerId] ?? 0) + 1;
    await writeJson(FILE, { date: todayUtc(), counts: current });
  });
}
