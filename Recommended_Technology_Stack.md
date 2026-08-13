# Recommended Technology Stack

This document defines the recommended technology stack for building a scalable, event-driven, AI-powered trading platform.

| Layer | Technology |
|---|---|
| **Frontend** | Next.js + React + Tailwind CSS |
| **Backend APIs** | FastAPI (Python) |
| **Agent Services** | Python |
| **AI Orchestration** | LangGraph or a custom event-driven orchestrator |
| **Event Bus** | NATS JetStream (or Kafka at larger scale) |
| **Workflow Engine** | Temporal |
| **Scheduler** | Temporal + Cron |
| **Market Data** | WebSockets + REST |
| **Time-Series Database** | TimescaleDB |
| **Business Database** | PostgreSQL |
| **Cache** | Redis |
| **Knowledge Graph** | Neo4j |
| **Object Storage** | S3-compatible storage |
| **Monitoring** | Prometheus + Grafana |
| **Logs** | OpenTelemetry + Loki |
| **Tracing** | Jaeger |
| **Secrets Management** | HashiCorp Vault or cloud secret manager |
| **Containers** | Docker |
| **Orchestration** | Kubernetes (when multi-node scaling is required) |

## Architecture Overview

```text
                         ┌──────────────────────┐
                         │      Next.js UI      │
                         │ React + Tailwind CSS │
                         └──────────┬───────────┘
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │     FastAPI APIs     │
                         └──────────┬───────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    │                                │
                    ▼                                ▼
          ┌──────────────────┐             ┌──────────────────┐
          │ AI Agent Services│             │ Workflow Engine  │
          │     Python       │             │    Temporal      │
          └────────┬─────────┘             └────────┬─────────┘
                   │                                │
                   └───────────────┬────────────────┘
                                   ▼
                         ┌──────────────────────┐
                         │    Event Bus         │
                         │   NATS JetStream     │
                         │   / Kafka            │
                         └──────────┬───────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
    ┌───────────────┐      ┌────────────────┐      ┌────────────────┐
    │ Market Data   │      │ Trading Agents │      │ Risk Management│
    │ WS + REST     │      │    Python      │      │     Agents     │
    └───────┬───────┘      └───────┬────────┘      └───────┬────────┘
            │                       │                       │
            └───────────────────────┼───────────────────────┘
                                    │
             ┌──────────────────────┼──────────────────────┐
             │                      │                      │
             ▼                      ▼                      ▼
      ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
      │ TimescaleDB │       │ PostgreSQL  │       │    Redis    │
      │ Market Data │       │ Business DB │       │    Cache    │
      └─────────────┘       └─────────────┘       └─────────────┘
                                    │
                                    ▼
                            ┌──────────────┐
                            │    Neo4j     │
                            │ Knowledge    │
                            │    Graph     │
                            └──────────────┘


     ┌─────────────────────────────────────────────────────────┐
     │              Observability & Operations                 │
     │                                                         │
     │ Prometheus │ Grafana │ OpenTelemetry │ Loki │ Jaeger   │
     └─────────────────────────────────────────────────────────┘

     ┌─────────────────────────────────────────────────────────┐
     │                 Infrastructure                          │
     │                                                         │
     │ Docker │ Kubernetes │ S3 │ Vault / Cloud Secrets       │
     └─────────────────────────────────────────────────────────┘
```

## Technology Responsibilities

### 1. Frontend

**Next.js + React + Tailwind CSS**

Responsibilities:

- Trading dashboard
- Portfolio monitoring
- Positions and orders
- Agent status
- Risk dashboard
- Strategy configuration
- Backtesting interface
- Performance analytics
- System health monitoring

---

### 2. Backend APIs

**FastAPI**

Responsibilities:

- REST APIs
- WebSocket APIs
- Authentication and authorization
- Trading operations
- Portfolio operations
- Strategy management
- Agent management
- Backtest APIs
- Configuration management

---

### 3. Agent Services

**Python**

Python services will contain the core AI and trading agents.

Possible agents:

