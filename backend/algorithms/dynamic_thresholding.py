def get_required_confidence(regime: str) -> float:
    """
    Phase 39: Dynamic Thresholding
    Determine the minimum confidence required to enter a trade based on market regime.
    """
    thresholds = {
        "Bull Trend": 0.60,
        "Bear Trend": 0.65,
        "Range": 0.75,
        "Low Volatility": 0.70,
        "High Volatility": 0.85,
        "Accumulation": 0.65,
        "Distribution": 0.80,
        "Panic": 0.95,
        "Euphoria": 0.95,
        "Liquidity Crisis": 0.99, # Effectively disables trading
    }
    return thresholds.get(regime, 0.80)

def get_regime_risk_multiplier(regime: str) -> float:
    """
    Phase 40: Position Sizing AI
    Determine the risk multiplier based on the safety of the current regime.
    """
    multipliers = {
        "Bull Trend": 1.0,
        "Bear Trend": 0.9,
        "Range": 0.5,
        "Low Volatility": 0.8,
        "High Volatility": 0.25,
        "Accumulation": 1.0,
        "Distribution": 0.3,
        "Panic": 0.1,
        "Euphoria": 0.1,
        "Liquidity Crisis": 0.0,
    }
    return multipliers.get(regime, 0.5)
