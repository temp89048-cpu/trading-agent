from typing import Any, Dict, List, Optional

from backend.algorithms.strategy_profiles import get_profile, is_strategy_active_in_regime
import logging

logger = logging.getLogger(__name__)

def trend_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Trend Following Agent: Uses simple moving averages.
    Requires at least 14 candles to compare short vs long momentum.
    """
    if len(klines) < 14:
        return "HOLD"
        
    closes = [k["close"] for k in klines]
    sma_short = sum(closes[-5:]) / 5
    sma_long = sum(closes[-14:]) / 14
    
    if sma_short > sma_long * 1.001:  # 0.1% buffer to prevent chop
        return "BUY"
    elif sma_short < sma_long * 0.999:
        return "SELL"
    return "HOLD"

def mean_reversion_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Mean Reversion Agent: Very basic RSI approximation.
    """
    if len(klines) < 15:
        return "HOLD"
        
    closes = [k["close"] for k in klines]
    gains = 0.0
    losses = 0.0
    
    for i in range(1, 15):
        change = closes[-i] - closes[-i-1]
        if change > 0:
            gains += change
        else:
            losses -= change
            
    avg_gain = gains / 14
    avg_loss = losses / 14
    
    if avg_loss == 0:
        rsi = 100
    else:
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        
    if rsi < 30:
        return "BUY" # Oversold, expect bounce
    elif rsi > 70:
        return "SELL" # Overbought, expect drop
    return "HOLD"

def momentum_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Momentum Agent: Looks for consecutive strong closes.
    """
    if len(klines) < 4:
        return "HOLD"
        
    # Last 3 candles
    c1, c2, c3 = klines[-3], klines[-2], klines[-1]
    
    bullish_1 = c1["close"] > c1["open"]
    bullish_2 = c2["close"] > c2["open"]
    bullish_3 = c3["close"] > c3["open"]
    
    bearish_1 = c1["close"] < c1["open"]
    bearish_2 = c2["close"] < c2["open"]
    bearish_3 = c3["close"] < c3["open"]
    
    if bullish_1 and bullish_2 and bullish_3:
        return "BUY"
    elif bearish_1 and bearish_2 and bearish_3:
        return "SELL"
    return "HOLD"

def scalping_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Scalping Agent: Evaluates wicks vs bodies on recent candles.
    """
    if len(klines) < 3:
        return "HOLD"
    c = klines[-1]
    body = abs(c["close"] - c["open"])
    upper_wick = c["high"] - max(c["open"], c["close"])
    lower_wick = min(c["open"], c["close"]) - c["low"]
    
    if lower_wick > body * 2 and upper_wick < body:
        return "BUY" # Strong rejection of lower prices
    elif upper_wick > body * 2 and lower_wick < body:
        return "SELL"
    return "HOLD"

def swing_trading_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Swing Trading Agent: Looks for broader HH/HL structure over 20 candles.
    """
    if len(klines) < 20:
        return "HOLD"
    highs = [k["high"] for k in klines]
    lows = [k["low"] for k in klines]
    recent_high = max(highs[-10:])
    old_high = max(highs[-20:-10])
    recent_low = min(lows[-10:])
    old_low = min(lows[-20:-10])
    
    if recent_high > old_high and recent_low > old_low:
        return "BUY"
    elif recent_high < old_high and recent_low < old_low:
        return "SELL"
    return "HOLD"

def breakout_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Breakout Agent: Triggers if current price breaks the 14-period high/low.
    """
    if len(klines) < 15:
        return "HOLD"
    current = klines[-1]["close"]
    highest = max([k["high"] for k in klines[-15:-1]])
    lowest = min([k["low"] for k in klines[-15:-1]])
    
    if current > highest:
        return "BUY"
    elif current < lowest:
        return "SELL"
    return "HOLD"

def range_trading_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Range Trading Agent: Fades the edges if the market is moving sideways.
    """
    if len(klines) < 20:
        return "HOLD"
    closes = [k["close"] for k in klines[-20:]]
    highest = max(closes)
    lowest = min(closes)
    current = closes[-1]
    
    # If the range is too tight, skip
    if highest < lowest * 1.002:
        return "HOLD"
        
    range_size = highest - lowest
    # If in top 20% of range, sell. If in bottom 20%, buy.
    if current > highest - (range_size * 0.2):
        return "SELL"
    elif current < lowest + (range_size * 0.2):
        return "BUY"
    return "HOLD"

def grid_strategy_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Grid Strategy Agent: Votes BUY if below recent median, SELL if above.
    """
    if len(klines) < 20:
        return "HOLD"
    closes = sorted([k["close"] for k in klines[-20:]])
    median = closes[10]
    current = klines[-1]["close"]
    
    if current < median * 0.999:
        return "BUY"
    elif current > median * 1.001:
        return "SELL"
    return "HOLD"