- Market Analysis Agent
- Technical Analysis Agent
- Sentiment Agent
- News Intelligence Agent
- Strategy Agent
- Risk Agent
- Portfolio Agent
- Execution Agent
- Performance Agent
- Learning/Optimization Agent

Agents should communicate through events rather than tightly coupled direct calls wherever practical.

---

### 4. AI Orchestration

**LangGraph or Custom Event-Driven Orchestrator**

Use LangGraph when:

- Agent workflows require state
- Agents need conditional routing
- Human approval may be required
- Complex multi-agent reasoning is needed
- Agent execution needs checkpoints

Use a custom event-driven orchestrator when:

- Low latency is critical
- Workflows are deterministic
- Trading execution must not depend on an LLM
- High-throughput event processing is required

**Important:** AI agents should recommend decisions, while deterministic risk and execution systems should enforce trading rules.

---

### 5. Event Bus

**NATS JetStream**

Recommended for the initial architecture because it provides:

- Low latency
- Pub/sub messaging
- Persistent streams
- Event replay
- Consumer groups
- Lightweight infrastructure

Example events:

```text
market.price.updated
market.orderbook.updated
market.trade.executed
signal.generated
signal.validated
risk.check.requested
risk.check.completed
order.created
order.submitted
order.filled
order.rejected
position.updated
portfolio.updated
strategy.started
strategy.stopped
agent.completed
```

For very large-scale deployments, **Kafka** can replace or supplement NATS.

---

### 6. Workflow Engine

**Temporal**

Use Temporal for long-running and reliable workflows.

Examples:

```text
TradingWorkflow
BacktestWorkflow
StrategyOptimizationWorkflow
PortfolioRebalanceWorkflow
RiskMonitoringWorkflow
DataIngestionWorkflow
ModelEvaluationWorkflow
```

Temporal should handle:

- Retries
- Timeouts
- Workflow state
- Failure recovery
- Scheduled execution
- Long-running processes

---

### 7. Scheduler

**Temporal + Cron**

Use scheduling for:

- Periodic market analysis
- Strategy evaluation
- Model evaluation
- Portfolio checks
- Daily reports
- Data synchronization
- System health checks

---

### 8. Market Data

**WebSockets + REST**

Use WebSockets for real-time data:

```text
Ticker
Trades
Order Book
Candles
Liquidations
Funding Rate
Open Interest
```

Use REST APIs for:

- Historical data
- Account information
- Order management
- Exchange configuration
- Recovery/resynchronization

---

### 9. Time-Series Database

**TimescaleDB**

Use TimescaleDB for high-volume time-series data.

Examples:

```text
OHLCV candles
Tick data
Order book snapshots
Trades
Funding rates
Open interest
Indicators
Signals
Market metrics
```

TimescaleDB is built on PostgreSQL, allowing SQL-based analytics while providing time-series optimizations.

---

### 10. Business Database

**PostgreSQL**

Store application and transactional data.

Examples:

```text
Users
Accounts
Exchanges
API configurations
Strategies
Orders
Positions
Trades
Risk settings
Agent configurations
Workflow metadata
System configuration
```

---

### 11. Cache

**Redis**

Use Redis for:

- Real-time state
- Frequently accessed data
- Rate limiting
- Distributed locks
- Session data
- Temporary calculations
- Agent state
- Fast market-data access

Redis should not be treated as the permanent source of truth for trading records.

---

### 12. Knowledge Graph

**Neo4j**

Use Neo4j when relationships between entities become important.

Example:

```text
Asset
  ↓
Sector
  ↓
Market Event
  ↓
News
  ↓
Sentiment
  ↓
Trading Signal
  ↓
Strategy
  ↓
Trade
```

Potential use cases:

- Asset relationships
- Event relationships
- News relationships
- Strategy knowledge
- Historical decision relationships
- Agent reasoning context

---

### 13. Object Storage

**S3-Compatible Storage**

Use object storage for large, immutable files.

Examples:

```text
Historical datasets
Backtest results
Agent reports
Model artifacts
Training datasets
Logs/archives
Exported reports
```

Possible implementations:

