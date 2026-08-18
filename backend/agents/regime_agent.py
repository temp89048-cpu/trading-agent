from typing import List, Dict, Any
import numpy as np

def detect_market_regime(klines: List[Dict[str, Any]]) -> str:
    """
    Phase 38: Market Regime Intelligence
    Classifies the current market into one of 10 granular states:
    Bull Trend, Bear Trend, Range, High Volatility, Low Volatility,
    Accumulation, Distribution, Panic, Euphoria, Liquidity Crisis.
    """
    if len(klines) < 50:
        return "Unknown"
        
    closes = np.array([k["close"] for k in klines])
    highs = np.array([k["high"] for k in klines])
    lows = np.array([k["low"] for k in klines])
    volumes = np.array([k["volume"] for k in klines])
    
    # 1. Volatility
    returns = np.diff(closes) / closes[:-1]
    volatility = np.std(returns) * np.sqrt(len(closes))
    
    # ATR
    true_ranges = [max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1])) for i in range(1, len(klines))]
    atr = np.mean(true_ranges[-14:])
    
    # 2. Trend (SMA 20 vs SMA 50)
    sma20 = np.mean(closes[-20:])
    sma50 = np.mean(closes[-50:])
    current_price = closes[-1]
    
    is_bull = sma20 > sma50 and current_price > sma20
    is_bear = sma20 < sma50 and current_price < sma20
    
    # 3. Volume Analysis
    avg_vol = np.mean(volumes[-20:])
    current_vol = volumes[-1]
    vol_spike = current_vol > avg_vol * 3.0
    vol_dead = current_vol < avg_vol * 0.1
    
    # Extreme price moves
    recent_drop = (closes[-1] - closes[-5]) / closes[-5] < -0.10
    recent_pump = (closes[-1] - closes[-5]) / closes[-5] > 0.10
    
    # Accumulation / Distribution (Price flat but volume rising = Accumulation, Price dropping but volume flat = Distribution)
    # Simple proxy: if ranging and volume is high, it's accumulation or distribution depending on support/resistance proximity.
    # We will use simple heuristics.
    
    range_high = np.max(closes[-20:])
    range_low = np.min(closes[-20:])
    in_range = (range_high - range_low) / range_low < 0.05
    
    near_support = current_price < range_low + (range_high - range_low) * 0.3
    near_resistance = current_price > range_high - (range_high - range_low) * 0.3
    
    # Priority classification (most extreme first)
    if vol_dead and volatility > 0.1:
        # High volatility with no volume = no liquidity
        return "Liquidity Crisis"
        
    if recent_drop and vol_spike:
        return "Panic"
        
    if recent_pump and vol_spike:
        return "Euphoria"
        
    if in_range and vol_spike and near_support:
        return "Accumulation"
        
    if in_range and vol_spike and near_resistance:
        return "Distribution"
        
    if volatility > 0.08:
        return "High Volatility"
        
    if is_bull and not in_range:
        return "Bull Trend"
        
    if is_bear and not in_range:
        return "Bear Trend"
        
    if in_range and volatility < 0.02:
        return "Low Volatility"
        
    return "Range"
