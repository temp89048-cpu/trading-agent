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

---

# The AI Operating System

Source files: `lib/agentOS.ts` (684 lines, framework-free kernel) and
`components/AgentRuntime.tsx` (139 lines, React binding).

## 0. Two things this is NOT

**There is no event bus. Status: not implemented.** Verified by search:
nothing in `lib/` or `components/` defines or uses an event bus, publisher,
or subscriber topic. `AgentOS` has a `subscribe()`/`notify()` pair, but it
carries **no payload** — it exists solely to tell React that runtime state
changed so `useSyncExternalStore` re-reads a snapshot. The `AgentContract`
type deliberately has **no** `eventsPublished` / `eventsConsumed` fields,
unlike the spec's Section 5 template. Coordination between subsystems is
React context plus direct function calls.

**The spec's CEO AI → CIO AI → CRO AI → … chain is a responsibility map, not
a deployment topology.** From `CLAUDE.md`: "Those responsibilities are
already implemented as modules. Do not rebuild them as separate services."
What exists instead is a flat registry of 31 agents with a
`category` + `priority` + `dependencies` graph. The nearest thing to a chain
of command is enforced in code, not in an org chart: only the Supervisor may
execute.

**What the Agent OS actually is:** a formal registry, monitoring overlay, and
scheduling *framework* layered on top of the existing React providers. Its
own header says it: *"This sits ALONGSIDE the existing 17 React context
providers — it does not replace them. … Each provider's existing logic
continues to work as-is; the Agent OS tracks and orchestrates them."*

## 1. Types

| Type | Purpose |
|---|---|
| `AgentId` | `string` |
| `AgentCapability` | 33 string literals (`'live-price'`, `'trade-validation'`, `'trade-approval'`, `'mission-planning'`, …) |
| `AgentCategory` | `market-intelligence` \| `strategy` \| `risk` \| `execution` \| `learning` \| `orchestration` |
| `AgentLifecycleState` | `init` \| `ready` \| `running` \| `paused` \| `stopped` \| `error` \| `recovering` |
| `AgentDescriptor` | id, name, version, description, changelog?, capabilities, dependencies, category, priority, tickIntervalMs, **contract?** |
| `AgentContract` | See §5 |
| `AgentPermission` | See §5 |
| `AgentHealthRecord` | See §4 |
| `AgentTickFn` | `(agentId) => void \| Promise<void>` |

## 2. Lifecycle states and transitions

Transitions are validated against `VALID_TRANSITIONS`; an illegal transition
returns `false` and changes nothing.

| From | Allowed to |
|---|---|
| `init` | `ready`, `error` |
| `ready` | `running`, `stopped`, `error` |
| `running` | `paused`, `stopped`, `error` |
| `paused` | `running`, `stopped`, `error` |
| `stopped` | `ready` |
| `error` | `recovering`, `stopped` |
| `recovering` | `ready`, `error`, `stopped` |

Entry points:

- `register(descriptor, tickFn?)` — inserts the agent at `init`, then calls
  `tryReady()`. Re-registering an existing id **updates the descriptor and
  tickFn but preserves the health record**.
- `tryReady(id)` — promotes `init → ready` only if **every** dependency is
  already `ready` or `running`. Registration order therefore matters:
  `AGENT_DESCRIPTORS` is ordered so dependencies register first.
- `pauseAgent` / `resumeAgent` / `stopAgent` — thin wrappers over
  `transitionState`. `resumeAgent` on an `error` agent moves it to
  `recovering`, not `running`.
- `restartAgent(id)` — clears error counters, forces state back to `init`,
  re-runs `tryReady()`, and if the result is `ready` **and** the scheduler is
  running, transitions to `running`.
- `destroy()` — stops the scheduler and clears agents + listeners.
  `resetAgentOS()` discards the singleton (used by tests).

## 3. Scheduler

