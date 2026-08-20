"""Does the Polymarket signal predict anything? — Phase 38.

`polymarket.md` §7 asks for a predictive-power study: correlation, AUC,
precision/recall, Sharpe, statistical significance, walk-forward validation, and an
ablation matrix over ΔP thresholds and windows.

This implements the measurable core of that and refuses the rest, for reasons worth
stating rather than leaving as gaps.

WHAT THIS MEASURES
------------------
One question, answered honestly: **does a prediction-market move precede a crypto
price move in the same direction, more often than chance?**

    for each stored probability observation at time t:
        signal  = sign(ΔP over the lookback window)      (skipped if unmeasurable)
        outcome = sign(price return from t to t + horizon)
        hit     = signal == outcome

From the hit sequence: hit rate, a two-sided binomial p-value against a fair coin,
and the mean forward return conditioned on the signal. Ablations vary the window, the
horizon and the ΔP threshold.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
**No Sharpe ratio, no equity curve, no max drawdown.** Those describe a STRATEGY, and
there is no strategy here: the prediction specialist contributes 1.0 of 8.0 panel
weight to a decision that also passes the Supervisor, the Risk Gateway and a
stop-loss requirement. Simulating "buy when ΔP > 3%" and reporting its Sharpe would
measure something this system will never do, and the number would be quoted as if it
described the agent.

`HistoricalBacktestEngine` exists for whole-system simulation and is the right tool
for that question later. It is not used here — this study needs no order flow.

**No AUC.** AUC needs a continuous score ranked against a binary label, and it is
computable — but with the sample sizes available (see below) it would be a precise
number over a handful of observations, which reads as more evidence than it is. Hit
rate with an explicit p-value and n makes the sample size impossible to overlook.

**No walk-forward split.** With no data at all, splitting zero observations into
train and test folds produces two empty folds and a false impression of rigour. The
split becomes meaningful once there is history; `MIN_OBSERVATIONS` is the gate.

WHY IT WILL REPORT "INSUFFICIENT DATA" FOR A LONG TIME
------------------------------------------------------
It needs stored probability history, which needs the poller to have run, which needs
`POLYMARKET_ENABLED`, a confirmed mapping, and network access to Polymarket. None of
those hold in this environment. So the harness is written to report that clearly and
return no metrics — rather than computing a hit rate over three observations and
presenting 0.67 as a finding.

THE OUTPUT CANNOT DEPLOY ITSELF
-------------------------------
The result is written as a `research_store` hypothesis with status `proposed`.
CLAUDE.md invariant 5: learning produces understanding, it does not deploy. A study
showing weight 2.0 beats 1.0 must NOT write `DIRECTIONAL_WEIGHTS` — a human reads it
and changes the weight themselves.

`tests/test_learning_pipeline.py` asserts no learning module imports anything that
can write trading configuration, and `tests/test_polymarket_validation.py` asserts
this module cannot reach the weights.
"""

from __future__ import annotations

import logging
import math
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.algorithms import prediction_market as pm

logger = logging.getLogger(__name__)

# Below this, no metrics are reported at all.
#
# 30 is not a statistical convention so much as a floor on embarrassment: at n=30 a
# hit rate of 0.70 has a two-sided p of roughly 0.04, so the number can at least
# distinguish itself from a coin. Below that, any hit rate is compatible with chance
# and reporting one invites it to be read as a finding.
MIN_OBSERVATIONS = 30

# The ablation grid. Deliberately small — §7's matrix crossed five dimensions, which
# over one dataset is a multiple-comparisons machine: twenty cells will produce a
# "significant" one by construction. Three windows x three horizons x two thresholds
# is 18 cells, and `BONFERRONI_NOTE` is reported alongside so the reader adjusts.
ABLATION_WINDOWS_SECONDS: Tuple[float, ...] = (900.0, 3600.0, 21600.0)
ABLATION_HORIZONS_SECONDS: Tuple[float, ...] = (3600.0, 14400.0, 86400.0)
ABLATION_THRESHOLDS: Tuple[float, ...] = (0.02, 0.05)

