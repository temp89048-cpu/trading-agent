# 20 — Deployment & Monitoring

**Status: partial.** Health checks, heartbeats, and a silence watchdog are
implemented. Distributed workers, failover, alerting, and auto-restart
are **not**. This file states which is which, because the gap here is the
difference between "runs on your desktop" and "runs 24/7 unattended."

Spec Section 22.8's design target: *"Assume the worst case is not 'the
bot makes a bad trade' but 'the bot goes silent while holding a leveraged
position.'"*

---

## Running it

```bash
npm run dev     # local development
npm run build   # production build — also catches route/provider errors tsc misses
npm start       # serve the production build
```

Verification loop (all three must pass):

```bash
npx tsc --noEmit -p tsconfig.json
npm run test
npm run build
```

`npx next lint` triggers a first-time ESLint setup wizard (no config
exists) and is not part of the loop.

**This environment has no network route** to `api.binance.com`, Yahoo, or
exchange APIs. Live data and real order paths cannot be verified here.

---

## What monitoring exists

| Surface | Implementation | Covers |
|---|---|---|
| Health endpoint | `app/api/health/route.ts` | Server-side: exercises the trade store, checks Binance reachability |
| System health panel | `components/SystemHealthPanel.tsx` | Candle feed presence, last-fetch error, staleness; MCP server status |
| Agent heartbeats | `lib/agentOS.ts` | Per-agent `lastHeartbeat`, `consecutiveErrors`, tick durations, `isStale()` |
| Health rollup | `lib/supervisorAgent.ts`'s `assessSystemHealth()` | Aggregates signals into healthy / degraded / unhealthy |
| Contract coverage | `contractCoverage()` in `lib/agentOS.ts`, shown in `components/AgentOSPanel.tsx` | Which agents lack a declared contract; unexpected execution authority |
| **Silence watchdog** | `lib/watchdog.ts` → `components/AutonomousTraderPanel.tsx` | Detects a stopped autonomous loop, escalates when exposure is open |
| Retry/backoff helpers | `lib/watchdog.ts`'s `backoffDelayMs` / `shouldRetry` | Pure, testable backoff schedule for **read** paths |

### The watchdog, specifically

`assessWatchdog()` grades each monitored loop against **its own expected
interval** (not a fixed wall-clock), tolerating up to 3 missed cycles
before warning and 10 before calling it stopped. Single late ticks are
normal — browsers throttle background timers, and alerting on that would
train the operator to ignore the warning.

The case it exists for is `silentWithOpenRisk`: a stale loop **plus** open
positions. That combination is escalated to critical on its own, because
stop-losses in this app are enforced by a loop evaluating live prices —
they are **not resting orders held by the exchange**. While the loop is
stopped, nothing will close a position moving against you.
`describeSilentRisk()` says exactly that, in those terms.

Deliberately **not** applied to order placement: retrying a write whose
response was lost is how duplicate fills happen. That path is protected
by the deterministic idempotency key in `lib/executionQuality.ts`
instead — a retry must reuse the same key, not back off and hope.

---

## Gaps — stated plainly

These are real limitations, not oversights to be discovered later.

- **Every loop is a client-side `setInterval`.** The autonomous trader
  (60s), agent tick (3s), mission evaluation (30s), research/curiosity
  (15m), market intel and event detection all stop when the tab closes,
  the machine sleeps, or the browser throttles hard enough. The watchdog
  makes this *visible* but cannot fix it.
- **Stop-losses are not exchange-native.** They exist as intent evaluated
  by the tick loop. A resting stop order on the exchange would survive
  the app being closed; that is the single highest-value reliability
  change available and is not implemented.
- **No server-side execution.** Genuine 24/7 operation needs the loops
  moved to a server process (or a cron/queue), which this single-process
  Next.js app does not have.
- **No alerting.** Nothing emails, pushes, or pages. The watchdog warning
  is only visible if someone is looking at the panel — which is a real
  limitation given the failure mode is "nobody is looking."
- **No auto-restart / crash recovery.** `lib/agentOS.ts` models a
  `recovering` lifecycle state and restart transitions, but there is no
  supervising process to restart anything after a real crash.
- **No exchange failover or redundant data providers.** One preferred
  exchange globally; one candle source per asset class.
- **`.data/` is not durable on serverless.** JSON files on the local
  filesystem — genuinely persistent for local/self-hosted use, ephemeral
  on Vercel and similar. `db/schema.sql` is an unwired Postgres migration
  target.
- **No event sourcing / distributed tracing.** The decision store is
  append-only, which gives an audit trail, but not replayable event
  sourcing.
- **No CI.** Tests and typecheck are run manually.
- **Secrets in `localStorage`, plain text.** No rotation, no encryption.
  Acceptable for single-user localhost; not otherwise.

## If you intend to run this unattended

In rough order of risk reduction per unit of work:

1. Place real stop-loss orders on the exchange at entry, so exposure is
   protected independently of this app running.
2. Move the autonomous loop server-side.
3. Add alerting on `silentWithOpenRisk`.
4. Migrate `.data/` to Postgres (`db/schema.sql`).
5. Add CI running the three verification commands.

Until at least (1), treat the autonomous loop as something to run while
watching, on paper — not as unattended infrastructure.
