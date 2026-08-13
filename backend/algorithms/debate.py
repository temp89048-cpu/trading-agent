"""Deterministic bull/bear scoring — the Multi-Agent Parliament's arithmetic.

Spec Section 22.7: *"When multiple specialist agents disagree, weigh their
evidence and confidence rather than taking a simple vote."*

WHY THIS IS COMPUTATION AND NOT A MODEL CALL
--------------------------------------------
Every input here is a number already on hand (closes, highs, lows, volumes).
Asking a language model to "reason over" figures we have already computed adds
hallucination risk to a financial decision for no benefit, and makes the result
non-reproducible — the same candles could yield a different verdict on a
re-run, which destroys any ability to backtest the decision rule. This mirrors
the TypeScript side's `lib/debate/moderator.ts`, which is deterministic for
the same reason. Reserve model calls for genuine judgment (reflection,
hypothesis generation, chat).

WHAT IT REPLACED
----------------
`agents/debate_agent.py` previously returned:

    bull_score = 3
    bear_score = 1
    winning_dir = "LONG"
    confidence = 0.85
    rationale = "Bull arguments outweighed Bear arguments."

Constants. It fetched macro data and memory statistics and then referenced
neither. Every debate in the system concluded LONG at 85% confidence, on every
symbol, in every market condition — so the "parliament" was a straight wire to
a fixed answer, and the downstream gates were being asked to check a decision
that had never actually been made.

EVIDENCE MODEL
--------------
Each check returns a signed score: positive favours LONG, negative favours
SHORT, zero means the check found nothing (which is different from the check
being unable to run — an unavailable check is reported in `unavailable` and
excluded from the total, never silently counted as neutral).

Confidence is the net score's magnitude relative to the total weight that was
actually evaluable, so a verdict resting on two of five checks cannot report
the same confidence as one resting on all five.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

# Weights are relative, not probabilities. Trend and structure carry more than
# momentum because a momentum reading against a strong trend is more often
# noise than signal; volatility is a context modifier rather than a direction
# vote, so it carries least.
WEIGHT_TREND = 3.0
WEIGHT_STRUCTURE = 3.0
WEIGHT_MOMENTUM = 2.0
WEIGHT_VOLUME = 1.5
WEIGHT_VOLATILITY = 1.0

# The strategy ensemble carries the most weight of any single check, because it
# is nine independent strategies rather than one indicator — and because those
# strategies are regime-gated, so a vote from it already excludes strategies
# unsuited to current conditions.
#
# WHY IT IS HERE AT ALL: `agents/strategy_ensemble.vote_strategies` had no
# callers anywhere in the backend. Nine implemented strategies and the whole of
# spec Section 11's library were dead code, while this module scored the market
# from five indicators of its own. Two independent signal systems, one unused.
WEIGHT_ENSEMBLE = 4.0

# Below this many candles nothing here can be computed honestly.
MIN_CANDLES = 50

# A net score this small relative to evaluated weight is a genuine
# disagreement, not a weak signal. Reporting NEUTRAL is the correct outcome —
# it is what lets the Supervisor decline instead of trading a coin flip.
NEUTRAL_BAND = 0.15


@dataclass
class Argument:
    """One check's contribution."""
    name: str
    score: float          # signed, already weighted
    weight: float         # the weight this check could have contributed
    detail: str


@dataclass
class DebateResult:
    direction: str                      # 'LONG' | 'SHORT' | 'NEUTRAL'
    confidence: float                   # 0.0 - 1.0
    bull_arguments: List[Argument] = field(default_factory=list)
    bear_arguments: List[Argument] = field(default_factory=list)
    unavailable: List[str] = field(default_factory=list)
    rationale: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "direction": self.direction,
            "confidence": self.confidence,
            "bull": [{"name": a.name, "score": a.score, "detail": a.detail} for a in self.bull_arguments],
            "bear": [{"name": a.name, "score": a.score, "detail": a.detail} for a in self.bear_arguments],
            "unavailable": self.unavailable,
            "rationale": self.rationale,
        }


def _sma(values: Sequence[float], period: int) -> Optional[float]:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def _rsi(closes: Sequence[float], period: int = 14) -> Optional[float]:
    """Wilder-style RSI. Returns None when there isn't enough history."""
    if len(closes) < period + 1:
        return None
    gains, losses = 0.0, 0.0
    for i in range(len(closes) - period, len(closes)):
        change = closes[i] - closes[i - 1]
        if change >= 0:
            gains += change
        else:
            losses -= change
    avg_gain = gains / period
    avg_loss = losses / period
    if avg_loss == 0:
        # All gains over the window. 100 is the correct RSI, not a divide error.
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _swings(values: Sequence[float], lookback: int = 5, want_high: bool = True) -> List[float]:
    """Local extrema — a point higher (or lower) than `lookback` neighbours each side."""
    out = []
    for i in range(lookback, len(values) - lookback):
        window = values[i - lookback : i + lookback + 1]
        if want_high and values[i] == max(window):
            out.append(values[i])
        elif not want_high and values[i] == min(window):
            out.append(values[i])
    return out


