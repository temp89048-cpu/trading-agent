# Frontend Replacement — Analysis & Plan

Deliverable for `REPLACE-FRONTEND-WITH-REFERENCE-UI.md`'s **FINAL COMMAND**: the
written report required *before* any replacement code. Five sections, in the order
that document asks for them.

Status: **Stage A (foundations) complete and verified** — see the BUILD LOG at the
end. Stages B (composite components), C (25 routes) and D (hardening) remain.
No legacy route has been removed: all six are still live.

---

## 1. Reference file summary — read and confirmed against §1–§4

`trading-agent-control-center.html` — 1,594 lines / 104 KB, self-contained, no build
step. **Note:** it sits at the repo root, not `/design-reference/`. It should be moved
to `/design-reference/trading-agent-control-center.html` as §0 specifies, so the path
referenced throughout the command file resolves.

### 1.1 Design system (lines 8–141) — three themes, exact tokens

| Token | Terminal (`:root`) | Aurora (`[data-theme="aurora"]`) | Platinum (`[data-theme="platinum"]`) |
|---|---|---|---|
| `--bg-app` | `#0A0B0D` | `#0D0D14` | `#0E0D0C` |
| `--bg-surface` | `#111318` | `#15141F` | `#171512` |
| `--bg-surface-2` | `#16181F` | `#1A1926` | `#1C1917` |
| `--border` / `--border-strong` | `#23262E` / `#2E323C` | `#26243A` / `#37344F` | `#2B2723` / `#3D3831` |
| `--text-primary/secondary/muted` | `#E7E9EE` / `#8A8F9C` / `#5B606B` | `#EDEBF5` / `#9B96B8` / `#66628A` | `#F1ECE0` / `#B0A491` / `#726A5C` |
| `--accent` / `--accent-2` | `#3B82F6` / `#3B82F6` | `#7C6FE0` / `#B8659A` | `#C9A961` / `#E8CE8E` |
| `--positive` / `--negative` / `--warning` | `#16C784` / `#EA3943` / `#F0B90B` | `#3FBF98` / `#D5657A` / `#D6A75B` | `#5FA98A` / `#B5636F` / `#C9A961` |
| `--orb-opacity` | `0` | `.28` | `.10` |

Confirmed as §3 describes: Aurora's ambient values are already toned down (orb `.28`,
card tint `.05` alpha, node glow `.28` alpha) and must not be re-intensified; Platinum
is near-zero decoration (`.10`).

Shared component classes to port: `.card`, `.card-2`, `.hairline`, `.navlink`,
`.badge`, `.dot`, `.pulse`, `table.term`, `.num`, `.chip`, `.gauge-track`,
`.modal-backdrop`, `.flow-node`/`.flow-edge` (+ `st-*` status modifiers and the
`flowmove` keyframe), `.journey-*`, `.ticker-strip`, `.hero-num`, `.step-pill`/
`.step-connector`, `.swarm-box`, `.bubble`, `.avatar`, `.live-dot`, `.btn-live`,
`.news-item`, `.log-line`, `.analysis-bar-label`.

`color-mix(in srgb, …)` is used for every tinted background (`badge()`, `.step-pill.active`,
`.btn-live`, `livepulse`). §3 flags this as a deliberate bug fix — **must not** revert to
concatenated hex+alpha.

### 1.2 Information architecture — 25 routes in 10 sidebar sections

`NAV` (line 437) exactly matches §2's route list. 24 `PAGES.*` functions plus
`PAGES['strategy-perf']`.

### 1.3 Component inventory — confirmed against §4

`badge`, `pnlClass`, `fmt`, `sparkline`, `candles`, `gauge`, `edgeSvg`, `flowDiagram`,
`journeyStep`, `journeyConnector`, `tradeJourney`, `execCycle`, `swarmSVG`, `statCard`,
`marketCard`, `pmCard`, `openPositionDetail`, `openDecision`, `replayToggle`/`replayStep`/
`selectSpeed`, `field`, `renderSidebar`, `navigate`, `selectAsset`, `selectTf`,
`openEstop`/`closeEstop`, `showJourneyModal`/`showPositionJourney`/`showHistoryJourney`,
`LIVE_STAGES`/`liveStageRow`/`newsItemHtml`/`analysisHtml`/`openLiveInspector`/
`closeLiveInspector`, `confirmAction`, `toggleCmd`/`bubbleHtml`/`renderAllChatViews`/
`newChat`/`askAgent`, `THEMES`/`toggleTheme`.

### 1.4 Mock data inventory — this is the real specification of what the backend must supply

`MOCK` (line 287) contains: `markets`, `positions`, `orders`, `execFlow` (7 stages),
`agentNodes`, `decisions`, `decisionDetail.{signals,risk}`, `strategies`, `risk` +
`risk.checks`, `learning` + `learning.failures`, `systemServices`, `logs`, `newsFeed`
(per asset), `liveLogTemplates` (14 templates), `polymarket` (8 questions).

**The reference trades ETHUSDT / SOLUSDT / DOGEUSDT.** The backend's Polymarket poller
watches `BTC/USDT, ETH/USDT`, and `funding_change` / `oi_spike` triggers are
**BTC-only by construction** (`triggers.BTC_ONLY_TRIGGERS`). This mismatch has to be
resolved before `/markets`, `/intel` or `/polymarket` are built — see §4, gap G0.

### 1.5 Simulated behaviour to replace (§5)

| Reference simulation | Line | Real replacement |
|---|---|---|
| `flowmove` CSS on `.flow-edge.active` | 100 | current-node from the LangGraph run stream |
| `pushLine()` + `liveInterval` (1.5 s) | 1495 | granular agent-action stream — **does not exist**, see G6 |
| `MOCK.newsFeed[asset]` | 1489 | per-asset news with sentiment + relevance — **does not exist**, see G5 |
| `MOCK.polymarket` filtered by `cat` | 1487 | `/api/polymarket/*` — exists, different shape, see G4 |
| `swarmSVG()` procedural | 578 | no backing data — label illustrative per §5 |
| `sparkline()` / `candles()` `Math.random()` | 463/470 | `lightweight-charts` (already a dependency) |
| `confirmAction()` `alert()` | 1528 | real mutations (`/api/admin/*`, close-position) |

---

## 2. Repository audit (Phase 6)

### 2.1 Stack

