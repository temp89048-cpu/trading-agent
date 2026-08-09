# 06 — Market Intelligence

Everything in this document is computed in `lib/` from real OHLCV candles,
real Binance depth/trade snapshots, or real Binance Futures endpoints.
None of it is an LLM "reading the chart" — these are deterministic
functions, unit-tested where the math matters (`lib/indicators.test.ts`).

Each module follows the same two-part shape:

1. **Pure compute functions** returning typed snapshots (or `null` when
   inputs are insufficient — never a plausible-looking fallback number).
2. **A `build*Context(...)` formatter** that turns the snapshot into a
   plain-text system message injected into `/api/chat` (assembled in
   `components/AppState.tsx`).

---

## Module map

| File | Computes | Primary output type |
|---|---|---|
| `lib/indicators.ts` | SMA, EMA, RSI, MACD, Bollinger, ATR, VWAP | scalars / small records, `null` when short of data |
| `lib/marketStructure.ts` | Swing points, HH/LH/HL/LL labels, BOS/CHoCH | `StructureSnapshot` |
| `lib/liquidity.ts` | Equal-high/low clusters, sweep (stop-hunt) events | `LiquiditySnapshot` |
| `lib/volumeProfile.ts` | POC, Value Area, HVN/LVN | `VolumeProfile \| null` |
| `lib/orderFlow.ts` | Book pressure, aggressive flow, large orders | `OrderFlowSnapshot` |
| `lib/multiTimeframe.ts` | Per-timeframe trend + state across 7 TFs | `SymbolMtfSnapshot` |
| `lib/sentimentAgent.ts` | Heuristic news sentiment, derivatives read, Market Health Score | `SentimentResult`, `MarketHealthScore` |
| `lib/eventDetection.ts` | Volatility explosion, unusual volume, gap, funding spike, OI drop | `MarketEvent[]` |
| `lib/strategyContext.ts` | Bundles all of the above into one per-symbol object | `StrategyContext \| null` |

---

## `lib/indicators.ts`

Shared `Candle` type: `{ t, o, h, l, c, v }`.

| Function | Signature | Notes |
|---|---|---|
| `sma` | `(values, period) => number \| null` | Simple mean of last `period` values. |
| `emaSeries` | `(values, period) => (number \| null)[]` | Full series (nulls until the seed SMA exists). MACD needs the whole series. |
| `ema` | `(values, period) => number \| null` | Last element of `emaSeries`. |
| `rsi` | `(closes, period=14) => number \| null` | Wilder's smoothing. Returns `100` when avg loss is 0 and avg gain > 0; `50` when both are 0. |
| `macd` | `(closes, 12, 26, 9) => { macd, signal, histogram } \| null` | Needs `slow + signalPeriod` bars. |
| `bollingerBands` | `(closes, 20, 2) => { upper, middle, lower } \| null` | Population stdev over the window. |
| `atr` | `(candles, period=14) => number \| null` | True range with Wilder's smoothing. |
| `vwap` | `(candles) => number \| null` | **Cumulative** over whatever window is passed — not session-anchored. Caller must pass a session's candles for a true session VWAP. |

Every function returns `null` rather than a partial estimate when there
aren't enough bars. This is load-bearing: `atr` returning `null` is what
makes `validateTrade()` hard-reject a position with no computable stop
(see safety invariant 3 in `CLAUDE.md`).

## `lib/marketStructure.ts`

**Swing detection.** `findRawSwingPoints(candles, strength)` — a bar is a
swing high if its `h` is strictly greater than the highs of `strength`
bars on both sides (a fractal); mirror for lows. `DEFAULT_STRENGTH = 2`
(5-bar fractal).

**Labelling.** Each swing is compared to the previous swing of the *same*
type: `HH`/`LH` for highs, `HL`/`LL` for lows. The first swing of a type
gets `label: null` — nothing to compare against yet.

**BOS / CHoCH.** A trend is only *confirmed* by HH-then-HL (bullish) or
LL-then-LH (bearish). Before confirmation, `currentTrend` stays
`'undefined'` and no break events are logged.

- Bullish + close above the watched swing high → `BOS` (continuation).
- Bullish + close below the watched swing low → `CHoCH`, trend flips bearish.
- Mirror for bearish structure.
- After a break fires, the watched level is cleared so a fresh swing is
  required before the next event of that kind can log.

Output:

```ts
type StructureSnapshot = {
  swings: SwingPoint[];        // { index, time, price, type, label }
  events: StructureEvent[];    // { index, time, type: 'BOS'|'CHoCH', direction, brokenLevel, brokenSwingIndex }
  currentTrend: 'bullish' | 'bearish' | 'undefined';
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
};
```

Context timeframes: `15m`, `1h`, `4h`.

## `lib/liquidity.ts`