def score_debate(klines: List[Dict[str, Any]]) -> DebateResult:
    """Weigh bull against bear evidence from real candles.

    Returns NEUTRAL with 0.0 confidence when there is not enough data. That is
    a refusal, and the Supervisor treats it as one — it does not become a
    default LONG.
    """
    if len(klines) < MIN_CANDLES:
        return DebateResult(
            direction="NEUTRAL",
            confidence=0.0,
            unavailable=["all checks"],
            rationale=(
                f"Only {len(klines)} candle(s) available; {MIN_CANDLES} are needed to weigh "
                f"trend, structure, momentum, volume and volatility. No directional view."
            ),
        )

    closes = [float(k["close"]) for k in klines]
    highs = [float(k["high"]) for k in klines]
    lows = [float(k["low"]) for k in klines]
    volumes = [float(k.get("volume", 0.0)) for k in klines]
    price = closes[-1]

    args: List[Argument] = []
    unavailable: List[str] = []

    # --- 1. Trend: price against fast and slow moving averages -----------
    sma20 = _sma(closes, 20)
    sma50 = _sma(closes, 50)
    if sma20 is None or sma50 is None or sma50 == 0:
        unavailable.append("trend (needs 50 candles)")
    else:
        # Separation as a fraction of price, so the reading is comparable
        # across instruments priced at $0.02 and $60,000.
        sep = (sma20 - sma50) / price
        above = (price - sma20) / price
        raw = max(-1.0, min(1.0, (sep * 40) + (above * 20)))
        args.append(
            Argument(
                "Trend",
                raw * WEIGHT_TREND,
                WEIGHT_TREND,
                f"price {price:.6g}, SMA20 {sma20:.6g}, SMA50 {sma50:.6g} "
                f"(fast/slow separation {sep * 100:+.2f}% of price)",
            )
        )

    # --- 2. Market structure: BOS / CHoCH --------------------------------
    swing_highs = _swings(highs, want_high=True)
    swing_lows = _swings(lows, want_high=False)
    if len(swing_highs) < 2 or len(swing_lows) < 2:
        unavailable.append("structure (no clear swing points)")
    else:
        trend_dir = "UP" if (sma20 or 0) >= (sma50 or 0) else "DOWN"
        from backend.algorithms.structure import detect_bos_choch

        event = detect_bos_choch(swing_highs, swing_lows, price, trend_dir)
        if event["event"] == "BOS":
            # Break of structure continues the prevailing trend.
            score = WEIGHT_STRUCTURE if trend_dir == "UP" else -WEIGHT_STRUCTURE
            detail = f"BOS at {event['level']:.6g} continuing the {trend_dir} trend"
        elif event["event"] == "CHOCH":
            # Change of character reverses it.
            score = -WEIGHT_STRUCTURE if trend_dir == "UP" else WEIGHT_STRUCTURE
            detail = f"CHoCH at {event['level']:.6g} against the {trend_dir} trend"
        else:
            score = 0.0
            detail = f"no structural break; price inside the last swing range ({trend_dir} bias)"
        args.append(Argument("Structure", score, WEIGHT_STRUCTURE, detail))

    # --- 3. Momentum: RSI ------------------------------------------------
    rsi = _rsi(closes)
    if rsi is None:
        unavailable.append("momentum (RSI needs 15 candles)")
    else:
        # Distance from 50, normalised. Overbought/oversold extremes are
        # treated as mean-reversion evidence AGAINST the recent move, which is
        # why the sign flips beyond 70/30 rather than continuing to grow.
        if rsi > 70:
            raw = -((rsi - 70) / 30)
            detail = f"RSI {rsi:.1f} overbought — mean-reversion risk against longs"
        elif rsi < 30:
            raw = (30 - rsi) / 30
            detail = f"RSI {rsi:.1f} oversold — mean-reversion favours longs"
        else:
            raw = (rsi - 50) / 20
            detail = f"RSI {rsi:.1f} neutral band, leaning {'up' if rsi > 50 else 'down'}"
        args.append(Argument("Momentum", max(-1.0, min(1.0, raw)) * WEIGHT_MOMENTUM, WEIGHT_MOMENTUM, detail))

    # --- 4. Volume confirmation -----------------------------------------
    recent_vol = _sma(volumes, 5)
    baseline_vol = _sma(volumes, 20)
    if not recent_vol or not baseline_vol or baseline_vol == 0:
        unavailable.append("volume (no volume data)")
    else:
        ratio = recent_vol / baseline_vol
        # Volume has no direction of its own: it confirms whichever way the
        # last 5 candles moved. Multiplying an unsigned ratio by a direction
        # would otherwise let heavy selling read as bullish.
        recent_move = (closes[-1] - closes[-5]) / closes[-5] if closes[-5] else 0.0
        direction_sign = 1.0 if recent_move > 0 else (-1.0 if recent_move < 0 else 0.0)
        strength = max(-1.0, min(1.0, (ratio - 1.0)))
        args.append(
            Argument(
                "Volume",
                strength * direction_sign * WEIGHT_VOLUME,
                WEIGHT_VOLUME,
                f"5-candle volume {ratio:.2f}x the 20-candle baseline, "
                f"confirming a {recent_move * 100:+.2f}% move",
            )
        )

    # --- 5. Volatility regime -------------------------------------------
    from backend.agents.regime_agent import detect_market_regime

    regime = detect_market_regime(klines)
    if regime == "Unknown":
        unavailable.append("volatility regime")
    else:
        # High volatility is a reason for less conviction either way, so it
        # contributes a negative score to whichever side is currently ahead
        # rather than a direction of its own.
        prelim = sum(a.score for a in args)
        if regime == "High Volatility":
            score = -WEIGHT_VOLATILITY if prelim > 0 else WEIGHT_VOLATILITY
            detail = "high-volatility regime — reduces conviction in the leading side"
        elif regime == "Trending Bullish":
            score = WEIGHT_VOLATILITY
            detail = "regime: trending bullish"
        elif regime == "Trending Bearish":
            score = -WEIGHT_VOLATILITY
            detail = "regime: trending bearish"
        else:
            score = 0.0
            detail = f"regime: {regime} — no directional contribution"
        args.append(Argument("Volatility", score, WEIGHT_VOLATILITY, detail))

    # --- 6. Strategy ensemble (spec Section 11's library) ----------------
    # Nine regime-gated strategies voting. Imported here rather than at module
    # scope because `agents/strategy_ensemble` imports from `algorithms/`, and a
    # top-level import would create a cycle.
    try:
        from backend.agents.strategy_ensemble import vote_strategies

        ensemble = vote_strategies(klines, regime=regime if regime != "Unknown" else None)
        voted = ensemble.get("strategiesVoted", 0)
        if voted == 0:
            unavailable.append("strategy ensemble (every strategy gated out)")
        else:
            consensus = ensemble["consensus"]
            # Confidence is already normalised against the strategies that
            # actually voted, so it can be used directly as a magnitude.
            strength = ensemble["confidence"] / 100.0
            if consensus == "BUY":
                score = strength * WEIGHT_ENSEMBLE
            elif consensus == "SELL":
                score = -strength * WEIGHT_ENSEMBLE
            else:
                score = 0.0
            gated = ensemble.get("strategiesGated", 0)
            args.append(
                Argument(
                    "StrategyEnsemble",
                    score,
                    WEIGHT_ENSEMBLE,
                    f"{voted} strategy/strategies voted {consensus} at {ensemble['confidence']}%"
                    + (f" ({gated} gated out for this regime)" if gated else ""),
                )
            )
    except Exception as e:
        # The ensemble must never take down the debate. Its absence is recorded
        # so confidence is scaled down rather than the failure being invisible.
        unavailable.append(f"strategy ensemble (errored: {e})")

    # --- verdict ---------------------------------------------------------
    evaluated_weight = sum(a.weight for a in args)
    if evaluated_weight == 0:
        return DebateResult(
            direction="NEUTRAL",
            confidence=0.0,
            unavailable=unavailable,
            rationale="No check could be evaluated, so there is no directional view.",
        )

    net = sum(a.score for a in args)
    # Normalised against the weight ACTUALLY evaluated, not the theoretical
    # maximum. A verdict from 2 of 5 checks cannot claim the confidence of one
    # from 5 of 5.
    normalised = net / evaluated_weight

    bulls = sorted([a for a in args if a.score > 0], key=lambda a: -a.score)
    bears = sorted([a for a in args if a.score < 0], key=lambda a: a.score)

    if abs(normalised) < NEUTRAL_BAND:
        direction = "NEUTRAL"
        confidence = 0.0
        verdict = (
            f"Bull and bear evidence are within the neutral band "
            f"(net {normalised:+.3f}, threshold ±{NEUTRAL_BAND}). No directional trade."
        )
    else:
        direction = "LONG" if normalised > 0 else "SHORT"
        confidence = min(1.0, abs(normalised))
        verdict = f"{direction} on net evidence {normalised:+.3f} of evaluated weight {evaluated_weight:.1f}."

    # Confidence is also scaled by how much of the total possible weight was
    # evaluable, so missing checks lower conviction instead of being ignored.
    total_possible = (
        WEIGHT_TREND + WEIGHT_STRUCTURE + WEIGHT_MOMENTUM
        + WEIGHT_VOLUME + WEIGHT_VOLATILITY + WEIGHT_ENSEMBLE
    )
    coverage = evaluated_weight / total_possible
    confidence = confidence * coverage

    parts = [verdict]
    if bulls:
        parts.append("Bull: " + "; ".join(f"{a.name} ({a.score:+.2f}) {a.detail}" for a in bulls))
    if bears:
        parts.append("Bear: " + "; ".join(f"{a.name} ({a.score:+.2f}) {a.detail}" for a in bears))
    if unavailable:
        parts.append(
            f"Not evaluated: {', '.join(unavailable)} — confidence scaled to "
            f"{coverage * 100:.0f}% coverage."
        )

    return DebateResult(
        direction=direction,
        confidence=confidence,
        bull_arguments=bulls,
        bear_arguments=bears,
        unavailable=unavailable,
        rationale=" ".join(parts),
    )