| Item | Value |
|---|---|
| Framework | Next.js **14.2.35**, App Router |
| React / TS | 18.3.1 / 5.4.5 |
| Styling | Tailwind **3.4.3** + CSS custom properties in `app/globals.css` |
| Charts | **`lightweight-charts` ^5.2.0 already installed.** No Recharts. |
| Tests | vitest ^4.1.10 — 16 files, 281 tests passing |
| Lint | `next lint` — **no ESLint config exists**; it launches a first-time setup wizard and is not part of the verification loop (CLAUDE.md) |
| Backend | FastAPI, **57 endpoints**, + 23 Next.js route handlers reading `.data/` JSON |

### 2.2 Existing frontend surface

- **7 routes**: `/`, `/dashboard`, `/audit`, `/backtest`, `/glassbox`, `/log`, `/log/[id]`.
  The reference needs **25**. This is an IA expansion of ~3.5×, not a reskin.
- **73 components**, **84 lib modules**.
- `/` is a single dense terminal driven by `components/TradingSidebar.tsx` with 10
  `CollapsibleGroup`s — much of the reference's per-route content already exists as
  *panels inside one page*. Roughly 30 of the 73 components map onto reference sections
  and can be **rewired rather than rewritten**.

### 2.3 The two constraints that shape everything

**(a) `app/layout.tsx` nests 22 providers and the order is load-bearing.**
CLAUDE.md documents the consequences: `Supervisor.tsx` sits *above* `AppStateProvider`
so it cannot call `useAppState()`; `AutonomousTrader` sits *below* `AgentProvider`
because it calls `startAgent()`; Memory/Reflection cannot reach `Supervisor` at all.
The new `AppShell` must mount **inside** this tree, and any new store must have its
position justified in a comment. Restructuring the tree to suit the new IA is the
single highest-risk action available and is explicitly out of scope.

**(b) The design tokens are completely different names.**

| Existing | Reference |
|---|---|
| `--bg-0/1/2/3`, `--line` | `--bg-app`, `--bg-surface`, `--bg-surface-2`, `--border`, `--border-strong` |
| `--txt-0/1/2` | `--text-primary/secondary/muted` |
| `--cyan`, `--amber`, `--green`, `--red` | `--accent`, `--accent-2`, `--positive`, `--negative`, `--warning` |

Tailwind maps the old names (`bg-bg2`, `text-txt2`, `border-line`, `text-cyan`), so
**all 73 components reference tokens that will not exist** after the port. Two options:

1. Add the reference tokens *alongside* the old ones and map old → new in
   `globals.css`, so existing components keep rendering while routes are migrated
   one at a time. **Recommended** — it is what makes §8's "replace route by route,
   never both live at once" achievable.
2. Big-bang rename. Rejected: it breaks all 73 components simultaneously, which
   violates §0's "keep the old page live until its replacement is verified".

Also: the existing theme is a **cyan/amber glassmorphism** look (`.glass-panel`,
`backdrop-filter`, radial gradients on `body`). Terminal theme is the opposite —
"no gradients, no glow". The body gradients in `globals.css` must become
theme-conditional, not deleted, until the last old route is retired.

### 2.4 Realtime infrastructure — already correct

`lib/agentEventStream.ts` is **already** the Phase 5 architecture: one module-scope
WebSocket, reference-counted by subscriber, last unsubscribe closes it. Its header
documents two bugs it exists to prevent — five components each opening their own
socket, and a reconnect timer that fired after unmount.

So §5 is largely **satisfied, not to be built**. What is missing is the *router* and
*store slices* between the socket and components: today consumers filter the raw event
buffer themselves.

`lib/backendConfig.ts` exists with `BACKEND_PATHS` + `agentEventsWsUrl()` +
`graphStreamWsUrl()`. **It is consumed by exactly two files** — `lib/agentEventStream.ts`
and `components/PolymarketPanel.tsx` (added this session). The graph paths are declared
and read by nothing, which is the exact "reachable but unread" gap recorded in
`POLYMARKET_INTEGRATION_PLAN.md`.

---

## 3. Backend contract discovery (Phase 7)

### 3.1 Confirmations §FINAL COMMAND explicitly asks for

**Does a Polymarket analysis module exist in the backend?** **Yes** — built and verified
this session (Phases 32–38 + 32b, `POLYMARKET_INTEGRATION_PLAN.md`). It exposes 7
endpoints under `/api/polymarket`. What it outputs:

```
GET /api/polymarket            enabled, adapterAvailable, mappingsDiscovered/Confirmed, series summary
GET /api/polymarket/snapshots  per symbol: applicable, fresh, ageSeconds,
                               directional{direction,confidence,driftPct,expectedPrice,
                                           spot,bucketsUsed,horizonSeconds,observation},
                               eventRisk{concern,key,probability,uncertainty,proximity,observation}
GET /api/polymarket/mappings   symbol→outcome mappings, role, confirmed, directionalBasis
GET /api/polymarket/signals    6-signal inventory + declared-unimplemented + thresholds
GET /api/polymarket/series     probability history per outcome
POST /mappings/confirm         the human gate (auth)
POST /discover/{symbol}        auth; refuses while disabled
```

**Live state right now: `mappingsConfirmed: 0`, `trackedOutcomes: 0`, and both
snapshots read `applicable: false`.** The feed is wired end to end and returns no
market data, because §8's reachability probe has never run (no route to Polymarket
from this environment). See G4.

**Does a news/research node exist?** **In the backend, no.**
`graphs/triggers.UNAVAILABLE_TRIGGERS["news_event"]` states it plainly: *"No backend
news feed exists. A news source is implemented on the TypeScript side (app/api/news)
but nothing in backend/ consumes it."* `specialist_news` ships `available=False`.
`app/api/news/route.ts` fetches public RSS server-side and returns
`{title, link, source, pubDate}` — **no sentiment, no relevance, no per-asset tagging.**

### 3.2 Per-route contract table

