# 08 — Learning System

The pipeline, exactly as built:

```
trade closes (pnl becomes a number)
   → components/Reflection.tsx     auto-generates an LLM post-mortem
   → lib/reflectionAgent.ts        parses WHY / FAILED_SIGNAL / EARLIER_EXIT / CONFIDENCE / LESSON
   → .data/reflections.json        (lib/reflectionStore.server.ts)
   → components/Hypothesis.tsx     auto-generates one CLAIM + TEST from the LESSON
   → lib/hypothesisAgent.ts        parses CLAIM: / TEST:
   → .data/hypotheses.json         (lib/hypothesisStore.server.ts)
   → components/HypothesisPanel.tsx  a HUMAN reviews, tests, and applies
```

**Nothing in this pipeline auto-deploys.** Learning produces
*understanding*. Every step from "the model has an idea" to "production
behaviour changed" is a human action. This is
`CLAUDE.md` safety invariant 5, and it is enforced structurally, not by
convention — see [Why nothing auto-deploys](#why-nothing-auto-deploys).

---

## Stage 1 — Reflection (`components/Reflection.tsx`)

**Trigger.** A `useEffect` watching `tradeLog` scans for entries where
`typeof trade.pnl === 'number'` (i.e. closed), that haven't been attempted
this session (`processedRef`), and that have no saved reflection. Gated on
both `tradeLogLoaded` and `reflectionsLoaded` so a cold mount doesn't
regenerate everything.

**Input assembly** (`generate`):

- Entry price is back-computed as `trade.price - trade.pnl / trade.qty`.
- `entryContext` comes from the most recent prior `buy` on the same
  symbol+tab that carries a captured `entryContext`; `null` if none
  (pre-dating the feature, or an imported log).
- `exitContext` is captured now via
  `captureContextSnapshot(symbol, getCandles)` — a one-line summary
  (RSI14, EMA20-vs-EMA50, MACD histogram, ATR14, structure trend, last
  BOS/CHoCH) built from the **same** pure functions the rest of the app
  uses. No new math is invented for reflection.

**LLM call.** `POST /api/chat` with `temperature: 0.2` (fixed and low —
analytical post-mortem text, not creative chat), `maxTokens: 500`,
buffered through `readSSEStream` rather than streamed into a chat
conversation. This is the pattern `CLAUDE.md` points other new LLM calls
at; there is no separate non-streaming endpoint.

**Prompt contract** (`REFLECTION_SYSTEM_PROMPT`). Hard rules given to
the model: do not suggest any new trade or position, do not output
anything resembling a trade command, do not discuss any other symbol,
and "this is commentary only — it will be stored as a read-only note."
Five labelled lines are required:

| Label | Parsed field |
|---|---|
| `WHY:` | `whyOutcome` |
| `FAILED_SIGNAL:` | `failedSignal` |
| `EARLIER_EXIT:` | `earlierExit` |
| `CONFIDENCE:` | `confidenceAssessment` |
| `LESSON:` | `lesson` |

`parseReflectionSections` is tolerant: whatever labels are present are
extracted, anything missing stays **`null` rather than guessed** from
surrounding prose, and it never throws. A fully unparsed response means
all five fields are `null` and the UI falls back to the raw text.

**Persistence.** `POST /api/reflections` → `saveReflection`, upserted by
`tradeId`. The record stores the verbatim `content`, the parsed
`sections`, both context strings actually used, and `finishReason` — so a
truncated reflection (`'length'`) is visible rather than silently trusted
as complete.

**Failure policy.** Any error is swallowed and `processedRef` is
*un-marked*, so a later retry (manual Regenerate, or next mount) can try
again. A failed advisory note is not treated as a permanent gap. If no
API key is configured, generation is skipped silently without marking the
trade processed.

**Scope, from the file's own header:** this provider's only side effects
are one `/api/chat` call and one `/api/reflections` write. It never calls
`buyPaper`/`sellPaper`, `executeTradeCommand`, or touches `Config`.

## Stage 2 — Hypothesis (`components/Hypothesis.tsx` + `lib/hypothesisAgent.ts`)

**Trigger.** Polling, not a subscription: a `setInterval` at
`SCAN_INTERVAL_MS = 5000` scans all loaded reflections for ones with no
hypothesis yet. `useReflection()` exposes only getters, not a
change-subscribable list, so a short interval is the simplest correct way
to notice a newly-generated reflection without threading a new
subscription API through `Reflection.tsx`. The getter is read through a
ref refreshed every render — the ref-in-interval pattern `CLAUDE.md`
requires.

**LLM call.** Same shape as Reflection: `POST /api/chat`,
`temperature: 0.2`, `maxTokens: 300`, buffered.

**Prompt contract** (`HYPOTHESIS_SYSTEM_PROMPT`). The model is told it is
"a quantitative research assistant … you never decide anything, you never
claim a change should be made." Hard rules:

- Exactly **ONE** claim, about **ONE existing, real** trading concept —
  an RSI/EMA threshold, a confidence floor, a stop/target distance, a
  timeframe, a position-size limit. **Never** a new mechanism, indicator,
  or data source that doesn't already exist in this app.
- The claim must be **falsifiable** — checkable by running the existing
  backtester or by paper-trading, not merely plausible-sounding.
- **Do not output anything that looks like a trade command or a config
  change instruction.**
- Do not claim this is validated, approved, or already in effect.

Output format is two lines, parsed by `parseHypothesisSections`:

```
CLAIM: <the specific, falsifiable claim>
TEST:  <one concrete way a human could test this — real, existing knobs/tools only>
```

If either `claim` or `suggestedTest` fails to parse, the whole attempt is
treated as an error, `processedRef` is un-marked, and nothing is saved.

Note the deliberate omission stated in the file's header: it **does not
ask the model to name an exact config field to mutate.** Even the *shape*
of the output is not a config patch.

**Persistence.** `POST /api/hypotheses` → `saveHypothesis`, upserted by
`tradeId` (one active hypothesis per trade in this simple model). The
store stamps `status: 'proposed'`.

## Stage 3 — Human review (`components/HypothesisPanel.tsx`)

The panel renders `claim`, `suggestedTest`, the current status badge, and
any prior `reviewNote`. Actions available depend on status:

| Status shown | Buttons offered |
|---|---|
| `proposed` | "Tested — Validated", "Tested — Rejected", "Dismiss" (plus an optional free-text note) |
| `validated` | "I've applied this change myself — mark Applied" |
| `dismissed` / `rejected` / `applied` | none — terminal for this trade |

Each button calls `setStatus(id, status, note)` → `PATCH /api/hypotheses`
→ `updateHypothesisStatus`. That is the *only* write. The panel's own
footer states it plainly: **"Advisory only — this never runs a backtest or
changes config on its own. Testing and applying are yours to do."**

Note what "Apply" does and does not mean. The button label is
deliberately phrased in the past tense — *"I've applied this change
myself"*. Clicking it **records** that a human already made the change
themselves. It does not make the change.

### Status workflow

```
                          ┌─→ dismissed   (human: not worth testing)
proposed (agent-generated) ┼─→ rejected    (human tested it; it did not hold up)
                          └─→ validated   (human tested it; it held up)
                                   │
                                   └─→ applied  (human manually changed the config themselves,
                                                 then recorded that fact here)
```

Semantics quoted from `lib/hypothesisStore.server.ts`:

| Status | Meaning |
|---|---|
| `proposed` | The Hypothesis Agent generated this; no human action yet. |
| `dismissed` | A human decided this isn't worth testing. |
| `validated` | A human tested it (backtest/paper trading) and it held up. |
| `rejected` | A human tested it and it did **not** hold up. |
| `applied` | A human, having validated it, manually changed the relevant existing config themselves. **"This status records that a human did it — nothing in this codebase ever sets it automatically, and nothing here writes config on its own behalf."** |

`applied` is reachable only from `validated` in the UI. `updateHypothesisStatus`
itself accepts any status transition — it is a plain setter with no state
machine — so the ordering above is enforced by the panel, not the store.

`reviewNote` holds the human's own words (e.g. what they found when they
tested it) and `updatedAt` is stamped on every transition.