def arbitrage_agent(klines: List[Dict[str, Any]]) -> str:
    """
    Arbitrage Agent (StatArb): Looks for extreme deviations from VWAP.
    """
    if len(klines) < 14:
        return "HOLD"
        
    cumulative_vol = 0.0
    cumulative_pv = 0.0
    for k in klines[-14:]:
        typ_price = (k["high"] + k["low"] + k["close"]) / 3
        cumulative_pv += typ_price * k["volume"]
        cumulative_vol += k["volume"]
        
    if cumulative_vol == 0:
        return "HOLD"
        
    vwap = cumulative_pv / cumulative_vol
    current = klines[-1]["close"]
    
    # If price is far above VWAP, it should revert down (sell)
    if current > vwap * 1.01:
        return "SELL"
    elif current < vwap * 0.99:
        return "BUY"
    return "HOLD"

# ---------------------------------------------------------------------------
# Spec Section 18 (Phase 35) names fourteen strategy styles.
#
# THE LIBRARY ALREADY COVERED ALL OF THEM before these two were added — nine
# implemented profiles plus sixteen entries in `strategy_profiles.PLANNED_STRATEGIES`,
# each with a SPECIFIC reason it is not implemented. My Sections 14-41 audit reported
# "~8 of 14 missing" because it inspected `STRATEGY_PROFILES` only and never looked at
# `PLANNED_STRATEGIES`. That finding was wrong.
#
# Only two are added here, and only because their documented objections do not apply
# to what is built:
#
#   VWAP               the objection was that a SESSION-ANCHORED VWAP has no
#                      well-defined session boundary in 24/7 crypto. True — so this is
#                      a ROLLING 30-candle VWAP, which is unambiguous.
#   VolatilityBreakout the objection was that "true volatility trading needs options
#                      or variance instruments". Also true, and a different strategy:
#                      this is a DIRECTIONAL breakout triggered by a volatility
#                      expansion, fully computable from linear futures. Named
#                      distinctly so it cannot be mistaken for volatility-as-an-asset.
#
# Volume Profile, SMC, ICT and Wyckoff were implemented here and then REVERTED. Their
# PLANNED_STRATEGIES objections are correct: klines give volume per TIME bucket so a
# value area is a guess; SMC needs sweep-then-break; ICT needs order blocks and
# fair-value gaps; Wyckoff needs phase classification over a volume profile. Versions
# built from what is available would carry each concept's NAME without its substance,
# which is the fabrication pattern this codebase keeps removing — and worse here,
# because it would override reasoning that was already written down and right.
# ---------------------------------------------------------------------------

def vwap_agent(klines: List[Dict[str, Any]]) -> str:
    """VWAP: fade price when it is stretched from the volume-weighted mean.

    Distinct from `arbitrage_agent`, which uses a 14-candle VWAP as a statistical
    mean-reversion trigger. This one uses a longer session-like window and a wider
    band, so it fires on genuine dislocation rather than ordinary noise.
    """
    if len(klines) < 30:
        return "HOLD"

    pv = 0.0
    vol = 0.0
    for k in klines[-30:]:
        typical = (k["high"] + k["low"] + k["close"]) / 3
        v = float(k.get("volume") or 0.0)
        pv += typical * v
        vol += v

    if vol <= 0:
        # No volume means no volume-WEIGHTED price. Not a HOLD decision about the
        # market — an inability to compute the indicator at all.
        return "HOLD"

    vwap = pv / vol
    current = klines[-1]["close"]
    if vwap <= 0:
        return "HOLD"

    deviation = (current - vwap) / vwap
    if deviation > 0.02:
        return "SELL"
    if deviation < -0.02:
        return "BUY"
    return "HOLD"