| Route | Backend source | Verdict |
|---|---|---|
| `/home` | `/api/dashboard`, `/api/dashboard/portfolio`, Next `/api/stats`, `/api/trades` | PARTIAL — no all-time-PnL or biggest-win aggregate; derivable from `trades.json`. Swarm has no source. |
| `/dashboard` | `/api/dashboard`, `/api/market/prices`, `/api/graphs`, `/api/graphs/nodes`, WS | PARTIAL — flow diagram real; "Recent Events" from agent WS. |
| `/markets` | `/api/market/klines/{symbol}`, `/api/market/price/{symbol}`, `/api/market/analysis/{symbol}`, Next `/api/candles` | COMPLETE-able. Funding/OI are **BTC-only**. |
| `/intel` | `/api/market/regime/{symbol}`, Next `/api/marketintel` | PARTIAL — correlation exists in `algorithms/market_graph.py` but has **no endpoint**. |
| `/polymarket` | `/api/polymarket/*` | PARTIAL — shape differs from reference (G4); currently returns no markets. |
| `/positions` | `/api/dashboard/portfolio`, `/api/graphs/positions` | COMPLETE-able. |
| `/orders` | — | **BLOCKED**. No orders endpoint or store. `/api/execution` is fills/audit, not an order book. |
| `/history` | Next `/api/trades`, `/api/trades/[id]` | COMPLETE-able. |
| `/execution` | `/api/execution`, `/api/execution/audit` | PARTIAL — 7-stage `execFlow` must map onto the real TAR pipeline; latency/slippage present in audit records. |
| `/agent` | `/api/graphs`, `/api/graphs/nodes`, `/api/graphs/runs`, WS `/api/graphs/stream` | COMPLETE-able — **the strongest-supported page.** 27 nodes with contracts, 9 specialists, ensemble confidence. |
| `/decisions` | Next `/api/decisions`, `/api/graphs/runs/{id}` | COMPLETE-able. Decision Inspector's signal/risk factors map to `specialists[]` + `risk.checks`. |
| `/agent/timeline` | WS agent events | COMPLETE-able. |
| `/chat` | Next `/api/chat` (client-supplied key → OpenAI-compatible upstream, default `z-ai/glm-5.2`) | PARTIAL — works **only if the user configures a key in Settings**. The *backend* LLM provider is `null`/unavailable, so no server-side chat. |
| `/strategies` | — | **BLOCKED**. `algorithms/strategy_profiles.py` has 11 profiles + 15 planned, and `agents/strategy_ensemble.py` votes — but **no endpoint exposes either**. |
| `/strategies/performance` | Next `/api/trades`, `/api/backtest` | PARTIAL — equity curve derivable from trades; per-regime breakdown needs regime stamped on each trade. |
| `/risk` | `/api/admin/status`, `/api/dashboard/portfolio` | PARTIAL — `core/risk_manager.py` has 9 checks but they are computed **inside a graph run**, not exposed as a standing risk snapshot. |
| `/exposure` | `/api/dashboard/portfolio` | COMPLETE-able. |
| `/learning` | `/api/memory/*`, `/api/research/*`, Next `/api/reflections`, `/api/hypotheses` | COMPLETE-able. |
| `/learning/failures` | Next `/api/reflections` | PARTIAL — clustering by asset/strategy/regime is **not computed anywhere**; would be client-side grouping. |
| `/learning/trades` | Next `/api/trades` | COMPLETE-able. |
| `/replay` | — | **BLOCKED**. `backend/tools/replay_engine.py` exists; no endpoint. `.data/graph_traces/` + `graph_checkpoints.sqlite` hold the data. |
| `/backtesting` | Next `/api/backtest`, `/montecarlo`, `/optimize` | COMPLETE-able (TS-side engine). |
| `/system` | `/api/monitoring` | PARTIAL — returns **one** check (`FastAPI Core`) + agent heartbeats. The reference shows **8 named services** with latency/errors/uptime. No per-service telemetry exists. |
| `/logs` | `/api/execution/audit` | PARTIAL — audit records are execution-scoped, not app-wide levelled logs. No level/service filter source. |
| `/settings` | `localStorage` via `AppState` + `TradingControls` | COMPLETE-able (client-side, as today). |
| Top bar | `/api/admin/status`, `/api/exchange/status`, `/api/dashboard` | COMPLETE-able. |
| Emergency Stop | `POST /api/admin/emergency-stop`, `/pause`, `/resume` | **COMPLETE** — all three exist. |
| Live Agent Inspector | WS + `/api/polymarket/snapshots` + Next `/api/news` | PARTIAL — see G5/G6. The three panels are the specific thing §9 requires be individually labelled. |

---

## 4. Gap list — reference elements with no backend support today

| # | Gap | Severity | §7 resolution |
|---|---|---|---|
| **G0** | Reference trades **ETH/SOL/DOGE**; backend watches **BTC/ETH**, and funding/OI triggers are BTC-only | **Decide first** | Operator decision — not a code gap. Either retarget `WATCH_SYMBOLS` or build the UI for BTC/ETH. |
| **G1** | **No orders endpoint/store** | High | (3) minimal backend addition — `/orders` is a whole route |
| **G2** | **No strategies endpoint** — data exists, unexposed | High | (3) thin read-only router over `strategy_profiles` + `strategy_ensemble` |
| **G3** | **No replay endpoint** — engine + traces exist, unexposed | Medium | (3) or mark BLOCKED |
| **G4** | Polymarket **relevance score per question** does not exist. Backend computes `directional.confidence` and `eventRisk.concern`; the reference wants a 0–1 relevance per market, plus `vol`/`liq`/`chg`/`closes` per question | Medium | (1) derive: `concern` for event-risk markets, `confidence` for directional. `volume` is on the ccxt payload but **not persisted** in the snapshot |
| **G5** | News has **no sentiment or relevance or per-asset tagging** | Medium | (2) omit the sentiment badge and relevance gauge, or (3) add scoring. **Do not fabricate.** |
| **G6** | **No granular per-action agent event stream** — only node-level | Medium | §5 says say so explicitly. Node-level events can drive the console honestly at coarser granularity; label it. |
| **G7** | **No per-service telemetry** — `/api/monitoring` has 1 check vs 8 services shown | Medium | (2) render only real checks |
| **G8** | **No app-wide levelled log store** | Medium | (2) scope `/logs` to the audit trail and label it |
| **G9** | **Agent Swarm has no backing data** | Low | §5/§4 pre-authorise labelling it illustrative of the model ensemble |
| **G10** | **No standing risk snapshot** — the 9 checks run inside a graph run | Medium | (1) surface the last run's `risk.checks` via `/api/graphs/runs`, labelled with its timestamp |
| **G11** | **No correlation endpoint** | Low | (1) `/intel` correlation from `market_graph.py` needs a route, or omit |
| **G12** | **Backend LLM provider is `null`** | Medium | `/chat` works via client key; server-side agent narration does not. State it. |
| **G13** | **Per-regime / per-timeframe P&L** requires regime stamped on each trade | Low | (2) omit those breakdowns |
| **G14** | **No mobile breakpoints in the reference** (§8.21) | Low | New work, not a port |

