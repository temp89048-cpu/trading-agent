import logging
from typing import Dict, Any, List

logger = logging.getLogger(__name__)

def generate_plan(klines: List[Dict[str, Any]], current_price: float, side: str) -> Dict[str, Any]:
    """
    Level 7: Planner Agent
    Generates a conditional execution plan based on market structure.
    Instead of buying now, it waits for confirmation.
    """
    if len(klines) < 10:
        # Fallback if we don't have enough data
        return {
            "type": "immediate",
            "target_price": current_price,
            "description": "Execute immediately due to lack of historical data."
        }
        
    highs = [k['high'] for k in klines]
    lows = [k['low'] for k in klines]
    
    recent_high = max(highs)
    recent_low = min(lows)
    
    if side == "buy":
        # If current price is below the recent high, wait for breakout
        if current_price < recent_high * 0.999: # 0.1% buffer
            target = recent_high * 1.001 # Buy slightly above the high to confirm breakout
            return {
                "type": "price_cross_above",
                "target_price": target,
                "description": f"Wait for BTC to breakout above resistance at {target:.2f}"
            }
        else:
            return {
                "type": "immediate",
                "target_price": current_price,
                "description": "Price already above resistance, execute now."
            }
            
    elif side == "sell":
        if current_price > recent_low * 1.001:
            target = recent_low * 0.999 # Sell slightly below low to confirm breakdown
            return {
                "type": "price_cross_below",
                "target_price": target,
                "description": f"Wait for BTC to break down below support at {target:.2f}"
            }
        else:
            return {
                "type": "immediate",
                "target_price": current_price,
                "description": "Price already below support, execute now."
            }
            
    return {
        "type": "immediate",
        "target_price": current_price,
        "description": "Default immediate execution."
    }
