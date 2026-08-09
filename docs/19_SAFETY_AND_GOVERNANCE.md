# 19 — Safety & Governance

**Status: implemented, with the enforcement point named for each rule.**

These are the invariants from `CLAUDE.md`, expanded with *what enforces
them* and *what test guards them*. Breaking one is a serious regression,
not a refactor.

---

## Invariant 1 — No AI-initiated trade bypasses the Supervisor

**Enforced by:** `components/Supervisor.tsx`'s `reviewAndExecute()` being
the only function that calls `buyPaper` / `sellPaper` /
`addRealPosition` / `removeRealPosition` / `submitRealOrderAsync` for
AI-originated trades.

**Callers routed through it:** chat `trade-action` (`components/AppState.tsx`),
agent-plan ticks (`components/Agent.tsx`), Debate "Act on this"
(`components/DebatePanel.tsx`), and the autonomous loop
(`components/AutonomousTrader.tsx` → `startAgent` → the tick loop).

**Guarded by:** `lib/agentContracts.test.ts` asserts against the *live*
descriptor registry that exactly one agent holds the `execute-trades`
permission and that it is `supervisor`. Adding that permission anywhere
else fails the suite.

**Deliberately out of scope:** a human clicking Buy manually. Supervising
agents means supervising agents, not overriding the operator.

## Invariant 2 — The leverage ceiling is not overridable

**Enforced by:** `ABSOLUTE_MAX_LEVERAGE` / `ABSOLUTE_MAX_LEVERAGE_PAPER`
living *outside* `RiskConfig` in `lib/riskManager.ts`, checked first in
`checkLeverage()`.

**Guarded by:** `lib/riskManager.test.ts` — including a test that a
lowered `liquidationSafetyBuffer` cannot unlock leverage above the
ceiling, and one asserting the tab default is the strict (`real`) value.

See `docs/12_RISK_ENGINE.md` for the paper/real split rationale.

## Invariant 3 — Every position requires a computed stop-loss

**Enforced by:** `validateTrade()` hard-rejecting when
`computeStopLossTakeProfit()` returns `null`.

**Guarded by:** `lib/riskManager.test.ts`'s "mandatory stop-loss" block,
which also asserts the reason is reported once rather than once per
dependent check.

## Invariant 4 — Closes/exits are never blocked

**Enforced by:** `reviewTradeRequest()` early-returning approved for any
sell; the pause gate in `reviewAndExecute()` applying to buys only; the
Debate Tier-1 veto applying to buys only.

## Invariant 5 — Learning never auto-deploys

**Enforced by:** the learning modules having no write path to production
config. `lib/hypothesisAgent.ts` and `lib/hypothesisStore.server.ts`
produce records with a `status` that only a human click advances;
`app/api/hypotheses/route.ts`'s `PATCH` touches no config store.

**Guarded by:** `lib/agentContracts.test.ts` asserts (a) no
`learning`-category agent holds `propose-trade` or `execute-trades`, and
(b) the hypothesis agent declares `human-gated`.

The forbidden path — `Loss → AI rewrites strategy → Live` — has no
implementation. Applying a validated hypothesis means the operator
changes the relevant setting themselves and marks it `applied`; the
status records that a human did it.

## Invariant 6 — Never fabricate market data

**Enforced by convention, and visible throughout:** `'unavailable'` risk
statuses, `null` returns from `computeExecutionQuality()` when no fill
price was reported, `unsupportedConstraints` in
`lib/knowledgeGraph.ts`'s `queryTrades()`, `null` answers in
`lib/curiosityEngine.ts`, and `PLANNED_EVENT_TYPES` in
`lib/eventDetection.ts` declaring what is *not* detected.

**Guarded by:** tests that specifically assert the honest-null behavior —
e.g. `executionQuality.test.ts`'s "refuses to score when no fill price
was reported, instead of implying a perfect fill", and
`curiosityEngine.test.ts`'s "renders unanswerable questions as
unanswerable, never as filler".

---

## Human oversight controls

| Control | Where | Effect |
|---|---|---|
| Global pause | `components/TradingControls.tsx` | Blocks new buys only; never closes |
| Manual-approval threshold | Trading Controls | Buys above a USD notional queue for explicit Approve/Reject |
| Real Trading Mode = Manual | `components/ExchangeAccounts.tsx` | Every real buy queues regardless of amount |
| Emergency stop | `components/TradingControlsPanel.tsx` | Pauses trading **and** cancels all running agent tasks |
| Autonomous loop off by default | `components/AutonomousTrader.tsx` | Opt-in; real-money mode requires typing a confirmation phrase |
| Real starting capital | Trading Controls | Opt-in; enables real-tab equity risk checks |
| Watchdog alert | `components/AutonomousTraderPanel.tsx` | Loud warning when a loop goes silent while exposure is open |

## Append-only audit trail

`lib/decisionStore.server.ts` exports only list/append — no update or
delete. Every Supervisor decision is recorded, including rejected and
not-executed ones. Real orders append a **follow-up** record with the
outcome and execution quality rather than editing the original row.

`lib/autonomousCycleStore.server.ts` records every autonomous cycle
*including no-trade ones*, with the full ranked candidate slate — so a
decision is auditable against what it was chosen over. Capped at 500
records (it appends on a fixed interval forever), trimmed oldest-first.

## Known governance gaps

- **No CRO/Compliance agent as a separate reasoning layer.** The Risk
  Engine holds the veto; there is no second agent auditing that the veto
  was respected. Spec Sections 82/85 describe that; it is not built.
- **No secret rotation or encryption at rest.** API keys live in
  `localStorage` in plain text — acceptable for a single-user local app,
  **not** acceptable if exposed beyond localhost. See `REAL_TRADING.md`.
- **No enforced walk-forward/paper-trading gate.** Spec Section 22.9
  requires a strategy to pass staged validation before production. The
  backtester and paper trading exist, but nothing *enforces* the
  progression — it relies on the operator.
