# 14 — API Specification

**Status: implemented.** 26 route files under `app/api/`. All are Next.js 14 App
Router route handlers in a single process — there is no separate API service.

Every route except `/api/chat` runs on the **Node.js runtime**
(`export const runtime = 'nodejs'`) because it touches the filesystem, Node
`crypto`, or an upstream that needs a server-side fetch to dodge CORS. All
declare `export const dynamic = 'force-dynamic'` except `/api/quote`.

---

## Full route table

| Route | Methods | Runtime | Purpose |
|---|---|---|---|
| `/api/chat` | POST | **edge** | The only LLM proxy. Re-issues the caller's `/chat/completions` request server-to-server and streams the raw SSE body straight back. |
| `/api/candles` | GET | nodejs | Historical OHLC for indicators and charts, capped at 500 bars. Fetch logic in `lib/candleSource.server.ts`. |
| `/api/quote` | GET | nodejs | Equity quotes (no free browser-reachable WS/CORS source). |
| `/api/news` | GET | nodejs | RSS feeds parsed server-side, plus optional rotating free news-aggregator APIs (`lib/newsProviders.ts`). Works with zero API keys. |
| `/api/marketintel` | GET | nodejs | Fear & Greed Index + Binance Futures per-symbol derivatives. Crypto only. |
| `/api/eventdata` | GET | nodejs | Historical funding-rate / open-interest series for `lib/eventDetection.ts`. Crypto only. |
| `/api/orderflow` | GET | nodejs | Binance public order-book depth for `lib/orderFlow.ts`. Crypto only. |
| `/api/multiexchange` | GET | nodejs | Cross-exchange price aggregation across 4 more public REST hosts. Crypto only. |
| `/api/trades` | GET, POST | nodejs | Trade log. Optional shared-secret auth: if `TRADES_API_KEY` is set, **writes** require it; GET stays open. |
| `/api/trades/[id]` | GET, DELETE | nodejs | One trade; delete a log entry. |
| `/api/decisions` | GET, POST | nodejs | The audit trail — every Supervisor decision. Append-only; GET filters by symbol/tab/outcome. |
| `/api/reflections` | GET, POST | nodejs | Post-mortem records, upsert by `tradeId`. |
| `/api/hypotheses` | GET, POST, PATCH | nodejs | Hypotheses. PATCH is **human review actions only** (dismissed/validated/rejected/applied + note) and touches no config store. |
| `/api/debate` | GET, POST, PATCH | nodejs | Debate records. PATCH allows exactly two mutations: link-to-trade and record-outcome. |
| `/api/collaboration` | GET, POST | nodejs | Second-opinion request/response records (append-only). |
| `/api/missions` | GET, POST, PATCH, DELETE | nodejs | Mission Planner CRUD. |
| `/api/strategy-versions` | GET, POST | nodejs | Append-only optimizer-parameter versions. |
| `/api/autonomous-cycles` | GET, POST | nodejs | Autonomous-loop cycle journal, including no-trade cycles. |
| `/api/memory` | GET, POST | nodejs | Persists only the explicitly stated risk preference. |
| `/api/stats` | GET | nodejs | Server-side aggregation reading `tradeStore` + `reflectionStore` directly. |
| `/api/backtest` | POST | nodejs | Runs a backtest against real historical candles; optionally fetches longer MTF timeframes. |
| `/api/backtest/optimize` | POST | nodejs | Grid / random / genetic / Bayesian parameter search, fully server-side (hundreds of backtests per request). |
| `/api/backtest/montecarlo` | POST | nodejs | Resamples the trade list from an already-completed backtest. Pure computation, kept off the UI thread. |
| `/api/exchange` | POST | nodejs | The single entry point for every HMAC-signed Binance/Bybit call. |
| `/api/health` | GET | nodejs | Two real active checks: trade-store read round-trip and Binance `/api/v3/ping`. |
| `/api/mcp-status` | POST | nodejs | HTTP reachability check for an MCP server URL. |

---

## `/api/chat` — the only LLM proxy, edge + streaming

Everything in this app that calls a model goes through `POST /api/chat`: chat
itself, Reflection, Hypothesis, and the Collaboration second opinion. **There is
no separate non-streaming endpoint** — a new LLM caller reuses the
`/api/chat` + `readSSEStream` buffering pattern from `components/Reflection.tsx`
(`CLAUDE.md`).

Why edge (the code's own reasoning): under the Node runtime this route was
verified locally to forward SSE chunks the instant they arrive, but Vercel's
Node.js Serverless Functions are documented to buffer a function's full response
before returning it, while Edge Functions are not. Edge is the runtime that
guarantees streaming if this is ever deployed there. Edge also means this route
cannot touch the filesystem — which is fine, because it persists nothing.

Request body (see `lib/chatUpstream.ts` and callers):

```json
{ "apiKey": "...", "baseUrl": "https://…/v1", "model": "…",
  "messages": [{ "role": "system", "content": "…" }],
  "temperature": 0.2, "maxTokens": 1536 }
```

Response: the upstream SSE stream, forwarded verbatim. Consumed client-side by
`readSSEStream` (`lib/sse.ts`).

**Key handling:** the API key is supplied by the client per request (keys live in
browser `localStorage`), used in memory for exactly one outbound request, and
never logged or persisted. Same trust model as `/api/exchange`.

---

## `/api/exchange` — signed exchange calls

Node runtime is mandatory here: HMAC signing uses Node's `crypto`, and browsers
should not be talking directly to an exchange's signed endpoints. The client
holds the key/secret (`components/ExchangeAccounts.tsx`, `localStorage`) and
sends it per request; the route signs and forwards, then discards.

Documented self-hosting caveat, verbatim in the file: the API secret crosses the
network from browser to this Next.js server on every call, the same as the LLM
key already does. Fine for localhost; anything beyond that needs a different
arrangement.

---

## Auth

There is **one** auth mechanism in the whole API surface: the optional
`TRADES_API_KEY` shared secret gating writes on `/api/trades`. It is unset by
default so local use needs zero setup. Every other route is unauthenticated.

**Status: no per-route auth, no rate limiting, no CSRF protection.** This is a
single-operator local/self-hosted app; exposing the server beyond your own
machine is not currently a supported configuration.

---

## Conventions across routes

- **Server-side fetch to avoid CORS** is the reason most GET routes exist at all
  (Binance, Yahoo, RSS hosts, exchange REST hosts send no CORS headers).
- **Crypto-only routes are labelled as such** — `/api/orderflow`,
  `/api/marketintel`, `/api/eventdata`, `/api/multiexchange`. Equities have no
  free equivalent; see `lib/providerCapabilities.ts`. Callers surface this as
  `'unavailable'`, never as a fabricated value.
- **Routes are thin.** They parse input, call a `lib/` module, and return JSON.
  Business logic lives in `lib/` so it stays pure and unit-testable — which is
  also why `db/README.md` can say a Postgres migration would not require route
  changes.
- **Audit/journal POSTs are fire-and-forget from the client** (`Supervisor.tsx`,
  `AutonomousTrader.tsx`). A failed POST never blocks or fails the decision it
  was recording.
