# TradingOS AI
Version 3.0

> Source material: `TradingOS-Engineering-Spec-and-Prompts.md` Sections 0–3.
> Source of truth for architectural facts: `CLAUDE.md` at the repo root.
> Where the spec and the code differ, the code (and `CLAUDE.md`) wins, and
> this document says so plainly.

## Mission

Build the world's most advanced autonomous AI trading platform capable of
continuously analyzing cryptocurrency futures markets, making explainable
decisions, preserving capital through rigorous risk management, learning
from validated experience, and operating safely 24/7 under human-defined
governance.

## Core Principles

1. Capital Preservation
2. Explainability
3. Reliability
4. Continuous Learning
5. Safety
6. Modularity
7. Scalability
8. Research Driven
9. Risk First
10. Evidence Based

---

## 1. The objective reframing (spec Section 0)

The original ask was: *"if I trade $2, I want it to return $2, compounding
through multiple trades up to $20, with the agent analyzing every market
movement and self-learning from every failure and success."*

Everything in that ask is kept — continuous analysis, self-reflection,
learning from every trade, never stopping. **One piece is deliberately not
encoded as a hard requirement:**

> "Turn $2 into $20" is a desired financial outcome, not a software
> requirement. No agent can honestly promise or optimize for a guaranteed
> return multiple. Encoding it as a hard target pushes the system toward
> overfitting and excessive risk-taking to hit the number.

**The engineering objective used throughout this repo instead:**

> Maximize long-term, risk-adjusted capital growth while preserving capital
> and continuously improving through validated learning.

A user can still *state* a dollar goal: `lib/missionPlanner.ts` defines a
`capital-target` Mission type (`startEquityUsd` → `targetEquityUsd`) with
**no deadline**, which only ever produces advisory alignment notes. See
`docs/01_PROJECT_GOAL.md` for the full reasoning and the code that enforces
it.

---

## 2. Master coverage checklist (spec Section 2), verified against the repo

Status is what was **verified in this codebase**, not what the spec asks
for. "Partial" means the capability exists in code but does not cover
everything the spec item names.