BONFERRONI_NOTE = (
    "p-values are UNADJUSTED and this grid has {cells} cells. At the conventional 0.05 "
    "level roughly one cell is expected to look significant by chance alone, so divide "
    "by the cell count (Bonferroni) before believing any single one: the honest "
    "threshold here is {adjusted:.4f}"
)


@dataclass
class CellResult:
    """One ablation cell. Every field is either measured or None."""

    window_seconds: float
    horizon_seconds: float
    threshold: float
    observations: int
    hits: Optional[int] = None
    hit_rate: Optional[float] = None
    p_value: Optional[float] = None
    mean_forward_return_pct: Optional[float] = None
    reason_unavailable: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class StudyResult:
    outcome: str
    symbol: str
    available: bool
    reason_unavailable: Optional[str] = None
    probability_points: int = 0
    price_points: int = 0
    cells: List[CellResult] = field(default_factory=list)
    best_cell: Optional[Dict[str, Any]] = None

    def as_dict(self) -> Dict[str, Any]:
        cells = len(ABLATION_WINDOWS_SECONDS) * len(ABLATION_HORIZONS_SECONDS) * len(
            ABLATION_THRESHOLDS
        )
        return {
            "outcome": self.outcome,
            "symbol": self.symbol,
            "available": self.available,
            "reasonUnavailable": self.reason_unavailable,
            "probabilityPoints": self.probability_points,
            "pricePoints": self.price_points,
            "minObservations": MIN_OBSERVATIONS,
            "cells": [c.as_dict() for c in self.cells],
            "bestCell": self.best_cell,
            "multipleComparisons": BONFERRONI_NOTE.format(
                cells=cells, adjusted=0.05 / cells
            ),
            "notMeasured": {
                "sharpe": (
                    "no Sharpe, equity curve or drawdown: those describe a STRATEGY, "
                    "and the prediction specialist contributes 1.0 of 8.0 panel weight "
                    "to a decision that also passes the Supervisor, the Risk Gateway "
                    "and a stop-loss requirement. A simulated 'buy when dP > 3%' "
                    "Sharpe would measure something this system never does"
                ),
                "auc": (
                    "no AUC: computable, but at these sample sizes it is a precise "
                    "number over very few observations. Hit rate with an explicit n and "
                    "p-value makes the sample size impossible to overlook"
                ),
                "walkForward": (
                    "no train/test split until there is enough history for both folds "
                    "to be non-trivial. Splitting a tiny sample produces the appearance "
                    "of rigour and none of the substance"
                ),
            },
            "deploymentMeaning": (
                "this study writes a hypothesis with status 'proposed' and NOTHING "
                "else. It cannot change DIRECTIONAL_WEIGHTS, SUPPLEMENTARY_WEIGHTS or "
                "any threshold — CLAUDE.md invariant 5. A human reads the result and "
                "makes the change themselves"
            ),
        }


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def binomial_p_value(hits: int, n: int, p: float = 0.5) -> Optional[float]:
    """Two-sided exact binomial p-value against a fair coin. None when n is 0.

    Exact rather than a normal approximation, because the samples this will see are
    small and the approximation is poor exactly there — it would understate the
    p-value and make a weak result look strong.

    Computed by summing the probabilities of every outcome at least as extreme as the
    one observed, which is the definition rather than a shortcut, and cheap for the n
    involved here.
    """
    if n <= 0:
        return None
    if not (0.0 < p < 1.0):
        return None

    observed = math.comb(n, hits) * (p ** hits) * ((1 - p) ** (n - hits))
    # `* (1 + 1e-12)` guards float comparison: a symmetric outcome that should count
    # as "at least as extreme" can otherwise be excluded by a rounding difference,
    # which halves the p-value of the most common case.
    cutoff = observed * (1 + 1e-12)

    total = 0.0
    for k in range(n + 1):
        prob = math.comb(n, k) * (p ** k) * ((1 - p) ** (n - k))
        if prob <= cutoff:
            total += prob
    return min(1.0, total)


