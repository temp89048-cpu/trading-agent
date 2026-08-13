from typing import List, Dict, Any
import numpy as np

def detect_market_regime(klines: List[Dict[str, Any]]) -> str:
    """
    Level 11: Market Regime Detection
    Classifies the current market into: Trending (Bull/Bear), Ranging, High Volatility, Low Volatility
    """
    if len(klines) < 20:
        return "Unknown"
        
    closes = [k["close"] for k in klines]
    highs = [k["high"] for k in klines]
    lows = [k["low"] for k in klines]
    
    # Calculate historical volatility (std dev of returns)
    returns = np.diff(closes) / closes[:-1]
    volatility = np.std(returns) * np.sqrt(len(closes))
    
    # Calculate ATR for range
    true_ranges = []
    for i in range(1, len(klines)):
        tr = max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
        true_ranges.append(tr)
    atr = sum(true_ranges[-14:]) / 14 if len(true_ranges) >= 14 else sum(true_ranges) / len(true_ranges)
    
    # Simple trend detection (SMA 20)
    sma20 = sum(closes[-20:]) / 20
    current_price = closes[-1]
    
    is_trending_up = current_price > sma20 * 1.01
    is_trending_down = current_price < sma20 * 0.99
    
    # Determine regime
    if volatility > 0.05: # High vol threshold (arbitrary for example)
        regime = "High Volatility"
    elif is_trending_up:
        regime = "Trending Bullish"
    elif is_trending_down:
        regime = "Trending Bearish"
    else:
        regime = "Ranging / Low Volatility"
        
    return regime