`startScheduler(tickMs = 1000)` promotes every `ready` agent to `running`,
then runs `tick()` on a base interval. `stopScheduler()` clears the interval
and moves every `running` agent to `stopped`.

Each `tick()`:

1. Computes `getExecutionOrder()` — a DFS topological sort, **seeded by
   ascending `priority`**, so dependencies run before dependents and, among
   independents, lower `priority` numbers first. A cycle is logged with
   `console.error` and broken rather than crashing.
2. For each agent in that order, skips it unless: state is `running`, it has
   a non-null `tickFn`, and `tickIntervalMs !== 0` (0 means on-demand only).
3. Skips if `now - lastScheduledAt < tickIntervalMs`.
4. Skips (does **not** error) if any dependency is not `running`/`ready` —
   "dependency may recover".
5. Runs `tickFn` inside a `try/catch` (sandboxed per agent). Sync throws and
   rejected promises both record a heartbeat **and** an error; success records
   a heartbeat with the measured duration.
6. **Auto-recovery:** any agent in `error` whose `lastErrorAt` is older than
   `RECOVERY_COOLDOWN_MS` (10s) gets `consecutiveErrors` zeroed and is walked
   `error → recovering → ready → running` if its dependencies are still
   healthy; otherwise back to `error`.
7. Calls `notify()`.

### Important honesty note: no agent currently has a `tickFn`

`components/AgentRuntime.tsx` registers every descriptor as
`os.register(descriptor, null)` — the inline comment reads
*"monitoring-only — existing providers handle actual execution."*

Consequences today, verifiable from the code:

- The scheduler's step 2 skips every agent, so **no `tickFn` ever runs**
  through the Agent OS. The real work still happens in each provider's own
  `setInterval` (`Agent.tsx` 3s, `AutonomousTrader.tsx` 60s, candle refresh
  60s, …).
- Therefore `recordHeartbeat()` / `recordError()` are never called in
  production, so `lastHeartbeat` stays `0`, `totalTicks` stays `0`,
  `tickDurationsMs` stays empty, and `getAvgTickDuration()` returns `null`.
