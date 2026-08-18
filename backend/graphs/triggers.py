"""Event triggers — spec Section 14 (Phase 31), Continuous Market Monitoring.

    "Your agent should continuously ask 'did anything change?' — not just run on
     a timer. Use event triggers, not polling: price movement > threshold, OI
     spike, funding change, liquidation spike, volatility regime change, news
     event, position risk change, exchange event. These generate graph runs.
     This is far more efficient than 'every 5 minutes → run LLM.'"

WHY THIS IS BUILT BEFORE PHASE 24, OUT OF THE SPEC'S ORDER
---------------------------------------------------------
The `AgentOS` scheduler ticks every 3 seconds. Wiring graph runs to that tick
before triggers exist means roughly 28,800 model calls a day per symbol. That is
not a cost item to optimise later — it makes Phases 24-30 untestable, because
every iteration burns budget and every run takes seconds. So the cheap gate comes
before the expensive reasoning it gates.

THE DISTINCTION THAT MATTERS: CHEAP DETECTION, EXPENSIVE REASONING
------------------------------------------------------------------
"Use event triggers, not polling" is the goal, but it cannot be taken literally
for every input. There is no push feed for funding rate or open interest, so
those must be polled. What the spec is actually asking for — and what this
implements — is:

  * detection is cheap and may poll (arithmetic over numbers already fetched);
  * a REASONING RUN happens only on a real change.

Price and volatility ride the existing websocket push (`TICK_RECEIVED` from
`services/live_market_data`), so those are genuinely event-driven. Funding and OI
are polled on a slow cadence and compared against a baseline. Both paths produce
the same `TriggerReason`.

WHAT THIS MODULE DELIBERATELY DOES NOT DO
-----------------------------------------
It does not start graph runs. `evaluate_*` returns a list of `TriggerReason`; the
worker decides what to do with them. Two reasons: the evaluator stays testable
without a graph or a checkpointer, and the component that decides *whether* to
reason is separate from the one that decides *what* to reason about — which is
the same separation that keeps `position_monitor` out of the entry path.

TRIGGER STORMS ARE THE REAL RISK
--------------------------------
An un-debounced trigger layer on a 24/7 system is worse than the 3-second tick,
because a volatile minute can produce a burst of hundreds of crossings. Three
independent controls, all enforced here:

  1. **Per-(symbol, kind) cooldown** — the same condition on the same symbol
     cannot re-fire until its cooldown elapses.
  2. **Baseline reset on fire** — after firing on a 2% move, the baseline moves
     to the new price. Without this, a sustained trend re-fires on every tick
     because it is still >2% from where it started.
  3. **Global and per-symbol rate ceilings** — a hard cap on runs per minute
     regardless of how many distinct conditions crossed.

A suppressed trigger is RECORDED, not discarded. "We detected it and chose not
to act" and "we never detected it" are different facts, and only one is a bug.
"""

from __future__ import annotations

import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Deque, Dict, List, Optional, Tuple

from backend.graphs.state import TriggerKind, TriggerReason

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Which of the spec's eight triggers can actually be evaluated today.
#
# Listed with the specific blocker, in the same spirit as
# `algorithms/strategy_profiles.PLANNED_STRATEGIES`. A feed-blocked trigger that
# simply never fires is indistinguishable from a working one in a quiet market,
# which is why it is named rather than omitted.
# ---------------------------------------------------------------------------

UNAVAILABLE_TRIGGERS: Dict[str, str] = {
    "liquidation_spike": (
        "No liquidation feed is subscribed. Binance publishes forced-liquidation "
        "orders on a dedicated websocket stream that services/live_market_data does "
        "not connect to. Open interest alone cannot locate liquidation clusters, so "
        "approximating this from OI would produce a confident signal about something "
        "not measured."
    ),
    "news_event": (
        "No backend news feed exists. A news source is implemented on the "
        "TypeScript side (app/api/news) but nothing in backend/ consumes it, and a "
        "news trigger without a latency budget would fire long after the move."
    ),
}

