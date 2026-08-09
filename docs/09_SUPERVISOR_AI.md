# 09 — Supervisor AI

Two files:

| File | Role |
|---|---|
| `lib/supervisorAgent.ts` | **Pure decision logic.** `reviewTradeRequest(request) → SupervisorDecision`. No I/O, unit-testable. |
| `components/Supervisor.tsx` | **The provider and execution gate.** Gathers every input, calls `reviewTradeRequest`, then executes / queues / drops, and writes the audit record. |

`reviewAndExecute()` in `Supervisor.tsx` is **the single execution path
for every AI-originated trade** — chat trade-actions, agent-plan ticks,
the Debate panel's "Act on this", and the autonomous loop. This is
`CLAUDE.md` safety invariant 1.

**Deliberately out of scope:** a human typing `@papertrade buy SOL 10` or
clicking the manual Buy button. Quoting the module header — *"Supervising
agents means supervising agents, not overriding the person running the
terminal."* Manual actions have never routed through the risk system and
still don't.

---

## Request and decision shapes

```ts
type SupervisorRequest = {
  symbol; side: 'buy'|'sell'; tab: TradeTab; qty: number;
  ctx: StrategyContext | null;
  equityUsd: number | null;
  tradeLog: TradeLogEntry[];
  requestedLeverage?; existingExposureUsd?; newsHeadlines?; correlationInputs?;
  originTag; rationale?;
  isClosingAction?: boolean;
  isStopOrTargetTriggered?: boolean;
  ensembleConsensus?: { signal: 'BUY'|'SELL'|'HOLD'; confidencePct: number } | null;
  debateRecommendation?: { recommendation: 'BUY'|'SELL'|'HOLD'; compositeConfidencePct: number; supportingEvidence: string[] } | null;
  riskConfig?: Partial<RiskConfig>;
  realStartingEquityUsd?: number | null;
  missionAlignment?: MissionAlignmentResult | null;
};

type SupervisorDecision = {
  approved: boolean;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  reasons: string[];        // rejection reasons — empty when approved
  conflictNotes: string[];  // disagreements, surfaced regardless of approval
  cautionNotes: string[];   // informational (mission alignment, events)
  explainable: ExplainableRecommendation | null;
  riskValidation: RiskValidation | null;
};
```

Note there is **no memory / reflection / hypothesis field**. See the known
gap in `docs/07_MEMORY_SYSTEM.md`.

---

## Two-tier conflict resolution

`resolveConflicts(request)` implements a stated rule, not "uses judgment".

### Tier 1 — Debate System: **can BLOCK**

The Debate System is the most rigorous signal this app produces (seven
independent agents, empirical confidence calibration, composite
adjustment). If it ran for this exact symbol and returned a
high-confidence recommendation that directly contradicts a **buy**:

```
DEBATE_BLOCK_CONFIDENCE_PCT = 60
```

