# Replace Existing Frontend With Reference UI — Full Build Command
### For: Claude Code / Antigravity / Cursor (paste as the first message in your real repo)

**Before you paste this:** put the reference file `trading-agent-control-center.html` (the design I built) somewhere in the repo, e.g. `/design-reference/trading-agent-control-center.html`, so the coding agent can open and read it directly. Everything below tells the agent to treat that file as the canonical, pixel-and-behavior source of truth for what to build — not as inspiration, as the spec.

---

## 0. WHAT THIS TASK IS

You are replacing the **entire existing frontend** of an autonomous crypto futures trading agent (ETH/SOL/DOGE) with a new frontend, using the attached reference file `/design-reference/trading-agent-control-center.html` as the exact visual and interaction specification.

The reference file is a static, self-contained HTML/CSS/JS mockup built with **all mock data** — every number, price, news headline, Polymarket question, and agent log line in it is fake and marked `// TODO: REMOVE MOCK DATA`. Your job is to rebuild every page and component it demonstrates as real, framework-native components (React/Next.js, or whatever this repo already uses) wired to the **actual backend** — not to ship the mockup as-is, and not to invent fake endpoints to make it "work."

This is a full replace, not an incremental addition:
- Remove/retire the existing frontend's pages, components, and styling once each equivalent new page is live and verified against the real backend.
- Do not leave a mix of old-design and new-design pages in the shipped app — if a new-design page cannot be completed because the backend doesn't support it yet, mark it `BLOCKED` or `NOT AVAILABLE FROM BACKEND` (see Phase 9) and keep the *old* page live for that route until it can be replaced, rather than shipping a half-built new page.
- DO NOT rebuild the backend, replace LangGraph, invent APIs, replace the database, or create fake trading functionality in the final build.
- DO NOT expose hidden chain-of-thought or private agent reasoning anywhere — only structured decision factors, indicators, scores, rules, risk checks, confidence, actions, and concise explanations, exactly as the reference file does in its Decision Inspector / Trade Journey / Live Agent Inspector components.

---

## 1. HOW TO READ THE REFERENCE FILE

