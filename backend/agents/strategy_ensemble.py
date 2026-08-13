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
}


def vote_strategies(klines: List[Dict[str, Any]], regime: Optional[str] = None) -> Dict[str, Any]:
    """Run every strategy, mute the ones unsuited to the regime, weigh the rest.

    TWO CHANGES FROM THE PREVIOUS VERSION.

    1. REGIME GATING. It ran all nine strategies unconditionally, so Mean
       Reversion voted during a strong trend and Grid voted in a trending market
       — the exact regimes where each loses money, per their own Section 11.3
       `worst_conditions`. A gated-out strategy is reported in `gatedOut` with
       the reason, not silently dropped: "Mean Reversion did not vote because
       the market is trending" and "Mean Reversion saw nothing" are different
       facts and only one of them is useful.

    2. WEIGHTED, NOT COUNTED. Spec Section 22.7: *"weigh their evidence and
       confidence rather than taking a simple vote."* The old version divided
       raw vote counts by a hardcoded `TOTAL_AGENTS = 9` — which was also a bug
       once gating exists, because dividing by 9 when only 4 strategies were
       eligible understates confidence for reasons that have nothing to do with
       the market. Confidence is now the net directional weight over the weight
       that actually voted.

    `regime=None` means "not classified" and gates nothing, matching
    `StrategyProfile.is_active_in`'s treatment of UNKNOWN.
    """
    if not klines:
        return {
            "consensus": "HOLD",
            "confidence": 0,
            "votes": {},
            "gatedOut": {},
            "regime": regime,
            "reason": "no candle data supplied",
        }

    votes: Dict[str, str] = {}
    gated_out: Dict[str, str] = {}

    for agent_name, fn in STRATEGY_FUNCTIONS.items():
        if not is_strategy_active_in_regime(agent_name, regime or ""):
            profile = get_profile(agent_name)
            gated_out[agent_name] = (
                f"muted in '{regime}' regime — {profile.worst_conditions}"
                if profile else f"muted in '{regime}' regime"
            )
            continue
        try:
            votes[agent_name] = fn(klines)
        except Exception as e:
            # One broken strategy must not take down the ensemble, but its
            # absence is recorded rather than silently reducing the vote base.
            logger.error("Strategy %s raised: %s", agent_name, e)
            gated_out[agent_name] = f"errored: {e}"

    if not votes:
        return {
            "consensus": "HOLD",
            "confidence": 0,
            "votes": {},
            "gatedOut": gated_out,
            "regime": regime,
            "reason": f"every strategy was gated out or errored in the '{regime}' regime",
        }

    buy_weight = sum(1.0 for v in votes.values() if v == "BUY")
    sell_weight = sum(1.0 for v in votes.values() if v == "SELL")
    voted_weight = float(len(votes))

    net = buy_weight - sell_weight
    # Normalised against the strategies that ACTUALLY voted, not a hardcoded 9.
    normalised = abs(net) / voted_weight

    # A minimum of two agreeing strategies, scaled to how many were eligible.
    # A single vote out of two eligible is not consensus.
    min_agreement = max(2.0, voted_weight * 0.4)

    if net > 0 and buy_weight >= min_agreement:
        consensus = "BUY"
        confidence = int(normalised * 100)
    elif net < 0 and sell_weight >= min_agreement:
        consensus = "SELL"
        confidence = int(normalised * 100)
    else:
        consensus = "HOLD"
        # Confidence in HOLD is how strongly the directional votes cancel:
        # a genuine split is a confident HOLD, one weak signal is not.
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
