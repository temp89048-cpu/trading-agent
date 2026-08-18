import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

def calculate_trade_probabilities(
    debate_result: Dict[str, Any], 
    base_win_rate: float = 0.45,
    reward_risk_ratio: float = 1.5
) -> Dict[str, Any]:
    """
    Phase 37: Bayesian Decision Engine.
    
    Takes the debate's conclusion (which aggregates the strategy ensemble and other 
    market factors) and uses Bayesian updating to calculate expected value.
    
    base_win_rate: Prior probability of a winning trade. Default 0.45 (assumes slight 
                   disadvantage due to fees/spread without edge).
    reward_risk_ratio: Expected return vs risk. Default 1.5.
    """
    direction = debate_result.get("direction", "HOLD")
    confidence = debate_result.get("confidence", 0)  # assumed 0.0 to 1.0 from debate.py
    
    if direction == "HOLD" or direction == "UNKNOWN":
        return {
            "p_profit": 0.0,
            "p_loss": 0.0,
            "expected_value": 0.0,
            "confidence": confidence,
            "risk": "N/A"
        }
        
    # Bayesian Update: P(Profit | Signal)
    # We treat the ensemble's 'confidence' as the likelihood of the signal being correct
    # given a profitable setup: P(Signal | Profit)
    # P(Profit | Signal) = [P(Signal | Profit) * P(Profit)] / P(Signal)
    
    # We will simplify by interpreting 'confidence' as a direct modifier to the base rate.
    # If confidence is 0, we revert to base_win_rate. If confidence is 1, we cap at 0.85 (never 100%).
    
    max_p = 0.85
    min_p = 0.15
    
    # Linear blend between base rate and the confidence signal
    p_profit = base_win_rate + (confidence * (max_p - base_win_rate))
    
    # Ensure bounds
    p_profit = max(min_p, min(max_p, p_profit))
    p_loss = 1.0 - p_profit
    
    # Expected Value = (P(Profit) * Reward) - (P(Loss) * Risk)
    # Assuming Risk = 1 unit, Reward = reward_risk_ratio units
    expected_value = (p_profit * reward_risk_ratio) - (p_loss * 1.0)
    
    return {
        "p_profit": round(p_profit, 3),
        "p_loss": round(p_loss, 3),
        "expected_value": round(expected_value, 3),
        "confidence": confidence,
        "risk": "acceptable" if expected_value > 0 else "rejected"
    }