def volatility_agent(klines: List[Dict[str, Any]]) -> str:
    """Volatility: trade the expansion out of a contraction.

    A squeeze — recent realised range far below its own baseline — followed by an
    expansion candle is the classic volatility-breakout setup. Direction comes from
    the expansion candle, because a squeeze itself is directionless.

    Returns HOLD while the market is merely quiet: a squeeze with no expansion yet
    is a setup, not a signal, and trading it early is trading a guess about which
    way it will resolve.
    """
    if len(klines) < 30:
        return "HOLD"

    ranges = [k["high"] - k["low"] for k in klines[-30:]]
    baseline = sum(ranges[:-5]) / max(1, len(ranges) - 5)
    if baseline <= 0:
        return "HOLD"

    recent = sum(ranges[-5:-1]) / 4       # the squeeze window, excluding the latest
    latest = ranges[-1]

    squeezed = recent < baseline * 0.7
    expanding = latest > baseline * 1.5
    if not (squeezed and expanding):
        return "HOLD"

    candle = klines[-1]
    if candle["close"] > candle["open"]:
        return "BUY"
    if candle["close"] < candle["open"]:
        return "SELL"
    return "HOLD"





STRATEGY_REGISTRY = {
    "EMA_Crossover_v1.0.0": trend_agent,
    "RSI_MeanReversion_v1.0.0": mean_reversion_agent,
    "MACD_Momentum_v1.0.0": momentum_agent
}

# Every strategy the ensemble runs, keyed by the SAME name used in
# algorithms/strategy_profiles.py. A mismatch between these keys and the profile
# `agent` field means gating silently does nothing for that strategy — which is
# how the TypeScript side's Grid strategy escaped its regime gate. There is a
# test (`test_every_voting_strategy_has_a_profile`) specifically for this.
STRATEGY_FUNCTIONS = {
    "Trend": trend_agent,
    "MeanReversion": mean_reversion_agent,
    "Momentum": momentum_agent,
    "Scalping": scalping_agent,
    "Swing": swing_trading_agent,
    "Breakout": breakout_agent,
    "Range": range_trading_agent,
    "Grid": grid_strategy_agent,
    "Arbitrage": arbitrage_agent,
    # Spec Section 18's remaining named styles that are computable from candles.
    # Funding, Basis and Event Driven are profile-only — see the note above
    # `vwap_agent` for why, and `strategy_profiles` for their blockers.
    "VWAP": vwap_agent,
    "VolatilityBreakout": volatility_agent,
}