---

## Why nothing auto-deploys

The "Loss → AI rewrites strategy → Live" path is **impossible by design**.
This is not a policy statement — there is no code to do it.

**There is no code path from a hypothesis to production configuration.**
Concretely:

| Would-be link | Actual state |
|---|---|
| Hypothesis → risk config | `lib/hypothesisAgent.ts` and `components/Hypothesis.tsx` import nothing from `lib/riskManager.ts` and never write `RiskConfig`. |
| Hypothesis → strategy selection | Neither module imports `lib/strategyEnsemble.ts` or any strategy file. |
| Hypothesis → trade execution | Neither module imports `buyPaper`/`sellPaper`, `executeTradeCommand`, or `useSupervisor()`. |
| Hypothesis output → parseable command | The output is two free-text lines (`CLAIM`/`TEST`), and the prompt forbids anything resembling a config-change instruction. There is no schema for a config patch to be expressed in. |
| Reflection → anything executable | `lib/reflectionAgent.ts`'s header: no path back into `executeTradeCommand()`, `agentEngine.ts`, or any Config/execution code. Output is a plain string. |
| `applied` status → a config write | `updateHypothesisStatus` writes only `status`, `reviewNote`, `updatedAt` into `.data/hypotheses.json`. Nothing reads that file to configure anything. |

The only side effects either learning provider has are: one buffered
`/api/chat` call, and one write to its own JSON store.

`CLAUDE.md` states this as a safety invariant with tests that exist to
keep it enforced:

> **Learning never auto-deploys.** Reflection → Hypothesis produces
> *understanding*. A hypothesis reaching production requires an explicit
> human click. `Loss → AI rewrites strategy → Live` must remain
> impossible. Nothing in `lib/hypothesis*` or `lib/curiosityEngine.ts`
> may write to production risk config or strategy selection.

If you are extending this system: the boundary to preserve is that the
learning pipeline may only ever produce **text a human reads**. Adding a
"one-click apply that actually changes the config" button would break the
invariant even with a human click, because the human would be approving a
change they did not author or verify. The current design forces the human
to make the edit themselves in Trading Controls, then record that they
did.

---

## Where learning output actually gets consumed

| Consumer | What it reads |
|---|---|
| Trade detail UI | Reflection text + `HypothesisPanel` for that `tradeId` |
| Chat system prompt | Reflection `LESSON:` lines, folded into Memory as "mistakes" / "successful strategies" by `summarizeLessons()` in `lib/memoryContext.ts` (capped at 5 per side) |
| Supervisor decision gate | **Nothing.** See the known gap in `docs/07_MEMORY_SYSTEM.md` — `SupervisorProvider` sits above `MemoryProvider`/`ReflectionProvider`/`HypothesisProvider` in the tree, and React context only flows downward. |

So a validated hypothesis influences future behaviour through exactly two
channels: a human editing config, and (for the `LESSON` line only) chat
context. It never reaches an autonomous decision.