# Triggers evaluated from a single hardcoded instrument.
#
# `agents/sentiment_agent.fetch_macro_data` queries BTCUSDT specifically for
# funding and open interest. So these two triggers are real, but they describe
# BTC and are attributed to BTC — they are NOT evaluated per requested symbol.
# Firing an ETH run off BTC funding would attribute a condition to the wrong
# instrument.
BTC_ONLY_TRIGGERS: Tuple[str, ...] = ("funding_change", "oi_spike")
BTC_SYMBOL = "BTC/USDT"


@dataclass
class TriggerConfig:
    """Thresholds and ceilings.

    Defaults are deliberately conservative: this layer decides how often the
    expensive half of the system runs, and a too-sensitive threshold costs money
    on every false positive.
    """

    # A move this large since the baseline warrants re-reasoning. 2% on crypto
    # futures is a real move, not noise.
    price_move_pct: float = 2.0

    # Absolute funding-rate change. 5 bps is a meaningful shift in the cost of
    # holding a position.
    funding_change_abs: float = 0.0005

    # Open interest this many times the baseline.
    oi_spike_ratio: float = 1.5

    # Unrealised P&L swing on an open position, in percent.
    position_risk_change_pct: float = 3.0

    # Per-(symbol, kind) cooldown. A regime change is a slower phenomenon than a
    # price move, so it gets a longer cooldown — re-reasoning about the same
    # regime shift every minute produces the same answer at full cost.
    cooldown_seconds: Dict[str, float] = field(default_factory=lambda: {
        "price_move": 180.0,
        "volatility_regime_change": 900.0,
        "funding_change": 900.0,
        "oi_spike": 600.0,
        "position_risk_change": 120.0,
        "exchange_event": 300.0,
        "liquidation_spike": 300.0,
        "news_event": 300.0,
        "manual": 0.0,        # an operator asking is never rate-limited
        "scheduled": 0.0,
    })

    # Hard ceilings. These are the backstop that holds even if every threshold is
    # misconfigured — the failure mode being prevented is an unbounded spend
    # during one volatile minute.
    max_runs_per_minute: int = 6
    max_runs_per_symbol_per_minute: int = 2

    def cooldown_for(self, kind: str) -> float:
        # Unknown kinds get the longest configured cooldown rather than zero: a
        # new trigger type added without a cooldown should be conservative by
        # default, not unthrottled.
        return self.cooldown_seconds.get(kind, max(self.cooldown_seconds.values()))


@dataclass
class SymbolBaseline:
    """What 'unchanged' means for one symbol.

    Every field is Optional because a baseline is only established once the
    corresponding value has actually been observed. A baseline seeded with a
    default would make the FIRST observation look like a change of exactly the
    default's distance from reality.
    """

    price: Optional[float] = None
    price_set_at: Optional[float] = None
    regime: Optional[str] = None
    funding_rate: Optional[float] = None
    open_interest: Optional[float] = None
    position_pnl_pct: Optional[float] = None
    exchange_reachable: Optional[bool] = None


@dataclass
class TriggerDecision:
    """One evaluated trigger and whether it may proceed."""

    reason: TriggerReason
    acted: bool
    suppressed_reason: Optional[str] = None


