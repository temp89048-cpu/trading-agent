# Database schema (migration prep — not wired into the app yet)

`schema.sql` in this directory is a PostgreSQL schema that mirrors, table for
table, everything this app currently persists in:

- `.data/*.json` file-backed stores (`lib/*Store.server.ts`) — Section 1
- client-side `localStorage` (`components/*.tsx`, `lib/storage.ts`) — Section 2

**The app does not use this schema today.** It still reads and writes the
`.data/*.json` files and `localStorage` exactly as before. This is prep work:
an exact target to migrate *to*, not a live change. Every `.data/*.json` file
already has a comment noting it isn't persistent on serverless platforms
(Vercel, etc.) — this is what you'd swap in when that becomes a real problem.

## Running it

```bash
# against a fresh local/hosted Postgres instance
psql "$DATABASE_URL" -f db/schema.sql
```

Any managed Postgres works (Supabase, Neon, Railway, RDS, or a local
`postgres` Docker container) — nothing in `schema.sql` is provider-specific.

## What each table replaces

| Table | Replaces |
|---|---|
| `trades` | `.data/trades.json` |
| `decisions` | `.data/decisions.json` (the audit trail) |
| `reflections` | `.data/reflections.json` |
| `memory_prefs` | `.data/memory-prefs.json` |
| `debate_records` | `.data/debate-records.json` |
| `strategy_versions` | `.data/strategy-versions.json` |
| `conversations`, `messages` | `localStorage` chat history |
| `positions`, `paper_account` | `localStorage` portfolio state |
| `agent_tasks`, `agent_events` | `localStorage` agent scheduler state |
| `watchlist`, `config`, `mcp_servers` | `localStorage` settings |
| `trading_controls`, `pending_approvals` | `localStorage` Trading Controls state |

## Design notes

- **Text ids, not UUIDs.** Every id column is `text` matching the app's
  existing id format (`lib/storage.ts`'s `uid()`, or the
  `Date.now().toString(36) + random suffix` pattern used by the `.server.ts`
  stores). No extension (`pgcrypto`/`uuid-ossp`) is required to adopt this
  schema as-is — the app can keep generating ids exactly as it does now.
- **`jsonb` for nested structures.** Fields that are already loosely-typed
  nested objects in TypeScript (risk-check breakdowns, debate agent
  opinions, plan conditions, scale-out levels) stay as `jsonb` rather than
  being forced into more tables. This matches the shape the application
  code already reads/writes and avoids an over-normalized schema for data
  that's never queried by its internal fields, only displayed whole.
- **`CHECK` constraints instead of native `ENUM` types.** Postgres enums
  need `ALTER TYPE ... ADD VALUE` (and can't run inside a transaction in
  older Postgres versions) to add a new value later — a `CHECK` constraint
  is a one-line `ALTER TABLE` instead. Matches every union type in
  `lib/types.ts` (e.g. `TradeSide`, `AgentMode`, `DecisionOutcome`).
- **Append-only tables are enforced at the DB layer, not just in app code.**
  `decisions` and `strategy_versions` are never updated or deleted by the
  application (`lib/decisionStore.server.ts` and
  `lib/strategyVersionStore.server.ts` export no update/delete function) —
  `schema.sql` backs that with `REVOKE UPDATE, DELETE ... FROM PUBLIC` so a
  bug or a future contributor can't quietly start editing history.
- **Singleton tables use a fixed `'default'` id.** `memory_prefs`,
  `paper_account`, `config`, and `trading_controls` all represent
  "the one operator's" state today — there's exactly one row, seeded by the
  `INSERT ... ON CONFLICT DO NOTHING` statements in `schema.sql`.

## Before actually wiring this in

If you do decide to move the app onto this schema (not done yet — see the
scope note in `schema.sql`'s header), a few things are worth deciding first,
not just running the SQL:

1. **Multi-user or not?** Every table here assumes a single operator. If
   more than one person will ever use this app against the same database,
   every table needs a `user_id` column (and the singleton tables stop being
   singletons — `memory_prefs`/`config`/`paper_account`/`trading_controls`
   become one row per user instead of one row total).
2. **Where do API keys live?** `config.api_keys` is a direct mirror of the
   app's current `localStorage` `Config.apiKeys` field — but storing API
   keys in a plain `jsonb` column server-side is a materially different
   trust model than client-side `localStorage` (a DB breach now exposes
   every user's keys, not just one browser's). If you migrate `config`
   server-side, encrypting that column (or moving keys to a secrets
   manager and keeping only a reference here) is worth doing at the same
   time, not as a follow-up.
3. **Ephemeral filesystem problem, solved — but check your hosting.** The
   whole point of this migration is fixing "writes vanish on serverless
   restarts." Confirm wherever you deploy actually gives you a persistent
   Postgres connection (most managed platforms do) rather than assuming it.
4. **Application code changes.** Every `lib/*Store.server.ts` file (and the
   handful of `components/*.tsx` providers that currently read/write
   `localStorage` via `lib/storage.ts`) would need to be rewritten to talk
   to this schema instead. The API routes that call them
   (`app/api/*/route.ts`) shouldn't need to change — they already just call
   into the store modules, same as the comment in `lib/tradeStore.server.ts`
   has said from the start.