- AWS S3
- Cloudflare R2
- MinIO
- Oracle Object Storage
- Other S3-compatible providers

---

### 14. Monitoring

**Prometheus + Grafana**

Prometheus collects metrics such as:

```text
CPU usage
Memory usage
API latency
Event processing latency
Order latency
Trading volume
Agent execution time
Error rates
Database performance
WebSocket connection status
```

Grafana provides dashboards for visualization.

---

### 15. Logging

**OpenTelemetry + Loki**

Use structured logging.

Example:

```json
{
  "timestamp": "2026-08-10T15:30:00Z",
  "service": "execution-agent",
  "event": "order_submitted",
  "symbol": "ETHUSDT",
  "side": "BUY",
  "quantity": 0.01,
  "latency_ms": 42
}
```

Loki stores and queries logs efficiently.

---

### 16. Distributed Tracing

**Jaeger + OpenTelemetry**

Tracing allows a single operation to be followed across services.

Example:

```text
Market Event
     ↓
Analysis Agent
     ↓
Signal Agent
     ↓
Risk Agent
     ↓
Execution Agent
     ↓
Exchange
```

This makes it possible to identify where latency or failures occur.

---

### 17. Secrets Management

**HashiCorp Vault or Cloud Secret Manager**

Never store exchange API keys directly in:

```text
Source code
GitHub
Docker images
Frontend code
Plain-text configuration files
```

Store secrets in:

```text
Vault
AWS Secrets Manager
Google Secret Manager
Azure Key Vault
Oracle Cloud Vault
```

---

### 18. Containers

**Docker**

Every service should be independently containerized.

Example:

```text
frontend
api
agent-market
agent-strategy
agent-risk
agent-execution
temporal
nats
redis
postgres
timescaledb
neo4j
prometheus
grafana
loki
jaeger
```

Docker provides consistent development, testing, and deployment environments.

---

### 19. Orchestration

**Kubernetes**

Kubernetes should be introduced when the platform requires:

- Multiple servers
- Horizontal scaling
- High availability
- Automatic service recovery
- Rolling deployments
- Service discovery
- Resource isolation

For the initial version, Kubernetes may be unnecessary.

A simpler deployment can be:

```text
Docker Compose
      ↓
Single VPS / Cloud VM
      ↓
PostgreSQL
Redis
NATS
FastAPI
Python Agents
Next.js
```

Then migrate to Kubernetes when actual scaling requirements justify it.

---

# Recommended Deployment Evolution

## Phase 1 — Development

```text
Next.js
FastAPI
Python Agents
PostgreSQL
Redis
Docker Compose
```

## Phase 2 — Production MVP

```text
Next.js
FastAPI
Python Agents
NATS JetStream
PostgreSQL
TimescaleDB
Redis
Temporal
Docker
Cloud VM
```

## Phase 3 — Advanced Platform

```text
Next.js
FastAPI
Multiple Agent Services
LangGraph
NATS JetStream
Temporal
PostgreSQL
TimescaleDB
Redis
Neo4j
S3
Prometheus
Grafana
OpenTelemetry
Loki
Jaeger
Docker
```

## Phase 4 — Large-Scale Infrastructure

```text
                    Kubernetes
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   API Services      Agent Services    Workflows
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                    NATS / Kafka
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
   PostgreSQL       TimescaleDB          Redis
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
              S3 + Neo4j + Observability
```

# Core Architectural Principle

The architecture should separate **AI decision-making** from **deterministic trading execution**.

```text
AI / Agents
    │
    │ Recommendation
    ▼
Strategy Engine
    │
    ▼
Risk Engine
    │
    │ Approved
    ▼
Execution Engine
    │
    ▼
Exchange
```

The AI should **never be the final authority for risk limits, position sizing constraints, or order safety checks**.

Deterministic systems should enforce:

- Maximum position size
- Maximum daily loss
- Maximum leverage
- Maximum exposure
- Stop-loss rules
- Take-profit rules
- Order validation
- Duplicate-order prevention
- Exchange/API failure handling
- Circuit breakers
- Emergency shutdown