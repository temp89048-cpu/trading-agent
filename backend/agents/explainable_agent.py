import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

def generate_receipt(trade_context: Dict[str, Any], confidence_score: int, tp_sl: Dict[str, float], entry_price: float, size_multiplier: float, sim_result: Dict[str, Any] = None) -> str:
    """
    Level 15: Explainable AI
    Generates a plain-English receipt answering exactly WHY a trade is being taken.
    """
    
    symbol = trade_context.get("symbol", "UNKNOWN")
    side = trade_context.get("side", "buy").upper()
    
    # 1. Gather Reasons
    reasons = []
    
    # Trend
    mtf = trade_context.get("mtf_trend", "Mixed")
    reasons.append(f"Trend is {mtf.lower()}.")
    
    # Strategies
    strats = trade_context.get("strategies", [])
    if strats:
        reasons.append(f"Strategies ({', '.join(strats)}) align with {side}.")
        
    # Macro / Sentiment
    macro = trade_context.get("macro", {})
    sent = macro.get("sentiment", "neutral")
    reasons.append(f"Macro Sentiment is {sent}.")
    
    # Risk
    if size_multiplier < 1.0:
        reasons.append(f"Risk scaled to {int(size_multiplier * 100)}% due to existing portfolio exposure.")
    else:
        reasons.append("Risk acceptable (Full allocation).")
        
    # Debate
    debate = trade_context.get("debate", {})
    if debate.get("approved"):
        reasons.append("Debate Supervisor verified setup.")
        
    # Simulation
    if sim_result:
        reasons.append(f"Stress Test passed: {sim_result['prob_success']:.1f}% win prob (EV: {sim_result['ev']:.4f}).")
        
    # Formatting reasons
    reasons_str = "\n".join([f"  - {r}" for r in reasons])
    
    # 2. Risk/Reward Math
    sl = tp_sl.get("stopLoss", 0)
    tp = tp_sl.get("takeProfit", 0)
    
    risk_dist = abs(entry_price - sl)
    reward_dist = abs(tp - entry_price)
    
    r_multiple = (reward_dist / risk_dist) if risk_dist > 0 else 0
    
    # 3. Final Receipt Format
    receipt = (
        f"\n--- EXPLAINABLE AI RECEIPT: {side} {symbol} ---\n"
        f"Reason:\n"
        f"{reasons_str}\n\n"
        f"Probability:       {confidence_score}%\n"
        f"Expected Reward:   {r_multiple:.1f}R\n"
        f"Stop Loss:         {sl:.4f}\n"
        f"Take Profit:       {tp:.4f}\n"
        f"----------------------------------------"
    )
    
    logger.info(receipt)
    return receipt
