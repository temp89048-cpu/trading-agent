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

## 7. Data Layer — Every Database

At minimum, the platform needs dedicated stores for:

| Store | Holds |
|---|---|
| Trades | Every order, fill, and position lifecycle event |
| Strategies | Versioned strategy definitions and status |
| Memory | Short/long-term agent memory |
| Knowledge | The Knowledge Graph (entities + relationships) |
| Research | Hypotheses, findings, validation status |
| Portfolio | Current and historical allocation, exposure, correlation |
| Market | Raw and normalized market data |
| Features | Engineered features used by models |
| Indicators | Computed technical/structural indicators |
| News | Ingested news + sentiment scoring |
| Reflection | Post-trade reflections and lessons |
| Evaluation | Decision-quality scores, benchmark comparisons |
| Agent Health | Heartbeats, latency, error rates per agent |
| Risk | Risk events, limit breaches, CRO decisions |

`13_DATABASE_SCHEMA.md` should turn every row above into an actual schema (tables/collections, fields, types, indexes, retention policy) before implementation starts.

### 7.1 Database Schema Contracts (Enhancement)

#### `trades` (TimescaleDB / PostgreSQL)
```sql
CREATE TABLE trades (
    trade_id UUID PRIMARY KEY,
    strategy_id VARCHAR(50) NOT NULL,
    symbol VARCHAR(20) NOT NULL,
    direction VARCHAR(10) NOT NULL, -- 'LONG' or 'SHORT'
    entry_price DECIMAL(18, 8),
    exit_price DECIMAL(18, 8),
    size DECIMAL(18, 8) NOT NULL,
    leverage INT DEFAULT 1,
    pnl DECIMAL(18, 8),
    status VARCHAR(20), -- 'OPEN', 'CLOSED', 'CANCELLED'
    execution_latency_ms INT,
    slippage_bps DECIMAL(5, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    closed_at TIMESTAMP WITH TIME ZONE
);
CREATE INDEX idx_trades_status_symbol ON trades(status, symbol);
```

#### `risk_events` (PostgreSQL)
```sql
CREATE TABLE risk_events (
    event_id UUID PRIMARY KEY,
    tar_id UUID REFERENCES trades(trade_id),
    decision VARCHAR(10) NOT NULL, -- 'APPROVED', 'REJECTED'
    rule_breached VARCHAR(100),
    rationale TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

#### `knowledge_graph` (Neo4j / Graph DB)
Nodes: `Trade`, `Strategy`, `MarketRegime`, `MacroEvent`, `Lesson`
Edges: `EXECUTED_DURING`, `CAUSED_LIQUIDATION`, `INVALIDATED_BY`, `SUPPORTED_BY`
```cypher
// Example insertion pattern
CREATE (t:Trade {id: "123", pnl: -50.0})
CREATE (r:MarketRegime {type: "high_volatility", funding: "negative"})
CREATE (t)-[:EXECUTED_DURING]->(r)
CREATE (l:Lesson {content: "Trend strategies fail under negative funding during high vol"})
CREATE (t)-[:GENERATED_LESSON]->(l)
```
