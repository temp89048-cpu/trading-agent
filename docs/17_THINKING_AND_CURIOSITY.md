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

## 13. The Thinking Engine

This is what separates TradingOS from a signal-following bot: every single trade decision runs through this full loop, not just an indicator check.

```
Observe → Think → Reason → Debate → Research Memory → Predict
        → Evaluate → Risk → Portfolio → Execution → Monitor
        → Reflect → Learn → Store → Improve
```

For every market update, the agent should explicitly work through:
Observe → Interpret → Reason → Evaluate → Debate → Estimate uncertainty → Estimate probability → Evaluate portfolio impact → Evaluate risk → Evaluate execution → Decide → Monitor → Reflect → Learn → Store → Improve.

## 14. Continuous Monitoring Loop — "The AI Never Sleeps"

Every minute, independent of whether a trade is being considered, the agent should be asking itself:
- What changed?
- What am I missing?
- Is my prediction still valid?
- Is risk increasing?
- Should I reduce leverage?
- Should I exit?
- Should I hedge?
- Should I wait?
- Should I learn something?
- Should I ask another AI?
- Should I ask the user?
- Should I perform research?

## 15. AI Curiosity Engine (the differentiating feature)

**Every hour, it asks itself:**
- What don't I understand?
- What strategy failed today? Why?
- What evidence contradicts my current view?
- Has this happened before?
- What can I simulate to test this?
- What (research/paper/data) should I look at?
- Should I ask another model for a second opinion?
- Should I create a hypothesis?
- Can I verify it?
- Can I improve because of it?

### Concrete Cron Schedules & Triggers (Enhancement)

To implement this practically, we tie these loops to actual background processes:
- **`* * * * *` (Every Minute) - The Monitor Task:** A lightweight Python background worker that scans open positions against current `orderbook` and `funding_rate`. If deviation > threshold, it triggers `EVALUATE_POSITION` event.
- **`0 * * * *` (Hourly) - The Curiosity Task:** A specialized prompt fired every hour. It pulls the last 60 minutes of `Reflections` and `Unrecognized_Patterns` from the Knowledge Graph. It runs an LLM call strictly to generate `Research_Task` payloads.
- **`Event-Triggered` - The Thinking Task:** Only fired upon receiving a `SIGNAL_GENERATED` event to conserve LLM tokens. It orchestrates the Debate -> Risk -> Execution pipeline.