Clusters swing highs (and separately lows) that sit within
`EQUAL_TOLERANCE_PCT = 0.15%` of the running cluster average — "equal
highs/lows" the market treats as one level, i.e. a pool of resting stops.

- `MIN_TOUCHES = 2` to register a zone at all.
- `LARGE_POOL_MIN_TOUCHES = 3` → `size: 'large'`.
- Zones sorted most-recently-touched first.

**Sweep detection.** Scanning only candles *after* a zone formed: for
`equal_highs`, a bar with `h > level` and `c < level` is a sweep (wick
grabbed the liquidity, close rejected). Mirror for `equal_lows`. One
sweep logged per zone — once swept, the pool is spent.

```ts
type LiquiditySnapshot = {
  zones: LiquidityZone[];   // { type: 'equal_highs'|'equal_lows', level, touches, size, firstIndex, lastIndex }
  sweeps: LiquiditySweepEvent[]; // { index, time, zone, wickPrice }
};
```

Context timeframes: `15m`, `1h`, `4h`.

## `lib/volumeProfile.ts`

Buckets the `[min low, max high]` range into `DEFAULT_BINS = 24` bins and
sums candle volume per bin.

- **POC** — midpoint of the highest-volume bucket.
- **Value Area** — expand outward from the POC bucket, always taking the
  higher-volume neighbour, until `VALUE_AREA_PCT = 70%` of total volume
  is enclosed. `vah` = top of the top bucket, `val` = bottom of the
  bottom bucket.
- **HVN** — a local volume peak (greater than both neighbours) holding
  ≥ `1.5×` mean bucket volume.
- **LVN** — local trough at ≤ `0.5×` mean.

**Documented approximation:** OHLCV candles carry no intrabar tick data,
so each candle's entire volume is assigned to the bin containing its
typical price `(h+l+c)/3`, rather than distributed across its traded
range. Coarser than a tick-level profile, especially on wide-range bars.
The generated context string states this rather than implying precision
it doesn't have.

Returns `null` on empty input, flat data (`max <= min`), or zero total
volume. Context timeframe: `1h` only.

## `lib/orderFlow.ts`

Consumes `RawOrderFlowData` from `/api/orderflow` (Binance depth snapshot
+ recent aggTrades). The math is kept pure and separate from the fetch.

| Function | Output | Rule |
|---|---|---|
| `computeOrderBookPressure(bids, asks, levels=20)` | `OrderBookPressure \| null` | `imbalance = (bidVol - askVol)/total`, −1..+1. `\|imbalance\| <= 0.1` → `'balanced'`. Also reports `bestBid`, `bestAsk`, `spreadPct`. |
| `computeAggressiveFlow(trades)` | `AggressiveFlow \| null` | Uses Binance's `buyerIsMaker`: maker-buyer means the **seller** crossed the spread. Same 0.1 threshold for `'balanced'`. |
| `detectLargeOrders(trades, multiplier=5)` | `LargeOrder[]` | Trades ≥ 5× the **median** trade size. Median deliberately, not mean — the mean gets dragged up by the very outliers being detected. |

`computeOrderFlow` returns all three as `OrderFlowSnapshot`.

`buildOrderFlowContext` calls `checkCapability(item, 'orderBook')` first
and, when unsupported, emits an explicit
`Status: Unsupported. Reason: … Recommendation: …` line rather than any
estimate.

## `lib/multiTimeframe.ts`

`MTF_TIMEFRAMES = ['1m','5m','15m','1h','4h','1d','1w']`.

Two-layer classification per timeframe, both traceable to plain numbers:

