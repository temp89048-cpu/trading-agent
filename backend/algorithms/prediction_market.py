"""Prediction-market signal computation — Phase 34.

Turns stored Polymarket probabilities into signals. Pure functions, no I/O, no
model calls — matching `algorithms/debate.py`, `algorithms/footprint.py` and
`algorithms/market_graph.py`.

CLAUDE.md: *"Deterministic over LLM where the math is real ... asking a model to
'reason over' numbers already on hand adds hallucination risk to a financial
decision for no benefit and isn't reproducible."* Every number in `polymarket.md`
§4 — ΔP, z-scores, volume ratios, confidence — is arithmetic over data already
fetched. It is also what makes this backtestable: identical inputs must produce an
identical signal, or the Phase 38 validation study measures nothing.

THE HARDEST QUESTION, ANSWERED HONESTLY
=======================================
A prediction-market probability is a LEVEL. A trading decision needs a DIRECTION.
Converting one to the other is where this module could most easily fabricate, so
the rule is stated up front:

    A PROBABILITY LEVEL ALONE IS NOT A DIRECTIONAL VIEW.

"P(BTC above $130k on Sept 30) = 0.42" does not say bullish or bearish. Whether
0.42 is high or low depends on how far $130k is from spot AND on how volatile BTC
is over that horizon — and turning a level into a stance therefore needs an
implied-volatility model of the underlying. This system has no such model, and
inventing one (assuming a lognormal walk at some guessed vol) would produce a
confident, precise, unfalsifiable number driving real position sizing.

So there are exactly two honest paths, and this module implements both and refuses
everything else:

  1. **Probability-weighted expected price** — available ONLY for a `scalar`
     market whose outcomes are BOUNDED price buckets. Then
     `E[price] = Σ p_i × midpoint_i` is a genuine market-implied expectation
     requiring no volatility assumption at all, and the drift against spot is a
     real directional signal. `expected_price` implements this, and refuses when
     any bucket is unbounded or the probabilities do not sum to ~1.

  2. **Change in probability (ΔP)** — available for any market, including binary
     thresholds. A rising P(above K) is unambiguously the market becoming more
     bullish, whatever the level. This needs no vol model. It DOES need to know
     whether the outcome means "above" or "below", which is why `delta_stance`
     takes an explicit `threshold_direction` and returns None without one.

A binary threshold market therefore yields a ΔP stance and NO expected price. That
is not a gap to be filled later with an assumption; it is the correct answer.

`None` MEANS NOT MEASURED
-------------------------
Throughout: `None` = could not be computed, `0.0` = computed and found to be zero.
The distinction is load-bearing in this codebase and every function below honours
it. A caller that coalesces `None` to `0.0` converts "we have no history" into "the
market has not moved", which is a measured claim about an unmeasured thing.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thresholds — every one named, with the reason it has that value
# ---------------------------------------------------------------------------

# Minimum observations inside a window before ΔP is reported. Two points is
# arithmetically enough; it is also how a single bad tick becomes a 40% "move".
MIN_POINTS_FOR_DELTA = 3

# Volatility needs a real sample. 20 buckets at the store's 5-minute resolution is
# ~100 minutes — the same order as `footprint.BASELINE_CANDLES`, and chosen for the
# same reason: long enough to smooth one busy bucket, short enough to describe now.
MIN_POINTS_FOR_VOLATILITY = 20

# A z-score at or above this is treated as a fully-developed move. 3.0 sigma rather
# than 2.0 because prediction-market probabilities are bounded in [0,1] and cluster,
# so their distribution has thin tails and 2-sigma events are common.
ZSCORE_FULL_CONFIDENCE = 3.0

# Quote volume at which liquidity stops discounting confidence. polymarket.md §4's
# point, restated: "a ΔP of 5% on high volume (>$10k) is more credible than the same
# on $100 volume". $50k is set above that $10k reference because Polymarket's crypto
# markets routinely carry far more, and a threshold that everything clears provides
# no discrimination.
VOLUME_FULL_CONFIDENCE_USD = 50_000.0

# A bid/ask spread this wide (in probability points) makes the mid untrustworthy.
# 0.05 = 5 probability points; beyond it, the "probability" is a wide guess between
# two thin quotes rather than a price anyone traded at.
SPREAD_FULL_PENALTY = 0.05

# Probabilities within this of 0 or 1 are refused for drift purposes. A market at
# 0.99 has essentially resolved, its remaining ΔP is bounded at 0.01, and its
# expected-price contribution is dominated by whichever bucket it has collapsed
# into.
DEGENERATE_PROBABILITY_MARGIN = 0.01

# Outcome probabilities must sum to this close to 1.0 before an expected price is
# computed. 0.05 allows for the bid/ask spread across several outcomes without
# allowing a MISSING outcome — a market whose buckets sum to 0.7 has a bucket we
# did not fetch, and averaging over the rest would bias the expectation toward
# whatever we happened to see.
PROBABILITY_SUM_TOLERANCE = 0.05

# Horizon bounds for a drift signal to be meaningful for intraday trading. Below
# the floor, the probability is dominated by settlement mechanics; above the
# ceiling, a terminal distribution six months out says nothing about the next hour.
MIN_HORIZON_SECONDS = 6 * 60 * 60
MAX_HORIZON_SECONDS = 120 * 24 * 60 * 60

DIRECTION_ABOVE = "above"
DIRECTION_BELOW = "below"


def _series_prices(points: Sequence[Dict[str, Any]]) -> List[Tuple[float, float]]:
    """(ts, p) pairs, oldest first, skipping anything unusable.

    Skips rather than raises: one malformed row written by an older version of the
    store must not make the whole series unreadable.
    """
    out: List[Tuple[float, float]] = []
    for point in points or []:
        ts, p = point.get("ts"), point.get("p")
        if not isinstance(ts, (int, float)) or not isinstance(p, (int, float)):
            continue
        if isinstance(p, bool):  # bool is an int subclass; a True here is corruption
            continue
        if not (0.0 <= float(p) <= 1.0):
            continue
        out.append((float(ts), float(p)))
    out.sort(key=lambda pair: pair[0])
    return out


# ===========================================================================
# 1. ΔP
# ===========================================================================

def delta_probability(
    points: Sequence[Dict[str, Any]],
    window_seconds: float,
    now: Optional[float] = None,
) -> Optional[float]:
    """Change in probability across `window_seconds`. None when unmeasurable.

    Measured last-minus-first INSIDE the window, not last-minus-`window_seconds`-ago:
    the store records on a poll cadence, so there is rarely a point at exactly the
    window edge, and interpolating to one would invent an observation.

    Returns None — never 0.0 — when there is too little history. A caller reading
    0.0 would conclude the market is quiet, which is a claim; None is the absence
    of one.
    """
    series = _series_prices(points)
    if not series:
        return None

    now = series[-1][0] if now is None else float(now)
    cutoff = now - float(window_seconds)
    inside = [(ts, p) for ts, p in series if ts >= cutoff]

    if len(inside) < MIN_POINTS_FOR_DELTA:
        return None
    return inside[-1][1] - inside[0][1]


def probability_volatility(
    points: Sequence[Dict[str, Any]],
    now: Optional[float] = None,
    lookback_seconds: Optional[float] = None,
) -> Optional[float]:
    """Standard deviation of consecutive probability changes. None when unmeasurable.

    This is the market's OWN normal step size, which is what makes a z-score
    meaningful: a 3-point move in a market that habitually moves 3 points is not
    news, and a fixed ΔP threshold cannot tell the two apart. polymarket.md §11's
    threshold table implicitly assumes every market has the same noise floor; this
    is the correction.

    Sample standard deviation (n-1). With n in the low tens the population form
    understates the spread, and understating it inflates every z-score.
    """
    series = _series_prices(points)
    if lookback_seconds is not None and series:
        end = series[-1][0] if now is None else float(now)
        series = [(ts, p) for ts, p in series if ts >= end - float(lookback_seconds)]

    if len(series) < MIN_POINTS_FOR_VOLATILITY:
        return None

    steps = [series[i][1] - series[i - 1][1] for i in range(1, len(series))]
    if len(steps) < 2:
        return None

    mean = sum(steps) / len(steps)
    variance = sum((s - mean) ** 2 for s in steps) / (len(steps) - 1)
    return math.sqrt(variance)


def probability_zscore(
    points: Sequence[Dict[str, Any]],
    window_seconds: float,
    now: Optional[float] = None,
) -> Optional[float]:
    """ΔP in units of the market's own step-size volatility. None when unmeasurable.

    None when EITHER input is unmeasurable, and also when volatility is exactly
    zero. A zero-volatility market is one whose probability has never moved in the
    sample; dividing by it would yield infinity, and reporting a huge z-score for
    the first move a stale market makes is precisely backwards.
    """
    delta = delta_probability(points, window_seconds, now=now)
    if delta is None:
        return None
    sigma = probability_volatility(points, now=now)
    if sigma is None or sigma <= 0.0:
        return None
    return delta / sigma


# ===========================================================================
# 2. Expected price (scalar markets only)
# ===========================================================================

@dataclass(frozen=True)
class PriceBucket:
    """One price range and the market-implied probability of settling inside it.

    A SEPARATE TYPE, RATHER THAN READING ccxt DICTS DIRECTLY, BECAUSE OF WHERE THE
    STRIKES ACTUALLY LIVE.
    ---------------------------------------------------------------------------
    The first version of `expected_price` took ccxt outcome dicts and read
    `floorStrike`/`capStrike` off each one. `PredictionOutcome` does not have those
    fields — verified against ccxt 4.5.73, it carries only
    `price`/`bid`/`ask`/`label`/`winner`/`settleFraction`. `floorStrike`, `capStrike`,
    `strikeType` and `underlying` are `PredictionMarket` fields, "scalar only".

    A price-range event is therefore shaped:

        PredictionEvent (mutuallyExclusive=True)
          +- PredictionMarket  floorStrike=120k capStrike=130k
          |    +- PredictionOutcome "…:YES"  price=0.42   <- P(this bucket)
          |    +- PredictionOutcome "…:NO"   price=0.58
          +- PredictionMarket  floorStrike=130k capStrike=140k
               +- …

    So the buckets come from the EVENT'S MARKETS, not from one market's outcomes.

    That mistake would not have crashed and would not have fabricated anything — it
    would have found no strikes on any real payload and returned None every time,
    leaving `expected_price_drift` permanently unavailable while looking merely
    blocked. Silent degradation masking broken code is a failure mode this project
    has hit before, so the shape is now an explicit type that cannot be satisfied by
    the wrong dict.
    """

    probability: float
    floor: float
    cap: float

    @property
    def midpoint(self) -> float:
        return (self.floor + self.cap) / 2.0


YES_LABELS = ("yes",)


def buckets_from_event(event: Dict[str, Any]) -> Optional[List[PriceBucket]]:
    """Build price buckets from a ccxt `PredictionEvent`. None when not possible.

    Requires:

      * `mutuallyExclusive is True` — the flag ccxt sets when exactly one market in
        the event resolves YES. Without it the markets are not a partition of the
        outcome space, so their probabilities do not form a distribution and a
        weighted average over them is not an expectation of anything. Not inferred
        from the probabilities summing to ~1, because several unrelated markets can
        coincidentally sum to 1.
      * every market to carry BOTH `floorStrike` and `capStrike`. One unbounded
        bucket makes the whole expectation uncomputable — see `expected_price`.
      * every market to expose a YES outcome with a numeric probability.

    Returns None on the first failure rather than dropping the offending bucket: a
    partial partition biases the expectation toward whichever buckets parsed, which
    is precisely the error `PROBABILITY_SUM_TOLERANCE` exists to catch and is better
    refused outright.
    """
    if not isinstance(event, dict):
        return None
    if event.get("mutuallyExclusive") is not True:
        logger.debug(
            "No buckets: event %r is not flagged mutuallyExclusive, so its markets are "
            "not a partition and a weighted average over them is not an expectation.",
            event.get("event") or event.get("id"),
        )
        return None

    markets = event.get("markets")
    if not isinstance(markets, list) or not markets:
        return None

    buckets: List[PriceBucket] = []
    for market in markets:
        if not isinstance(market, dict):
            return None
        floor, cap = market.get("floorStrike"), market.get("capStrike")
        if not isinstance(floor, (int, float)) or isinstance(floor, bool):
            logger.debug(
                "No buckets: market %r has floorStrike=%r. A market without both "
                "strikes is an unbounded bucket.", market.get("market"), floor,
            )
            return None
        if not isinstance(cap, (int, float)) or isinstance(cap, bool):
            logger.debug(
                "No buckets: market %r has capStrike=%r.", market.get("market"), cap,
            )
            return None

        probability: Optional[float] = None
        for outcome in market.get("outcomes") or []:
            if not isinstance(outcome, dict):
                continue
            label = str(outcome.get("label") or "").strip().lower()
            handle = str(outcome.get("outcome") or "")
            is_yes = label in YES_LABELS or handle.upper().endswith(":YES")
            if not is_yes:
                continue
            p = outcome.get("price")
            if isinstance(p, bool) or not isinstance(p, (int, float)):
                return None
            probability = float(p)
            break

        if probability is None:
            logger.debug(
                "No buckets: market %r exposes no YES outcome with a numeric "
                "probability.", market.get("market"),
            )
            return None

        buckets.append(PriceBucket(probability=probability,
                                   floor=float(floor), cap=float(cap)))

    return buckets


@dataclass
class ExpectedPrice:
    """A market-implied expected price for the underlying, and its drift vs spot.

    Carries `probability_sum` and `buckets_used` so a consumer can see the
    expectation's basis rather than only its value — an expectation over three
    buckets summing to 0.96 is a different claim from one over eight summing to
    0.999, and reporting only the number would erase that.
    """

    expected_price: float
    spot: float
    drift_pct: float
    direction: str  # LONG | SHORT | NEUTRAL
    probability_sum: float
    buckets_used: int
    horizon_seconds: Optional[float] = None


# Drift smaller than this is NEUTRAL, not a weak directional call. Matches the
# spirit of `specialists.NEUTRAL_BAND`: a signal indistinguishable from zero should
# say so rather than pick a side.
DRIFT_NEUTRAL_BAND_PCT = 0.25


def expected_price(
    buckets: Sequence[PriceBucket],
    spot: Optional[float],
    *,
    horizon_seconds: Optional[float] = None,
) -> Optional[ExpectedPrice]:
    """Probability-weighted expected price from BOUNDED price buckets.

        E[price] = Σ p_i × (floor_i + cap_i) / 2

    is a genuine market-implied expectation with NO volatility assumption — which
    is the entire reason this path is preferred over inverting a binary threshold.

    Takes `PriceBucket` values, built by `buckets_from_event` from a ccxt event's
    markets. See `PriceBucket` for why the shape is explicit rather than a ccxt dict.

    Returns None, with the reason logged, when:

      * `spot` is missing or non-positive — the drift would be undefined, and a
        drift of 0.0 would read as "the market agrees with spot";
      * a bucket is malformed (cap below floor). The unbounded-bucket case — a
        binary "above $130k" with no upper limit — cannot reach here at all, because
        `PriceBucket` requires both bounds and `buckets_from_event` refuses to build
        one without them. Substituting a cap (2x the strike, say) would be inventing
        the single input the answer is most sensitive to;
      * the probabilities do not sum to ~1.0. A short sum means a bucket was not
        fetched, and averaging over the remainder biases the expectation toward
        whichever buckets happened to be visible.
    """
    if spot is None:
        logger.debug("No expected price: spot is unavailable.")
        return None
    try:
        spot = float(spot)
    except (TypeError, ValueError):
        return None
    if spot <= 0.0:
        logger.debug("No expected price: spot %s is not positive.", spot)
        return None

    if horizon_seconds is not None:
        if horizon_seconds < MIN_HORIZON_SECONDS or horizon_seconds > MAX_HORIZON_SECONDS:
            logger.debug(
                "No expected price: horizon %.0fs is outside [%d, %d] — a terminal "
                "distribution that far out (or that close to settlement) is not a "
                "statement about the next hour.",
                horizon_seconds, MIN_HORIZON_SECONDS, MAX_HORIZON_SECONDS,
            )
            return None

    weighted = 0.0
    prob_sum = 0.0
    used = 0

    for bucket in buckets or []:
        if not isinstance(bucket, PriceBucket):
            # A dict here means a caller went round `buckets_from_event` and is
            # passing the raw ccxt shape — the exact mistake documented on
            # `PriceBucket`. Refused loudly rather than returning None, because None
            # is indistinguishable from "this market has no buckets".
            raise TypeError(
                f"expected_price takes PriceBucket values, got {type(bucket).__name__}. "
                f"Build them with buckets_from_event() — outcome dicts do not carry "
                f"floorStrike/capStrike, those are PredictionMarket fields."
            )
        if not (0.0 <= bucket.probability <= 1.0):
            logger.debug("No expected price: bucket probability %s is out of range.",
                         bucket.probability)
            return None
        if bucket.cap < bucket.floor:
            logger.error(
                "No expected price: bucket has cap %s below floor %s — malformed.",
                bucket.cap, bucket.floor,
            )
            return None

        weighted += bucket.probability * bucket.midpoint
        prob_sum += bucket.probability
        used += 1

    if used == 0:
        return None
    if abs(prob_sum - 1.0) > PROBABILITY_SUM_TOLERANCE:
        logger.debug(
            "No expected price: outcome probabilities sum to %.3f, outside 1.0 +/- %.2f "
            "— a bucket is missing and the remainder would bias the expectation.",
            prob_sum, PROBABILITY_SUM_TOLERANCE,
        )
        return None

    drift_pct = (weighted - spot) / spot * 100.0
    if drift_pct > DRIFT_NEUTRAL_BAND_PCT:
        direction = "LONG"
    elif drift_pct < -DRIFT_NEUTRAL_BAND_PCT:
        direction = "SHORT"
    else:
        direction = "NEUTRAL"

    return ExpectedPrice(
        expected_price=weighted,
        spot=spot,
        drift_pct=drift_pct,
        direction=direction,
        probability_sum=prob_sum,
        buckets_used=used,
        horizon_seconds=horizon_seconds,
    )


# ===========================================================================
# 3. ΔP stance (binary thresholds)
# ===========================================================================

@dataclass
class DeltaStance:
    """A direction derived from a CHANGE in probability, not from its level."""

    direction: str  # LONG | SHORT | NEUTRAL
    delta: float
    threshold_direction: str
    basis: str = "delta"


def delta_stance(
    delta: Optional[float],
    threshold_direction: Optional[str],
    *,
    neutral_band: float = 0.005,
) -> Optional[DeltaStance]:
    """Direction from ΔP on a threshold market. None when it cannot be determined.

    `threshold_direction` says what the outcome pays out on:

        'above' — YES means the underlying trades above the strike.
                  P rising  => the market turned more bullish  => LONG
        'below' — YES means it trades below.
                  P rising  => more bearish                    => SHORT

    RETURNS None WHEN `threshold_direction` IS UNKNOWN, and that is the point.
    Guessing it — defaulting to 'above' because most markets are phrased that way —
    would invert the signal on every 'below' market. An inverted probability is
    undetectable downstream: it looks exactly like a market with a strong opposite
    view, and `run_debate` would weight it as confidently as a correct one.

    This is why `polymarket_registry.classify_market` refuses markets whose
    direction sense cannot be read from typed fields rather than inferring it from
    the title.
    """
    if delta is None:
        return None
    if threshold_direction not in (DIRECTION_ABOVE, DIRECTION_BELOW):
        logger.debug(
            "No delta stance: threshold_direction is %r, so it is unknown whether a "
            "rising probability is bullish or bearish. Not defaulting — a wrong "
            "default inverts the signal undetectably.",
            threshold_direction,
        )
        return None

    signed = delta if threshold_direction == DIRECTION_ABOVE else -delta

    if signed > neutral_band:
        direction = "LONG"
    elif signed < -neutral_band:
        direction = "SHORT"
    else:
        direction = "NEUTRAL"

    return DeltaStance(
        direction=direction,
        delta=delta,
        threshold_direction=threshold_direction,
    )


# ===========================================================================
# 4. Confidence
# ===========================================================================

def confidence_from_liquidity(
    zscore: Optional[float],
    quote_volume: Optional[float],
    spread: Optional[float] = None,
) -> Optional[float]:
    """How much to trust a detected move, in 0..1. None when unmeasurable.

    polymarket.md §4 proposes `conf = (|ΔP| / σP) * sqrt(volume)`. Implemented with
    two changes, both necessary:

      * **Bounded.** The published formula is unbounded and its units depend on the
        volume figure, so it cannot be compared across markets or fed anywhere that
        expects 0..1 — and `SpecialistFinding.confidence` expects exactly that.
      * **Three factors, multiplied.** Magnitude, liquidity and quote quality are
        each capable of independently invalidating a move, so the weakest should
        dominate. `sqrt(volume)` lets a big enough number rescue an insignificant
        move, which is backwards.

    Returns None when magnitude or volume is unmeasured. Not 0.5, not a
    volume-free fallback: an unmeasured input means the trustworthiness of this
    move is unknown, and the specialist reports `available=False` rather than a
    hedged number that looks like a measurement.

    `spread` is optional and treated as no penalty when absent — the mid is then
    taken at face value, which is stated here so the omission is visible rather
    than silently favourable.
    """
    if zscore is None:
        return None
    if quote_volume is None:
        logger.debug(
            "No confidence: quote volume is unavailable, so a large move cannot be "
            "distinguished from a large move on nothing."
        )
        return None
    try:
        volume = float(quote_volume)
    except (TypeError, ValueError):
        return None
    if volume < 0.0:
        return None

    magnitude = min(1.0, abs(float(zscore)) / ZSCORE_FULL_CONFIDENCE)
    liquidity = min(1.0, volume / VOLUME_FULL_CONFIDENCE_USD)

    quality = 1.0
    if spread is not None:
        try:
            spread_f = abs(float(spread))
        except (TypeError, ValueError):
            spread_f = None  # type: ignore[assignment]
        if spread_f is not None:
            quality = max(0.0, 1.0 - min(1.0, spread_f / SPREAD_FULL_PENALTY))

    return magnitude * liquidity * quality


# ===========================================================================
# 4b. Event risk — concern from uncertainty, never from a side
# ===========================================================================
#
# An event resolving further out than this contributes no concern. 14 days: beyond
# a fortnight a scheduled decision is not a risk to a position opened today, and
# any position still open then will have been re-evaluated many times by the
# monitoring graph.
EVENT_PROXIMITY_HORIZON_SECONDS = 14 * 24 * 60 * 60


def event_uncertainty(probability: Optional[float]) -> Optional[float]:
    """How undecided the market is, in 0..1. None when unmeasured.

    `4p(1-p)` — the Bernoulli variance normalised to peak at 1.0 when p = 0.5 and
    fall to 0.0 at either certainty.

    WHY UNCERTAINTY AND NOT DIRECTION
    ---------------------------------
    The obvious alternative is to score which OUTCOME is adverse and use its
    probability. It cannot be done honestly. "Will exchange X be hacked?" has a
    clearly bad side; "Will the ETH ETF be approved?" does not, and deciding whether
    approval is good or bad for a long BTC position is guesswork that would be
    presented as analysis — and then multiplied into a real confidence number.

    Uncertainty needs no such opinion, and says something true: a market at 0.50 on
    a major decision means informed participants genuinely do not know, so a
    technical thesis is resting on an unresolved question. A market at 0.97 means
    the outcome is already in the price and there is little left to be surprised by.
    """
    if probability is None:
        return None
    try:
        p = float(probability)
    except (TypeError, ValueError):
        return None
    if not (0.0 <= p <= 1.0):
        return None
    return 4.0 * p * (1.0 - p)


def event_proximity(
    seconds_to_resolution: Optional[float],
    horizon_seconds: float = EVENT_PROXIMITY_HORIZON_SECONDS,
) -> Optional[float]:
    """How soon the event settles, in 0..1. None when unknown.

    Linear decay to zero at the horizon. Linear rather than exponential because
    there is no measured hazard rate to justify a curve — a shape chosen for
    elegance would be a modelling assumption smuggled in as a default.

    Returns None, not 0.0, for an unknown resolution time: an event whose timing we
    cannot read is not thereby far away.

    A resolution time in the PAST returns 0.0 rather than a negative or clamped-high
    value. The event has happened; whatever it did is already in the price.
    """
    if seconds_to_resolution is None:
        return None
    try:
        t = float(seconds_to_resolution)
    except (TypeError, ValueError):
        return None
    if t <= 0.0:
        return 0.0
    if t >= horizon_seconds:
        return 0.0
    return 1.0 - (t / horizon_seconds)


def event_concern(
    probability: Optional[float],
    seconds_to_resolution: Optional[float],
    profile_weight: float,
    *,
    ceiling: float = 1.0,
) -> Optional[float]:
    """Concern this event contributes, in 0..`ceiling`. None when unmeasurable.

        concern = profile_weight x uncertainty(p) x proximity(t)

    Multiplied, so the weakest factor dominates: a high-stakes event that is either
    already decided OR months away contributes nothing, and correctly so.

    Returns None when either factor is unmeasured. A caller must NOT coalesce that
    to 0.0 — "we could not tell how uncertain this event is" is not "this event is
    settled", and the second reads as reassurance.
    """
    u = event_uncertainty(probability)
    if u is None:
        return None
    prox = event_proximity(seconds_to_resolution)
    if prox is None:
        return None
    return min(ceiling, max(0.0, float(profile_weight) * u * prox))


def is_degenerate(probability: Optional[float]) -> bool:
    """True when a probability has effectively resolved.

    A market at 0.995 has ~0.005 of ΔP left in it and its bucket has collapsed. Its
    remaining moves are settlement mechanics, and treating them as information
    produces the largest signals at the least informative moment.
    """
    if probability is None:
        return False
    return (
        probability <= DEGENERATE_PROBABILITY_MARGIN
        or probability >= 1.0 - DEGENERATE_PROBABILITY_MARGIN
    )


# ===========================================================================
# 5. Signal inventory
# ===========================================================================

@dataclass
class PredictionSignal:
    """One named signal: either a computation or a stated blocker.

    Same shape as `footprint.FootprintSignal`, which already reports 3 of its 6
    signals as unavailable. The convention exists because a signal that silently
    never fires is indistinguishable from one that fires and finds nothing.
    """

    name: str
    available: bool
    value: Optional[float] = None
    observation: Optional[str] = None
    consistent_with: List[str] = field(default_factory=list)
    reason_unavailable: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "available": self.available,
            "value": self.value,
            "observation": self.observation,
            "consistentWith": self.consistent_with,
            "reasonUnavailable": self.reason_unavailable,
        }


# The six signals polymarket.md §4 names, and what this system can actually do with
# each. Declared as data so `/api/polymarket` can report the inventory without
# running a computation, exactly as `footprint.FOOTPRINT_SIGNALS` does.
PREDICTION_SIGNALS: Tuple[str, ...] = (
    "delta_probability",
    "probability_zscore",
    "expected_price_drift",
    "delta_stance",
    "move_confidence",
    "anomaly_detection",
)

# The one signal from §4 that is NOT implemented, named rather than omitted.
#
# §4 proposes "feed the probability time-series into an anomaly detector (e.g.
# Gaussian process or LSTM autoencoder)". Declined, and not on effort grounds: a
# learned detector on this data would be fitted to a few weeks of a few markets,
# would be unexplainable inside a decision this system is required to explain
# (Section 10's ten questions), and could not be reproduced in a backtest after
# retraining. `probability_zscore` is the deterministic, auditable version of the
# same idea and it is what a Gaussian model would mostly recover anyway.
UNIMPLEMENTED_SIGNALS: Dict[str, str] = {
    "anomaly_detection": (
        "no learned anomaly detector: it would be fitted to a few weeks of a few "
        "markets, would be unexplainable inside a decision that must answer Section "
        "10's ten questions, and would not reproduce in a backtest after retraining. "
        "probability_zscore is the deterministic equivalent"
    ),
}


def evaluate_signals(
    points: Sequence[Dict[str, Any]],
    window_seconds: float,
    *,
    spot: Optional[float] = None,
    buckets: Optional[Sequence[PriceBucket]] = None,
    threshold_direction: Optional[str] = None,
    quote_volume: Optional[float] = None,
    spread: Optional[float] = None,
    horizon_seconds: Optional[float] = None,
    now: Optional[float] = None,
) -> List[PredictionSignal]:
    """Compute every signal, reporting each as available or blocked.

    Returns one entry per name in `PREDICTION_SIGNALS`, always — a caller can rely
    on the shape, and a missing signal is reported as blocked rather than absent
    from the list.
    """
    signals: List[PredictionSignal] = []

    delta = delta_probability(points, window_seconds, now=now)
    signals.append(
        PredictionSignal(
            name="delta_probability",
            available=delta is not None,
            value=delta,
            observation=(
                None if delta is None
                else f"probability moved {delta:+.4f} over the last {window_seconds:.0f}s"
            ),
            consistent_with=(
                [] if delta is None else [
                    "new information reaching the market",
                    "a single large participant repositioning",
                    "thin-book noise if volume is low",
                ]
            ),
            reason_unavailable=(
                None if delta is not None
                else f"fewer than {MIN_POINTS_FOR_DELTA} observations in the window"
            ),
        )
    )

    z = probability_zscore(points, window_seconds, now=now)
    sigma = probability_volatility(points, now=now)
    signals.append(
        PredictionSignal(
            name="probability_zscore",
            available=z is not None,
            value=z,
            observation=None if z is None else f"{z:+.2f} sigma against this market's own step size",
            consistent_with=[] if z is None else [
                "an unusual move for THIS market",
                "not comparable to a fixed percentage threshold across markets",
            ],
            reason_unavailable=(
                None if z is not None
                else (
                    f"fewer than {MIN_POINTS_FOR_VOLATILITY} observations for a "
                    f"volatility baseline"
                    if sigma is None
                    else "this market's probability has never moved in the sample, so "
                         "a z-score would divide by zero"
                )
            ),
        )
    )

    ep = expected_price(buckets or [], spot, horizon_seconds=horizon_seconds)
    signals.append(
        PredictionSignal(
            name="expected_price_drift",
            available=ep is not None,
            value=None if ep is None else ep.drift_pct,
            observation=(
                None if ep is None
                else (
                    f"market-implied expected price {ep.expected_price:.2f} vs spot "
                    f"{ep.spot:.2f} ({ep.drift_pct:+.2f}%), from {ep.buckets_used} "
                    f"buckets summing to {ep.probability_sum:.3f}"
                )
            ),
            consistent_with=[] if ep is None else [
                f"the market pricing a {ep.direction} terminal distribution",
                "a TERMINAL expectation, not a forecast for the next candle",
            ],
            reason_unavailable=(
                None if ep is not None
                else (
                    "needs a mutually-exclusive event whose markets are BOUNDED price "
                    "buckets (both floorStrike and capStrike), a spot price, and bucket "
                    "probabilities summing to ~1.0. A binary threshold market has an "
                    "unbounded bucket and no computable midpoint — see the module "
                    "docstring on why no bound is assumed"
                )
            ),
        )
    )

    stance = delta_stance(delta, threshold_direction)
    signals.append(
        PredictionSignal(
            name="delta_stance",
            available=stance is not None,
            value=None if stance is None else stance.delta,
            observation=(
                None if stance is None
                else (
                    f"{stance.direction} from a {stance.delta:+.4f} move on an "
                    f"'{stance.threshold_direction}' threshold"
                )
            ),
            consistent_with=[] if stance is None else [
                "the market revising its view in this direction",
                "a change in view, NOT a level — says nothing about how far",
            ],
            reason_unavailable=(
                None if stance is not None
                else (
                    "no ΔP" if delta is None
                    else "the threshold direction (above/below) is unknown, so it cannot "
                         "be said whether a rising probability is bullish or bearish"
                )
            ),
        )
    )

    conf = confidence_from_liquidity(z, quote_volume, spread)
    signals.append(
        PredictionSignal(
            name="move_confidence",
            available=conf is not None,
            value=conf,
            observation=(
                None if conf is None
                else f"{conf:.3f} from magnitude x liquidity x quote quality"
            ),
            consistent_with=[] if conf is None else [
                "how much to trust the move, not which way it points",
            ],
            reason_unavailable=(
                None if conf is not None
                else (
                    "no z-score" if z is None
                    else "quote volume is unavailable, so a large move cannot be told "
                         "apart from a large move on nothing"
                )
            ),
        )
    )

    signals.append(
        PredictionSignal(
            name="anomaly_detection",
            available=False,
            reason_unavailable=UNIMPLEMENTED_SIGNALS["anomaly_detection"],
        )
    )

    return signals
