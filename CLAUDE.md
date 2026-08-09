# TradingOS AI — Project Instructions

This file is read automatically every session. It is the persistent
instruction layer described in `TradingOS-Engineering-Spec-and-Prompts.md`
Section 21, adapted to the architecture that **actually exists here** —
not the idealized one in the spec. Where the two differ, this file wins,
because it is kept in sync with the code.

Supporting long-term context lives in `docs/`. Read the relevant file
before working in a domain.

---

## Mission

An autonomous AI trading platform that continuously analyzes markets,
makes explainable decisions, preserves capital through rigorous risk
management, learns from validated experience, and operates under
human-defined governance.

## Core principles

1. Capital preservation
2. Explainability
3. Reliability
4. Continuous learning
5. Safety
6. Modularity
7. Scalability
8. Research-driven
9. Risk first
10. Evidence-based

## Primary objective

Seek long-term, risk-adjusted capital growth through disciplined trading.

**Do NOT optimize for a guaranteed return multiple** (e.g. "turn $X into
$Y"). That is a financial outcome, not an engineering requirement, and
encoding it as a hard objective pushes the system toward unsafe
risk-taking. A `capital-target` Mission exists so a user can *state* such
a goal and track progress toward it, and it deliberately has no deadline
and only ever produces advisory caution notes — never a hard rule, never
a sizing override. Keep it that way.

---

## What this codebase actually is

A **single-process Next.js 14 app** (App Router, React 18, TypeScript,
Tailwind). Not microservices. Not an event bus. State lives in React
context providers under `components/`; pure logic lives in `lib/`;
persistence is JSON files under `.data/` via `lib/*.server.ts`, plus
`localStorage` for client state.

The spec describes an event-driven microservice org chart (CEO AI → CIO
AI → CRO AI → …). **That is a description of responsibilities, not a
deployment topology to build.** Those responsibilities are already
implemented as modules. Do not rebuild them as separate services — the
spec's own Master Prompt says "Do NOT rebuild existing systems. Reuse
existing modules."

`db/schema.sql` is a **future Postgres migration target**, not wired up.
Nothing reads it today.

### Provider tree matters

`app/layout.tsx` nests providers in a specific order, and React context
only flows **downward**. This has real consequences that have already
bitten:

- `components/Supervisor.tsx` sits **above** `AppStateProvider`, so it
  **cannot** call `useAppState()`. Config it needs (risk limits, real
  starting capital, second-opinion model) lives in
  `components/TradingControls.tsx`, which is mounted above it precisely
  for this reason.
- `components/AutonomousTrader.tsx` sits **below** `AgentProvider`
  because it calls `startAgent()`.
- Memory/Reflection data cannot currently reach `Supervisor.tsx` for this
  same structural reason. That is a known, documented gap — see
  `docs/07_MEMORY_SYSTEM.md`. Do not "fix" it by restructuring the tree
  without checking every provider's dependencies first.

Before adding a provider, work out where it must sit and say so in a
comment.

### The ref-in-interval pattern

Any provider running a `setInterval` created once (e.g.
`useEffect(..., [hydrated])`) must read live values through refs
refreshed every render, never by closing over state directly. Otherwise
it permanently reads mount-time values. See `components/Agent.tsx`'s
`ticksRef`/`getCandlesRef` and copy that pattern.

---

## Safety invariants — never break these

These are enforced in code, and there are tests that exist specifically
to keep them enforced. Breaking one is a serious regression, not a
refactor.

1. **No AI-initiated trade may bypass the Supervisor gate.**
   `components/Supervisor.tsx`'s `reviewAndExecute()` is the single
   execution path for every AI-originated trade (chat trade-action,
   agent-plan ticks, Debate "Act on this", the autonomous loop). Manual
   human clicks are deliberately out of scope — supervising agents means
   supervising agents, not overriding the operator.

2. **The leverage ceiling is not overridable.**
   `ABSOLUTE_MAX_LEVERAGE` (3x real / 10x paper) in `lib/riskManager.ts`
   is deliberately **not** part of `RiskConfig`, so no setting, agent, or
   confidence level can raise it. It is checked before any stop-distance
   math so a tight stop cannot compute past it. Do not move it into
   `RiskConfig`.

3. **Every position requires a computed stop-loss.** If no stop can be
   computed (no ATR), `validateTrade()` hard-rejects. Do not soften this
   back to a non-blocking `'unavailable'`.

4. **Closes/exits are never blocked.** Not by pause, not by risk checks,
   not by a Debate veto. Refusing to let someone exit a position they are
   already in is actively harmful. This holds for real money more, not
   less.

5. **Learning never auto-deploys.** Reflection → Hypothesis produces
   *understanding*. A hypothesis reaching production requires an explicit
   human click. `Loss → AI rewrites strategy → Live` must remain
   impossible. Nothing in `lib/hypothesis*` or `lib/curiosityEngine.ts`
   may write to production risk config or strategy selection.

6. **Never fabricate market data.** No invented prices, fills, or
   indicator values. If something isn't computable, say so honestly and
   return `null`/`'unavailable'` rather than a plausible number. This
   codebase's comments are full of this discipline — match it.

---

## Engineering conventions actually used here

- **Comments explain *why*, especially non-obvious tradeoffs and past
  bugs.** This codebase documents root causes inline so regressions
  don't recur (see `components/Agent.tsx`'s React Strict Mode
  double-invocation comment). Match that density; don't strip it.
- **Pure logic in `lib/`, side effects in `components/`.** Decision
  functions (`agentTick`, `scoreOpportunity`, `moderate`,
  `validateTrade`) are pure and unit-tested. Keep them that way — pass
  computed context in rather than reaching for I/O.
- **Deterministic over LLM where the math is real.** The Debate
  moderator, opportunity scanner, and curiosity engine are deliberately
  pure computation, not model calls — asking a model to "reason over"
  numbers already on hand adds hallucination risk to a financial
  decision for no benefit and isn't reproducible. Reserve LLM calls for
  genuine judgment (chat, reflection, hypothesis, second opinion).
- **Stores follow one pattern:** `lib/<name>Store.server.ts`, JSON under
  `.data/`, lazy file creation, a serialize() promise queue against write
  races. Copy an existing one.
- **New LLM call?** Reuse the `/api/chat` + `readSSEStream` buffering
  pattern from `components/Reflection.tsx`. There is no separate
  non-streaming endpoint.

## Verification — run these

```bash
npx tsc --noEmit -p tsconfig.json   # must be clean
npm run test                        # vitest; must all pass
npm run build                       # catches route/provider issues tsc won't
```

`npx next lint` will try to run a first-time ESLint setup wizard (no
config exists) — it is not part of the verification loop.

**Note:** this environment has no network route to `api.binance.com`,
Yahoo, or exchange APIs. Live data paths cannot be verified here; say so
plainly rather than claiming they work.

---

## Output expectations

When implementing a feature: analyze the current architecture first,
explain the design, name affected modules, then write production-ready
code **with tests, honest comments, and failure handling**. Describe
risks and how to roll back. Ask rather than guess when a decision is the
user's to make. Never invent functionality that conflicts with what's
already here.