1. **Direction** — EMA20 vs EMA50. Spread within
   `FLAT_THRESHOLD_PCT = 0.05%` → `'neutral'` ("Flat — EMA20/EMA50
   converged"). If there isn't enough history for EMA50, direction falls
   back to price-vs-EMA20 and the detail string says so explicitly.
2. **State** over `LOOKBACK_WINDOW = 8` bars →
   `'Momentum Returning'` / `'Breakdown Resuming'` (price crossed EMA20
   in the window and is now clearly back on the trend side),
   `'Pullback'` / `'Relief Bounce'` (retrace off the window's raw
   high/low beyond `RETRACE_THRESHOLD_PCT = 0.12%`),
   `'Momentum Extending …'` (spread > `EXTENDED_THRESHOLD_PCT = 0.15%`,
   no retrace), else `'Holding above/below EMA20'`.

State uses **raw** window highs/lows rather than EMA-relative spread
because a freshly seeded EMA's own warm-up lag would otherwise read as a
pullback.

Rollup (`computeMtfSnapshot`) is an honest count, not a weighted model:
majority trend across whichever timeframes had enough data, an
`agreement` string (`"5/7 timeframes agree"`), and an `assessment`
derived from that same ratio plus how many timeframes are actively
confirming:

| Condition | Assessment |
|---|---|
| neutral / no dominant | "No clear direction — timeframes are split or flat" |
| ratio ≥ 0.75 and ≥1 confirming | "High probability continuation" |
| ratio ≥ 0.6 | "Likely continuation, but confirmation is mixed" |
| ratio > 0.5 | "Weak majority — treat direction as contested" |
| else | "Mixed signals across timeframes — no reliable majority" |

Timeframes with no candle history are omitted, never guessed.

## `lib/sentimentAgent.ts`

Three real inputs plus one explicitly-labelled heuristic.

**Real:** Binance Futures derivatives (`fundingRate`, `openInterest`,
`topTraderLongShortRatio`, `topTraderLongAccountPct`,
`takerBuySellRatio`) and alternative.me's Fear & Greed Index.

**Heuristic:** `BULLISH_KEYWORDS` / `BEARISH_KEYWORDS` matched against
RSS headlines filtered to the symbol via `SYMBOL_ALIASES` (BTC →
`btc`/`bitcoin`, etc.). This is a keyword scan, not NLP, and both the
code comment and the injected context string say so.

`computeSentiment` sums weighted scores (funding ±10, top-trader ratio
±10, taker ratio ±8, Fear & Greed ±10, headline hits capped at 15 per
side) and returns:

```ts
type SentimentResult = {
  sentiment: 'Bullish' | 'Bearish' | 'Neutral'; // |net| > 10 to leave Neutral
  confidence: number;      // 50 + |net|, hard-capped at 95 — never near-certainty off a heuristic
  reasons: string[];
  riskNote: string | null; // crowded funding / Extreme Greed / Extreme Fear warnings
};
```

`computeMarketHealthScore` maps five already-computed numbers to 1–5
stars each (MTF agreement, momentum-timeframe ratio, |funding| bands,
sentiment confidence/20, Fear & Greed classification) and returns
`overall` as `(sum/25)*100`, plus `bias` and a `risk` label
(`High` if ≥2 categories ≤2 stars, `Medium` if exactly 1, else `Low`).
No category is invented — each traces to a real input, and unknown
funding/Fear&Greed default to a neutral 3 stars.

**Asset-class gating in the context builder:** Fear & Greed is a crypto
index, so it is passed as `null` for equities rather than misapplied.
Derivatives are gated behind `checkCapability(item, 'fundingRate')`.

X/Twitter and Reddit sentiment sources are surfaced as
`Status: Planned` from `lib/newsProviders.ts` (`X_TWITTER_STATUS`,
`REDDIT_STATUS`) — **Status: not implemented**.

## `lib/eventDetection.ts`

| Detector | Inputs | Trigger | `high` severity at |
|---|---|---|---|
| `detectVolatilityExplosion` | candles (≥16) | latest bar's true range ≥ 2.5× current ATR(14) | ≥ 4× |
| `detectUnusualVolume` | candles (≥21) | latest volume ≥ 3× trailing 20-bar average (latest excluded from its own baseline) | ≥ 5× |
| `detectGapOpening` | candles (≥2), assetType | \|gap%\| ≥ 1.5% crypto / 0.5% equity | ≥ 2× threshold |
| `detectFundingRateSpike` | funding history (≥8 points) | \|z-score\| vs trailing settlements ≥ 2.5 | ≥ 4 |
| `detectOiDelta` | OI history (≥2 points) | OI **drop** ≥ 5% over the window | ≥ 10% |

`detectMarketEvents({ symbol, assetType, candles, fundingHistory?, oiHistory?, priceChangePctOverOiWindow? })`
runs each applicable check and returns `MarketEvent[]`
(`{ kind, symbol, severity: 'medium'|'high', detail, ts }`). Funding and
OI checks are skipped entirely for equities — those are futures concepts
with no equity equivalent — and skipped silently (not faked) when their
history wasn't supplied.

Two honest scoping notes carried in the code:

- **OI drop is a liquidation-cascade *proxy*,** not a liquidation feed.
  Binance's real forced-liquidation websocket is not consumed. An OI
  *rise* is never flagged — that's new positioning, not a cascade.
- **A crypto "gap" is a candle-boundary artifact,** not a session gap,
  which is why the crypto threshold is 3× the equity one.

### Deliberately not built: `PLANNED_EVENT_TYPES`

**Status: not implemented.** Two event types are declared in code as
`PlannedEventType` records rather than silently omitted:

| Constant | Event | Why not built | Recommended providers |
|---|---|---|---|
| `WHALE_TRANSFER_STATUS` | Whale Transfer Detection | Needs real on-chain, wallet-to-wallet transfer data. No free/no-key API provides it at the needed volume or reliability. Inferring it from price/volume would present a guess as an on-chain fact. | Whale Alert, Nansen, Arkham Intelligence |
| `EXCHANGE_FLOW_STATUS` | Exchange Inflow/Outflow Detection | Same root cause — needs address-level data on which wallets are exchange-owned plus a historical balance baseline. The exchange REST endpoints already wired up (Binance, Bybit, OKX, Kraken, Coinbase) expose market data only, never their own wallet balances. | Glassnode, CryptoQuant, Nansen |

Both are `complexity: 'High'`, targeted at
`'v2 / Future Release (needs a funded data provider decision)'`, and both
require **a paid on-chain data provider subscription** as their first
listed prerequisite. `buildEventDetectionContext` prints them under
"NOT YET DETECTED (roadmap, not a gap to guess around)" so the model
knows the gap exists and doesn't improvise around it.

## `lib/strategyContext.ts`

One object every strategy agent reads from. `buildStrategyContext(item,
primaryCandles, mtfLookup, rawOrderFlow)` returns `null` if fewer than
`MIN_CANDLES = 55` primary (1h) bars exist — enough for EMA50 and the
rest of the stack to be meaningful.

```ts
type StrategyContext = {
  symbol: string;
  price: number;                    // last close of the primary series
  candles: Candle[];                // primary timeframe (1h)
  rsiValue: number | null;
  macdValue: MacdResult | null;
  ema20: number | null;
  ema50: number | null;
  bb: BollingerResult | null;
  atrValue: number | null;
  vwapValue: number | null;
  mtf: SymbolMtfSnapshot;
  structure: StructureSnapshot;
  liquidity: LiquiditySnapshot;
  volumeProfile: VolumeProfile | null;
  orderFlow: OrderFlowSnapshot | null;  // null when unsupported (equities) or not loaded yet
};
```

Strategy agents return the shared shape:

```ts
type StrategySignal = {
  agent: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number; // 0..1 — this agent's own conviction, not the ensemble's
  reason: string;
};
```

No agent fetches anything or invents a number; they only branch on what
`StrategyContext` already holds. See `docs/11_TRADING_STYLES.md`.

---

## Provider capability matrix — what equities cannot do

`lib/providerCapabilities.ts` is a **capability registry, not a router**.
Nothing else in the app asks "is this crypto?" — it asks this module.
Adding a real equities L2 provider later means editing one entry here.

Two descriptors exist. `getProviderForAsset(item)` returns Binance for
`item.type === 'crypto'`, Yahoo Finance otherwise.

| Capability | Binance (crypto) | Yahoo Finance (equity) |
|---|---|---|
| `price` | ✓ | ✓ |
| `candles` | ✓ | ✓ |
| `volume` | ✓ | ✓ |
| `technicalIndicators` | ✓ | ✓ |
| `news` | ✗ | ✗ |
| `orderBook` | ✓ | **✗** |
| `trades` | ✓ | **✗** |
| `bidAskDepth` | ✓ | **✗** |
| `aggressiveFlow` | ✓ | **✗** |
| `largeOrders` | ✓ | **✗** |
| `fundingRate` | ✓ | **✗** |
| `openInterest` | ✓ | **✗** |

`news: false` for both is deliberate — news comes from the separate RSS
agent (`lib/newsProviders.ts`), not from either market-data provider.

**Consequences for equities:**

| Signal | Equity status |
|---|---|
| Order-book pressure, aggressive flow, large-order detection (`lib/orderFlow.ts`) | Unavailable — `buildOrderFlowContext` emits `Status: Unsupported` with the reason and a recommendation to connect **Polygon.io, Alpaca, Interactive Brokers, or Finnhub** (`EQUITY_L2_ALTERNATIVES`). |
| Funding rate, open interest, top-trader long/short, taker buy/sell (`lib/sentimentAgent.ts`) | Unavailable — futures-market concepts with no equity equivalent. Derivatives line reads `Status: Unsupported`. |
| Funding-spike and OI-delta events (`lib/eventDetection.ts`) | Not run — gated on `assetType === 'crypto'`. |
| Fear & Greed Index | Not applied — it measures crypto sentiment specifically. |
| `StrategyContext.orderFlow` | `null` for equities. Strategies depending on it must degrade, not assume. |
| Indicators, market structure, liquidity zones, volume profile, MTF trend, volatility/volume/gap events | **Available** — all derive from OHLCV only. |

For crypto, the only ✗ is `news`. `checkCapability` still returns a
recommendation for a hypothetical crypto funding/OI gap ("wire up Binance
Futures endpoints") even though both are now `true` — kept so the
message stays correct if the flags are ever reverted.

`buildCapabilityContext` injects a per-symbol ✓/✗ matrix into chat with
an explicit instruction: **✗ means genuinely unavailable, not "not
checked yet" — never estimate or infer a value for a ✗ capability.**