def vote_strategies(klines: List[Dict[str, Any]], regime: Optional[str] = None) -> Dict[str, Any]:
    """Run every strategy, mute the ones unsuited to the regime, weigh the rest.

    PHASE 36: STRATEGY SELECTION GRAPH.
    This now uses a LangGraph graph to intelligently select and weigh strategies
    based on the viable Trading Styles (Phase 35) and current market regime.
    """
    if not klines:
        return {
            "consensus": "HOLD",
            "confidence": 0,
            "votes": {},
            "gatedOut": {},
            "regime": regime,
            # Present on EVERY return path. `algorithms/debate.score_debate` reads
            # `ensemble.get("strategiesVoted", 0)` to decide whether its heaviest leg
            # (weight 4.0) is available, so an omission here makes the leg report
            # itself unavailable and silently lowers every confidence in the system.
            # Both early returns omitted it; fixing only one left this path broken.
            "strategiesVoted": 0,
            "strategiesGated": 0,
            "reason": "no candle data supplied",
        }

    from backend.graphs.strategy_selection_graph import run_strategy_selection

    
    # Volatility is MEASURED from the candles this function was already given, via
    # the same `_volatility_band` the market-state graph uses — so the ensemble and
    # the graph cannot disagree about whether the market is volatile.
    #
    # It previously hardcoded `volatility="MEDIUM", liquidity="HIGH"` with the comment
    # "we default to HIGH/MEDIUM". Both fed the strategy scorer. `liquidity="HIGH"` is
    # specifically the claim this system refuses to make everywhere else — there is no
    # order-book depth feed, and the Phase 26 liquidity specialist and the Phase 28
    # liquidity check both report it unavailable for that reason.
    from backend.graphs.nodes.market import _volatility_band

    volatility, _stdev = _volatility_band(klines)
    market_state = {
        # `regime`, NOT `regime or "UNKNOWN"`.
        #
        # `is_strategy_active_in_regime` treats None as PERMISSIVE (every strategy
        # eligible) and the literal string "UNKNOWN" as matching nothing. Substituting
        # the string inverted the rule: with no regime determined, all nine strategies
        # were gated out instead of all nine being eligible, so the ensemble returned
        # no votes at all on any symbol whose regime could not be classified.
        "regime": regime,
        # None when too few candles to measure. The scorer skips the volatility
        # component and records it, rather than assuming MEDIUM.
        "volatility": volatility,
        # None, always. Not "HIGH" — see above.
        "liquidity": None,
    }
    
    # Four plain function calls, not a compiled graph. `build_strategy_selection_graph`
    # was compiling a LangGraph on EVERY call — 7.0ms of the 9.0ms this function took,
    # 78% — for a synchronous pipeline with no branching, no parallelism and nothing to
    # resume. `score_debate` calls this on every graph run.
    final_state = run_strategy_selection({
        "market_state": market_state,
        "available_strategies": list(STRATEGY_FUNCTIONS.keys()),
        # Pre-declared so a stage appends to it rather than ADDING the key mid-run.
        "unavailable": [],
    })
    
    selected_strategies = final_state.get("selected_strategies", {})
    gated_out = final_state.get("gated_out", {})

    votes: Dict[str, str] = {}

    # Only run the strategies that were selected.
    #
    # Iterates a SNAPSHOT of the keys, because the error handler below pops from
    # `selected_strategies`. Iterating the live dict raised
    # "RuntimeError: dictionary changed size during iteration" the moment any one
    # strategy failed — so a single broken strategy took down the entire ensemble
    # and no strategy voted at all. That is the precise opposite of what the
    # surrounding error handling is for, and it is the failure
    # `test_a_broken_strategy_is_recorded_not_silently_dropped` exists to catch.
    for agent_name in list(selected_strategies.keys()):
        fn = STRATEGY_FUNCTIONS[agent_name]
        try:
            votes[agent_name] = fn(klines)
        except Exception as e:
            logger.error("Strategy %s raised: %s", agent_name, e)
            gated_out[agent_name] = f"errored: {e}"
            selected_strategies.pop(agent_name, None)

    if not votes:
        return {
            "consensus": "HOLD",
            "confidence": 0,
            "votes": {},
            "gatedOut": gated_out,
            "regime": regime,
            # `strategiesVoted` and `strategiesGated` MUST be present on this path too.
            # `algorithms/debate.score_debate` reads `ensemble.get("strategiesVoted", 0)`
            # to decide whether its ensemble leg is available, and this early return
            # omitted the key — so `.get()` returned None on every no-vote run and the
            # leg reported itself unavailable. Since the ensemble carries the largest
            # single weight in the debate (4.0), that silently cut every debate's
            # coverage to 72% and its confidence with it.
            "strategiesVoted": 0,
            "strategiesGated": len(gated_out),
            "reason": f"every strategy was gated out or errored in the '{regime}' regime",
        }

    buy_weight = sum(selected_strategies[k] for k, v in votes.items() if v == "BUY")
    sell_weight = sum(selected_strategies[k] for k, v in votes.items() if v == "SELL")
    voted_weight = sum(selected_strategies.values())

    net = buy_weight - sell_weight
    # Normalised against the strategies that ACTUALLY voted
    normalised = abs(net) / voted_weight if voted_weight > 0 else 0

    # A minimum of two agreeing strategies (or equivalent weight), scaled to how many were eligible.
    min_agreement = max(2.0, len(votes) * 0.4)
    # Convert min_agreement to weight equivalent assuming average weight 0.9
    min_weight = min_agreement * 0.9

    if net > 0 and buy_weight >= min_weight:
        consensus = "BUY"
        confidence = int(normalised * 100)
    elif net < 0 and sell_weight >= min_weight:
        consensus = "SELL"
        confidence = int(normalised * 100)
    else:
        consensus = "HOLD"
        # Confidence in HOLD is how strongly the directional votes cancel:
        confidence = int((1.0 - normalised) * 100)

    result = {
        "consensus": consensus,
        "confidence": confidence,
        "votes": votes,
        # Surfaced so an operator can see WHY only some strategies voted.
        "gatedOut": gated_out,
        "regime": regime,
        "strategiesVoted": len(votes),
        "strategiesGated": len(gated_out),
        "minAgreementRequired": min_agreement,
    }

    logger.info(
        "Strategy Ensemble: %s at %d%% (%d voted, %d gated out in regime '%s')",
        consensus, confidence, len(votes), len(gated_out), regime,
    )
    return result


def vote_strategies_for_klines(klines: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Classify the regime from the candles, then vote with gating applied.

    The convenience wrapper callers should prefer — passing `regime=None` by
    accident silently disables every gate, which is the failure this avoids.
    """
    from backend.agents.regime_agent import detect_market_regime

    return vote_strategies(klines, regime=detect_market_regime(klines))