**Nothing in the reference is fabricated data I am willing to ship.** Every gap above
resolves to derive / omit-and-label / propose-a-minimal-addition, per §7's ordering.

---

## 5. Implementation plan (Phase 8 order)

### Stage A — foundations (no route replaced yet)

1. **Move the reference** to `/design-reference/trading-agent-control-center.html`.
2. **Token layer.** Add the three theme blocks with reference variable names to
   `globals.css`; extend `tailwind.config.ts` with the new names; map old → new so
   existing components keep working. Make the `body` radial gradients
   theme-conditional. `ThemeToggle` + `localStorage` persistence, default Terminal,
   cycle Terminal → Aurora → Platinum.
3. **Primitive components** (`components/ui/`): `Badge`, `Gauge`, `StatCard`, `Chip`,
   `Card`, `TermTable`, `Mono`. One `Badge` for the whole app, `color-mix()` tints.
4. **Realtime router + store.** Layer an event router and typed store slices *on top of*
   `lib/agentEventStream.ts` — do not open a second socket. Add the
   `graphStreamWsUrl()` consumer that currently does not exist.
5. **AppShell**: `Sidebar` (10 sections, 25 links) + `TopBar` + `<main>`, mounted
   **inside** the existing 22-provider tree. All 25 routes created as placeholder pages
   that render `NOT YET MIGRATED` and link to the old route.

**Checkpoint:** `tsc`, `vitest`, `next build`, and every existing route still renders.

### Stage B — composite components

6. `FlowDiagram` + `edgeSvg` (driven by the graph stream), `TradeJourney`,
   `ExecCycleStepper`, `MarketCard`, `PolymarketCard`, `CandlestickChart`
   (lightweight-charts), `AgentSwarmViz` (labelled illustrative), `CommandDrawer`,
   `EmergencyStopModal` (type-`STOP`-to-confirm).

### Stage C — routes, in dependency order, replacing old routes as each lands

7. `/agent`, `/decisions`, `/agent/timeline` — **first, deliberately.** Best-supported
   by the backend (27 node contracts, 9 specialists, run traces, WS) so the realtime
   plumbing is proven on real data before pages that depend on weaker sources.
8. `/dashboard`, `/home` → retire `app/dashboard`, `app/page.tsx`.
9. `/positions`, `/history`, `/execution` → retire `app/log`, `app/audit`.
10. `/markets`, `/intel`, `/polymarket`.
11. Live Agent Inspector + Journey/Decision modals → retire `app/glassbox`.
12. `/risk`, `/exposure`, `/strategies`(G2), `/strategies/performance`.
13. `/learning`, `/learning/failures`, `/learning/trades`, `/backtesting` → retire
    `app/backtest`.
14. `/system`, `/logs`, `/settings`.
15. `/orders`(G1), `/replay`(G3) — **last**, because both need a backend addition and
    may ship `BLOCKED`.

### Stage D — hardening

16. Tests: component tests for `Badge`/`Gauge`/`TradeJourney`, realtime store tests,
    **emergency-stop confirmation test**, navigation test across all 25 routes.
17. Performance: code-split charts, virtualize `/logs` + `/history` + timeline.
18. Responsive: 1440+ / 1024–1439 / 768–1023 (collapsible sidebar) / <768.
19. **Phase 9 contract table**, `grep -rn "TODO: REMOVE MOCK DATA"` output, tsc/test/
    build results, new env vars, and the list of backend changes recommended but not made.

### Verification after every stage

```bash
npx tsc --noEmit -p tsconfig.json
npm run test
npm run build
python -m pytest tests/ -q        # must stay at 1298 passed
```

`npx next lint` is **not** in the loop — no ESLint config exists and it launches a
setup wizard (CLAUDE.md).

---

## Three things I need decided before Stage C

1. **G0 — which assets?** The reference is ETH/SOL/DOGE; the backend is BTC/ETH with
   BTC-only funding/OI. Building the UI for assets the agent does not watch would ship
   empty panels on every market page.
2. **G1/G2/G3 — may I add the three thin read-only routers** (`/api/orders`,
   `/api/strategies`, `/api/replay`)? §7 step 3 says propose, do not build unless asked.
   Without them, `/orders`, `/strategies` and `/replay` ship `BLOCKED` with the old
   pages left live.
3. **Scope confirmation.** 25 routes + ~20 components + a token migration across 73
   existing components is a large build. The plan sequences it so the app is shippable
   at every checkpoint, but I want to confirm you want all 25 routes rather than a
   prioritised subset first.

I will start at Stage A on your go-ahead, and I will not fabricate a number to fill a
panel — any element without a real source will be omitted and listed in the Phase 9
table.

---

# BUILD LOG — Stage A complete (foundations)

## Decisions taken

**G0 — asset list: data-driven, not hardcoded.** Neither the reference's
ETH/SOL/DOGE nor the backend's BTC/ETH is baked in. Market pages will render whatever
`/api/market/prices` and the poller's `WATCH_SYMBOLS` actually report, so the UI is
correct today and stays correct if the backend is retargeted. Where a stat is
genuinely BTC-only (funding, open interest — `sentiment_agent.fetch_macro_data` queries
BTCUSDT specifically) it will be labelled BTC-wide rather than shown per asset.

**G1/G2/G3 — the three thin read-only routers are approved** and scheduled for Stage C
step 15. Until they exist, `/orders`, `/strategies` and `/replay` render a `BLOCKED`
placeholder that names the minimal unblock, and no old route is removed.

**All 25 routes**, in the Phase 8 order.

## What landed

| File | Purpose |
|---|---|
| `app/globals.css` | 3 themes with the reference's exact tokens + alias layer + all component classes |
| `tailwind.config.ts` | both token vocabularies |
| `components/ui/Badge.tsx` | one Badge for the app, `color-mix()` tints |
| `components/ui/Gauge.tsx` | one Gauge; unmeasured renders differently from zero |
| `components/ui/primitives.tsx` | `Card`, `StatCard`, `Chip`, `TermTable`, `Num`, `fmt`, `NotAvailable` |
| `components/ui/Theme.tsx` | provider, toggle, orbs |
| `lib/realtime/store.ts` | event router + typed slices over the EXISTING socket |
| `lib/realtime/useRealtime.ts` | selector hooks + `useBackend` |
| `lib/nav.ts` | the 25-route IA and the migration ledger |
| `components/shell/*` | `AppShell`, `Sidebar`, `TopBar`, `EmergencyStopModal`, `CommandDrawer`, `RoutePlaceholder` |
| `app/(terminal)/layout.tsx` + 24 pages | route group mounting the shell |
| 3 test files | 45 new tests |

