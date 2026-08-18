# Event Schema

This defines the events that will wake up the LangGraph nodes. Currently, agents poll every X seconds. This will be replaced by an Event Bus model.

## Event Types (Phase 31)

```python
from pydantic import BaseModel
from typing import Dict, Any

class MarketEvent(BaseModel):
    event_type: str # "PRICE_SPIKE", "VOLUME_ANOMALY", "LIQUIDATION_CLUSTER", "NEWS_ALERT"
    symbol: str
    timestamp: float
    magnitude: float
    metadata: Dict[str, Any]

class RiskEvent(BaseModel):
    event_type: str # "DRAWDOWN_WARNING", "MARGIN_CALL_RISK", "CORRELATION_SPIKE"
    severity: str # "LOW", "MEDIUM", "HIGH", "CRITICAL"
    timestamp: float
    metadata: Dict[str, Any]
    
class SystemEvent(BaseModel):
    event_type: str # "AGENT_HEARTBEAT_FAILURE", "LATENCY_SPIKE", "EXCHANGE_DISCONNECT"
    timestamp: float
    metadata: Dict[str, Any]
```

These events will trigger `run_graph()` with the event context.
