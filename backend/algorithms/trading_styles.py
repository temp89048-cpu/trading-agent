from dataclasses import dataclass
from typing import List, Dict, Any, Optional

@dataclass
class TradingStyleProfile:
    name: str
    timeframe: str
    requires_high_liquidity: bool
    requires_low_volatility: bool
    description: str

SCALPING = TradingStyleProfile(
    name="Scalping",
    timeframe="Seconds to Minutes",
    requires_high_liquidity=True,
    requires_low_volatility=False,
    description="Low latency, tight execution, high liquidity, small edge per trade."
)

DAY_TRADING = TradingStyleProfile(
    name="Day Trading",
    timeframe="Minutes to Hours",
    requires_high_liquidity=True,
    requires_low_volatility=False,
    description="Intraday structure, session analysis, momentum, volatility awareness."
)

SWING_TRADING = TradingStyleProfile(
    name="Swing Trading",
    timeframe="Days to Weeks",
    requires_high_liquidity=False,
    requires_low_volatility=False,
    description="Higher-timeframe structure, broader trend context, overnight risk."
)

POSITION_TRADING = TradingStyleProfile(
    name="Position Trading",
    timeframe="Weeks to Months",
    requires_high_liquidity=False,
    requires_low_volatility=True, # Often avoids choppy volatile entries
    description="Macro context, long-term trends, fundamental information."
)

ALL_STYLES = [SCALPING, DAY_TRADING, SWING_TRADING, POSITION_TRADING]

def get_viable_styles(market_state: Dict[str, Any]) -> List[str]:
    """
    Determine which styles are viable given the current market state.
    """
    viable = []
    regime = market_state.get("regime", "UNKNOWN")
    liquidity = market_state.get("liquidity", "HIGH")
    volatility = market_state.get("volatility", "MEDIUM")
    
    for style in ALL_STYLES:
        if style.requires_high_liquidity and liquidity == "LOW":
            continue
        
        if style.requires_low_volatility and volatility == "HIGH":
            continue
            
        viable.append(style.name)
        
    return viable