`design-reference/trading-agent-control-center.html` — moved, as §0 specifies.

## Choices worth recording

**The alias layer, not a rename.** The reference tokens are the source of truth and
the 13 old names (`--bg-0`, `--txt-2`, `--cyan`, …) are `var()` aliases onto them. So
all 73 unmigrated components keep rendering **and** re-theme with the toggle — the old
routes look coherent with the new ones during the transition. A big-bang rename would
have broken all 73 at once, which the brief forbids.

**The shell mounts in a route group, not `app/layout.tsx`.** `app/layout.tsx` nests 22
providers whose order is load-bearing (CLAUDE.md records what has already broken).
Rendering the shell from `app/(terminal)/layout.tsx` puts it inside `{children}`, i.e.
below every provider — which is required, because `CommandDrawer` calls
`useAppState()`. It also leaves the six legacy routes' presentation untouched.

**The chat drawer reuses `AppState`.** It already owns conversations, the input buffer,
streaming, `sendMessage`, provider/model/key resolution and the natural-language trade
path that routes through the Supervisor gate. A second chat store would duplicate all
of it and could disagree about whether a message had been sent — not an acceptable
ambiguity on a surface that can trigger a trade action. Drawer/`/chat` state sharing
comes free.

**`/dashboard` has no placeholder.** It is the one route that collides with an existing
page. Next.js rejects two routes on one path, and a placeholder would take a working
dashboard away. It is created in Stage C step 8, when the old one is deleted in the
same change.

**Emergency Stop is real.** `POST /api/admin/emergency-stop`, type-`STOP`-to-confirm,
and it **fails loudly** — on error the modal stays open and says the system is NOT
stopped. The reference's `confirmAction()` was an `alert()` with a
`// TODO: wire to real mutation endpoint`.

**The mode badge never infers.** `live_trading` absent renders `MODE UNKNOWN`, not
`PAPER`. Showing PAPER while the system is live would be the most dangerous pixel in
the app.

## Two problems found and fixed

**1. The production build ran out of heap.** Compilation succeeded; static generation
died at `FATAL ERROR: Committing semi space failed` once 10 pages became 34. The `dev`
script already caps heap at 512 MB, so this machine is memory-tight and `build` had no
cap at all. Fixed by setting `--max-old-space-size=4096` on `build`; now 34/34 pages.
Worth knowing before the remaining ~20 real pages land.

**2. A source-text check matched the comment warning against the thing it checks.**
`designSystem.test.ts` asserts no component builds a colour by concatenating a hex
alpha. It failed — on the string `var(--accent) + '18'` inside Badge.tsx's comment
explaining why that is wrong.

Fifth occurrence of this exact class in the project. On the Python side every such
check was moved to AST; there is no cheap AST here, so all source checks now go through
a `code()` helper that strips comments first. A check that cannot tell a warning from a
violation trains authors to delete the warning.

## Verification

```
npx tsc --noEmit -p tsconfig.json     clean
npm run test                          326 passed (19 files) — was 281
npm run build                          Compiled successfully, 34/34 static pages
pytest tests/ -q                       1298 passed, 2 skipped (unchanged)
next start + HTTP probe                all 24 new routes -> 200
                                       all 6 legacy routes -> 200 (still live)
                                       all 10 sidebar sections render
                                       /orders renders BLOCKED + "minimal unblock"
```

`npx next lint` is not run — no ESLint config exists and it launches a setup wizard
(CLAUDE.md).

## Next: Stage B — composite components

`FlowDiagram` (driven by the graph stream), `TradeJourney`, `ExecCycleStepper`,
`MarketCard`, `PolymarketCard`, `CandlestickChart` (lightweight-charts, already a
dependency), `AgentSwarmViz` (labelled illustrative), `LiveAgentInspectorModal`.

Then Stage C begins with `/agent`, `/decisions`, `/agent/timeline` — deliberately
first, because they are the best-supported by the backend (27 node contracts, 9
specialists, run traces, a WS stream), so the realtime plumbing gets proven on real
data before pages that depend on weaker sources.

---

# BUILD LOG — Stage B complete (composite components)

## What landed

| Component | Replaces | Bound to |
|---|---|---|
| `viz/FlowDiagram` | `flowDiagram()` + `edgeSvg()` | `/api/graphs/nodes` topology + live `currentNode` |
| `viz/TradeJourney` | `tradeJourney()` + `journeyStep()` | whatever a run actually produced |
| `viz/ExecCycleStepper` | `execCycle()` | the real 6-stage pipeline |
| `viz/AgentSwarmViz` | `swarmSVG()` | real panel/strategy counts — labelled illustrative |
| `cards/MarketCard` | `marketCard()` | prices + last decision from the stream |
| `cards/PolymarketCard` | `pmCard()` | `/api/polymarket/snapshots` |
| `ui/CandlestickChart` | `candles()` | prop-driven, lightweight-charts, theme-aware |
| `ui/Sparkline` | `sparkline()` | real closes |
| `ui/useThemeColors` | — | resolves tokens for canvas libraries |
| `modals/LiveAgentInspectorModal` | `openLiveInspector()` | news + snapshots + node stream |
| `lib/viz/journey.ts`, `lib/viz/flow.ts` | — | the pure builders |

## Where the reference was followed, and where it was not

**The flowing dot is a real event.** `active` is true only when a node has COMPLETED
*and* the next node is the one the stream reports as `currentNode`. No timer, no
interval. `null` current node means nothing animates.

**The flow diagram renders the declared topology**, not just nodes seen so far.
Otherwise the diagram grows during a run and vanishes between runs — a quiet system
would look like a system with no pipeline. Unreported nodes show IDLE, which is true.

**`ExecCycleStepper` does not use the reference's six labels.** Scan/Detect/Validate/
Size/Fill/Settle are not stages this system has. The real ones are Trigger → Analyse →
Decide → Validate → Submit → Fill. Keeping the mock labels would have described a
system that does not exist: an operator reading "Size" would look for a sizing stage,
and sizing happens *inside* Validate — which matters, because the Risk Gateway is the
only place in the reasoning layer that sizes.

