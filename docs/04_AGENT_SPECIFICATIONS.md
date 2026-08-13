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

## 5. Agent Contract Template

**Every single agent in the system — no exceptions — must be specified with all of these fields before it's built.** This merges the two field-lists from the original planning session (the SRS's "every AI gets…" list and the Master Prompt's "Agent Behavior" list) into one complete contract:

```markdown
### Agent: <name>

**Purpose:** one sentence — what this agent exists to do.
**Responsibilities:** bullet list of what it owns.
**Inputs:** what data/events it consumes.
**Outputs:** what data/events/decisions it produces.
**Dependencies:** which other agents/services it relies on.
**Permissions:** exactly what it is and isn't allowed to do or touch.
**Memory:** what it remembers and for how long.
**Knowledge Sources:** what parts of the Knowledge Graph / DB it reads.
**Prompt:** link to its prompt file in 15_PROMPT_LIBRARY.md.
**APIs:** which internal/external APIs it calls.
**Database:** which tables/collections it reads and writes.
**Metrics:** what it reports for evaluation (Section 3 of the roadmap's
  Evaluation Framework — accuracy, latency, confidence calibration, etc.).
**Failure Recovery:** what happens if it crashes, times out, or returns
  garbage — must degrade safely, never fail silently.
**Events Published:** what it announces to the event bus.
**Events Consumed:** what it listens for.
**Health Status:** how the system checks if this agent is alive and sane.

**Every agent must be able to explain every decision it makes** — this is
non-negotiable and applies even to agents that seem purely mechanical.
```

### 5.1 Fully Implemented Example: Supervisor AI Contract

To demonstrate the required engineering rigor, below is a fully filled-out contract for the Supervisor AI. All future agents must meet this standard of specification before development begins.

```markdown
### Agent: Supervisor AI

**Purpose:** Acts as the orchestration layer to coordinate specialized agents, resolve disagreements, and approve or reject trades after reviewing all evidence before submitting to Risk.
**Responsibilities:**
- Coordinate Market Intelligence and Portfolio agents.
- Resolve conflicting signals (e.g., Market says buy, Portfolio says too much exposure).
- Prioritize tasks based on urgency (e.g., liquidation cascading).
- Produce the final, human-readable explanation for a trading decision.
- Monitor system health and trigger recovery workflows on failure.
**Inputs:** Structured signals from Market Intelligence, Portfolio states, and Debate consensus outputs.
**Outputs:** Formatted Trade Authorization Requests (TAR) sent to the CRO AI, or Research Tasks sent to the Research Agent.
**Dependencies:** Requires Market Intelligence, Portfolio, and Debate agents to be healthy.
**Permissions:** 
  - *Allowed:* Request risk evaluation, request research, pause strategy execution.
  - *Denied:* Cannot execute trades directly, cannot override the CRO, cannot modify production strategy config.
**Memory:** Maintains short-term memory of the current trading session (last 24 hours of debated decisions).
**Knowledge Sources:** Reads the `Strategy Library` and recent `Reflection` logs from the Knowledge Graph.
**Prompt:** `docs/15_PROMPT_LIBRARY.md#supervisor-ai`
**APIs:** Internal `AI Reasoning API`, Internal `Knowledge API`.
**Database:** Reads `Market`, writes `Agent Health` and `Evaluation`.
**Metrics:** Decision latency, consensus accuracy, percentage of trades rejected by CRO (lower is better).
**Failure Recovery:** If the Supervisor crashes, the system defaults to 'Observation Mode' (cancels open limit orders, halts new entries) until manually restarted.
**Events Published:** `Trade_Proposed`, `Agent_Debate_Started`, `Strategy_Paused`.
**Events Consumed:** `Market_Anomaly_Detected`, `Portfolio_Update`, `Debate_Concluded`.
**Health Status:** Evaluated via a 10-second heartbeat check and semantic validation of its last 5 TAR outputs.

**Explanation Mandate:** The Supervisor AI must attach a plain-text `rationale` field to every `Trade_Proposed` event detailing exactly which agents it listened to and why it ignored opposing signals.
```