| Requested side | Debate says | Composite confidence | Outcome |
|---|---|---|---|
| `buy` | `SELL` | **≥ 60%** | **Rejected outright.** `approved: false`, `urgency: 'critical'`, `riskValidation: null` (risk checks aren't even run — the block happens first). |
| `buy` | `SELL` | < 60% | `conflictNote` only, explicitly labelled "noted, not blocking". |
| `buy` | `HOLD` (any confidence) | any | `conflictNote` only. A HOLD is never an opposing high-confidence call. |
| `sell` | `BUY` | ≥ 60%, and not stop/target-triggered | `conflictNote` for the record — *"Closing/de-risking is never blocked by the Supervisor regardless."* |

The rejection message tells the operator what to do about it: run a fresh
Debate (conditions may have changed), or act via a path that doesn't route
through the Supervisor if they're certain the read is stale.

### Tier 2 — Strategy Ensemble: **caution note only, never blocks**

If `ensembleConsensus.signal` is non-`HOLD` and disagrees with the
requested side, a `conflictNote` is added reading, verbatim in the code,
*"The Ensemble is informational-only (Commit 12) and never blocks by
itself."*

The reason is scoping consistency, not weakness: the Ensemble was designed
as informational-only, and granting it blocking power here would
contradict its own established contract. Conflict bullets from Tier 2 are
tagged in the explanation as
`'Supervisor — cross-agent conflict check (Tier 2, non-blocking)'`.

### Auto-Debate escalation

Before conflict resolution, `reviewAndExecute` checks
`getLatestDebate(symbol)` — which returns `undefined` once a record is
older than `DEBATE_FRESHNESS_MS = 10 minutes` (`components/Debate.tsx`).

If there is **no fresh debate**, the side is **`buy`**, and a
`StrategyContext` exists, the Supervisor **runs one itself** via
`runDebateSync({ symbol, ctx, sentiment, liveCandles })`.

Why this is safe to do inline: `runFullDebate` is a pure, deterministic
computation over data already on hand — no LLM call, no network round
trip — so there is nothing to await. `runDebateSync` returns the result
synchronously and persists it fire-and-forget.

The problem it fixed: previously an AI-initiated buy only consulted the
Debate System if a human happened to have clicked "Run Debate" on that
exact symbol within the last 10 minutes. Otherwise `debateRecommendation`
was `null` and the Supervisor decided alone — meaning Tier 1 was
effectively dormant for autonomous trades.

**Sells never trigger this.** Closing risk is never blocked regardless of
what Debate says, so there is nothing for the escalation to inform.

If an auto-run happens and the caller supplied no `debateId`, the debate's
id is attached to `params.debateId` so `components/Debate.tsx`'s
win/loss outcome tracking still applies to this trade.

---

## Closes/sells are NEVER blocked

`reviewTradeRequest` short-circuits before any risk check:

```ts
if (request.side === 'sell') {
  return { approved: true, urgency: classifyUrgency(request, true),
           reasons: [], conflictNotes, cautionNotes: [],
           explainable: buildCloseExplainable(...), riskValidation: null };
}
```

For a close, the Supervisor's job is producing the explanation and the
urgency tag — **not** approving or rejecting. The stated rationale:
reducing exposure cannot itself create the kind of risk the opening gate
exists to catch, and `sellPaper` has never gone through an opening-risk
gate.

This rule is layered and holds in `Supervisor.tsx` too:

| Gate | Applies to sells? |
|---|---|
| Debate Tier-1 veto | No |
| Risk Manager (`validateTrade`) | No — not called at all for sells |
| Operator pause | No |
| Manual-approval threshold | No |
| Real Trading Mode = manual | No |
| Event Detection caution notes | No (buy-only loop) |
| Collaboration second opinion | No |

`isClosingAction` is set by the caller for a reducing/closing sell, but
per the type's own comment it *"just affects urgency and the explanation
text, not the approval outcome."*

`CLAUDE.md` invariant 4 states this holds **more** for real money, not
less: *"Refusing to let someone exit a position they are already in is
actively harmful."*

---

## `classifyUrgency`

```ts
function classifyUrgency(request, approved): SupervisorUrgency {
  if (request.isStopOrTargetTriggered) return 'critical';
  if (request.side === 'sell')         return 'high';
  if (!approved)                       return 'critical';
  return 'normal';
}
```

| Case | Urgency | Why |
|---|---|---|
| Stop-loss or take-profit level hit | `critical` | Time-sensitive protective exit; must surface first in a batch. |
| Any other sell / close | `high` | De-risking is always prioritized over new opens. |
| Rejected buy | `critical` | *"A blocked buy needs visibility — something stopped it."* |
| Approved buy | `normal` | Routine. |

`'low'` is part of the type but never returned by `classifyUrgency`.

**This has a real consumer, not just a label.** `components/Agent.tsx`'s
tick loop computes every running task's pending action *before* executing
any of them, orders closes ahead of new opens, and only then runs each
one's Supervisor review in that order. Consequence: a close that frees up
cash/exposure in a given tick is actually available to an open evaluated
later in that same tick. It also drives ordering of the pending-approval
queue and the decision audit log's `urgency` field.

---

## Decision flow in `reviewAndExecute`

```
1. Resolve WatchItem (falls back to inferring type from the symbol format)
2. Build StrategyContext from 1h candles          → ctx (may be null)
3. Auto-Debate escalation (buys only, no fresh debate, ctx present)
4. Run Strategy Ensemble                          → ensembleConsensus
5. Assemble SupervisorRequest (equity, exposure, news, correlation,
   riskConfig, realStartingEquityUsd, missionAlignment)
6. reviewTradeRequest(request)  ← pure logic
     a. resolveConflicts (Tier 1 / Tier 2)
     b. side === 'sell'  → approve immediately, done
     c. blockedByDebate  → reject, urgency critical
     d. ctx === null     → reject ("cannot validate risk without it,
                            so this is rejected rather than approved blind")
     e. validateTrade(...)  ← Risk Manager
     f. missionAlignment → cautionNotes (never a rejection)
7. Event Detection      → cautionNotes (buys only, never a rejection)
8. Paused gate          → flips approved to false (buys only)
9. Collaboration second opinion (fire-and-forget, buys only, no effect)
10. Execute / queue for approval / submit real order
11. logDecisionRecord → POST /api/decisions (best-effort, never a gate)
```

### Step 6d — no context is a rejection, not a pass

If no `StrategyContext` exists (insufficient candle history), the buy is
**rejected**, not waved through. Same "stop rather than trade blind"
principle applied elsewhere.

### Step 6e — the Risk Manager

`validateTrade` runs nine checks: `positionRisk`, `dailyLoss`,
`drawdown`, `liquidity`, `spread`, `leverage`, `portfolioExposure`,
`correlation`, `news`. `approved` is true only when no check has
`status: 'reject'`. `'unavailable'` checks become non-blocking
`cautionNotes` — visible, never silently absorbed. Rejection reasons are
deduped, because a single root cause (a missing stop) can legitimately
fail two checks and reporting it twice reads like two problems.

Two invariants live in the Risk Manager, not here:
`ABSOLUTE_MAX_LEVERAGE` (3x real / 10x paper) is deliberately **not** part
of `RiskConfig` so nothing can raise it, and a missing stop-loss (no ATR)
is a **hard reject** rather than a soft `'unavailable'`.

### Step 6f / 7 — Tier-2-style caution notes

Two inputs can only ever add caution notes, never reject:

- **Mission alignment** (Phase 22). `alignment === 'misaligned'` or
  `'aligned'` both produce a note. The `capital-target` mission in
  particular is designed to *only* produce advisory notes — never a hard
  rule, never a sizing override.
- **Event Detection** (Level 16). Every event for this symbol is pushed as
  `Event Detection [SEVERITY] kind: detail`. This closed a real gap:
  detected liquidation cascades and volatility explosions previously
  reached only the chat system prompt, where the model reading them had no
  ability to stop an autonomous trade. They are notes rather than
  rejections because, per `lib/eventDetection.ts`'s own framing, these
  events "often precede significant moves but are not trade signals on
  their own" — a real risk check still has to be the thing that blocks.

### Step 8 — the paused-trading gate

```ts
if (params.side === 'buy' && paused && decision.approved) {
  decision.approved = false;
  decision.reasons = [...decision.reasons,
    'Trading is paused by the operator (Trading Controls) — no new positions until resumed.'];
}
```

- **Buys only.** Never sells/closes.
- Applied **after** `reviewTradeRequest`, by flipping an already-approved
  decision — so the operator sees *why* it would otherwise have passed.
- A paused buy is deliberately shaped to look exactly like a
  risk-rejected one, because every caller already branches on
  `!decision.approved`. No new call-site logic was needed.

`paused` comes from `useTradingControls()`. `TradingControlsProvider` is
mounted **above** `SupervisorProvider` in `app/layout.tsx` precisely so
the Supervisor can read it — the Supervisor cannot use `useAppState()`,
which sits below it.

### Step 9 — Collaboration Protocol (advisory only)

When a buy is **approved** and a second-opinion model is configured, and
either there are conflict notes or the Debate composite confidence is
below **55%**, `requestCollaborationOpinion` asks a genuinely separate,
human-configured model for an independent read.

It is fire-and-forget and **never re-executes, cancels, or otherwise
touches the trade** — the appended audit record via `/api/collaboration`
is its only effect. The trade decision has already been made by the time
it resolves.

### Step 10 — the manual-approval threshold queue

Only reached for approved **buys**:

```ts
const requiresManualApproval =
  (manualApprovalThresholdUsd !== null && notionalUsd > manualApprovalThresholdUsd)
  || (targetExchange !== null && realTradingMode === 'manual');
```

Two independent triggers:

| Trigger | Scope |
|---|---|
| Notional exceeds `manualApprovalThresholdUsd` | Any tab. `null` threshold disables this trigger. |
| Real Trading Mode is `'manual'` **and** a live exchange is the target | Every real order, regardless of size — a deliberate operator-comfort control layered on top of the size check. |

When either fires, `addPendingApproval({...})` queues the request instead
of executing it, **even though it passed every risk check**. The queued
entry carries a `decisionSummary` explaining which trigger fired and the
decision's urgency and conflict-note count.

**Deduplication.** `pendingApprovalKey` (typically the agent task's id)
becomes the queue's `dedupeKey`; `addPendingApproval` returns the existing
entry's id if a matching key is already queued. Without this, a repeating
caller like `Agent.tsx`'s tick loop — which re-evaluates the same logical
trade every tick until it executes — would enqueue one `PendingApproval`
per tick. One-off callers (chat, manual, Debate's "Act on this") omit the
key; they are never retried.

The result type distinguishes three non-executed cases, and every caller
handles them separately:

| Result | Meaning |
|---|---|
| `executed: true` | Ledgered locally (paper buy/sell or real manual-ledger entry). |
| `executed: false, pendingApprovalId` set | **Not rejected** — queued for a human's Approve click. |
| `executed: false, realOrderSubmitted: true` | A live exchange order was submitted asynchronously; the fill is confirmed and ledgered later. |
| `executed: false`, neither set | Rejected (or approved but nothing to close). |

Approval is completed by `executeApprovedRequest(...)`, called from
`components/TradingControlsPanel.tsx`'s Approve button. It lives in
`Supervisor.tsx` rather than the approval UI so there is exactly one place
that decides "does this go to a real exchange."

---

## Real-order execution

A real trade only reaches a live exchange when an exchange is configured
**and** connected **and** selected as preferred. Otherwise the `real` tab
keeps its pre-existing behaviour of a manual ledger entry — deliberate
backward compatibility, since connecting an exchange is opt-in and must
not silently change behaviour for anyone using the real tab as a journal.

`submitRealOrderAsync` is fire-and-forget because placing a live order is
HMAC-signed network I/O that the synchronous `reviewAndExecute` cannot
await without rippling `async` through every caller. It polls order status
once if the exchange didn't return fills synchronously (Bybit's market
response doesn't; Binance's does), then ledgers **the exchange's real fill
price/qty — never the app's own tick price** — or logs the failure. It
never throws into the caller.

---

## Audit trail

`logDecisionRecord` POSTs **every** decision to `/api/decisions`, not just
executed trades, with the outcome classified as:

| Condition | `DecisionOutcome` |
|---|---|
| queued | `pending-approval` |
| `!decision.approved` | `rejected` |
| executed | `approved-executed` |
| approved but not executed (e.g. real order in flight) | `approved-not-executed` |

It records urgency, rejection reasons, conflict notes, caution notes, all
risk-check statuses, stop/target, recommended qty, ensemble and debate
readings, and the rationale. It is **fire-and-forget**: a failed POST
never blocks or fails the trade decision — *"the audit trail is a record
of what happened, not a gate on whether it's allowed to happen."*

`logRealOrderFollowup` **appends** a second record when a real order
resolves rather than editing the first — decisions are append-only by
design (`lib/decisionStore.server.ts`). The initial
`approved-not-executed` row was accurate at the time it was written.

---

## Explainability

Every decision carries an `ExplainableRecommendation` (or `null` when
there's no context to build one from), approved or not.

- **Buys** (`buildBuyExplainable`): caller rationale, each rejecting risk
  check, each risk caution note, and each conflict bullet — all
  source-tagged. Probability comes from the Debate composite when
  available, else `unavailable('no Debate run available for this request')`.
  Expected R comes from `runTradeSimulation` (Monte Carlo) when ATR and
  SL/TP exist, else `unavailable`. Stop and target come from the Risk
  Manager. If nothing else applies, it says "All Risk Manager checks
  passed with no cross-agent conflicts."
- **Closes** (`buildCloseExplainable`): notes whether a stop/target
  triggered it, the caller rationale, and any conflict notes marked
  "informational only for closes". Probability / expected R / stop /
  target are all `unavailable('not applicable to a closing action')`
  rather than fabricated.

---

## System health

`assessSystemHealth(signals)` is an honest **rollup** of signals the
caller already has, not new monitoring infrastructure:

```
0 failing            → 'healthy'
failing ≤ half       → 'degraded'
otherwise            → 'unhealthy'
```

Real active checks feed it: candle feeds are checked for presence,
last-fetch error, and staleness (`components/SystemHealthPanel.tsx`); MCP
servers are auto-rechecked on an interval; `app/api/health/route.ts`
independently exercises the trade store and Binance reachability
server-side.

**Status: not production monitoring.** The module header says so plainly:
no external uptime pinger against this app's own process, no
alerting/paging — out of scope for a single-process app. "Recover from
failures" happens at each point of failure (news provider fallback,
partial multi-exchange tolerance, the candle-refresh loop's auto-retry);
the Supervisor surfaces that state, it does not reimplement each module's
recovery.