**Every journey step can be `unknown`, with a reason.** The reference builds all eight
from one mock decision so each always renders PASS/WARN/FAIL. A real run can exit
before a thesis exists, may never reach the gateway, and an open trade has no outcome.
Showing PASS for a stage that never ran asserts the agent checked something it did not
— the most misleading thing an explainability view can do. A P&L of exactly `0` is
still a measurement and renders as one; only absence is unknown.

**The swarm denies being a swarm.** Four layers bound to real counts — watched symbols,
the specialist panel, scored strategies, the one decision — with edge activity from the
live `currentNode`. It carries a permanent `Illustrative` badge and the words "this is
**not** a multi-agent swarm: there are no sub-agents behind these dots".

**`PolymarketCard` does not call `concern` "relevance".** The reference shows an "Agent
Relevance" gauge. The backend computes `directional.confidence` (how much to trust a
drift) and `eventRisk.concern` (how much to dampen conviction). Both are shown under
their real names with a one-line explanation. Renaming either to "relevance" would have
matched the mockup and told the operator something false — a constraint's concern is
not a relevance score.

**`MarketCard` labels funding/OI when they describe another symbol.**
`sentiment_agent.fetch_macro_data` queries BTCUSDT specifically, so an unlabelled
funding rate under SOL is a wrong number, not a rounding.

**The Live Inspector marks all three panels**, which the brief requires be visually
verifiable: News → `app/api/news · public RSS · unfiltered`, with the sentiment badge
and relevance gauge **omitted** because the feed carries neither; Polymarket →
`/api/polymarket/snapshots · live`; Console → `node-level` with the full
`NODE_LEVEL_ONLY` disclaimer, because no backend event exists at per-action
granularity.

**No `Math.random()` anywhere.** The reference uses it in `sparkline`, `candles` and
`swarmSVG`. In a render path it re-randomises the picture on every unrelated state
change *and* differs between server and client, which is a hydration mismatch. The
swarm's layout comes from a deterministic hash; the sparkline draws real closes and a
dashed rule when there are too few.

## Two problems found

**1. vitest cannot parse `.tsx`.** `tsconfig.json` sets `jsx: "preserve"` for Next's
own transform, and vitest's importer then refuses the file outright. It never surfaced
because no existing test imported a component. Overriding `esbuild.jsx` in
`vitest.config.ts` does **not** win over tsconfig — tried, failed.

Rather than add `@vitejs/plugin-react` to a machine already running the build at a
raised heap limit, the pure logic moved out of the components into `lib/viz/*.ts` —
which is where this codebase's own convention puts it anyway. Better architecture and
no new dependency: the components became pure presentation, and the interesting
behaviour is testable as plain modules.

**2. A theme-aware chart needs resolved colours.** lightweight-charts cannot consume
`var(--positive)`. `useThemeColors` reads the computed values and **re-reads on theme
change** — a one-shot read at mount would leave a blue chart on a gold Platinum page.
Fallbacks are Terminal's values, because an empty colour string draws an invisible
series, which is worse than a mistimed palette.

`LiveChart.tsx` was left untouched. It is coupled to `useCandles()` and hardcoded hex,
so it cannot chart a backtest or follow a theme — but it still serves the legacy routes,
and its indicator overlays are worth lifting later rather than reimplementing now.

## Verification

```
npx tsc --noEmit          clean
npm run test              352 passed (20 files) — was 326
npm run build              Compiled successfully, 34/34 static pages
pytest tests/ -q           1298 passed, 2 skipped (unchanged)
```

## Next: Stage C

`/agent`, `/decisions`, `/agent/timeline` first — best-supported by the backend, so the
realtime plumbing gets proven on real data before the weaker-sourced pages. Each route
flips its `migrated` flag in `lib/nav.ts` and, where it replaces one, the legacy route
is deleted in the same change.

---

# BUILD LOG — Stage C, part 1: /agent, /decisions, /agent/timeline

Built first on purpose: the best-backed pages in the system (27 node contracts, 9
specialists, traced runs, a live WS stream), so the realtime plumbing gets proven on
real data before pages that lean on weaker sources.

Migration ledger: `/agent`, `/decisions`, `/agent/timeline` → `migrated: true`.
**No legacy route deleted yet** — `/glassbox` stays live until `/agent` has been used
against a backend with live market data, which this environment cannot provide.

## Bound to real fields, read off the live API

The response shapes were transcribed from the **running** backend, not from the FastAPI
source, because the casing is genuinely mixed: `/api/graphs/runs` returns `run_id`,
`started_at` and per-node `duration_ms` in snake_case alongside `durationMs` and
`llm_budget.callsMade` in camelCase. Normalising in `lib/api/graphs.ts` means one place
to fix if the backend tidies up, and no component silently reading `undefined`.

Per-node trace data turned out richer than the reference's mock: `wrote`, `llm_calls`,
`llm_tokens`, `error`, `unavailable` per node. `/agent` shows all of it.

## Three places the reference was not followed

**`/agent` has no action-probability bars and no per-model prediction cards.** Both
imply things that do not exist: the Supervisor reports ONE `probability` (P(direction
correct)) and only once enough resolved trades exist to measure a hit rate; there is no
ensemble of independent models to card up. The page says so in a "Not shown, and why"
section rather than leaving a suspiciously absent panel. What replaces them is the node
contract table — every node's declared writes and whether it may call a model, which is
the one property of this pipeline worth watching.

**`/decisions` renders `riskChecks: null` as "none captured", never as passed.** Most
stored records have it null — the gateway may never have run. The reference's inspector
always shows seven green risk rows because its mock always has them. A green row for a
check that never ran is the same class of lie as a fabricated price. `riskCheckSummary()`
returns `null` rather than `0/0`, and checks reporting `unavailable`/`delegated` are
counted as neither passed nor failed, preserving the distinction the backend draws.

**Graph 2's node order is declared in the page.** The API returns nodes alphabetically
(sorted registry), which would draw the pipeline out of sequence. Unlisted nodes are
appended rather than dropped, so a new backend node appears rather than vanishing.

## Two bugs found

**1. CORS was hardcoded to `http://localhost:3000` — the serious one.**

`http://localhost:3000` and `http://127.0.0.1:3000` are **different origins** to a
browser. An operator opening the dashboard on 127.0.0.1 got a failed preflight on every
backend call, so every new page rendered "backend unreachable" **while the backend was
running perfectly**.