| # | Spec checklist item | Status | Where / what's missing |
|---|---|---|---|
| 1 | Complete project vision and mission statement | **Built** | `CLAUDE.md` (Mission, Primary objective), `docs/00`, `docs/01` |
| 2 | Engineering principles | **Built** | `CLAUDE.md` — "Safety invariants" (6 named invariants) + "Engineering conventions actually used here" |
| 3 | Folder / repository architecture | **Built** | `app/` (App Router + 26 route handlers), `lib/` (pure logic), `components/` (React providers + panels), `db/schema.sql`, `.data/` — see `docs/02` |
| 4 | Every AI agent (contract, not just a name) | **Partial** | 31 agents registered in `lib/agentDescriptors.ts`; **8 have a filled-in `contract`**, 23 do not. `contractCoverage()` reports the gap rather than hiding it — see `docs/04` |
| 5 | Every API | **Partial** | 26 Next.js route handlers under `app/api/` exist and are enumerable; a written per-endpoint contract is not part of this file set (see `docs/14`) |
| 6 | Every database / schema | **Partial** | 13 JSON-file stores (`lib/*.server.ts` → `.data/*.json`) plus `localStorage`. `db/schema.sql` maps them to Postgres tables but is **UNWIRED** — no `pg` dependency, nothing reads it |
| 7 | Every workflow (event-to-event, tick-to-trade) | **Partial** | The tick-to-trade and autonomous-cycle paths are traced end-to-end in `docs/05`. Other workflows (learning pipeline, backtest, chat) are not yet documented at that level |
| 8 | Every event on the event bus | **Not built** | **Status: not implemented.** There is no event bus in this codebase — `grep` for `eventBus`/`emit(` returns nothing. Coordination is React context + direct function calls. `AgentEvent` in `lib/types.ts` is a UI activity log, not a bus |
| 9 | Every prompt (system, planner, debate, reflection, per-agent) | **Partial** | Prompts exist inline: `SYSTEM_PROMPT` + context builders in `components/AppState.tsx`, `REFLECTION_SYSTEM_PROMPT`, `HYPOTHESIS_SYSTEM_PROMPT`, `COLLABORATION_SYSTEM_PROMPT`. There is no central prompt library, and the deterministic modules (Debate moderator, opportunity scanner, curiosity engine) have **no prompt by design** |
| 10 | Every memory store | **Built** | 13 `lib/*Store.server.ts` / `*.server.ts` modules, each JSON-backed under `.data/` with a serialize() write queue; plus `localStorage` for client state |
| 11 | Every model in use (and why) | **Partial** | Provider/model are operator-configured at runtime (Settings), plus a separate second-opinion model slot used by the Collaboration Protocol. There is no fixed model roster in the repo to enumerate |
| 12 | Every risk rule | **Built** | `lib/riskManager.ts`: 9 named checks (positionRisk, dailyLoss, drawdown, liquidity, spread, leverage, portfolioExposure, correlation, news), `ABSOLUTE_MAX_LEVERAGE` (3x real / 10x paper, deliberately outside `RiskConfig`), mandatory-stop hard reject. Guarded by `lib/riskManager.test.ts` |
| 13 | Every trading style | **Partial** | 9 strategies in `lib/strategies/`. `grid` and `arbitrage` are v0.9.0 — they vote in the ensemble but **cannot execute** their style. The spec's wider style library (Section 11.2) is not all present |
| 14 | Every strategy | **Partial** | Same 9 modules; the spec's per-strategy template (Section 11.3) is not filled in per strategy |
| 15 | Every learning algorithm | **Partial** | Reflection → Hypothesis (human-gated), Curiosity Engine, backtest optimizer + Monte Carlo + stability scoring. Nothing auto-deploys — safety invariant 5 in `CLAUDE.md` |
| 16 | Every evaluation metric | **Partial** | `lib/learningDashboard.ts` (win rate by origin/condition/regime/weekday/hour, expectancy), `lib/memoryStats.ts`, `lib/backtest/riskMetrics.ts`. Per-agent metrics exist only for the 8 agents with contracts |
| 17 | Every dashboard | **Partial** | `app/dashboard`, `app/audit`, `app/log/[id]` pages plus ~30 panels in `components/`. No written executive-dashboard spec (see `docs/23`) |
| 18 | Every deployment requirement | **Not built** | **Status: not implemented.** No Dockerfile, no CI config, no `.github/`, no deploy manifest, no `.env.example` in the repo. It runs via `npm run dev` / `next build` + `next start` |
| 19 | Every monitoring requirement | **Partial** | `app/api/health/route.ts` (server-side active checks: trade store round-trip + Binance `/ping`), `assessSystemHealth()` rollup, `components/SystemHealthPanel.tsx`, and Agent OS health records. **No alerting/paging and no external uptime probe** — and the Agent OS health records are currently unpopulated (see `docs/03`) |
| 20 | Every coding standard | **Built** | `CLAUDE.md` — "Engineering conventions actually used here" (comments explain *why*; pure logic in `lib/`, side effects in `components/`; deterministic over LLM where the math is real; one store pattern; one LLM-call pattern) plus the verification loop |

### Verification loop (from `CLAUDE.md`)

```bash
npx tsc --noEmit -p tsconfig.json   # must be clean
npm run test                        # vitest; must all pass
npm run build                       # catches route/provider issues tsc won't
```

`npx next lint` is **not** part of the loop — no ESLint config exists, so it
launches a first-run setup wizard. Also note: this environment has no
network route to `api.binance.com`, Yahoo, or exchange APIs, so live data
paths cannot be verified locally.

---

## 3. Specification header template (spec Section 3)

Every spec document under `docs/` should open with this anchor, so any
coding agent reading the folder gets the same framing:

```markdown
# TradingOS AI
Version 3.0

## Mission
Build the world's most advanced autonomous AI trading platform capable of
continuously analyzing cryptocurrency futures markets, making explainable
decisions, preserving capital through rigorous risk management, learning
from validated experience, and operating safely 24/7 under human-defined
governance.

## Core Principles
1. Capital Preservation
2. Explainability
3. Reliability
4. Continuous Learning
5. Safety
6. Modularity
7. Scalability
8. Research Driven
9. Risk First
10. Evidence Based
```

---

## 4. Where to read next

| Question | File |
|---|---|
| Why isn't "$2 → $20" a requirement? | `docs/01_PROJECT_GOAL.md` |
| What is the real architecture and provider tree? | `docs/02_ARCHITECTURE.md` |
| How does the Agent OS runtime work? | `docs/03_AI_OPERATING_SYSTEM.md` |
| Which agents exist, and which have contracts? | `docs/04_AGENT_SPECIFICATIONS.md` |
| How does a tick become a trade? | `docs/05_TRADING_ENGINE.md` |
