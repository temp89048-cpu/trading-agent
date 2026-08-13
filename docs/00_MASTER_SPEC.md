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

## 1. Why One Prompt Isn't Enough

A single prompt can start a coding agent, but it can't hold the persistent, structured context a project like this needs across hundreds of sessions. The recommended approach is a proper **Software Requirements Specification (SRS)** — the kind of internal engineering blueprint used at serious AI/quant engineering orgs — that Claude Code or Codex reads as permanent project context, with a **Master System Prompt** on top of it to set behavior. This document gives you both: the full specification content, and the ready-to-paste prompts (Section 22–23).

### Recommended `docs/` folder structure

```
docs/
  00_MASTER_SPEC.md              — this document's Sections 0–3
  01_PROJECT_GOAL.md             — Section 0 (vision, objective, principles)
  02_ARCHITECTURE.md             — Section 21 (architecture principles)
  03_AI_OPERATING_SYSTEM.md      — Section 5 (org hierarchy, event bus)
  04_AGENT_SPECIFICATIONS.md     — Section 6 (agent contract template, filled per agent)
  05_TRADING_ENGINE.md           — Section 7 (workflows) + Section 20 (execution)
  06_MARKET_INTELLIGENCE.md      — market analysis scope (Section 6 of prior roadmap)
  07_MEMORY_SYSTEM.md            — Section 8 (databases) + knowledge graph
  08_LEARNING_SYSTEM.md          — Section 13 (self-learning pipeline)
  09_SUPERVISOR_AI.md            — debate + decision arbitration logic
  10_ROADMAP.md                  — your existing Phase 21–100 roadmap
  11_TRADING_STYLES.md           — Section 12 (full strategy library)
  12_RISK_ENGINE.md              — risk rules, leverage ceilings, CRO veto logic
  13_DATABASE_SCHEMA.md          — Section 8, expanded into real table schemas
  14_API_SPECIFICATION.md        — Section 9, expanded into endpoint contracts
  15_PROMPT_LIBRARY.md           — Section 10 + Sections 22–23, all prompts in one place
  16_ALGORITHM_LIBRARY.md        — Section 11
  17_THINKING_AND_CURIOSITY.md   — Sections 14–16
  18_COLLABORATION_PROTOCOL.md   — Section 17 (ask-for-help via API)
  19_SAFETY_AND_GOVERNANCE.md    — Section 21 (safety principles) + human oversight
  20_DEPLOYMENT_AND_MONITORING.md— infra, observability, alerting
  21_CODING_STANDARDS.md         — engineering principles, review checklist
  22_TESTING_AND_QA.md           — test strategy, walk-forward validation gates
  23_DASHBOARD_SPEC.md           — executive dashboard requirements
```
*(The original plan only sketched `00`–`10` with "…" — `11`–`23` above complete that list so every topic in this document has a home.)*

---

## 2. What the Full Specification Must Cover (master checklist)

- [ ] Complete project vision and mission statement
- [ ] Engineering principles
- [ ] Folder / repository architecture
- [ ] Every AI agent (contract, not just a name)
- [ ] Every API
- [ ] Every database / schema
- [ ] Every workflow (event-to-event, tick-to-trade)
- [ ] Every event on the event bus
- [ ] Every prompt (system, planner, debate, reflection, per-agent)
- [ ] Every memory store
- [ ] Every model in use (and why)
- [ ] Every risk rule
- [ ] Every trading style
- [ ] Every strategy
- [ ] Every learning algorithm
- [ ] Every evaluation metric
- [ ] Every dashboard
- [ ] Every deployment requirement
- [ ] Every monitoring requirement
- [ ] Every safety requirement
- [ ] Every coding standard

Everything below either fills in one of these checkboxes directly, or is a template the coding agent fills in per-module as it builds.
