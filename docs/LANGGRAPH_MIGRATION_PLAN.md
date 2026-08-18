# LangGraph Migration Plan

## Principle: Multiple Graphs, Not One Giant Graph
We will migrate the existing async swarm into 7 discrete, purpose-built LangGraphs.

### Graph 1: Market Intelligence Graph
**Trigger:** Market Event (Price spike, volume anomaly, scheduled tick)
**Flow:** `Market Event -> Validation -> Feature Extraction -> Regime -> Market Analysis -> Market State`
**Output:** Updated `TradingState` stored in memory.

### Graph 2: Trade Decision Graph
**Trigger:** Favorable Market State
**Flow:** `Market State -> Strategy Selection -> Opportunity -> Specialists -> Debate -> Supervisor -> Risk Gateway`
**Output:** `TradeIntent` passed to Control Plane.

### Graph 3: Execution Graph (Deterministic)
**Trigger:** Approved `TradeIntent`
**Flow:** `Execution Request -> Risk Validation -> Order Manager -> Exchange -> Confirmation`

### Graph 4: Position Monitoring Graph
**Trigger:** Open Position Tick
**Flow:** `Position -> Monitor -> Risk -> Market Change -> Hold / Reduce / Exit`

### Graph 5: Reflection Graph
**Trigger:** Trade Closed
**Flow:** `Trade Closed -> Context -> Outcome -> Reflection -> Lesson -> Memory`

### Graph 6: Research Graph
**Trigger:** User query or Curiosity Engine
**Flow:** `Question -> Research -> Hypothesis -> Experiment -> Backtest -> Validation -> Candidate`

### Graph 7: Learning Graph
**Trigger:** Meta-Learning tick
**Flow:** `Evidence -> Pattern -> Hypothesis -> Validation -> Knowledge Update`

## Persistent Checkpointing
The system will use a `PostgresSaver` or `RedisSaver` (not memory) to persist state across server restarts. `thread_id` will be mapped logically (e.g., one thread per open position for monitoring).