Open `/design-reference/trading-agent-control-center.html` directly (it's plain HTML/CSS/JS — no build step, just read the source) and extract, in order:

1. **The `<style>` block** — this is the full design system: CSS custom properties for three themes (`:root` = Terminal, `body[data-theme="aurora"]` = Aurora, `body[data-theme="platinum"]` = Platinum), typography rules (`.mono` for all numeric values), card/table/badge/gauge/chip component classes, and the theme-toggle mechanics. Port these as Tailwind theme tokens / CSS variables in the real app, keep all three themes, and keep the same toggle behavior (cycles Terminal → Aurora → Platinum → Terminal).
2. **The `NAV` array and sidebar markup** — this is the exact information architecture (see Phase 2 for the full route list). Reproduce section grouping and labels exactly.
3. **Each `PAGES.<id>` function** — this is the literal content/layout spec for that route. Reproduce the layout structure (grid ratios, card groupings, table columns in order, gauge/chip usage) faithfully; only the data source changes (mock arrays → real API/store hooks).
4. **Shared components** — `flowDiagram()`, `tradeJourney()`, `execCycle()`, `swarmSVG()`, `pmCard()`, `badge()`, `gauge()`, `statCard()`, `marketCard()`, the Live Agent Inspector modal, the Emergency Stop modal, and the Command Center / Agent Chat — rebuild each as a real, reusable, typed component. See Phase 4 for the full component inventory.
5. **The JS event wiring** at the bottom of the file — this defines exact interaction behavior (what opens on click, what streams live, what confirms before executing). Reproduce the same interactions, wired to real mutations/subscriptions instead of `setInterval`/`Math.random()` simulations.

Wherever the reference file simulates "live" behavior with `setInterval` and random mock values (the flowing dot on graph edges, the Live Agent Console streaming lines, the swarm visualization's active edges), replace the simulation with a subscription to the real realtime event stream (Phase 5) — the visual behavior should look identical, but every value must originate from a real event, not `Math.random()`.

---

## 2. FULL ROUTE LIST (build every one of these — this is the complete IA from the reference file)

```
/home                     — Hero overview: rank/PnL ticker, all-time PnL hero card, biggest-win
                             card, mini chart, Execution Cycle stepper, Agent Swarm visualization,
                             Polymarket Pulse strip
/dashboard                — Equity/PnL/win-rate stat row, ETH/SOL/DOGE market cards, Agent Status
                             panel (with embedded live LangGraph flow diagram + "Watch Live" button),
                             Recent Events, Polymarket Pulse
/markets                  — Live Markets: asset/timeframe selector, candlestick + volume, toggleable
                             indicators, funding/OI stats, agent signal panel
/intel                    — Market Intelligence: regime + correlation per asset
/polymarket               — Polymarket Signals: full prediction-market grid (YES/NO bars, volume,
                             24h change, close date, agent-relevance gauge), sorted by relevance
/positions                — Positions table + click-through detail panel; each row has "● Live",
                             "◎ How", and "Close" actions
/orders                   — Orders table (status, fills, slippage, latency)
/history                  — Trade History table with "◎ How" per closed trade
/execution                — Execution pipeline visualization (7-stage flow) + latency/slippage/
                             fill-ratio stats + recent execution table
/agent                    — Agent Brain: live LangGraph flow diagram (connected nodes + animated
                             edges), node detail list, ensemble confidence gauge, action-probability
                             bars, per-model prediction cards
/decisions                — Decisions table + click-through Decision Inspector (Trade Journey +
                             Signal Factors + Risk Checks, PASS/WARN/FAIL)
/agent/timeline            — Live event feed, category filters, pause/resume autoscroll, click any
                             asset row to open the Live Agent Inspector
/chat                     — Agent Chat: full ChatGPT/Claude-style page (history rail, message
                             thread, suggestion chips, input bar) sharing state with the drawer
/strategies                — Strategy Center: per-strategy cards (status, trades, win rate, profit
                             factor, avg R, avg return, max DD, suitability)
/strategies/performance     — Equity curve, drawdown, P&L by asset/regime/timeframe charts
/risk                      — Risk Center: equity/margin/exposure stats + risk-check gauges
/exposure                  — Per-asset exposure table
/learning                  — Learning Center: trades analyzed, wins/losses, patterns, cycles
/learning/failures          — Failure clusters grouped by asset/strategy/regime/etc.
/learning/trades            — Trade analysis table
/replay                    — Agent Replay: scrubber, play/pause/speed controls, reconstructed
                             market state / signals / outcome panels
/backtesting               — Backtesting Lab: config form + results stat grid + equity/drawdown/
                             monthly/distribution charts
/system                   — System Health: per-service status cards (latency, errors, uptime)
/logs                     — Event Logs: search + level/service/asset filters, paginated table
/settings                 — Trading / Agent / Notifications config forms
```

Plus these cross-cutting, non-route UI elements (build once, mount globally):
- **Top bar**: agent status, exchange status, WS status, mode badge, equity, today's P&L, position count, risk state, theme toggle, Pause/Resume, Emergency Stop, "Ask Agent" button.
- **Emergency Stop modal**: type-to-confirm ("STOP") before submitting.
- **Command Center drawer**: right-docked chat panel, suggestion chips, shares message state with `/chat`.
- **Live Agent Inspector modal**: opened from any "● Live" trigger — 8-stage tracker (Ingest → News → Polymarket → Indicators → Regime → Signal → Risk → Decision), 3-column live panel (Reading News / Reading Polymarket / Market Condition Analysis), and a streaming Live Agent Console.
- **Trade Journey visualizer**: 8-step horizontal flow (Market Data → Indicators → Regime → Strategy Signal → Risk Checks → Decision → Execution → Outcome) used inside the Decision Inspector and from "◎ How" buttons on Positions/History rows.

---

## 3. DESIGN SYSTEM (port exactly, don't reinterpret)

Three themes, same variable names, same default (Terminal on first load), same toggle cycle order:

**Terminal (default)** — near-black base, single blue accent, Bloomberg-terminal density. No gradients, no glow.

**Aurora** — deep indigo base, muted purple/pink accent gradient, very low-opacity ambient background glow (already toned down from an earlier, too-saturated version — keep the low opacity: orb opacity ~0.28, card gradient tint ~0.05 alpha, node glow shadow ~0.28 alpha — do not re-intensify it).

**Platinum** — deep graphite base, warm off-white text, champagne-gold accent (`#C9A961`→`#E8CE8E` gradient), muted emerald/burgundy for positive/negative, near-zero ambient decoration (opacity ~0.10). This is the "elegant/luxury" theme — restraint is the point; don't add extra ornamentation to it.

Shared rules across all three themes:
- All numeric values (prices, sizes, P&L, %, timestamps) are monospaced and right-aligned in tables.
- Status badges use the same PASS/WARN/FAIL and RUNNING/COMPLETED/WAITING/IDLE/SKIPPED/FAILED vocabulary and color mapping throughout — reuse one `Badge` component everywhere, don't reimplement per page.
- Badge/pill tinted backgrounds use `color-mix()` (or your framework's equivalent) against the CSS variable, not string-concatenated hex+alpha — the reference file specifically fixed this bug; don't reintroduce it.
- Gauges are a single reusable horizontal bar component (`<Gauge pct color />`), used identically for risk checks, confidence, relevance, and analysis bars.

---

## 4. COMPONENT INVENTORY (build as real, typed, reusable components)

| Component | Reference function | Used on |
|---|---|---|
| `AppShell` (Sidebar + TopBar + Main) | static shell markup | every route |
| `ThemeToggle` | `toggleTheme()` | TopBar |
| `EmergencyStopModal` | `#estop-modal` + confirm logic | TopBar |
| `CommandDrawer` / `AgentChatPage` | `toggleCmd()`, `askAgent()`, `renderAllChatViews()` | Drawer + `/chat` |
| `StatCard` | `statCard()` | Dashboard, Risk, Backtesting |
| `MarketCard` | `marketCard()` | Dashboard, Home |
| `Badge` | `badge()` | everywhere |
| `Gauge` | `gauge()` | Risk, Agent Brain, Live Inspector, Polymarket cards |
| `CandlestickChart` | `candles()` (replace with a real charting lib — Recharts/Lightweight-Charts — the mock draws fake SVG bars) | Markets, Home, Strategy Performance, Backtesting |
| `FlowDiagram` (LangGraph pipeline) | `flowDiagram()`, `edgeSvg()` | Agent Brain, Dashboard |
| `TradeJourney` | `tradeJourney()`, `journeyStep()`, `journeyConnector()` | Decision Inspector, Positions "How", History "How" |
| `ExecCycleStepper` | `execCycle()` | Home |
| `AgentSwarmViz` | `swarmSVG()` (procedural mock — replace with a real per-agent/sub-strategy activity map if the backend exposes one; otherwise keep as an explicitly-labeled illustrative panel, see Phase 9) | Home |
| `PolymarketCard` | `pmCard()` | Polymarket Signals, Dashboard Pulse strip, Live Inspector |
| `LiveAgentInspectorModal` | `openLiveInspector()`, `liveStageRow()`, `newsItemHtml()`, `analysisHtml()`, live console `pushLine()` loop | Positions, Dashboard, Agent Timeline |
| `DecisionInspector` | `openDecision()` | `/decisions` |
| `PositionDetailPanel` | `openPositionDetail()` | `/positions` |
| `JourneyModal` (for closed/open trade "How") | `showJourneyModal()`, `showPositionJourney()`, `showHistoryJourney()` | Positions, History |

---

## 5. REALTIME BEHAVIOR — replace every simulation with a real subscription

The reference file fakes "live" feeling with client-side timers. Replace each with the real mechanism:

- **Flowing dot on active LangGraph edges** → driven by the actual current-node event from the LangGraph run stream, not a CSS animation keyed off a guessed "active" state.
- **Live Agent Console lines** (`pushLine()` / `liveInterval`) → subscribe to the backend's actual granular agent-action event stream for that run/asset. If the backend does not emit granular per-action events (only coarse node-level events), say so explicitly in the deliverables report — do not fabricate a plausible-looking log.
- **News items in the Live Agent Inspector** → the backend's actual research/news-ingestion node output (headline, source, sentiment, relevance) for that decision cycle — not evergreen mock headlines.
- **Polymarket items** → the backend's actual Polymarket analysis module output (question, YES/NO price, volume, computed relevance score) for that asset/cycle.
- **Agent Swarm visualization** → if the backend exposes per-sub-agent or per-strategy-candidate activity (the reference implies ~300 sub-agents scanning), bind node/edge activity to that. If it doesn't, keep the visualization but label it clearly as an illustrative representation of the single agent's multi-model ensemble (the "Model Predictions" data already on Agent Brain), not a fabricated multi-agent swarm.

One shared realtime connection for the whole app (per the earlier phase-0 architecture): Realtime Connection → Event Router → Global Store → component updates. Do not open a new WebSocket/SSE connection per component, including the Live Agent Inspector modal — it should attach to the existing global stream, filtered by asset/run ID, and detach cleanly on modal close (the reference file's `clearInterval` on `closeLiveInspector()` is the pattern to preserve — clean up subscriptions on unmount).

---

## 6. REPOSITORY AUDIT — do this before writing/replacing any code

Inspect the existing frontend and backend thoroughly:
- Current frontend framework, Next.js/React version, TS config, existing component library, existing routes/layouts.
- Existing API routes, auth, database/ORM, existing API clients, WebSocket/SSE implementation.
- LangGraph implementation: graph name, nodes, state schema, events, checkpoints, run IDs.
- Existing trading/market/order/position/strategy/risk/learning/backtesting models.
- Whether a Polymarket integration/analysis module already exists in the backend (the user has stated one does) — find its actual output shape before building `/polymarket` and the Live Agent Inspector's Polymarket panel.
- Whether a news-ingestion/research node exists and what it outputs.
- Existing env vars, tests, deployment config.

Do not assume names. Do not create duplicate abstractions when existing ones can be reused. Do not remove any existing backend code, LangGraph nodes, or database structures — this task is frontend-only.

---

## 7. BACKEND CONTRACT DISCOVERY — required before building each page

For every route in Phase 2, before writing its real implementation, document:
- **REST**: method, URL, params, request/response shape, auth, error format.
- **Realtime**: event name(s), payload shape, and which global store slice it updates.
- **Data completeness**: does the backend currently return every field the reference page displays? List any gaps.

If a field the reference design shows doesn't exist in the backend yet (e.g., a "relevance score" for Polymarket questions, or a granular per-action agent log), do one of, in this order:
1. Derive it from existing data if reasonably possible without inventing semantics.
2. Omit that specific field/section from the shipped page and note it as `NOT AVAILABLE FROM BACKEND` in the final report — do not fabricate a number to fill the space.
3. Only if the missing piece is foundational to the page (e.g., there's no news/Polymarket data at all), propose the minimal backend addition needed, isolated and clearly documented — do not build it yourself unless asked.

---

## 8. IMPLEMENTATION ORDER

1. Repository audit (Phase 6)
2. Backend contract discovery (Phase 7)
3. Port design system + theme tokens (Phase 3)
4. Application shell (Sidebar/TopBar, all nav routes wired to placeholder pages)
5. Global realtime infrastructure (Phase 5)
6. Shared component library (Phase 4) — build once, reuse everywhere
7. `/home`, `/dashboard` (retire old landing/dashboard once these are live and backend-verified)
8. `/markets`, `/intel`, `/polymarket`
9. `/positions`, `/orders`, `/history`, `/execution`
10. `/agent` (Agent Brain), `/decisions`, `/agent/timeline`, `/chat`
11. Live Agent Inspector modal (depends on realtime infra + news/Polymarket contracts)
12. Trade Journey + Decision Inspector + position/history "How" modals
13. `/strategies`, `/strategies/performance`
14. `/risk`, `/exposure`
15. `/learning`, `/learning/failures`, `/learning/trades`, `/replay`
16. `/backtesting`
17. `/system`, `/logs`, `/settings`
18. Remove/retire old frontend pages and dead code once each replacement route is verified against the real backend
19. Testing (component tests, realtime state tests, emergency-stop confirmation test, navigation test)
20. Performance pass (code-split charts, virtualize large tables/log streams, lazy-load below-the-fold routes)
21. Responsive pass (1440px+ full terminal, 1024–1439px compressed, 768–1023px collapsible sidebar, <768px mobile layout — the reference file is desktop-first and does not define mobile breakpoints, so this is new work, not a port)
22. Final QA + deliverables report (Phase 9)

Build shared infrastructure first. Do not implement pages as isolated mockups, and do not leave both the old and new implementation of the same route live at the same time once a route is marked complete.

---

## 9. FRONTEND ↔ BACKEND CONTRACT DECLARATION (mandatory final deliverable)

This is the most important deliverable — it's the explicit statement that the frontend matches the backend, not just that it looks like the reference file.

Produce a table, one row per route from Phase 2, with these columns:

| Route | Backend endpoint(s)/event(s) used | Status | Notes |
|---|---|---|---|

Where **Status** is exactly one of:
- `COMPLETE` — every element on the page is bound to a real, verified backend field. No mock data remains.
- `PARTIAL` — page is live and functional but one or more secondary elements are `NOT AVAILABLE FROM BACKEND` (list which, and confirm they are hidden/omitted, not faked).
- `BLOCKED` — cannot be built against the current backend; old page kept live at this route; describe exactly what backend addition would unblock it.
- `NOT AVAILABLE FROM BACKEND` — entire page/section has no backing data source at all yet.

Also include, at the end of the report:
- Confirmation that **no page in `COMPLETE` or `PARTIAL` status contains any `// TODO: REMOVE MOCK DATA` comment** — grep the final codebase for that string and paste the (ideally empty) result.
- Confirmation that the Live Agent Inspector's News, Polymarket, and Console panels are each individually marked with their real data source or explicitly flagged as unavailable — this is the specific feature the user asked to have visually verifiable, so it must not silently fall back to mock content in the shipped build.
- TypeScript / lint / test / production build results.
- List of any required new environment variables.
- List of any backend changes that were required or recommended but not made.

Never hide incomplete functionality. A page that looks finished but quietly renders mock data is a failure condition for this task, not an acceptable shortcut.

---

## FINAL COMMAND

Start by opening `/design-reference/trading-agent-control-center.html` and the existing repository side by side. Do not write any replacement code yet.

First produce, as a written report:
1. Summary of the reference file's design system, routes, and components (confirm you've read all of §1–§4 above against the actual file).
2. Repository audit (Phase 6).
3. Backend contract discovery per route (Phase 7), including explicit confirmation of whether the Polymarket analysis module and any news/research node already exist in the backend and what they currently output.
4. A gap list: which reference-file elements have no backend support today.
5. Implementation plan following Phase 8's order.

Then begin implementation phase by phase, replacing old frontend routes only as their new-design equivalents reach `COMPLETE` or `PARTIAL` status against the real backend. After each phase: run TypeScript checks, run lint, run tests, verify the app builds, fix regressions.

Finish with the Phase 9 contract declaration table. The task is not done until every route in Phase 2 has a status, every `COMPLETE`/`PARTIAL` route is confirmed mock-data-free, and the old frontend has been fully removed for every route that reached `COMPLETE` or `PARTIAL`.
