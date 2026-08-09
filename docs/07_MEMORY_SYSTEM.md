# 07 — Memory System

"Memory" here means two different things, and keeping them separate is
the whole design:

1. **Derived memory** — win rate, favourite assets, active hours,
   inferred risk appetite. Recomputed **live from `tradeLog` on every
   call**. Never persisted as an aggregate.
2. **Stated memory** — the one fact that cannot be derived: the user's
   *explicitly chosen* risk preference. This is the only thing
   `lib/memoryStore.server.ts` writes.

The rule this follows (stated in `lib/memoryStats.ts`): a single source
of truth. If a trade is edited or deleted, every derived number is
correct on the next render with zero migration or sync work.

---

## Module map

| File | Role | Persistence |
|---|---|---|
| `lib/memoryStats.ts` | Pure derivations from `TradeLogEntry[]` | none (live) |
| `lib/memoryContext.ts` | Formats derived + stated memory into a chat system message | none |
| `lib/memoryStore.server.ts` | Stated risk preference | `.data/memory-prefs.json` |
| `lib/reflectionStore.server.ts` | Per-trade LLM post-mortems | `.data/reflections.json` |
| `lib/hypothesisStore.server.ts` | CLAIM/TEST hypotheses + human review status | `.data/hypotheses.json` |
| `components/Memory.tsx` | `MemoryProvider` / `useMemory()` — fetches `/api/memory` | — |
| `components/MemoryPanel.tsx` | UI to set the stated risk preference | — |

---

## `lib/memoryStats.ts` — derived memory

`closedTrades(trades)` narrows to `TradeLogEntry & { pnl: number }` —
only entries with a finite numeric `pnl` count as closed.

| Function | Output | Honesty guard |
|---|---|---|
| `computeOverallStats` | `{ totalTrades, closedCount, wins, losses, winRate, totalPnl, avgPnl }` | `winRate` and `avgPnl` are `null` until at least one closed trade exists. |
| `computeSymbolStats` | `SymbolStats[]` per symbol: trades, closedCount, winRate, totalPnl, avgNotional | per-symbol `winRate` also `null` with no closed trades |
| `computeFavoriteAssets` | `{ mostTraded, bestPerforming }` | `bestPerforming` requires `MIN_CLOSED_FOR_BEST_PERFORMER = 2` closed trades on that symbol — one lucky trade is a sample size of one, so it stays `null`. |
| `computeActiveHours` | `{ peakWindowUtc, histogram }` (24 UTC hour buckets, best contiguous 2h window) | `peakWindowUtc` is `null` below `MIN_TRADES_FOR_HOUR_PATTERN = 8` trades. |
| `inferRiskPreference` | `{ preference, reason }` | Needs `MIN_CLOSED_FOR_INFERENCE = 5` closed trades, else `preference: null` with the reason string. |

`inferRiskPreference` heuristic: average `|pnl| / notional` as a percent
across closed trades. ≤1.5% → `conservative`, ≤4% → `moderate`, else
`aggressive`. The code labels this explicitly as a rough proxy, not a
real risk assessment, and an explicitly stated preference always wins.

## `lib/memoryContext.ts` — the injected context

