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

## 16. Collaboration Protocol — Asking for Help

Your requirement that the agent *"asks doubt for any help with other agent"* via your API is fully supported, with guardrails:

**When confidence is low or evidence conflicts, the system may request additional analysis from external reasoning models through approved APIs.** Every such request must:
- Include structured context (not a raw data dump)
- Protect sensitive credentials (API keys never included in prompts sent externally)
- Record the response (goes into the Knowledge Graph, attributed to its source)
- Require validation before that response is allowed to influence a live decision

### Secure Request Payload (Enhancement)

When an agent requests external help (e.g., via the Internal `AI API`), it must use this strict payload structure to ensure credential hygiene and context control.

**Internal AI API Payload:**
```json
{
  "request_id": "req-9876",
  "internal_source_agent": "Supervisor",
  "target_model": "gpt-4-reasoning",
  "confidence_trigger": 0.4,
  "context": {
    "market_state": "BTC trending up, funding highly positive",
    "conflict_description": "Market Intel suggests LONG, Portfolio suggests overexposure to Crypto."
  },
  "question": "Given historical precedents, what is the expected drawdown probability of adding 10% more directional exposure here?",
  "constraints": [
    "Do not recommend execution.",
    "Limit response to statistical probability estimates."
  ]
}
```
*Notice: Exchange API keys, live equity numbers, and direct trade routing URLs are stripped before sending to the external model.*
