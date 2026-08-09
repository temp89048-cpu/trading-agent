# 13 — Database Schema (actual persistence)

**Status: no database is wired up.** All server-side persistence is JSON files
under `.data/`, written by `lib/*.server.ts`. `db/schema.sql` exists as a future
Postgres migration target that **nothing reads today**.

The spec's Section 8 describes a multi-database layer. This file documents what
is actually on disk.

---

## Three storage tiers in use

| Tier | Where | What lives there |
|---|---|---|
| Server JSON | `.data/*.json` via `lib/*Store.server.ts` | trades, decisions, reflections, hypotheses, debates, missions, strategy versions, autonomous cycles, collaboration, memory prefs, news-provider usage |
| Browser `localStorage` | `lib/storage.ts` + `components/*.tsx` providers | conversations/messages, portfolio, agent tasks/events, watchlist, `Config` + API keys, MCP servers, Trading Controls, autonomous-trader config, research digests |
| In-process memory | `lib/mtfCache.server.ts` | multi-timeframe candle cache (TTL, lost on restart — a cache, not a store) |

---

## The shared store pattern

Every `lib/*Store.server.ts` is a copy of the same shape. Copy an existing one
rather than inventing a variant.

```ts
const DATA_DIR  = path.join(process.cwd(), '.data');
const DATA_FILE = path.join(DATA_DIR, '<name>.json');

async function ensureFile() {                    // lazy create on first touch
  await fs.mkdir(DATA_DIR, { recursive: true });
  try { await fs.access(DATA_FILE); }
  catch { await fs.writeFile(DATA_FILE, '[]', 'utf8'); }
}

let queue: Promise<unknown> = Promise.resolve();  // write-race serialization
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

async function readAll()  { /* ensureFile, readFile, JSON.parse, [] on parse error */ }
async function writeAll() { /* fs.writeFile(JSON.stringify(x, null, 2)) */ }
```

Properties that follow from it:

- **Lazy creation** — the file appears on first read or write, so a fresh clone
  needs no setup step.
- **`serialize()` promise queue** — every *write* goes through it, so two
  concurrent API requests cannot interleave a read-modify-write and lose a
  record. Reads bypass the queue.
- **Corrupt file degrades to empty**, never throws — a malformed JSON file reads
  as `[]` rather than crashing the route.
- **Whole-file rewrite** on every append. Fine at these volumes; it is why the
  larger stores carry a `MAX_RECORDS` trim.

---

## Store inventory

| Module | File | Shape | Mutability | Cap |
|---|---|---|---|---|
| `tradeStore.server.ts` | `.data/trades.json` | `TradeLogEntry[]` | append + delete-by-id | — |
| `decisionStore.server.ts` | `.data/decisions.json` | `DecisionRecord[]` | **append-only** (no update/delete exported) | `MAX_RECORDS = 20_000`, oldest trimmed |
| `reflectionStore.server.ts` | `.data/reflections.json` | `ReflectionRecord[]` | upsert by `tradeId` | — |
| `hypothesisStore.server.ts` | `.data/hypotheses.json` | `HypothesisRecord[]` | upsert by `tradeId`, plus status update | — |
| `debateStore.server.ts` | `.data/debate-records.json` | `DebateRecord[]` | append; only `tradeId` and `outcome` may be patched | `MAX_RECORDS = 2000` |
| `missionStore.server.ts` | `.data/missions.json` | `Mission[]` | upsert by `id`, delete by `id` | — |
| `strategyVersionStore.server.ts` | `.data/strategy-versions.json` | `StrategyVersion[]` | **append-only** | — |
| `autonomousCycleStore.server.ts` | `.data/autonomous-cycles.json` | `AutonomousCycleRecord[]` | append-only | `MAX_RECORDS = 500` |
| `collaborationStore.server.ts` | `.data/collaboration.json` | `CollaborationRecord[]` | append-only | — |
| `memoryStore.server.ts` | `.data/memory-prefs.json` | `{ riskPreference, updatedAt }` **singleton object** | overwrite | — |
| `newsProviderUsage.server.ts` | `.data/news-usage.json` | `{ date, counts: Record<providerId, number> }` | increment | — |