That is the worst shape this bug could take: the UI blames the data source, so the
natural response is to debug a backend that is fine. Found by serving a production build
on port 3100 and watching an `OPTIONS` preflight return 400 with no
`access-control-allow-origin` header.

Fixed with an `ALLOWED_ORIGINS` env override and defaults covering both hostnames on
ports 3000/3001/3100. Deliberately not `["*"]` — with `allow_credentials=True` the CORS
spec rejects a wildcard, so it would have broken every request rather than loosened
anything. Verified: preflight from :3100 → 200, and both `localhost:3000` and
`127.0.0.1:3000` get a matching allow-origin header.

**This is a backend change.** The brief says frontend-only; it is listed here because
the frontend cannot function without it, and it is config, not logic.

**2. A fetch in `useMemo`.** `useSameOrigin` ran its request inside `useMemo`, which may
be called during a discarded render or skipped entirely — so requests fire at
unpredictable times and the cleanup never runs. Moved to `useEffect`.

## Two tests updated, both because they did their job

`nav.test.ts` asserted "nothing is migrated yet" and "every placeholder states its
contract". Both failed the moment three routes became real pages — which is what the
ledger is for. They now assert the migrated set against an **explicit list** (so
flipping a flag without building the page still fails) plus a new check that no migrated
route still renders `RoutePlaceholder`.

## Verification

```
npx tsc --noEmit          clean
npm run test              353 passed (20 files)
npm run build              Compiled successfully, 34/34 static pages
pytest tests/ -q           1298 passed, 2 skipped
next start + HTTP probe    /agent, /decisions, /agent/timeline -> 200
                           real content confirmed in the SSR HTML
CORS preflight             :3100 -> 200; localhost and 127.0.0.1 both allowed
```

## Honest state of these three pages

They are `PARTIAL`, not `COMPLETE`, and for one shared reason: **this environment has no
route to Binance**, so no trigger fires, no graph run happens, and the live panels
correctly show an idle pipeline and an empty trigger feed. Every binding is real and
every empty state names why it is empty. Confirming `COMPLETE` needs a backend with
market data.

## Next

`/dashboard` + `/home` — the first pair that deletes legacy routes (`app/dashboard`,
`app/page.tsx`) in the same change that creates their replacements, since `/dashboard`
is the one path that cannot hold two routes at once.

---

# BUILD LOG — Stage C complete, Stage D complete

All 25 routes are real. The four legacy routes and the old single-page sidebar are
deleted. What follows is the Phase 9 deliverable.

## The regression this stage nearly shipped

Worth putting first, because it is the most important thing that happened here.

`app/page.tsx` was changed to `redirect('/home')` in Stage C part 1, with a comment
claiming *"every one of them is reachable from the sidebar, and
`components/TradingSidebar.tsx` remains in the tree for the legacy routes."* Both
halves were false. The old root mounted **31 real operator panels** — placing a
paper trade, editing the watchlist, writing live risk limits, starting the
autonomous trader, creating a Mission, connecting an exchange, applying a
hypothesis. The redirect made every one of them unreachable, and no legacy route
mounted the sidebar, so the comment's own escape hatch did not exist.

Nothing in the test suite caught it. 354 tests passed while the app had lost the
ability to place a trade. The tests asserted that routes existed and that pages
were not placeholders — neither of which is a statement about whether a *control*
survived the move.

Fixed by mounting all 31 on the route whose subject each belongs to, via
`components/operator/`, plus the three from `/glassbox` and the two from
`/backtest`. `lib/nav.test.ts` now names all 35 and fails by name if one is
dropped. That test is the deliverable, not the fix.

A second instance of the same class: the first draft of `/backtesting` called
`/api/backtest` with a symbol and an interval and drew an equity curve — while the
route it replaced mounted `BacktestPanel` **and** `OptimizerPanel`, i.e. strategy
selection, multi-timeframe confirmation, regime breakdown, Monte Carlo,
walk-forward folds, four search algorithms and a stability score. It would have
deleted all of it and looked like progress. `/backtesting` now hosts both panels.

## Phase 9 — contract declaration

`COMPLETE` = every element on the page is bound to a real backend or same-origin
field. `PARTIAL` = real data plus at least one element the backend cannot supply,
stated on the page. No route is `BLOCKED`: the three that were (`/orders`,
`/strategies`, `/replay`) were unblocked by `backend/api/catalog.py`.

