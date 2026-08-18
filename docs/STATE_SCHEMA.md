# State Schema

The `TradingState` defines the data structure passed between nodes in the LangGraph Cognitive Plane.

```python
from typing import TypedDict, List, Dict, Any, Optional

class TradingState(TypedDict):
    # Context
    symbol: str
    timeframe: str
    
    # Market Intelligence Graph State
    klines: List[Dict[str, float]]
    regime: str
    volatility: float
    volume_profile: Dict[str, Any]
    market_events: List[str]
    
    # Trade Decision Graph State
    selected_strategies: List[str]
    debate_history: List[Dict[str, Any]]
    bayesian_probs: Dict[str, float]
    supervisor_decision: str # "APPROVE", "REJECT", "REQUIRE_CONSULTATION"
    
    # Position Graph State
    open_positions: List[Dict[str, Any]]
    drawdown_pct: float
    portfolio_health: str
    
    # Execution intent (Passed to Control Plane)
    trade_intent: Optional[Dict[str, Any]]
    
    # LLM Token Accounting
    token_usage: int
```
