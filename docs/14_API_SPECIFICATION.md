# TradingOS AI
Version 3.0

## Mission
Build the world's most advanced autonomous AI trading platform capable of
continuously analyzing cryptocurrency futures markets, making explainable
decisions, preserving capital through rigorous risk management, learning
from validated experience, and operating safely 24/7 under human-defined
governance.

## Core Principles
1. Capital Preservation
2. Explainability
3. Reliability
4. Continuous Learning
5. Safety
6. Modularity
7. Scalability
8. Research Driven
9. Risk First
10. Evidence Based

---

## 8. API Layer — Every API

| API | Purpose |
|---|---|
| Market API | Serves normalized market data to all agents |
| Exchange API | Wraps Binance/Bybit/OKX/etc. connectors behind one interface |
| AI API | Routes reasoning requests to the correct model/agent |
| Knowledge API | Query/write access to the Knowledge Graph |
| Memory API | Read/write access to agent memory stores |
| Research API | Submits and retrieves research tasks/findings |
| Execution API | The only path by which any agent can place/modify/cancel an order |
| Monitoring API | Health, metrics, and alerting surface |
| Dashboard API | Feeds the Executive Operations Dashboard |

**Rule:** the Execution API is a hard chokepoint — no agent talks to an exchange directly, ever. This is what makes the Risk/Compliance layer able to actually enforce anything.

### 8.1 API Endpoint Contracts (Enhancement)

#### `POST /api/v1/execution/order`
The sole entry point for placing a trade. Handled by the Execution Engine.
**Request Payload:**
```json
{
  "tar_id": "uuid-v4",
  "symbol": "BTC-USDT-PERP",
  "side": "BUY",
  "order_type": "LIMIT",
  "price": 62500.00,
  "quantity": 0.5,
  "leverage": 3,
  "post_only": true,
  "idempotency_key": "unique-request-hash",
  "risk_signature": "cryptographic-approval-from-CRO"
}
```
**Response (202 Accepted):**
```json
{
  "status": "routing",
  "order_id": "exchange-assigned-or-internal-uuid",
  "estimated_slippage": 0.01
}
```

#### `GET /api/v1/monitoring/health`
Used by the Supervisor AI to ensure system sanity.
**Response (200 OK):**
```json
{
  "system_status": "healthy",
  "agents": {
    "supervisor": {"status": "alive", "last_heartbeat": 2},
    "risk_engine": {"status": "alive", "last_heartbeat": 1},
    "market_intel": {"status": "degraded", "latency_ms": 1500}
  },
  "exchange_connections": {
    "binance": "connected",
    "bybit": "connected"
  }
}
```
