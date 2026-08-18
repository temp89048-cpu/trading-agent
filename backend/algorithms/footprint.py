"""Institutional Footprint Analysis — spec Section 27 (Phase 44).

    "Analyze observable signals: large trades, order-book changes, liquidity
     absorption, liquidation clusters, volume anomalies, funding anomalies.
     **Don't claim to know exactly what an institution is doing — treat it as
     probabilistic evidence.**"

THAT BOLD SENTENCE IS THE DESIGN CONSTRAINT
-------------------------------------------
Every function here returns a SIGNAL with a stated confidence and a stated
interpretation, never a conclusion about who did what. "Volume was 4.2x its baseline
on a candle that closed down 0.3%" is an observation. "An institution distributed
into strength" is a story, and the story is the part that gets people into trouble
— it feels like knowledge and is unfalsifiable.

So no function in this module returns a phrase like "smart money is accumulating".
They return the measurement and the range of things it is consistent with.

THREE OF THE SIX NAMED SIGNALS CANNOT BE COMPUTED HERE
------------------------------------------------------
    large trades          needs a per-trade tape with sizes. Candles aggregate
                          every trade in a bucket into one volume number, so a
                          single 500 BTC print and 500 prints of 1 BTC are
                          indistinguishable — which is the entire distinction the
                          signal depends on.
    order-book changes    needs level-2 depth snapshots over time. None subscribed.
    liquidity absorption  needs depth AND the tape: absorption is large volume
                          arriving and price NOT moving because resting orders ate
                          it. Volume-without-price-movement is computable and is a
                          WEAKER proxy, so it is reported under its own honest name
                          rather than as absorption.

They are returned as `available=False` with those reasons, matching how the Phase 26
liquidity and orderflow specialists and the Phase 28 liquidity check already handle
the same missing feeds.

WHAT IS GENUINELY COMPUTABLE
----------------------------
    volume anomaly        candle volume vs its own baseline. Real.
    funding anomaly       funding rate vs its neutral band. Real, when supplied.
    liquidation proxy     a long wick rejected on high volume is consistent with a
                          liquidation cascade. Named a PROXY because a real
                          liquidation feed would settle it and none is subscribed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

# Volume this many times its baseline is anomalous. 3x is where a candle stops being
# "busy" and becomes an outlier worth naming — below that, ordinary session variation
# produces constant false positives.
VOLUME_ANOMALY_MULTIPLE = 3.0
# Candles used for the baseline. 20 is long enough to smooth one busy candle and
# short enough to reflect the current session.
BASELINE_CANDLES = 20

# Funding beyond this is anomalous. Same threshold the Phase 26 funding specialist
# and the thesis evidence gatherer use, referenced rather than re-picked.
FUNDING_ANOMALY_ABS = 0.001

# A wick this many times the body, on above-baseline volume, is consistent with a
# forced-liquidation cascade: price spiked, was rejected, and closed back.
LIQUIDATION_WICK_RATIO = 2.5

MIN_CANDLES = BASELINE_CANDLES + 2


@dataclass
class FootprintSignal:
    """One observable signal. NEVER an attribution.

    `interpretation` deliberately lists what the observation is CONSISTENT WITH,
    plural. A single interpretation would be a conclusion wearing a hedge.
    """

    name: str
    available: bool
    # 0.0-1.0 how pronounced the observation is. None when unavailable — never 0.0,
    # which would read as "measured and found nothing unusual".
    strength: Optional[float] = None
    observation: Optional[str] = None
    consistent_with: List[str] = field(default_factory=list)
    reason_unavailable: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "available": self.available,
            "strength": self.strength,
            "observation": self.observation,
            "consistentWith": self.consistent_with,
            "reasonUnavailable": self.reason_unavailable,
        }


# Spec Section 27's six named signals, so a caller can assert coverage rather than
# counting whatever happened to be produced.
FOOTPRINT_SIGNALS = (
    "large_trades",
    "order_book_changes",
    "liquidity_absorption",
    "liquidation_clusters",
    "volume_anomalies",
    "funding_anomalies",
)


def _unavailable(name: str, reason: str) -> FootprintSignal:
    return FootprintSignal(name=name, available=False, reason_unavailable=reason)


def analyse_footprint(
    candles: Optional[Sequence[Dict[str, Any]]],
    funding_rate: Optional[float] = None,
) -> Dict[str, Any]:
    """All six of Section 27's signals. Pure; no I/O.

    Returns every signal including the three that cannot run, because a result
    listing three signals reads as though three were all that exist.
    """
    signals: List[FootprintSignal] = [
        _unavailable(
            "large_trades",
            "needs a per-trade tape with sizes. Candles aggregate every trade in the "
            "bucket into one volume number, so one 500-unit print and 500 prints of 1 "
            "unit are indistinguishable — which is the whole distinction this signal "
            "depends on",
        ),
        _unavailable(
            "order_book_changes",
            "needs level-2 depth snapshots over time. No depth feed is subscribed "
            "anywhere in this system",
        ),
        _unavailable(
            "liquidity_absorption",
            "needs depth AND the tape: absorption is large volume arriving while price "
            "does NOT move because resting orders absorbed it. "
            "Volume-without-price-movement is computable and is reported separately "
            "under the volume_anomalies signal, because it is a weaker proxy and must "
            "not borrow this one's name",
        ),
    ]

    signals.append(_liquidation_proxy(candles))
    signals.append(_volume_anomaly(candles))
    signals.append(_funding_anomaly(funding_rate))

    available = [s for s in signals if s.available]
    return {
        "signals": [s.as_dict() for s in signals],
        "signalsAvailable": len(available),
        "signalsTotal": len(FOOTPRINT_SIGNALS),
        # The strongest available observation, or None. Not an average: averaging a
        # pronounced anomaly with two quiet signals hides the one thing worth seeing.
        "strongest": max(
            (s.name for s in available if s.strength is not None),
            key=lambda n: next(s.strength for s in available if s.name == n),
            default=None,
        ),
        "attributionMeaning": (
            "NO signal here attributes activity to an institution. Section 27: "
            "\"Don't claim to know exactly what an institution is doing — treat it as "
            "probabilistic evidence.\" Each signal reports what was MEASURED and what "
            "that measurement is consistent with, plural, because a single "
            "interpretation would be a conclusion wearing a hedge"
        ),
    }


def _volume_anomaly(candles: Optional[Sequence[Dict[str, Any]]]) -> FootprintSignal:
    """Latest candle volume against its own recent baseline."""
    if not candles or len(candles) < MIN_CANDLES:
        return _unavailable(
            "volume_anomalies",
            f"needs at least {MIN_CANDLES} candles for a baseline, got "
            f"{len(candles) if candles else 0}",
        )

    window = list(candles[-(BASELINE_CANDLES + 1):])
    latest = window[-1]
    baseline_bars = window[:-1]

    try:
        volumes = [float(b["volume"]) for b in baseline_bars]
        latest_volume = float(latest["volume"])
    except (KeyError, TypeError, ValueError) as exc:
        return _unavailable("volume_anomalies", f"volume unreadable: {exc}")

    baseline = sum(volumes) / len(volumes) if volumes else 0.0
    if baseline <= 0:
        return _unavailable(
            "volume_anomalies",
            "baseline volume is zero — this venue reports no volume, so an anomaly "
            "cannot be defined relative to it",
        )

    multiple = latest_volume / baseline
    try:
        move_pct = (float(latest["close"]) - float(latest["open"])) / float(latest["open"]) * 100.0
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        move_pct = None

    if multiple < VOLUME_ANOMALY_MULTIPLE:
        return FootprintSignal(
            name="volume_anomalies",
            available=True,
            strength=0.0,
            observation=(
                f"latest volume is {multiple:.2f}x the {BASELINE_CANDLES}-candle "
                f"baseline, below the {VOLUME_ANOMALY_MULTIPLE}x anomaly threshold"
            ),
            consistent_with=["ordinary participation"],
        )

    # Saturates at 3x the threshold: a 30x volume candle is not ten times the
    # evidence of a 3x one.
    strength = min(1.0, (multiple - VOLUME_ANOMALY_MULTIPLE) / (VOLUME_ANOMALY_MULTIPLE * 2))
    observation = (
        f"latest volume is {multiple:.2f}x the {BASELINE_CANDLES}-candle baseline"
    )
    consistent: List[str] = []

    if move_pct is None:
        consistent.append("unknown price reaction — the candle's open/close was unreadable")
    elif abs(move_pct) < 0.1:
        observation += f" while price moved only {move_pct:+.2f}%"
        consistent += [
            "resting orders absorbing the flow (a WEAKER proxy for absorption than "
            "real depth data, which is not subscribed)",
            "two-sided flow of similar size netting out",
            "a data artefact in the volume field",
        ]
    else:
        observation += f" on a {move_pct:+.2f}% move"
        consistent += [
            "a participant moving size with urgency",
            "a stop or liquidation cascade adding volume to an existing move",
            "scheduled rebalancing that happens to align with the move",
        ]

    return FootprintSignal(
        name="volume_anomalies", available=True, strength=strength,
        observation=observation, consistent_with=consistent,
    )


def _liquidation_proxy(candles: Optional[Sequence[Dict[str, Any]]]) -> FootprintSignal:
    """A rejected wick on elevated volume — consistent with a forced cascade.

    Named a PROXY in every string it produces. A real liquidation feed would settle
    what happened; none is subscribed, so this is a shape that liquidations tend to
    leave and that other things also leave.
    """
    if not candles or len(candles) < MIN_CANDLES:
        return _unavailable(
            "liquidation_clusters",
            f"needs at least {MIN_CANDLES} candles, got {len(candles) if candles else 0}. "
            f"NOTE: even with data this is a wick/volume PROXY — no liquidation feed is "
            f"subscribed",
        )

    window = list(candles[-(BASELINE_CANDLES + 1):])
    latest = window[-1]

    try:
        high, low = float(latest["high"]), float(latest["low"])
        open_, close = float(latest["open"]), float(latest["close"])
        latest_volume = float(latest["volume"])
        baseline = sum(float(b["volume"]) for b in window[:-1]) / (len(window) - 1)
    except (KeyError, TypeError, ValueError, ZeroDivisionError) as exc:
        return _unavailable("liquidation_clusters", f"candle unreadable: {exc}")

    body = abs(close - open_)
    upper = high - max(open_, close)
    lower = min(open_, close) - low

    if body <= 0:
        # A doji has no body to compare the wick against. Not a measurement of
        # "no liquidation" — the ratio is simply undefined.
        return _unavailable(
            "liquidation_clusters",
            "the latest candle has no body, so the wick-to-body ratio is undefined",
        )

    elevated = baseline > 0 and latest_volume > baseline * 1.5
    down_wick = lower / body
    up_wick = upper / body

    if not elevated or max(down_wick, up_wick) < LIQUIDATION_WICK_RATIO:
        return FootprintSignal(
            name="liquidation_clusters", available=True, strength=0.0,
            observation=(
                f"no rejected wick on elevated volume (lower {down_wick:.1f}x body, "
                f"upper {up_wick:.1f}x, volume "
                f"{latest_volume / baseline if baseline else 0:.2f}x baseline)"
            ),
            consistent_with=["no cascade shape present in the latest candle"],
        )

    side = "lower" if down_wick >= up_wick else "upper"
    ratio = max(down_wick, up_wick)
    return FootprintSignal(
        name="liquidation_clusters",
        available=True,
        strength=min(1.0, ratio / (LIQUIDATION_WICK_RATIO * 2)),
        observation=(
            f"{side} wick {ratio:.1f}x the candle body on "
            f"{latest_volume / baseline:.2f}x baseline volume — a PROXY only, no "
            f"liquidation feed is subscribed"
        ),
        consistent_with=[
            "a forced-liquidation cascade that was absorbed and reversed",
            "a stop run beyond a visible level, then a reclaim",
            "a single large market order into thin depth at an unusual hour",
        ],
    )


def _funding_anomaly(funding_rate: Optional[float]) -> FootprintSignal:
    """Funding beyond its neutral band. Supplied, never fetched."""
    if funding_rate is None:
        return _unavailable(
            "funding_anomalies",
            "no funding rate supplied. It is fetched once per run into "
            "TradingState.sentiment_analysis; this function takes it as an argument so "
            "it cannot become a second market-data path",
        )

    magnitude = abs(funding_rate)
    if magnitude <= FUNDING_ANOMALY_ABS:
        return FootprintSignal(
            name="funding_anomalies", available=True, strength=0.0,
            observation=(
                f"funding {funding_rate:+.5f} is within the neutral band "
                f"(+/-{FUNDING_ANOMALY_ABS})"
            ),
            consistent_with=["balanced positioning"],
        )

    crowded = "longs" if funding_rate > 0 else "shorts"
    return FootprintSignal(
        name="funding_anomalies",
        available=True,
        strength=min(1.0, magnitude / (FUNDING_ANOMALY_ABS * 4)),
        observation=(
            f"funding {funding_rate:+.5f} is beyond the neutral band — {crowded} are "
            f"paying to hold"
        ),
        consistent_with=[
            f"crowded {crowded[:-1]} positioning that may unwind sharply",
            "a basis trade holding the perpetual leg, which pays funding by design "
            "and is not directional at all",
            "a sustained genuine trend that funding is simply following",
        ],
    )