class TriggerEvaluator:
    """Detects change, debounces it, and rate-limits the result.

    Holds baselines in-process. Not persisted, and that is a real limitation
    rather than an oversight: after a restart the first observation of each value
    establishes a new baseline instead of firing. Losing a trigger on restart is
    the safe direction — the alternative (persisting baselines and firing on the
    accumulated gap) would produce a burst of stale triggers the moment the
    process came back, all describing moves that finished while it was down.
    """

    def __init__(self, config: Optional[TriggerConfig] = None):
        self.config = config or TriggerConfig()
        self._baselines: Dict[str, SymbolBaseline] = {}
        # (symbol, kind) -> last fired timestamp
        self._last_fired: Dict[Tuple[str, str], float] = {}
        # Timestamps of admitted runs, for the rate ceilings.
        self._recent_runs: Deque[float] = deque()
        self._recent_by_symbol: Dict[str, Deque[float]] = {}
        # Counters, surfaced by `stats()` so the layer's own behaviour is visible.
        self._detected = 0
        self._suppressed = 0
        self._admitted = 0

    # -- baselines ----------------------------------------------------

    def baseline(self, symbol: str) -> SymbolBaseline:
        if symbol not in self._baselines:
            self._baselines[symbol] = SymbolBaseline()
        return self._baselines[symbol]

    # -- push-driven: price and volatility ----------------------------

    def evaluate_tick(
        self,
        symbol: str,
        price: float,
        now: Optional[float] = None,
        regime: Optional[str] = None,
    ) -> List[TriggerDecision]:
        """Evaluate a websocket tick. Genuinely event-driven — no polling.

        `now` is injectable so tests do not depend on wall-clock timing, and so a
        replayed tick is evaluated against its own timestamp rather than the
        moment of replay.
        """
        now = time.time() if now is None else now
        out: List[TriggerDecision] = []

        if price is None or price <= 0:
            # A zero tick is missing data. Treating it as a price would fire a
            # 100% price-move trigger on every open symbol at once.
            return out

        base = self.baseline(symbol)

        # --- price movement ------------------------------------------
        if base.price is None:
            base.price = price
            base.price_set_at = now
        else:
            move_pct = abs(price - base.price) / base.price * 100.0
            if move_pct >= self.config.price_move_pct:
                decision = self._admit(
                    TriggerReason(
                        kind="price_move",
                        symbol=symbol,
                        detail=(
                            f"{move_pct:.2f}% move from {base.price:.8g} to {price:.8g}"
                        ),
                        observed_value=move_pct,
                        threshold=self.config.price_move_pct,
                    ),
                    now,
                )
                out.append(decision)
                if decision.acted:
                    # Baseline reset ONLY on a fire. Without this a sustained
                    # trend re-fires on every tick, because it remains >2% from
                    # where it started.
                    base.price = price
                    base.price_set_at = now

        # --- volatility regime change --------------------------------
        if regime is not None and regime != "Unknown":
            if base.regime is None:
                base.regime = regime
            elif regime != base.regime:
                decision = self._admit(
                    TriggerReason(
                        kind="volatility_regime_change",
                        symbol=symbol,
                        detail=f"regime changed from '{base.regime}' to '{regime}'",
                    ),
                    now,
                )
                out.append(decision)
                if decision.acted:
                    base.regime = regime

        return out

    # -- polled: funding, open interest -------------------------------

    def evaluate_macro(
        self,
        macro: Dict[str, Any],
        now: Optional[float] = None,
    ) -> List[TriggerDecision]:
        """Evaluate a `fetch_macro_data()` payload.

        Attributed to BTC_SYMBOL, not to a caller-supplied symbol: the underlying
        endpoint queries BTCUSDT specifically, and firing an ETH run off BTC
        funding would attribute a condition to the wrong instrument.

        Unavailable fields arrive as None from `fetch_macro_data` (it was fixed to
        stop returning plausible neutral defaults). None means not measured, so
        nothing fires — as opposed to a measured zero, which would.
        """
        now = time.time() if now is None else now
        out: List[TriggerDecision] = []
        base = self.baseline(BTC_SYMBOL)

        funding = macro.get("funding_rate")
        if funding is not None:
            if base.funding_rate is None:
                base.funding_rate = funding
            else:
                delta = abs(funding - base.funding_rate)
                if delta >= self.config.funding_change_abs:
                    decision = self._admit(
                        TriggerReason(
                            kind="funding_change",
                            symbol=BTC_SYMBOL,
                            detail=(
                                f"funding moved {delta:+.6f} from {base.funding_rate:.6f} "
                                f"to {funding:.6f}"
                            ),
                            observed_value=delta,
                            threshold=self.config.funding_change_abs,
                        ),
                        now,
                    )
                    out.append(decision)
                    if decision.acted:
                        base.funding_rate = funding

        oi = macro.get("oi")
        if oi is not None and oi > 0:
            if base.open_interest is None or base.open_interest <= 0:
                base.open_interest = oi
            else:
                ratio = oi / base.open_interest
                if ratio >= self.config.oi_spike_ratio:
                    decision = self._admit(
                        TriggerReason(
                            kind="oi_spike",
                            symbol=BTC_SYMBOL,
                            detail=f"open interest {ratio:.2f}x the baseline {base.open_interest:.4g}",
                            observed_value=ratio,
                            threshold=self.config.oi_spike_ratio,
                        ),
                        now,
                    )
                    out.append(decision)
                    if decision.acted:
                        base.open_interest = oi

        return out

    # -- position risk ------------------------------------------------

    def evaluate_position(
        self,
        symbol: str,
        pnl_pct: Optional[float],
        now: Optional[float] = None,
    ) -> List[TriggerDecision]:
        """A meaningful swing in an open position's unrealised P&L.

        This is the trigger that makes the monitoring graph event-driven rather
        than a timer. It does NOT replace the stop-loss check: `position_monitor`
        checks stops on every tick on the deterministic path, because a stop that
        waited for a reasoning run would fire late.
        """
        now = time.time() if now is None else now
        out: List[TriggerDecision] = []
        if pnl_pct is None:
            return out

        base = self.baseline(symbol)
        if base.position_pnl_pct is None:
            base.position_pnl_pct = pnl_pct
            return out

        delta = abs(pnl_pct - base.position_pnl_pct)
        if delta >= self.config.position_risk_change_pct:
            decision = self._admit(
                TriggerReason(
                    kind="position_risk_change",
                    symbol=symbol,
                    detail=(
                        f"unrealised P&L moved {delta:.2f} points, from "
                        f"{base.position_pnl_pct:+.2f}% to {pnl_pct:+.2f}%"
                    ),
                    observed_value=delta,
                    threshold=self.config.position_risk_change_pct,
                ),
                now,
            )
            out.append(decision)
            if decision.acted:
                base.position_pnl_pct = pnl_pct
        return out

    # -- exchange health ---------------------------------------------

    def evaluate_exchange(
        self,
        reachable: bool,
        detail: str,
        now: Optional[float] = None,
    ) -> List[TriggerDecision]:
        """Fires on a CHANGE in exchange reachability, in either direction.

        Recovery matters as much as failure: coming back online is exactly when
        the system should re-examine what happened while it was blind, and firing
        only on failure would leave it running on a stale view after recovery.
        """
        now = time.time() if now is None else now
        base = self.baseline("__exchange__")
        if base.exchange_reachable is None:
            base.exchange_reachable = reachable
            return []
        if reachable == base.exchange_reachable:
            return []

        decision = self._admit(
            TriggerReason(
                kind="exchange_event",
                symbol="__exchange__",
                detail=f"exchange {'recovered' if reachable else 'became unreachable'}: {detail}",
            ),
            now,
        )
        if decision.acted:
            base.exchange_reachable = reachable
        return [decision]

    # -- liquidation spikes (stubbed) --------------------------------

    def evaluate_liquidation(
        self,
        reachable: bool,
        detail: str,
        now: Optional[float] = None,
    ) -> List[TriggerDecision]:
        """Stub for liquidation spikes."""
        now = time.time() if now is None else now
        return [
            TriggerDecision(
                reason=TriggerReason(
                    kind="liquidation_spike",
                    symbol="__exchange__",
                    detail=detail,
                ),
                acted=False,
                suppressed_reason="unavailable: feed not subscribed",
            )
        ]

    # -- news events (stubbed) ---------------------------------------

    def evaluate_news(
        self,
        reachable: bool,
        detail: str,
        now: Optional[float] = None,
    ) -> List[TriggerDecision]:
        """Stub for news events."""
        now = time.time() if now is None else now
        return [
            TriggerDecision(
                reason=TriggerReason(
                    kind="news_event",
                    symbol="__exchange__",
                    detail=detail,
                ),
                acted=False,
                suppressed_reason="unavailable: feed not subscribed",
            )
        ]

    # -- manual ------------------------------------------------------

    def manual(self, symbol: str, detail: str = "operator request") -> TriggerDecision:
        """An operator asking. Never rate-limited or debounced.

        Throttling a human's explicit request would make the system feel broken
        at exactly the moment someone is trying to understand it.
        """
        self._detected += 1
        self._admitted += 1
        return TriggerDecision(
            reason=TriggerReason(kind="manual", symbol=symbol, detail=detail),
            acted=True,
        )

    # -- admission control -------------------------------------------

    def _admit(self, reason: TriggerReason, now: float) -> TriggerDecision:
        """Debounce and rate-limit. The single gate every automatic trigger passes.

        Order matters: cooldown is checked before the rate ceiling so a repeated
        condition is reported as debounced (the accurate reason) rather than
        rate-limited (which would suggest the system is busy when it is simply
        ignoring a duplicate).
        """
        self._detected += 1
        key = (reason.symbol, reason.kind)

        # 1. Per-(symbol, kind) cooldown.
        cooldown = self.config.cooldown_for(reason.kind)
        last = self._last_fired.get(key)
        if last is not None and cooldown > 0 and (now - last) < cooldown:
            remaining = cooldown - (now - last)
            self._suppressed += 1
            return TriggerDecision(
                reason=reason,
                acted=False,
                suppressed_reason=(
                    f"debounced: '{reason.kind}' fired for {reason.symbol} "
                    f"{now - last:.0f}s ago, cooldown {cooldown:.0f}s "
                    f"({remaining:.0f}s remaining)"
                ),
            )

        # 2. Global rate ceiling.
        self._prune(now)
        if len(self._recent_runs) >= self.config.max_runs_per_minute:
            self._suppressed += 1
            return TriggerDecision(
                reason=reason,
                acted=False,
                suppressed_reason=(
                    f"rate limited: {len(self._recent_runs)} run(s) already started in the "
                    f"last 60s (ceiling {self.config.max_runs_per_minute})"
                ),
            )

        # 3. Per-symbol rate ceiling. Stops one violent symbol consuming the
        #    whole global budget and starving every other instrument.
        per_symbol = self._recent_by_symbol.setdefault(reason.symbol, deque())
        if len(per_symbol) >= self.config.max_runs_per_symbol_per_minute:
            self._suppressed += 1
            return TriggerDecision(
                reason=reason,
                acted=False,
                suppressed_reason=(
                    f"rate limited for {reason.symbol}: {len(per_symbol)} run(s) in the last "
                    f"60s (per-symbol ceiling {self.config.max_runs_per_symbol_per_minute})"
                ),
            )

        self._last_fired[key] = now
        self._recent_runs.append(now)
        per_symbol.append(now)
        self._admitted += 1
        return TriggerDecision(reason=reason, acted=True)

    def _prune(self, now: float) -> None:
        cutoff = now - 60.0
        while self._recent_runs and self._recent_runs[0] < cutoff:
            self._recent_runs.popleft()
        for dq in self._recent_by_symbol.values():
            while dq and dq[0] < cutoff:
                dq.popleft()

    # -- introspection ------------------------------------------------

    def stats(self) -> Dict[str, Any]:
        """Reported so the layer's own behaviour is visible.

        `suppressionRate` is the number to watch: consistently high means the
        thresholds are too sensitive and the system is detecting noise, which
        costs nothing but hides real triggers behind the ceilings.
        """
        return {
            "detected": self._detected,
            "admitted": self._admitted,
            "suppressed": self._suppressed,
            "suppressionRate": (
                round(self._suppressed / self._detected, 3) if self._detected else None
            ),
            "runsInLastMinute": len(self._recent_runs),
            "maxRunsPerMinute": self.config.max_runs_per_minute,
            "symbolsTracked": sorted(k for k in self._baselines if not k.startswith("__")),
            "unavailableTriggers": sorted(UNAVAILABLE_TRIGGERS),
            "btcOnlyTriggers": list(BTC_ONLY_TRIGGERS),
        }

    def implemented_kinds(self) -> List[str]:
        """Trigger kinds this evaluator can actually produce."""
        return sorted(
            k for k in (
                "price_move", "volatility_regime_change", "funding_change",
                "oi_spike", "position_risk_change", "exchange_event", "manual",
            )
        )


_evaluator: Optional[TriggerEvaluator] = None


def get_trigger_evaluator() -> TriggerEvaluator:
    """Singleton — baselines must be shared across callers or every caller would
    establish its own and nothing would ever be detected as a change."""
    global _evaluator
    if _evaluator is None:
        _evaluator = TriggerEvaluator()
    return _evaluator


def reset_trigger_evaluator() -> None:
    global _evaluator
    _evaluator = None