def _price_at(candles: Sequence[Dict[str, Any]], ts: float) -> Optional[float]:
    """Close of the last candle at or before `ts`. None when there is none.

    LAST AT OR BEFORE, never nearest: a nearest-match could return a candle from
    AFTER `ts`, which would leak future information into the signal timestamp. That
    is the classic lookahead bias, and it inflates every metric silently.
    """
    best: Optional[float] = None
    best_ts = -math.inf
    for candle in candles:
        open_time = candle.get("openTime")
        close = candle.get("close")
        if not isinstance(open_time, (int, float)) or not isinstance(close, (int, float)):
            continue
        # Candle timestamps are milliseconds (see `market_data.fetch_klines`).
        candle_ts = float(open_time) / 1000.0
        if candle_ts <= ts and candle_ts > best_ts:
            best, best_ts = float(close), candle_ts
    return best


# ---------------------------------------------------------------------------
# One cell
# ---------------------------------------------------------------------------

def evaluate_cell(
    points: Sequence[Dict[str, Any]],
    candles: Sequence[Dict[str, Any]],
    window_seconds: float,
    horizon_seconds: float,
    threshold: float,
) -> CellResult:
    """Measure one (window, horizon, threshold) combination. Pure.

    Skips an observation — rather than counting it as a miss — whenever the signal or
    the outcome is unmeasurable. A missing price is not a failed prediction, and
    scoring it as one would bias the hit rate downward by an amount that depends on
    data coverage rather than on predictive power.
    """
    cell = CellResult(
        window_seconds=window_seconds,
        horizon_seconds=horizon_seconds,
        threshold=threshold,
        observations=0,
    )

    series = sorted(
        (p for p in points if isinstance(p.get("ts"), (int, float))),
        key=lambda p: p["ts"],
    )
    if not series or not candles:
        cell.reason_unavailable = "no probability history or no price candles"
        return cell

    hits = 0
    forward_returns: List[float] = []

    for i, point in enumerate(series):
        ts = float(point["ts"])

        # The signal must be computed from data available AT ts — the slice is
        # `series[: i + 1]`, never the whole series. Passing everything would let a
        # later observation set the ΔP for an earlier timestamp.
        delta = pm.delta_probability(series[: i + 1], window_seconds, now=ts)
        if delta is None or abs(delta) < threshold:
            continue

        price_now = _price_at(candles, ts)
        price_later = _price_at(candles, ts + horizon_seconds)
        if price_now is None or price_later is None or price_now <= 0:
            continue
        # `_price_at` returns the last candle at or before its argument, so if the
        # horizon extends past the data the two lookups collapse onto the same candle
        # and the "return" would be a guaranteed 0.0. Skip rather than score it.
        if price_later == price_now:
            continue

        forward = (price_later - price_now) / price_now
        cell.observations += 1
        forward_returns.append(forward * 100.0)
        if (delta > 0) == (forward > 0):
            hits += 1

    if cell.observations < MIN_OBSERVATIONS:
        cell.reason_unavailable = (
            f"only {cell.observations} usable observation(s); {MIN_OBSERVATIONS} are "
            f"needed before a hit rate can distinguish itself from a coin flip"
        )
        return cell

    cell.hits = hits
    cell.hit_rate = hits / cell.observations
    cell.p_value = binomial_p_value(hits, cell.observations)
    cell.mean_forward_return_pct = sum(forward_returns) / len(forward_returns)
    return cell


# ---------------------------------------------------------------------------
# The study
# ---------------------------------------------------------------------------