| Route | Status | Real sources | Stated as unavailable, with the reason |
|---|---|---|---|
| `/` | COMPLETE | — | server redirect to `/home` |
| `/home` | PARTIAL | `/api/trades`, `/api/candles`, `/api/graphs/nodes`, `/api/catalog/strategies`, `/api/polymarket/snapshots`, tick stream | "Rank" dropped entirely — implies a leaderboard against other accounts that does not exist |
| `/dashboard` | PARTIAL | `/api/dashboard/portfolio`, `/api/exchange/status`, `/api/graphs/nodes`, `/api/market/prices`, `/api/trades`, event stream | Today's P&L — no daily mark exists, and choosing a session boundary would invent it |
| `/markets` | PARTIAL | `/api/market/prices`, `/api/candles`, `/api/market/analysis/{sym}`, `/api/market/regime/{sym}`, tick stream | Funding and OI are not shown per asset — the backend fetches both for BTCUSDT only |
| `/intel` | PARTIAL | `/api/market/regime/{sym}` per symbol, `/api/market/prices` | Cross-asset correlation — computed in `algorithms/market_graph.py`, exposed by no route |
| `/polymarket` | PARTIAL | `/api/polymarket` + `/signals` `/mappings` `/snapshots` | Per-question volume, liquidity, 24h change (on the ccxt payload, not persisted) and "Agent Relevance" (does not exist — `confidence` and `concern` are shown under their own names) |
| `/positions` | COMPLETE | `/api/dashboard/portfolio`, `/api/exchange/status`, tick stream | — |
| `/orders` | PARTIAL | `/api/catalog/orders` | `slippageBps`, `latencyMs`, and any status other than FILLED — not recorded on a trade |
| `/history` | PARTIAL | `/api/trades` | Indicators, regime, strategy and risk per trade — a trade record stores no link to its decision |
| `/history/[id]` | COMPLETE | `usePortfolio`, `useReflection`, `/api/hypotheses`, `/api/trades/{id}` | — |
| `/execution` | PARTIAL | `/api/catalog/orders`, `/api/exchange/status`, event stream | Latency, slippage and fill-ratio stats — not recorded anywhere |
| `/agent` | PARTIAL | `/api/graphs`, `/graphs/nodes`, `/graphs/runs`, event stream | Per-node token counts — traced runs record LLM call counts, not tokens |
| `/decisions` | PARTIAL | `/api/decisions`, `/api/graphs/runs` | Realised P&L per decision — not stored on a decision record |
| `/agent/timeline` | COMPLETE | `/api/graphs/runs`, event stream | — |
| `/chat` | COMPLETE | `/api/chat` via `useAppState` | — (no key configured is reported as a cause, not a blank) |
| `/strategies` | PARTIAL | `/api/catalog/strategies` | Per-strategy live performance — trades carry no strategy tag, so a win rate here would attribute one strategy's results to another |
| `/strategies/performance` | PARTIAL | `/api/trades` | P&L by regime and by timeframe — neither field is on a trade record |
| `/risk` | PARTIAL | `/api/dashboard/portfolio`, `/api/admin/status`, `/api/exchange/status`, `/api/decisions` | The nine checks are shown from the most recent run that captured them, stamped with that run's time — there is no endpoint returning a standing risk snapshot |
| `/exposure` | COMPLETE | `/api/dashboard/portfolio`, tick stream | — (an unvalued position shows `null`, never a 0% share) |
| `/learning` | PARTIAL | `/api/graphs/meta-learning`, `/api/memory/stats`, `/api/reflections`, `/api/hypotheses` | Each unanswered meta question shows its own `reasonUnanswered` rather than being hidden |
| `/learning/failures` | PARTIAL | `/api/trades`, `/api/reflections` | Clustering is client-side by symbol and side only — strategy and regime are not on a trade record |
| `/learning/trades` | PARTIAL | `/api/trades`, `/api/reflections`, `/api/hypotheses` | The lesson column is joined by symbol only, the sole key both records carry |
| `/replay` | PARTIAL | `/api/catalog/replay`, `/api/graphs/runs/{id}` | No play/pause or speed control — the trace is static, so a 2x button would be theatre |
| `/backtesting` | COMPLETE | `/api/backtest`, `/api/backtest/optimize`, `/api/backtest/montecarlo` | — |
| `/system` | PARTIAL | `/api/monitoring`, `/api/exchange/status`, `/api/graphs`, event stream | Per-service latency, error rate and uptime — no such instrumentation exists; the reference's eight service rows would make an uninstrumented system look monitored |
| `/logs` | PARTIAL | `/api/execution/audit`, event stream | Level and service filters — there is no levelled log store, so INFO/WARN/ERROR/CRITICAL would be four filters matching nothing |
| `/settings` | PARTIAL | `/api/exchange/status`, `/api/admin/status`, `/api/polymarket`, `useAppState` | Runtime gates are read-only by design; notification settings do not exist (no email/webhook/push transport) |

25 nav routes + `/` + `/history/[id]` = 27 pages.

## Verification

```
grep -rn "TODO: REMOVE MOCK DATA"   -> 0 in shipped code
                                       (6 hits: the brief x2, this plan, the
                                        reference HTML, and the two tests that
                                        assert its absence)
grep -rn "Math.random" in new UI    -> 0 calls; every hit is a comment explaining
                                       which reference behaviour it replaced
npx tsc --noEmit                    -> clean
npm run test                        -> 22 files, 365 tests, all passing
npx next build                      -> compiled; 30 pages generated
```

Bundle, first-load JS, after the perf pass:

| | before | after |
|---|---|---|
| `/agent` | 198 kB | 104 kB |
| `/markets` | 174 kB | 102 kB |
| `/home` | 174 kB | 104 kB |
| `/learning/trades` | 185 kB | 92 kB |
| shared | 87 kB | 88 kB |

Three routes remain at ~185 kB — `/chat`, `/settings`, `/history/[id]`. Each
imports `useAppState` or `useReflection` as its *primary* content, so there is
nothing below the fold to defer. That is the provider tree's cost, not a
lazy-loading miss.

## Stage D

* **Paging, not virtualisation** — `lib/ui/paging.ts` on `/history` and `/logs`.
  True windowing needs a fixed row height; these tables wrap. The hidden count is
  always stated: a silent `.slice(0, 50)` on a trade log reads as "that is every
  trade", which is the kind of wrong an operator acts on. 5 tests.
* **Emergency stop** — the arming rule and the failure wording moved to
  `lib/ui/emergencyStop.ts` so they could be asserted at all (vitest here cannot
  parse JSX). 6 tests, including that `STO`, `STOPP` and `STOP NOW` do **not**
  arm, and that every failure branch still says *"The system is NOT stopped."*
* **Code splitting** — `lightweight-charts` behind `next/dynamic` (twice: the
  in-page chart and `ChartModal`'s), plus all 12 operator blocks, which sit below
  each page's real-data content.
* **Responsive** — the shell already collapses the rail to an overlay below
  1024px; `TermTable` scrolls inside its own container so no page scrolls
  horizontally. Grids are `1 -> md:2/3 -> lg:2/3` throughout.
* **Navigation** — 14 assertions in `lib/nav.test.ts`, including that
  `/history/abc123` resolves to `/history` so the sidebar highlights the right item
  on the detail route.

## Backend changes made but not requested

Both were necessary and both are read-only:

1. **`backend/api/catalog.py`** — `/orders`, `/strategies`, `/replay`. Three
   routes were `BLOCKED` for want of a read path to data the backend already had.
   Derives from `.data/trades.json`, `sp.STRATEGY_PROFILES` and
   `list_recent_runs`. No writes, no new state.
2. **CORS** — `ALLOWED_ORIGINS`, defaulting to localhost **and** 127.0.0.1 on
   3000/3001/3100. It was hardcoded to `http://localhost:3000`, and
   `127.0.0.1:3000` is a different origin, so every page reported "backend
   unreachable" while the backend was healthy.

New env vars: `ALLOWED_ORIGINS` (optional), `POLYMARKET_ENABLED` (optional).

## Two operator decisions still outstanding

Neither is mine to make:

* **`LIVE_TRADING=true`** — real money. Deliberately not settable from the
  browser; `/settings` shows it read-only and says why.
* **Polymarket reachability** — this environment has no route to Polymarket, so
  the poll path is unverified here. The three gates on `/polymarket` are rendered
  as a checklist precisely because "no markets" has three different causes and the
  next action differs for each.