`buildMemoryContext(trades, explicitRiskPreference, reflections)` returns
a plain-text block. With no trades it says so outright ("no trade history
yet … This will fill in as trades are logged") rather than emitting zeros.

Lines it emits:

- Win rate over N closed trades (W/L) and total realized P&L, or
  "N trade(s) logged, none closed yet — no win/loss rate available."
- Most traded symbol.
- Best performer, or "not enough closed trades per symbol yet to call one
  out honestly."
- Typical trading window, or "not enough trade history yet to identify one."
- Risk preference: **stated** (marked "treat as authoritative"), else
  **inferred** (marked "heuristic … treat as a rough signal only"), else
  "not stated, and not yet inferable".
- Recent mistakes / recent successful strategies.

**Reflection → Memory fold-in.** `summarizeLessons()` joins each closed
trade to its reflection's parsed `LESSON:` line by `tradeId`, then splits
by sign of `pnl`: losses become "mistakes", wins become "successful
strategies". Most-recent-first, capped at
`MAX_LESSONS_PER_CATEGORY = 5` per side so this can't grow into an
unbounded wall of text. If no reflection carries a usable lesson, it says
that instead of leaving the section blank.

`ReflectionLessonInput = { tradeId, lesson }` is declared locally rather
than imported from `lib/reflectionStore.server.ts` — that module pulls in
Node's `fs` and is not safe to import into this client-usable file.

## `lib/memoryStore.server.ts` — stated preference only

Standard store pattern for this repo: `.data/memory-prefs.json`, lazy
file creation via `ensureFile()`, a `serialize()` promise queue against
write races.

```ts
type StoredPrefs = { riskPreference: 'conservative'|'moderate'|'aggressive'|null; updatedAt: number|null };
```

`read()` validates the stored value against the three allowed literals
and falls back to `null` on anything else or on a JSON parse failure.
API: `getStoredRiskPreference()`, `setStoredRiskPreference(pref)`.

**Persistence caveat, carried in the file's own comment:** genuinely
persistent for local/self-hosted use, **not** persistent on Vercel or any
ephemeral serverless filesystem. Same caveat applies to every
`*.server.ts` store below.

`components/Memory.tsx` fetches `/api/memory` once on mount. `setRiskPreference`
is optimistic and rolls back on a failed POST — deliberately low-stakes,
since this is a preference toggle, not a trade action. On a fetch failure
it leaves the value `null`, and `buildMemoryContext` falls back to the
inferred heuristic.

## `lib/reflectionStore.server.ts`

```ts
type ReflectionRecord = {
  tradeId: string;
  ts: number;
  symbol: string;
  content: string;                       // the model's post-mortem, stored verbatim, read-only
  sections?: ReflectionSections | null;   // parsed WHY / FAILED_SIGNAL / EARLIER_EXIT / CONFIDENCE / LESSON
  entryContextUsed: string | null;
  exitContextUsed: string;
  finishReason: string | null;            // 'stop' | 'length' | … — a truncated reflection stays visible
};
```

`sections` is optional: `undefined`/`null` for records predating the
field, or when the model didn't follow the labelled format at all.
`finishReason` is surfaced specifically so a truncated post-mortem isn't
silently trusted as complete.

`saveReflection` **upserts by `tradeId`** — a manual "regenerate"
replaces the record rather than accumulating duplicates.
API: `listReflections()`, `getReflection(tradeId)`, `saveReflection(record)`.

## `lib/hypothesisStore.server.ts`

```ts
type HypothesisRecord = {
  id: string;
  tradeId: string;      // the closed trade whose reflection produced this
  ts: number;
  symbol: string;
  claim: string;
  suggestedTest: string;
  status: 'proposed' | 'dismissed' | 'validated' | 'rejected' | 'applied';
  reviewNote: string | null;  // the human's own note when changing status
  updatedAt: number;
};
```

Status semantics, quoted from the file:

| Status | Meaning |
|---|---|
| `proposed` | The Hypothesis Agent generated this; no human action yet. |
| `dismissed` | A human decided it isn't worth testing. |
| `validated` | A human tested it (backtest/paper) and it held up. |
| `rejected` | A human tested it and it did **not** hold up. |
| `applied` | A human, having validated it, manually changed the relevant config themselves. **Nothing in this codebase ever sets this automatically, and nothing here writes config on its own behalf.** |

`saveHypothesis` upserts by `tradeId` (one active hypothesis per trade in
this simple model). `updateHypothesisStatus(id, status, reviewNote)`
looks up by `id` and stamps `updatedAt`. See
`docs/08_LEARNING_SYSTEM.md` for the full pipeline.

---

## Known gap: Memory and Reflection do not reach the Supervisor

**This is the most important thing in this document.**

Memory and Reflection reach **only the chat system prompt**. They do
**not** reach the Supervisor decision gate — the code path that actually
approves or rejects AI-initiated trades.

### Where memory actually goes

`components/AppState.tsx` assembles the `/api/chat` message array and
includes, among ~18 context builders:

```ts
{ role: 'system', content: buildMemoryContext(tradeLog, getRiskPreference(), reflectionLessons) },
```

That is the only consumer. `lib/supervisorAgent.ts`'s `SupervisorRequest`
type has no memory, reflection, or hypothesis field at all, and
`components/Supervisor.tsx` imports no memory module.

### The structural reason

From `app/layout.tsx`, the relevant nesting (outermost first):

```
… → SupervisorProvider → AgentProvider → AutonomousTraderProvider
      → MemoryProvider → AppStateProvider → ReflectionProvider → HypothesisProvider
```

`SupervisorProvider` sits **above** `MemoryProvider`, `AppStateProvider`,
`ReflectionProvider`, and `HypothesisProvider`. **React context only
flows downward**, so `Supervisor.tsx` cannot call `useMemory()`,
`useReflection()`, or `useHypothesis()` — those contexts do not exist at
its position in the tree.

This is the same constraint documented in `CLAUDE.md`, and it is why
config the Supervisor genuinely needs (risk limits, real starting
capital, second-opinion model, pause flag, approval threshold) lives in
`components/TradingControls.tsx`, which is mounted **above**
`SupervisorProvider` precisely for this reason.

A related instance of the same problem is already handled inside
`AppState.tsx`: it cannot call `useReflection()` either, because
`ReflectionProvider` sits *below* it and reads `config`/`resolvedApiKey`
from `useAppState()` — which would be a cycle. So `AppState` fetches
`/api/reflections` directly and keeps `reflectionLessons` in its own
state, refetched whenever `tradeLog.length` changes.

### What this means in practice

| Consumer | Sees Memory / Reflection lessons? |
|---|---|
| Chat (`/api/chat` system prompt) | Yes |
| Supervisor gate (`reviewTradeRequest`) | **No** |
| Agent-plan ticks routed through the Supervisor | **No** |
| Autonomous trader loop | **No** |
| Debate "Act on this" | **No** |

So a lesson like "I keep getting stopped out entering SOL during low
volume" informs a chat answer but has **zero** effect on whether an
autonomous buy is approved. Past mistakes are advisory to the
conversation, not to the gate.

### Fixing it — and why not to rush

Two viable approaches, neither attempted yet:

1. **Mount a memory/reflection provider above `SupervisorProvider`.**
   Requires checking every provider's dependencies first —
   `MemoryProvider` itself only fetches `/api/memory` and has no upward
   dependency, so it is a plausible candidate to hoist; `ReflectionProvider`
   is not, because it depends on `useAppState()`.
2. **Fetch directly in `Supervisor.tsx`**, the same way `AppState.tsx`
   already fetches `/api/reflections`, and pass the result into
   `SupervisorRequest` as new optional fields.

Either way, note the design constraint from `CLAUDE.md` safety invariant
5: memory-derived lessons could reasonably become **caution notes** (the
Tier-2 pattern already used for mission alignment and event detection),
but must not silently become blocking rules or sizing overrides without
an explicit decision to make them so.

`CLAUDE.md` warns against restructuring the provider tree without
auditing every provider's dependencies. Do that audit before touching it.

---

## Knowledge Graph

**Status: not implemented.**

There is no knowledge-graph module, store, API route, or entity/relationship
schema anywhere in `lib/`, `components/`, or `app/api/`. The only
references in the repository are aspirational, in planning documents:

- `TradingOS-Engineering-Spec-and-Prompts.md` — describes a Knowledge
  Graph as an entities+relationships layer with a "Knowledge API".
- `AI-Trading-Enterprise-Roadmap-Phases-21-100.md` — Phase 78 (Knowledge
  Graph Intelligence) and Phase 90 (Universal Trading Knowledge Graph).
- `TradingOS_Production_Readiness_Review.md` — section 4.

What exists today instead is a set of flat, independent JSON stores under
`.data/` (`trades.json`, `reflections.json`, `hypotheses.json`,
`memory-prefs.json`, decisions, debates, missions, collaboration,
strategy versions, autonomous cycles), joined ad hoc by `tradeId` at read
time — see `summarizeLessons()` above for the one place that join
actually happens. There is no graph, no traversal, and no cross-entity
query layer.

`db/schema.sql` is a **future Postgres migration target and is not wired
up** — nothing reads it today (`CLAUDE.md`). A real knowledge graph would
most plausibly be built on top of that migration, not on the JSON files.