Two of these are not stores: `lib/candleSource.server.ts` (shared upstream fetch
logic for `/api/candles` and `/api/backtest`) and `lib/mtfCache.server.ts`
(in-memory TTL cache).

### Files currently present in `.data/`

`debate-records.json`, `decisions.json`, `memory-prefs.json`, `missions.json`,
`news-usage.json`, `reflections.json`, `strategy-versions.json`, `trades.json`.
`hypotheses.json`, `collaboration.json` and `autonomous-cycles.json` appear on
first write.

---

## Record shapes

### `TradeLogEntry` (`lib/types.ts`)

```ts
{
  id: string; ts: number;
  tab: 'paper' | 'real';
  symbol: string; side: 'buy' | 'sell'; qty: number; price: number;
  note?: string;
  pnl?: number;              // realized, set only when this row closes/reduces
  entryContext?: string;     // indicator/structure snapshot, buy rows only
  debateId?: string;         // links to a DebateRecord
  originTag?: 'debate' | 'chat-trade-action' | 'agent-plan' | 'user-command' | 'manual-click';
  exchangeOrderId?: string;  // only when a live Binance/Bybit order filled this
}
```

`originTag` is never set on sell rows — a close inherits its origin from the
position it closes, reconstructed by `lib/learningDashboard.ts`.

### `DecisionRecord` (`lib/types.ts`) — the audit trail

```ts
{
  id: string; ts: number;
  symbol; side; tab; originTag;
  requestedQty: number; requestedPrice: number;
  outcome: 'approved-executed' | 'approved-not-executed' | 'rejected'
         | 'pending-approval' | 'manually-approved' | 'manually-rejected';
  urgency: string;
  rejectionReasons: string[]; conflictNotes: string[]; cautionNotes: string[];
  riskChecks: Record<string, { ok: boolean; status: string; detail: string }> | null;
  stopLoss: number | null; takeProfit: number | null; recommendedQty: number | null;
  ensembleConsensus: string | null;   ensembleConfidencePct: number | null;
  debateRecommendation: string | null; debateConfidencePct: number | null;
  rationale?: string; tradeLogEntryId?: string;
}
```