async def run_study(
    outcome: str,
    symbol: str,
    candles: Optional[Sequence[Dict[str, Any]]] = None,
) -> StudyResult:
    """Full ablation for one outcome against one symbol's price history.

    `candles` is injected rather than fetched so the study is testable without a
    network and reproducible from a saved dataset — the same reason `TradingState`
    holds market data instead of letting nodes re-fetch.
    """
    from backend.services import polymarket_store as store

    points = await store.get_series(outcome)

    if candles is None:
        from backend.services.market_data import fetch_klines

        candles = await fetch_klines(symbol, "1h", limit=1000)

    result = StudyResult(
        outcome=outcome,
        symbol=symbol,
        available=False,
        probability_points=len(points),
        price_points=len(candles or []),
    )

    if len(points) < MIN_OBSERVATIONS:
        result.reason_unavailable = (
            f"only {len(points)} stored probability observation(s) for {outcome}. The "
            f"poller writes one per outcome per 5 minutes when POLYMARKET_ENABLED is "
            f"on and a mapping is confirmed, so this needs roughly "
            f"{MIN_OBSERVATIONS * 5} minutes of live polling before it can say "
            f"anything"
        )
        return result
    if not candles:
        result.reason_unavailable = f"no price candles for {symbol}"
        return result

    result.available = True
    for window in ABLATION_WINDOWS_SECONDS:
        for horizon in ABLATION_HORIZONS_SECONDS:
            for threshold in ABLATION_THRESHOLDS:
                result.cells.append(
                    evaluate_cell(points, candles, window, horizon, threshold)
                )

    measured = [c for c in result.cells if c.p_value is not None]
    if measured:
        # Lowest p-value, reported as BEST CELL and not as THE result. The Bonferroni
        # note travels with it in `as_dict` precisely because picking the extreme of 18
        # cells is what makes an unadjusted p-value misleading.
        best = min(measured, key=lambda c: c.p_value)
        result.best_cell = best.as_dict()

    return result


async def record_as_hypothesis(result: StudyResult) -> Optional[Dict[str, Any]]:
    """Write the study to the research queue with status `proposed`. Never applies.

    Returns None when there is nothing worth recording — a study that could not run is
    not a finding, and filling the operator's queue with "insufficient data" entries
    would bury the ones that say something.

    THE ONLY WRITE THIS MODULE PERFORMS, and it is to the research queue.
    `research_store.update_hypothesis_status` refuses `validated`/`applied` without
    `set_by_human=True`, which only an HTTP route passes. So the path

        study -> weight change -> live trading

    has no automated segment anywhere along it. CLAUDE.md invariant 5.
    """
    if not result.available or result.best_cell is None:
        logger.info(
            "Polymarket study for %s produced no finding: %s",
            result.outcome, result.reason_unavailable or "no cell had enough data",
        )
        return None

    from backend.services import research_store

    best = result.best_cell
    cells = len(ABLATION_WINDOWS_SECONDS) * len(ABLATION_HORIZONS_SECONDS) * len(
        ABLATION_THRESHOLDS
    )
    adjusted = 0.05 / cells
    significant = best["p_value"] is not None and best["p_value"] < adjusted

    claim = (
        f"A {best['threshold']:.0%} probability move on {result.outcome} over "
        f"{best['window_seconds'] / 60:.0f}m preceded a same-direction "
        f"{result.symbol} move over {best['horizon_seconds'] / 3600:.0f}h in "
        f"{best['hit_rate']:.1%} of {best['observations']} cases "
        f"(p={best['p_value']:.4f}, Bonferroni-adjusted threshold {adjusted:.4f}: "
        f"{'significant' if significant else 'NOT significant'})"
    )

    return await research_store.add_hypothesis(
        # Not a trade. Prefixed so the queue shows what produced it, and unique per
        # outcome so `add_hypothesis`'s duplicate check keeps one entry per market
        # rather than one per run.
        trade_id=f"polymarket-study:{result.outcome}",
        symbol=result.symbol,
        claim=claim,
        suggested_test=(
            "Re-run this study on out-of-sample history once at least twice the "
            "current observation count exists, and check the result holds on the "
            "SAME cell rather than on whichever cell is best next time"
        ),
        validation_plan=[
            "collect further live polling so a walk-forward split has two non-trivial folds",
            "re-run the identical ablation grid on the held-out fold",
            "confirm the previously-best cell still clears the Bonferroni-adjusted threshold",
            "only then does a human decide whether to change SUPPLEMENTARY_WEIGHTS",
        ],
        evidence={
            "bestCell": best,
            "allCells": [c.as_dict() for c in result.cells],
            "probabilityPoints": result.probability_points,
            "pricePoints": result.price_points,
            "bonferroniAdjustedThreshold": adjusted,
            "significantAfterAdjustment": significant,
            "honestCaveat": (
                "the best of 18 cells was selected, so the unadjusted p-value is "
                "optimistic by construction. A single dataset cannot establish that "
                "this signal works — it can only fail to rule it out"
            ),
        },
    )
