# Connecting a database

How to point this app at a Postgres database — local or hosted — and move the
existing data into it.

---

## What changed, and why

The app used to keep data in **three** places, and one quantity could have three
different values:

| Store | Held | Problem |
|---|---|---|
| **Postgres** | the Python agent's trades, decisions, reflections, risk events | fine |
| **`.data/*.json`** | the Next.js routes' trades, missions, debates, … | vanishes on serverless; separate from the agent's copy |
| **`localStorage`** | portfolio, watchlist, chat history, provider config | one browser only; lost on clearing site data |

That split had already caused a real fault: `/orders` displayed **4** trades from
the JSON file under a heading describing the agent's execution record, while the
agent had recorded **2,620** in Postgres. Two books, one heading.

`db/schema.sql` was designed for this migration all along — nearly every table
carries a `-- Source: lib/xStore.server.ts` comment. It just was never wired to the
Next.js half of the app.

**Postgres is now the primary store.** The JSON files remain as a *fallback* so a
fresh clone with no database still runs, and every store reports which one
answered rather than quietly swapping.

---

## 1. Pick a database

### Option A — local (what this machine already has)

PostgreSQL 18 is installed and running here, with a `tradingos` database. Nothing
to do.

```
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/tradingos
```

### Option B — hosted (for access from anywhere, or to deploy)

Any managed Postgres works. All three below have a free tier that fits this app:

