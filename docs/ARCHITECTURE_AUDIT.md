# Architecture Audit

## 1. Goal
Audit the existing TradingOS system to assess readiness for the LangGraph migration specified in Phase 23+.

## 2. Current Architecture
The system is currently built as a **Swarm/Asynchronous Event Loop** model. 
- Agents are registered in `backend/core/agent_os.py` via `AgentDescriptor`.
- Agents tick on `tickIntervalMs`.
- Agents communicate via `backend/core/message_bus.py`.
- Trades are authorized by a `SupervisorAgent` which uses `RiskGateway` rules.

## 3. Reusable Components
The following components are highly deterministic and mathematically sound. They **must be reused** and remain outside of LLM reasoning:
- `backend/core/risk_manager.py` (Kelly sizing, Dynamic Risk fractions)
- `backend/algorithms/bayesian_engine.py` (Probability updating)
- `backend/algorithms/dynamic_thresholding.py` (Regime multipliers)
- `backend/services/execution.py` or `ccxt` wrappers (Order placement)
- `backend/services/market_data.py` (Kline fetching)

## 4. Components Requiring Refactoring (Migration to LangGraph)
The following agents currently run on timers but must be converted into **LangGraph Nodes**:
- `debate_agent.py` & `supervisor_agent.py` -> Must become part of the `Trade Decision Graph`.
- `market_intelligence.py` & `regime_agent.py` -> Must become the `Market Intelligence Graph`.
- `reflection_agent.py` -> Must become the `Trade Reflection Graph`.

## 5. Non-LLM Deterministic Zones
- The **Execution Plane** (Order placement, position sizing, risk checks) must NEVER be controlled directly by an LLM.
- LLMs emit *Intents* (e.g. `Intent(LONG, BTCUSDT)`). The Control Plane validates them.
