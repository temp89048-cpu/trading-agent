def detect_bos_choch(highs: list[float], lows: list[float], current_price: float, trend: str) -> dict:
    """
    Simplified Market Structure analysis to detect Break of Structure (BOS) 
    or Change of Character (CHoCH).
    
    trend: 'UP' or 'DOWN'
    highs: list of recent swing highs
    lows: list of recent swing lows
    """
    if len(highs) < 2 or len(lows) < 2:
        return {"event": "NONE"}
        
    last_high = highs[-1]
    last_low = lows[-1]
    
    if trend == 'UP':
        if current_price > last_high:
            return {"event": "BOS", "level": last_high}
        elif current_price < last_low:
            return {"event": "CHOCH", "level": last_low}
            
    elif trend == 'DOWN':
        if current_price < last_low:
            return {"event": "BOS", "level": last_low}
        elif current_price > last_high:
            return {"event": "CHOCH", "level": last_high}
            
    return {"event": "NONE"}
