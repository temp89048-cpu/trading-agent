# TradingOS AI — real indicator/charting engine + two agent bugs fixed

## Bug #1 (the serious one): "opened, then immediately insufficient cash"
**Root cause, found by careful reading of the exact symptom, not a guess:**
`components/Agent.tsx`'s tick loop called `buyPaper()` — a real side
effect that deducts cash — *inside* the function passed to
`setTasks(prev => ...)`. React 18 Strict Mode (enabled in this project's
`next.config.js` since Commit 1) deliberately calls that kind of
function **twice** per update, specifically to catch exactly this kind
of impurity. `buyPaper` isn't pure — call it twice and it genuinely
deducts cash twice for one logical trade. First call succeeds, second
call is now actually short on cash and fails — which is exactly the
"opened" then "insufficient paper cash, agent stopped" sequence in your
transcript.

**Fix**: the tick loop now reads task state from a ref (a plain
synchronous value), decides what should happen, executes every side
effect exactly once in normal function-call code, and calls
`setTasks(nextTasksArray)` with a plain array — never a function — so
there's nothing left for Strict Mode to double-invoke. Same fix applied
to `cancelAgent`, which had the identical pattern (lower stakes — it
only would have duplicated a cancellation message, not double-charged
anything, but same root cause).

**I proved this, not just described it**: I wrote a small script that
literally simulates React Strict Mode's double-invocation against both
the old code's pattern and the new one, using a mock cash balance. The
old pattern reproduces your exact bug sequence — `['opened',
'insufficient cash, agent stopped']` — and drains the mock balance to
zero after one $2 trade (charged twice). The new pattern produces
exactly one event and charges once. That test is honestly the best
evidence I can produce without a real browser (see the sandbox
limitation note below).

## Bug #2: "start agent" made it fabricate an entire fake simulation
When your previous turn ended in "Didn't start an agent — confidence
too low," and you replied with a plain **"start agent"** (no `@tag`),
the app found no `@papertrade`/`@real` mention in that message,
attached no trade instruction at all, and the model — completely
ungoverned — invented an entire fake trade sequence in prose (made-up
prices, made-up TP/SL triggers), presented as if it had actually
happened. Nothing was logged; it was pure fabrication.

**Fix, two parts:**
1. `lib/tradeIntent.ts` now has `inferContinuationTab`: if the current
   message has no tag, but the *previous* assistant message was clearly
   a pending/rejected trade decision, it looks back for the most recent
   user message that *did* mention `@real`/`@papertrade` and reuses
   that tab — so "start agent" now correctly gets governed the same way
   the original request was. Tested directly against your exact
   transcript sequence, plus a negative case (an unrelated follow-up
   after a *successful* trade correctly does NOT trigger this).
2. The system prompt now explicitly states: the model has no ability
   to execute, monitor, or wait for anything; the *only* thing that
   ever affects the real trade log is a valid action block; and it must
   never narrate a trade, a fill, a TP/SL trigger, or a "simulation" as
   if it were real. If asked to simulate hypothetically, it must label
   it as such, not present invented numbers as observations.

## The indicator/charting engine you asked for
You were right that the model's "I don't have indicator access"
disclaimer was a real limitation, not over-caution — the app genuinely
had no historical price data, only a single live tick. Fixed properly:

- **`lib/indicators.ts`** — RSI (Wilder's method), MACD, EMA, SMA,
  Bollinger Bands, ATR, VWAP. Dependency-free, and validated against
  the classic Wilder/StockCharts reference RSI example (expected ~70.5,
  got 70.46) plus edge cases (strictly rising → RSI 100, strictly
  falling → RSI 0, flat → RSI 50).
- **`app/api/candles/route.ts`** — real OHLC history: Binance klines
  for crypto, Yahoo's chart endpoint for equities. This is what makes
  real indicators possible at all.
- **`components/Candles.tsx`** — background cache, auto-refreshing 1h
  and 4h candles for every watchlist symbol every 60s, so a chat message
  never has to wait on a fetch.
- **Real indicators are now injected into every chat request** — the
  model gets actual computed RSI/MACD/EMA/Bollinger/ATR values per
  watchlist symbol per timeframe, and is told plainly when nothing's
  computed yet for something, instead of inventing plausible numbers.
- **`components/LiveChart.tsx`** — a real in-app chart using
  `lightweight-charts` (TradingView's own open-source engine, now an
  actual dependency of this project) rendering candles + EMA20/EMA50 +
  Bollinger bands on the main pane, RSI in its own pane, MACD histogram
  in a third — computed by *this app*, not an embed. The chart modal
  (click any watchlist symbol) now toggles between this and the
  existing TradingView iframe.
- Ran the full pipeline against 250 bars of realistic synthetic
  OHLC data (deterministic, seeded) since this sandbox can't reach
  Binance/Yahoo: RSI stayed in [0,100], Bollinger bands stayed properly
  ordered, and EMA20 < EMA50 < EMA200 correctly reflected the
  downtrend I fed it. All sanity checks passed.

## Honest limitations going in
- **This sandbox cannot reach `api.binance.com` or Yahoo's endpoints**
  (same network restriction as `/api/quote` and `/api/news` in earlier
  commits) — confirmed the route fails gracefully (clean `502`, not a
  crash) rather than actually fetching real candles. Test real data
  from your machine.
- **I could not run a real browser test of the Strict Mode fix.** I
  proved the *mechanism* with a faithful simulation, and the fix
  structurally removes any function that Strict Mode's double-invoke
  check applies to — but watching the actual scheduler run correctly
  over real time in a real browser is still worth doing yourself.
- **`lightweight-charts` renders based on whatever candles actually
  come back** — I could not visually confirm the chart renders
  correctly in a browser (canvas rendering, same sandbox limitation).
  The data pipeline feeding it is tested; the pixels are not.
- Yahoo's intraday history has real limits (e.g., 1-minute bars only
  go back ~7 days) — the route respects that with per-interval range
  mapping, but very long lookback + very fine granularity for equities
  will legitimately return less history than for crypto.

## Run it
```bash
npm install
npm run dev
```