One row per Supervisor review — approved, rejected, or queued alike. Append-only
by design: a real exchange order that resolves later appends a **second** row
rather than editing the first (`Supervisor.tsx`'s `logRealOrderFollowup`).

### `ReflectionRecord` (`lib/reflectionStore.server.ts`)

```ts
{ tradeId: string; ts: number; symbol: string;
  content: string;                       // model text, verbatim, read-only
  sections?: ReflectionSections | null;  // parsed WHY/FAILED_SIGNAL/EARLIER_EXIT/CONFIDENCE/LESSON
  entryContextUsed: string | null; exitContextUsed: string;
  finishReason: string | null }          // 'length' surfaces a truncated reflection
```

Keyed by `tradeId`, so regenerating overwrites rather than duplicating.

### `HypothesisRecord` (`lib/hypothesisStore.server.ts`)

```ts
{ id; tradeId; ts; symbol; claim: string; suggestedTest: string;
  status: 'proposed' | 'dismissed' | 'validated' | 'rejected' | 'applied';
  reviewNote: string | null; updatedAt: number }
```

`status: 'applied'` is only ever set by a human clicking Apply in
`components/HypothesisPanel.tsx` **after changing the config themselves** — the
route does not touch any config store (`CLAUDE.md` invariant #5).

### `DebateRecord` (`lib/debate/types.ts`)

Starts with `tradeId` and `outcome` both `null` — a prediction, not a result.
Only two mutations are allowed anywhere: `linkDebateToTrade()` and
`updateDebateOutcomeByTradeId()`. The opinions/moderator fields are never
edited, because retroactively changing what was "predicted" would corrupt the
confidence-calibration data (`lib/debate/calibration.ts`) that depends on them.

### `StrategyVersion` (`lib/strategyVersionStore.server.ts`)

```ts
{ id; ts; symbol; assetType; interval; objective; algorithm;
  params: TunableParams;
  trainMetrics: StrategyVersionMetrics | null;
  testMetrics:  StrategyVersionMetrics | null;   // out-of-sample — the honest number
  stabilityScore: number | null; note?: string }
```

Versions the **Backtest Optimizer's** `TunableParams`, not the hardcoded live
Strategy Ensemble.

### `AutonomousCycleRecord` (`lib/autonomousCycleStore.server.ts`)

```ts
{ id; ts; outcome: 'traded' | 'no-trade' | 'error';
  considered: { symbol; side; score; actionable; reasons[]; blockers[] }[];
  actedSymbol | actedSide | actedMarginUsd | actedLeverage | agentTaskId: … | null;
  decisionSummary: string;          // always populated, including no-trade cycles
  missionId: string | null; missionProgressPct: number | null }
```

`considered` keeps the full ranked slate so a reader sees not just what was
chosen but what it was chosen over — and every no-trade cycle is explainable.

### `CollaborationRecord` (`lib/collaborationStore.server.ts`)

```ts
{ id; ts; symbol; side; ownConfidencePct: number;
  triggerReason: string; provider: string; model: string;
  opinion: CollaborationOpinion | null;   // null = request failed or unparseable
  error: string | null }
```

### `memory-prefs.json` — singleton

`{ riskPreference: RiskPreference | null, updatedAt: number | null }`. Only the
*explicitly stated* risk preference is stored. Everything else "memory" surfaces
(win rate, favorite assets, active hours, inferred appetite) is computed live
from the trade log in `lib/memoryStats.ts` — no stale duplicate is written.

---

## `db/schema.sql` — unwired future target

**Status: not wired in. Nothing in the app reads or writes Postgres.**

`db/schema.sql` is a PostgreSQL schema that mirrors, table for table, both
storage tiers above:

- **Section 1** — the `.data/*.json` stores: `trades`, `decisions`,
  `reflections`, `memory_prefs`, `debate_records`, `strategy_versions`.
- **Section 2** — currently `localStorage`-only state, for completeness:
  `conversations`, `messages`, `positions`, `paper_account`, `agent_tasks`,
  `agent_events`, `watchlist`, `config`, `mcp_servers`, `trading_controls`,
  `pending_approvals`.

Design decisions it locks in (see `db/README.md`): `text` ids matching the app's
existing `uid()` format so no extension is needed; `jsonb` for already-nested
structures (risk-check breakdowns, agent opinions, plan conditions, scale-out
levels); `CHECK` constraints rather than native `ENUM`s so a union type can be
extended with a one-line `ALTER TABLE`; `REVOKE UPDATE, DELETE ... FROM PUBLIC`
on `decisions` and `strategy_versions` so append-only is enforced at the DB layer
too; singleton tables keyed on a fixed `'default'` id.

Running it (`psql "$DATABASE_URL" -f db/schema.sql`) changes nothing in the app —
every `lib/*Store.server.ts` would have to be rewritten to talk to it. The API
routes would not need to change, since they only call into the store modules.

`db/README.md` flags four decisions to make **before** wiring it: multi-user
(every table currently assumes one operator), where API keys live (moving
`Config.apiKeys` server-side into plain `jsonb` is a materially worse trust model
than client `localStorage`), confirming the host really gives a persistent
Postgres, and the application-code rewrite.

---

## `.data/` is not durable on serverless

Every store module carries this caveat inline. On Vercel or any ephemeral
serverless filesystem, `.data/*.json` writes vanish on restart/redeploy and are
not shared between concurrent function instances. The stores are genuinely
persistent for **local and self-hosted** use only.

Consequences that matter today:

- The audit trail, reflections, hypotheses and debate calibration history all
  disappear on a serverless restart — including the append-only records whose
  whole value is being a permanent record.
- The `serialize()` queue is **per-process**. Multiple instances writing the same
  file would still race; it protects against concurrent requests in one process,
  not horizontal scale.
- `lib/mtfCache.server.ts` is in-process memory and is expected to be lost.

Fixing this is what `db/schema.sql` exists for.
