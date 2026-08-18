# Risk Boundary: The Three Planes

This document formalizes the boundary between the AI (Cognitive Plane) and the Deterministic Risk engines (Control/Execution Planes), as mandated by Section 36 of the Architecture Spec.

## 1. Cognitive Plane (LangGraph)
**Purpose:** Reasoning, Planning, Research, Strategy, Reflection.
**Contains:** All AI Agents (`Supervisor`, `Debate`, `Market Intelligence`, etc.).
**Rules:**
- May request data at any time.
- May emit a `TradeIntent`.
- **Cannot** directly communicate with exchange APIs.
- **Cannot** place, modify, or cancel orders.
- Operates on probabilities and LLM token generation.

## 2. Control Plane (Deterministic)
**Purpose:** Risk Limits, Configuration, Approvals, Circuit Breakers.
**Contains:** `RiskManager`, `Governance`, `DynamicThresholding`.
**Rules:**
- Receives `TradeIntent` from Cognitive Plane.
- **Must** mathematically calculate position sizing based on equity.
- **Must** enforce correlation limits and max drawdown.
- Uses `LangGraph.interrupt()` if human approval is required.
- **Cannot** be overridden by the Cognitive Plane. If Risk says NO, the trade dies.

## 3. Execution Plane (Deterministic)
**Purpose:** Order routing, partial fills, reconciliation.
**Contains:** `ExecutionManager`, `CCXT Wrapper`.
**Rules:**
- Only accepts `TradeIntent` directly from the Control Plane.
- Must ensure **Idempotency** (uses `decision_id` to prevent double execution if LangGraph resumes from a checkpoint).
- Responsible for latency minimization and slippage tracking.
