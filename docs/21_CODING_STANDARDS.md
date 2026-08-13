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

## 20. Engineering Principles

Write production-quality code. No shortcuts, no technical debt, never duplicate logic, composition over inheritance, interfaces over concrete implementations, dependency injection, strongly typed APIs, readable code. Every feature ships with tests, documentation, logging, metrics, configuration, failure handling, and health checks.

### Actionable PR Checklist (Enhancement)
Before any code is merged into `main`, the human or AI reviewer MUST verify:
- [ ] **No Execution API Bypass:** Did this code add a direct HTTP call to Binance/Bybit outside of the Execution Engine? (If yes, REJECT).
- [ ] **No Secret Logging:** Are API keys or secrets dumped in `logger.debug()`? (If yes, REJECT).
- [ ] **Event-Driven:** Does this module directly invoke another module's function, or does it correctly emit an event to the bus?
- [ ] **Test Coverage:** Are there unit tests specifically testing the failure/crash mode of the new logic?
- [ ] **Documentation:** Is the new agent/strategy/algorithm documented in its respective `docs/` spec file?
