# Trading OS - Architecture Documentation

## Overview
TradingOS is a fully autonomous, production-ready, High-Frequency Trading (HFT) Agent OS. It utilizes a multi-agent orchestration architecture to evaluate markets across 20 specialized cognitive layers.

## Core Hierarchy

```text
                              User
                               │
                        Chat Interface
                               │
                       Supervisor Agent (Level 19)
                               │
        ┌──────────────────────┼───────────────────────┐
        │                      │                       │
        ▼                      ▼                       ▼
   Market Agent            News Agent            Portfolio Agent
        │                      │                       │
        ▼                      ▼                       ▼
  Structure Agent        Sentiment Agent           Risk Agent
        │                      │                       │
   Execution Agent       Strategy Ensemble       Simulation Agent
```

## System Components

### 1. Event-Driven Message Bus (`message_bus.py`)
All agents communicate asynchronously via a Publish/Subscribe pattern. Messages conform to strict Pydantic JSON schemas.

### 2. Knowledge Graph (`knowledge_graph.py`)
Maps higher-level causal relationships. Instead of treating features independently, the AI understands graph-based implications (e.g. High Funding -> High Liquidation Risk).

### 3. Replay Engine (`replay_engine.py`)
Allows feeding historical kline data directly into the event bus, tricking the OS into believing it is trading live. Used for strategy regression testing.

### 4. Audit Trail (`audit.py`)
An SQLite database that persistently logs:
- Every market condition
- Every prompt sent to the LLM
- The LLM's raw output and confidence
- The final Supervisor decision

### 5. Context Builder (`context_builder.py`)
Prevents token exhaustion by strictly managing the LLM prompt window, pruning irrelevant indicators and long-tail news.

### 6. Admin Controls (`admin.py`)
Provides Human-in-the-Loop HTTP endpoints to `/pause` or trigger an `/emergency-stop`.

## Deployment
The entire OS is containerized via Docker and orchestrated via Docker Compose. Secrets are injected at runtime using AES-encrypted stores (`security.py`).
