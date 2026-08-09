# 12 — Risk Engine

**Status: implemented.** `lib/riskManager.ts` + `lib/positionSizing.ts`.
Invoked from `lib/supervisorAgent.ts`'s `reviewTradeRequest()` via
`validateTrade()`, which is reached only through
`components/Supervisor.tsx`'s `reviewAndExecute()`.

The Risk Engine holds **veto authority and nothing else** — its agent
contract deliberately excludes `execute-trades` (see
`lib/agentDescriptors.ts`). It can only ever say no.

---

## The nine checks

`validateTrade()` runs all of these and collects results into
`checks: Record<string, RiskCheck>`. A `RiskCheck` is
`{ ok, status: 'pass' | 'reject' | 'unavailable', detail }` — `detail`
always states the real numbers and the threshold, so a rejection is
explainable rather than a bare refusal.

| Check | Rejects when | Config field |
|---|---|---|
| `positionRisk` | Risk (qty × stop distance) exceeds max % of equity | `maxRiskPctPerTrade` (2%) |
| `dailyLoss` | Today's realized loss exceeds the limit | `maxDailyLossPct` (5%) |
| `drawdown` | Drawdown from peak equity exceeds the limit | `maxDrawdownPct` (15%) |
| `liquidity` | Requested size is large vs visible top-of-book depth | `minBookDepthMultiple` (3×) |
| `spread` | Spread wider than the threshold | `maxSpreadPct` (0.5%) |
| `leverage` | Above the hard ceiling, **or** stop sits too close to liquidation | `liquidationSafetyBuffer` (1.5×) — ceiling is NOT configurable |
| `portfolioExposure` | Total exposure (existing + new) exceeds the cap | `maxPortfolioExposurePct` (75%) |
| `correlation` | Combined exposure to highly-correlated holdings exceeds the cap | `correlationRejectThreshold` (0.75), `correlationExposureLimitPct` (40%) |
| `news` | **Never rejects** — reduces recommended size instead | 90-min window, ×0.6 size |

`approved` is `rejectionReasons.length === 0`. Reasons are **deduplicated**,
because two checks can fail for one root cause (a missing stop-loss
blocks both `positionRisk` and `leverage`) and reporting it twice reads
as two separate problems.

`'unavailable'` results are surfaced as `cautionNotes` — visible, not
silently treated as passes.

---

## Non-negotiable rules

### 1. The leverage ceiling cannot be overridden

`ABSOLUTE_MAX_LEVERAGE = 3` (real) / `ABSOLUTE_MAX_LEVERAGE_PAPER = 10`
(paper), via `maxLeverageCeiling(tab)`.

These are **deliberately not members of `RiskConfig`**. Every other limit
is operator-tunable through `components/TradingControls.tsx`; putting the
ceiling there would make it overridable, which is exactly what spec
Section 22.3 forbids. `checkLeverage()` tests the ceiling **before** the
1×-early-return and before any stop-distance math, so no combination of a
tight stop and a lowered `liquidationSafetyBuffer` can compute past it.

`checkLeverage`'s `tab` parameter defaults to `'real'` — a caller that
forgets to pass one gets the **strict** behavior, not the lax one.

The paper/real split is a stated judgment call, not a softening: the
spec's rationale is protecting real capital from a liquidation-scale
move, which genuinely doesn't apply to paper — and paper is where a
higher-leverage strategy *should* be testable. Paper is still hard-capped
so runaway 100× paper tasks remain impossible.

Guarded by tests in `lib/riskManager.test.ts`, including one that
asserts a lowered safety buffer **cannot** unlock leverage above the
ceiling. (An earlier test asserted the opposite — that lowering the
buffer permitted 5× — and was updated, because it encoded the loophole.)

### 2. Every position requires a computed stop-loss

If `computeStopLossTakeProfit()` returns `null` (no ATR — insufficient
candle history), both `positionRisk` and `leverage` become a hard
`reject`. Previously both degraded to non-blocking `'unavailable'`,
meaning a trade could execute with **no stop and an unchecked leverage
figure** — precisely the combination those checks exist to prevent.

### 3. Closes are never blocked

`reviewTradeRequest()` returns early and approved for any `side === 'sell'`.
Not by pause, not by risk, not by a Debate veto. Refusing to let someone
exit a position they're already in is actively harmful — and this holds
*more* for real money, not less.

---

## Stop-loss / take-profit derivation

`computeStopLossTakeProfit()`, in priority order:

1. **Structural** — nearest swing high/low against the trade. If that
   level breaks, the setup's thesis is wrong, not just "price moved."
2. **ATR floor** — a structural stop closer than `1.2 × ATR` is
   noise-distance, so it's widened to the floor rather than trusted.
3. **ATR fallback** — `1.8 × ATR` when no swing exists (wider, because
   there's no structural backing).

Take-profit is a fixed 2:1 reward:risk multiple of the final stop
distance.

## Position sizing

`lib/positionSizing.ts`: fixed-fractional, volatility-based, max-exposure
cap, and **half-Kelly** (not full — full Kelly is too aggressive for
uncertain probability estimates). `computeKellyRiskCap()` can only ever
*shrink* risk below the fixed cap, never grow it past it, regardless of
how good the trade history looks.

---

## Honest gaps

- **Real-tab checks depend on a declared baseline.** `dailyLoss`,
  `drawdown`, `positionRisk`, and `portfolioExposure` read
  `'unavailable'` for the `real` tab unless the operator enters
  "Real account starting capital" in Trading Controls — the real tab has
  no exchange-tracked cash balance (it's a manual ledger). Once declared,
  equity is reconstructed as declared capital + realized P&L + unrealized
  P&L. Left blank, behavior is identical to before this existed.
- **`liquidity` and `spread` need order-book data**, which
  `lib/providerCapabilities.ts` reports as unavailable for equities.
  Those checks read `'unavailable'` there.
- **Not futures.** "Leverage" is notional-only for paper; real trading is
  spot only. There is no margin/liquidation engine — see
  `REAL_TRADING.md`.
- **No isolated-margin enforcement**, because there is no margin trading
  to enforce it on. Spec Section 22.3 lists it; it is not applicable to
  the current spot-only scope rather than skipped.
