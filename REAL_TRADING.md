# Real Exchange Trading (Binance + Bybit)

This app can place **real orders with real money** on your actual Binance
and/or Bybit account, driven by the same Supervisor/Agent decision logic
that governs paper trading. Read this whole file before connecting a live
account — it is a different risk category from everything else in this app.

## Scope — read this first

- **Spot trading only. Not futures/margin.** This app's "leverage" field has
  always been notional-only for paper trades — building real margin/
  liquidation mechanics (isolated vs cross margin, funding rates, position
  mode) is a materially larger and riskier undertaking than spot order
  placement, and isn't what this connects to. If you need real futures
  execution, that should be its own deliberate piece of work, built and
  reviewed on its own.
- **Binance and Bybit only**, via each exchange's public signed REST API
  (Binance Spot v3, Bybit V5 Unified). Not tested against a live endpoint
  from this development environment — this sandbox has no network route to
  `api.binance.com` or `api.bybit.com` (same limitation this app has always
  had for its read-only candle/quote fetching). The signing math is unit
  tested (`lib/exchangeClients/*.test.ts`); the actual HTTP round-trip
  against a real account is not something that could be verified here.
  **Test on testnet before trusting this with real funds.**

## How it works

1. **Connect an account** — Trading Sidebar → Risk & Controls → Exchange
   Connections. Paste an API key/secret, pick testnet or mainnet, click
   Connect/Test. A successful connection shows your real (or testnet)
   balances.
2. **Pick a preferred exchange** — if you connect both, one dropdown
   decides which one actually receives real orders. There's no per-symbol
   routing between the two in this build — that's a real limitation, not
   an oversight, and would be a reasonable next step if you need it.
3. **Pick a Real Trading Mode**:
   - **Manual** (default) — every real BUY is queued in Trading Controls
     for you to Approve or Reject, regardless of any USD threshold set
     there. Nothing executes without your click.
   - **Automatic** — real BUYs execute the instant they pass risk checks,
     the same way paper trading already works, subject only to Trading
     Controls' pause toggle and approval-threshold (if you've set one).
   - **Sells/closes are never gated by either mode** — same "never block
     an exit" principle this app applies to every risk check. That matters
     more for real money, not less: you don't want to be stuck unable to
     exit a losing real position because you weren't at your computer to
     click Approve.
4. **Nothing changes if you don't connect anything.** The `real` tab's
   pre-existing behavior — a manual ledger you tell the app about, with no
   actual exchange call — is exactly what happens if no exchange is
   connected+preferred. Connecting an exchange is opt-in.

## Before you paste in a real API key

- **Create a trading-only key. Never enable withdrawals on it.** A stolen
  trading-only key can lose you money through bad trades. A withdrawal-
  enabled key can lose you everything in the account, directly, with no
  trade involved at all.
- **Use your exchange's IP allowlist feature** if you run this from a
  fixed IP address.
- **Start on testnet.** Both exchanges offer free testnet environments
  that behave like the real API with fake funds — exactly what this was
  built to be verified against first.
- **Understand the storage model.** API keys/secrets are stored in this
  browser's `localStorage`, in plain text — the same trust model this app
  already uses for LLM provider keys. That's a reasonable tradeoff for a
  single-user app that never leaves your own machine. It is **not**
  reasonable if you ever expose this app beyond `localhost` — see
  `app/api/exchange/route.ts`'s header comment for the exact data flow.

## Known limitations, stated plainly rather than hidden

- **No LOT_SIZE / step-size precision handling.** Quantities are rounded to
  6 decimal places and sent as-is — not validated against the symbol's real
  minimum increment (querying and caching `exchangeInfo` per symbol would
  be a reasonable follow-up). If a symbol's step size disagrees, the
  exchange rejects the order with a clear error; it is not silently
  resized to something you didn't ask for.
- **Real order placement is asynchronous; the Supervisor's synchronous
  decision call can't wait on it.** `reviewAndExecute` returns
  `realOrderSubmitted: true` immediately, then the fill is confirmed (or
  the failure is recorded) a moment later — visible in `/audit`, and in
  the trade log once ledgered. This means an Agent task's own TP/SL
  tracking uses the *requested* price as a placeholder until the real fill
  confirms; if the real fill price differs meaningfully from the requested
  price (a fast-moving market), the agent's percentage-based TP/SL is
  computed from a slightly approximate entry until it re-reads the real
  ledger.
- **One preferred exchange globally, not per-symbol.** See "Pick a
  preferred exchange" above.
- **Bybit market orders don't report fill price/quantity synchronously** —
  this app makes one follow-up `getOrderStatus` call to get it. Binance's
  market-order response includes fills directly, no follow-up needed.
- **A manually-approved real BUY fills at the price it was queued at, not
  a fresh quote** — same documented limitation the paper-trading manual-
  approval queue already has. For a fast-moving market this can mean a
  real market order fills at a different real-world price than what was
  shown when you clicked Approve (the exchange fills at whatever the
  market actually is at that instant — this app never sends a limit price,
  only a `qty`).

## Where to look when something goes wrong

- **`/audit`** — every Supervisor decision, including a follow-up record
  once a real order actually confirms or fails (search for `Real <exchange>
  order ... confirmed` or `Real <exchange> order failed`).
- **Browser console** — real order failures are also `console.error`'d
  from `components/Supervisor.tsx`'s `submitRealOrderAsync`.
- **The exchange's own order history** — the ultimate source of truth for
  what actually happened to your account; this app's ledger reconciles
  from the exchange's response, but if in doubt, check there directly.
