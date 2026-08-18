"""Probability and calibration primitives.

`measured_accuracy` and `volatility_penalty_from_closes` were extracted here from
`agents/confidence_agent.py` in Phase 27 so that the Supervisor graph node and the
ConfidenceAgent read the SAME trade ledger through the SAME code. Two components
computing a historical hit rate from one ledger is how they end up reporting
different accuracies for the same history — and both numbers feed position sizing.

The behavioural split between the two callers is deliberate and lives at the call
site, not in here: `measured_accuracy` returns `None` when the sample is too small,
and the ConfidenceAgent substitutes its conservative prior because it must always
produce *a* calibrated confidence. The Supervisor does not substitute anything,
because it is answering "what is the probability?" and a prior-derived number that
looks measured is the worst possible answer to that question.
"""

import logging
from typing import Any, Dict, List, Optional, Sequence, Tuple

logger = logging.getLogger(__name__)

# Below this many resolved trades, a measured win rate is noise. Not a statistical
# threshold — a floor to stop a 3-win streak reading as 100%.
MIN_TRADES_FOR_ACCURACY = 20

# Bounds on a measured rate. A 100% win rate over a small sample is a sampling
# artefact, and letting it through would make calibration AMPLIFY confidence
# instead of tempering it.
ACCURACY_FLOOR = 0.2
ACCURACY_CEILING = 0.9

# Applied when volatility cannot be measured. The MAXIMUM, not zero: treating an
# unknown volatility regime as calm is the assumption most likely to produce an
# oversized position at the worst possible moment.
UNKNOWN_VOLATILITY_PENALTY = 0.30
# Capped so volatility alone can never zero out a genuine signal.
MAX_VOLATILITY_PENALTY = 0.40
MIN_CANDLES_FOR_VOLATILITY = 20


def measured_accuracy(stats: Optional[Dict[str, Any]]) -> Tuple[Optional[float], str]:
    """Historical hit rate from the trade ledger, or None when unmeasurable.

    Returns `(rate, note)`. `rate` is None — never a default — when there is no
    usable sample, so a caller cannot accidentally treat an assumption as a
    measurement. The note always explains which case applied.

    Takes the stats dict rather than fetching it, so this stays pure and testable
    and the I/O decision belongs to the caller.
    """
    if not stats:
        return None, "no trade history available"

    # The counters live under "global_stats", not at the top level. Reading them
    # from the root returned None every time, so the ConfidenceAgent silently
    # always fell back to its prior and the real win rate was never used. Falling
    # back to the root as well keeps this working if the shape is ever flattened.
    global_stats = stats.get("global_stats") or stats
    total = global_stats.get("total_trades") or global_stats.get("totalTrades") or 0
    wins = global_stats.get("wins") or global_stats.get("winning_trades") or 0

    if not total or total < MIN_TRADES_FOR_ACCURACY:
        return None, (
            f"only {total} resolved trade(s), need {MIN_TRADES_FOR_ACCURACY} "
            f"to measure accuracy"
        )

    rate = max(ACCURACY_FLOOR, min(ACCURACY_CEILING, wins / total))
    return rate, f"measured over {total} resolved trades"


def volatility_penalty_from_closes(closes: Sequence[float]) -> Tuple[float, str]:
    """Realised-volatility penalty from a close series. Pure.

    Takes closes rather than fetching candles so a caller that already holds a
    market snapshot does not trigger a second fetch — which could return a
    different market than the one the decision is being made about.
    """
    if len(closes) < MIN_CANDLES_FOR_VOLATILITY:
        return UNKNOWN_VOLATILITY_PENALTY, (
            f"volatility unknown ({len(closes)} candle(s), need "
            f"{MIN_CANDLES_FOR_VOLATILITY}) — maximum penalty applied"
        )

    returns: List[float] = [
        (closes[i] - closes[i - 1]) / closes[i - 1]
        for i in range(1, len(closes))
        if closes[i - 1]
    ]
    if not returns:
        return UNKNOWN_VOLATILITY_PENALTY, "no usable returns — maximum penalty applied"

    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / len(returns)
    stdev = variance ** 0.5

    # 1% per-candle stdev on 15m candles is already brisk; scale so that maps to
    # roughly a 0.2 penalty.
    penalty = min(MAX_VOLATILITY_PENALTY, stdev * 20)
    return penalty, f"per-candle stdev {stdev * 100:.2f}%"


def bayesian_update(prior: float, likelihood_evidence_given_regime: float, likelihood_evidence_given_not_regime: float) -> float:
    """
    Applies Bayes' Theorem to update the probability of a market regime.
    prior: P(Regime)
    """
    # P(Evidence) = P(Evidence|Regime) * P(Regime) + P(Evidence|Not Regime) * P(Not Regime)
    p_evidence = (likelihood_evidence_given_regime * prior) + (likelihood_evidence_given_not_regime * (1.0 - prior))
    
    if p_evidence == 0:
        return prior
        
    # P(Regime|Evidence) = (P(Evidence|Regime) * P(Regime)) / P(Evidence)
    posterior = (likelihood_evidence_given_regime * prior) / p_evidence
    return posterior

def calibrate_confidence(raw_confidence: float, historical_accuracy: float, volatility_penalty: float) -> float:
    """
    Scales a raw confidence score (e.g. from the Debate Judge) based on agent track record
    and current market conditions.
    """
    # Base calibration
    calibrated = raw_confidence * historical_accuracy
    
    # Apply penalty for high volatility environments
    calibrated = calibrated * (1.0 - volatility_penalty)
    
    return max(0.0, min(1.0, calibrated))