| Provider | Notes |
|---|---|
| **[Neon](https://neon.tech)** | Postgres-native, generous free tier, connection pooling built in. Easiest fit. |
| **[Supabase](https://supabase.com)** | Postgres plus a dashboard and auth you are not obliged to use. |
| **[Railway](https://railway.app)** | Simple provisioning; free tier has an hours cap. |

Steps are the same for each:

1. Create an account and a new **Postgres** database (region: closest to you).
2. Copy the **connection string**. It looks like:
   ```
   postgresql://USER:PASSWORD@ep-xxxx-yyyy.eu-central-1.aws.neon.tech/dbname?sslmode=require
   ```
3. On Neon, prefer the **pooled** connection string (it has `-pooler` in the host)
   — a free tier caps direct connections, and this app runs two pools (Python and
   Node).

---

## 2. Put the URL in `.env`

One file, at the repo root. **Both halves of the app read the same variable**, so
there is one place to change and no way for them to disagree:

```dotenv
# The Python backend (asyncpg + LangGraph checkpointer) and the Next.js routes
# (lib/db.server.ts) both read this.
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Optional TLS control. Default: TLS with the provider's own setting for a remote
# host, none for localhost.
#   strict  demand a verifiable certificate chain
#   off     disable TLS entirely (local only)
# DATABASE_SSL=strict

# Optional. Node-side pool size. Keep it small — a free tier caps total
# connections and the Python side already holds up to 20.
# DATABASE_POOL_MAX=5
```

> **If your password contains `@`, `:`, `/`, `?` or `#`**, percent-encode it or the
> URL parses wrongly and you get an authentication error that looks like a bad
> password. `@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`.

`.env` is gitignored. Do not commit a connection string.

---

## 3. Create the tables

Just start the backend. It applies `db/schema.sql` on **every** startup, and every
statement in that file is idempotent:

```bash
.venv/Scripts/python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Watch the log:

```
Database schema applied — CREATED 28 table(s) that did not exist: agent_events, ...
```

On a database that already has them:

```
Database schema applied; all 28 table(s) already present.
```

> **Why every startup.** It used to apply the schema only when the `trades` table
> was absent — so once `trades` existed the file was never read again, and
> `execution_quality`, added later, was **never created**. Every write to it failed
> *after* the order had already reached the exchange. Gating a whole schema on one
> table's existence is not a migration.

**Adding a column later** needs a line in the `COLUMN ADDITIONS` section at the
bottom of `schema.sql` as well as in the table's `CREATE` block —
`CREATE TABLE IF NOT EXISTS` is a no-op on an existing table and cannot add a
column. The two are not redundant; they serve a fresh database and an existing one.

---

## 4. Verify the connection

```bash
curl http://127.0.0.1:8000/api/monitoring          # backend up
curl http://127.0.0.1:3100/api/health              # Next side + DB ping
```

Or directly:

```bash
.venv/Scripts/python.exe -c "import asyncio, asyncpg; from backend.core.config import settings; \
print(asyncio.run(asyncpg.connect(dsn=settings.DATABASE_URL)) and 'connected')"
```

---

## 5. Import the existing JSON data

Dry run first — it writes nothing and tells you exactly what it would do:

```bash
.venv/Scripts/python.exe scripts/import_json_to_postgres.py --dry-run
```

```
Store                  imported  existing        skipped
--------------------------------------------------------
  trades                 +4      already had 2620   skipped 0
  missions               +1      already had 0      skipped 0
```

Then for real:

```bash
.venv/Scripts/python.exe scripts/import_json_to_postgres.py
```

**Safe to re-run.** Every insert is `ON CONFLICT DO NOTHING`, so a second run
imports only what is new and never overwrites a row Postgres already has. That
direction is deliberate: Postgres is authoritative, and re-running an old JSON file
must not clobber newer data.

**The JSON files are left in place.** They are still the fallback when
`DATABASE_URL` is unset, and until you have checked the import they are the only
copy. Delete them yourself when satisfied — the script will not.

---

## 6. Browser data (`localStorage`)

A server-side script cannot read your browser, so the portfolio, watchlist, chat
history, provider config and exchange-account metadata are not covered by step 5.

For most of these, letting them recreate themselves is less work than migrating: a
watchlist is a few clicks, and a sidebar collapse state is not worth moving.

To carry the portfolio over, open the app, run this in the browser console, and
keep the output:

```js
Object.fromEntries(
  ['qt_portfolio_v2', 'qt_watchlist_v2', 'qt_tradelog_v1', 'qt_pv_history_v1',
   'qt_trading_controls_v1', 'qt_exchange_accounts_v1']
    .map((k) => [k, localStorage.getItem(k)])
    .filter(([, v]) => v !== null),
)
```

### API keys are deliberately **not** moved to the database

Your LLM and exchange keys stay in the browser. A trading-enabled API key sitting
in a hosted database is a materially different risk from one in a single browser:
a backup, a read replica, a leaked connection string, or one SQL injection
anywhere in the app now exposes funds.

`exchange_accounts` therefore stores only the **last four characters** of a key —
enough to tell two accounts apart in the UI, useless to an attacker. Cross-device
keys would need envelope encryption with a KMS key the database itself cannot read.
Do not add a plaintext `api_key` column "for now".

---

## 7. Deploying

Once `DATABASE_URL` points at a hosted database, the JSON fallback stops mattering
and the app can run on an ephemeral filesystem:

- Set `DATABASE_URL` in your host's environment (Vercel/Render/Fly project
  settings), **not** in a committed file.
- Keep `LIVE_TRADING=false` until you have deliberately decided otherwise. It is
  the only flag that routes real orders, and it is not settable from the browser
  by design.
- `USE_TESTNET=true` additionally blocks every private exchange call, because
  Binance dropped futures testnet support in ccxt. **Real trading needs both
  `LIVE_TRADING=true` and `USE_TESTNET=false`** — that is mainnet with real funds.

---

## Current migration status

Every store below reads Postgres when `DATABASE_URL` is set. Where a fallback is
listed, that is what answers when it is **not** set — a fresh clone still runs.

### Server stores — migrated and verified

| Store | Table | Rows now | Fallback |
|---|---|---|---|
| `tradeStore.server.ts` | `trades` | 2,624 | `.data/trades.json` |
| `decisionStore.server.ts` | `decisions` | 17,600+ | `.data/decisions.json` |
| `reflectionStore.server.ts` | `reflections` | 2,479 | `.data/reflections.json` |
| `hypothesisStore.server.ts` | `hypotheses` | 3 | `.data/hypotheses.json` |
| `debateStore.server.ts` | `debate_records` | 22 | `.data/debate-records.json` |
| `missionStore.server.ts` | `missions` | 1 | `.data/missions.json` |
| `autonomousCycleStore.server.ts` | `autonomous_cycles` | 64 | `.data/autonomous-cycles.json` |
| `strategyVersionStore.server.ts` | `strategy_versions` | 0 | `.data/strategy-versions.json` |
| `newsProviderUsage.server.ts` | `news_provider_usage` | resets daily | `.data/news-usage.json` |
| `memoryStore.server.ts` | `memory_prefs` | 1 seeded row | `.data/memory-prefs.json` |

The three that matter most changed what the UI shows, because the dashboard had
been reading the wrong book: **trades 4 → 2,624**, **decisions a handful →
17,600+**, **reflections ~10 → 2,479**.

### Browser state — moved off `localStorage`

| Was | Now | Route |
|---|---|---|
| `qt_portfolio_v2` | `paper_account` + `positions`, in one transaction | `GET/PUT/DELETE /api/portfolio` |
| `qt_watchlist_v2` | `watchlist` | `GET/PUT /api/watchlist` |
| `qt_pv_history_v1` | `pv_history` | `GET/POST /api/pv-history` |

`localStorage` is **kept as the fallback**, deliberately:

- With no `DATABASE_URL` the routes answer `source: 'none'` and the browser keeps
  using its own copy. A `null` book is **not** an empty book — treating it as one
  would wipe a portfolio because a database was unreachable.
- The local write stays synchronous. `getPortfolioSnapshot()` must see a trade made
  earlier in the same synchronous batch, and awaiting a network round trip in a
  mutator would break that.
- The server write is fire-and-forget. A dropped sync costs durability, not
  correctness — and blocking a trade on it would be worse than losing the mirror.

`PUT /api/portfolio` **replaces** the whole book, so it validates the payload and
returns 400 rather than storing a partial one. Positions are deleted and re-inserted
because "absent from the payload" is how a close is expressed; a merge would
resurrect a position you had just closed.

### Still `localStorage`, and why

| Key | Reason |
|---|---|
| `qt_config_v2` | Holds your **API keys**. See below — this one is a deliberate no. |
| `qt_conversations` | Chat history. `conversations` + `messages` tables are ready; low value, easy to add. |
| `qt_mcp_v2` | MCP server list. `mcp_servers` table is ready. |
| `qt_trading_controls_v1` | `trading_controls` table is ready. Note it holds the second-opinion API keys, so it has the same problem as `config`. |
| `qt_exchange_accounts_v1` | `exchange_accounts` table is ready, and stores only a key's last four characters. |
| `qt_sidebar_groups_v1` | A per-browser UI preference. `localStorage` is the *correct* place for this — syncing which sidebar groups you collapsed would be worse, not better. |

### API keys are deliberately **not** in the database

Your LLM and exchange keys stay in the browser. A trading-enabled API key sitting
in a hosted database is a materially different risk from one in a single browser: a
backup, a read replica, a leaked connection string, or one SQL injection anywhere
in the app now exposes funds.

`db/schema.sql` does declare `config.api_keys` and
`trading_controls.second_opinion_api_keys` — they predate this decision. **Nothing
writes to them**, and nothing should until there is envelope encryption with a KMS
key the database itself cannot read. `exchange_accounts` stores only
`api_key_last4`: enough to tell two accounts apart in the UI, useless to an
attacker.

### Left alone on purpose

`.data/graph_checkpoints.sqlite` and `db/knowledge_graph.db` — LangGraph's own
checkpointer and the knowledge graph, both managed by their libraries.
`lib/mtfCache.server.ts` is a derived cache that rebuilds itself; putting it in the
database would add write load for data that is cheaper to recompute.

---

## Open gap worth knowing about

The **backend's** open positions are still an in-memory dict
(`backend/services/portfolio_store.py`), so a restart forgets them. The browser's
positions now persist; the agent's do not. Postgres has the `positions` table and
the Next.js side writes it — the Python side still needs to.

For paper that loses P&L continuity. For **real money** the position still exists
at the exchange with a stop this process was the only thing enforcing, and after a
restart nothing is watching it. `tests/test_post_trade_chain.py` pins the current
behaviour with two tests; invert them when it is fixed rather than deleting them.

**This is the thing I would fix before enabling real trading.**