- `isStale()` returns `false` whenever `lastHeartbeat === 0` ("never ticked
  yet"), so staleness detection is inert until real tick functions are wired
  in.
- What *is* live and useful: the registry, the dependency graph and its
  validation, lifecycle state (`init → ready → running` at startup), operator
  pause/resume/restart/stop, capability discovery, and
  `contractCoverage()`.

Wiring real `tickFn`s is the natural next step; `tickIntervalMs` values in
the descriptors already document each agent's intended cadence.

## 4. Heartbeat / health records

```ts
type AgentHealthRecord = {
  agentId: AgentId;
  lastHeartbeat: number;        // 0 = never ticked
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveErrors: number;
  totalTicks: number;
  totalErrors: number;
  tickDurationsMs: number[];    // rolling window
  status: AgentLifecycleState;
};
```

Constants: `MAX_CONSECUTIVE_ERRORS = 5` (→ `error` state),
`RECOVERY_COOLDOWN_MS = 10_000`, `TICK_DURATION_HISTORY = 20`,
`STALENESS_MULTIPLIER = 3` (stale if elapsed > 3× `tickIntervalMs`),
`TICK_WARN_DURATION_MS = 1000` (a slower tick logs a `console.warn`).

Readers: `getHealth`, `getAllHealth`, `getAvgTickDuration`, `isStale`.

## 5. `AgentContract` and `AgentPermission` (spec Section 5, in code)

The contract lives in the descriptor rather than only in prose, for a stated
reason: *"a contract that lives in markdown drifts silently from the code,
whereas one that lives in the descriptor is visible in the Agent OS panel,
greppable, and type-checked."*

```ts
type AgentContract = {
  purpose: string;            // one sentence
  inputs: string[];
  outputs: string[];
  permissions: AgentPermission[];
  memory: string;             // 'none' is a valid, common answer
  metrics: string[];
  failureRecovery: string;    // must describe safe degradation
  healthCheck: string;
  explainability: string;     // non-negotiable, even for mechanical agents
};
```

`contract` is **optional** on `AgentDescriptor` on purpose — so descriptors
can be filled in incrementally instead of via one big migration — and
`contractCoverage()` reports which ones are missing.

### `AgentPermission` — the field that matters for safety review

| Permission | Meaning |
|---|---|
| `read-market-data` / `read-trade-log` / `read-portfolio` | Read-only analysis. The overwhelming majority of agents |
| `emit-signal` | Produces an opinion something else may act on — explicitly **not** permission to act on it |
| `propose-trade` | Proposes a trade that must still pass the Supervisor gate |
| `execute-trades` | **The single execution authority.** Only the Supervisor holds this |
| `veto-trade` | Can reject a proposed trade |
| `write-store` | Writes to a persistent store under `.data/` |
| `call-llm` | Calls an external LLM API |
| `human-gated` | Requires an explicit human action before its output takes effect |

## 6. `contractCoverage()` and the sole-execution-authority check

```ts
export const SOLE_EXECUTION_AUTHORITY: AgentId = 'supervisor';

export function contractCoverage(descriptors: AgentDescriptor[]): {
  total: number;
  withContract: number;
  missing: AgentId[];
  unexpectedExecutionAuthority: AgentId[];  // should always be empty
};
```

It does two jobs:

1. **Reports the gap rather than asserting it closed.** The spec says every
   agent must have a full contract "before it's built"; this function makes
   the actual number visible in the Agent OS panel. Current state: **31 total,
   8 with a contract, 23 missing** (see `docs/04`).
2. **Flags a second execution authority.** Any descriptor whose
   `contract.permissions` includes `'execute-trades'` while its id is not
   `'supervisor'` lands in `unexpectedExecutionAuthority`. Per the module's
   own comment this is "a review-stopping finding, not a warning," and it
   mirrors `CLAUDE.md` safety invariant 1. Current state: **empty** — only
   `supervisor` declares `execute-trades`.

## 7. Dependency graph API

| Method | Behavior |
|---|---|
| `getExecutionOrder()` | Topological order, priority-seeded; logs and breaks cycles |
| `getDependents(id)` | Direct dependents of an agent |
| `validateDependencies()` | Returns a list of issue strings: dependencies on unregistered ids, and circular-dependency paths rendered as `a → b → a` |
| `findByCapability(cap)` / `findByCategory(cat)` / `hasCapability(id, cap)` | Capability discovery |

Note a real quirk worth knowing: `mission-planner` has `priority: 3` but
depends on `supervisor` (`priority: 9`). The topological sort still orders
`supervisor` first — dependency order dominates priority. Priority only
seeds the DFS entry order.

## 8. The React binding — `components/AgentRuntime.tsx`

`AgentRuntimeProvider` is the **outermost** provider in `app/layout.tsx`
(it depends on nothing else).

- Gets the singleton via `getAgentOS()` in a `useMemo`.
- Exposes state through `useSyncExternalStore`, with a **cached snapshot in a
  ref**: `getSnapshot` must return a referentially stable object, so the
  snapshot is only rebuilt inside the `subscribe` callback when the OS calls
  `notify()`, then `onStoreChange()` fires. `EMPTY_SNAPSHOT` is a stable
  module constant used as the SSR/server snapshot.
- On mount: registers all `AGENT_DESCRIPTORS` (with `null` tickFn), calls
  `startScheduler(1000)`, refreshes the snapshot; on unmount calls
  `stopScheduler()`.
- Context value: `snapshot`, `pauseAgent`, `resumeAgent`, `restartAgent`,
  `stopAgent`, `getHealth`, `getStatus`, `isStale`, `getAvgTickDuration`,
  and the raw `os`.

UI surface: `components/AgentOSPanel.tsx`.
