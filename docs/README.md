# TradingOS AI — Specification Docs

Companion to `CLAUDE.md` (repo root), which holds the persistent
instruction layer and the safety invariants. This folder is the
supporting long-term context described in
`TradingOS-Engineering-Spec-and-Prompts.md` Section 1.

**Rule for everything in here: these docs describe what the code
actually does.** Where a spec'd capability isn't built, it is marked
`**Status: not implemented**` rather than described as if it exists.
Documentation that flatters the system is worse than no documentation,
because it removes the ability to tell what's real.

## Index

| File | Covers | State |
|---|---|---|
| `12_RISK_ENGINE.md` | Every risk check, the un-overridable leverage ceiling, mandatory stop-loss | Written |
| `19_SAFETY_AND_GOVERNANCE.md` | The six safety invariants and what enforces/tests each | Written |
| `20_DEPLOYMENT_AND_MONITORING.md` | Current ops reality + the watchdog, and an explicit gaps list | Written |
| `00_MASTER_SPEC.md` | Spec Sections 0–3, coverage checklist | Not yet written |
| `01_PROJECT_GOAL.md` | Vision, objective, why no guaranteed-return target | Not yet written |
| `02_ARCHITECTURE.md` | Real architecture, provider tree | Not yet written |
| `03_AI_OPERATING_SYSTEM.md` | Agent OS, lifecycle, contracts | Not yet written |
| `04_AGENT_SPECIFICATIONS.md` | Per-agent contract table | Not yet written |
| `05_TRADING_ENGINE.md` | Tick-to-trade path | Not yet written |
| `06_MARKET_INTELLIGENCE.md` | Indicators, structure, liquidity, flow | Not yet written |
| `07_MEMORY_SYSTEM.md` | Memory/reflection stores + the Supervisor gap | Not yet written |
| `08_LEARNING_SYSTEM.md` | Reflection → hypothesis → human apply | Not yet written |
| `09_SUPERVISOR_AI.md` | Two-tier conflict resolution | Not yet written |
| `10_ROADMAP.md` | Pointer to the two roadmap files + status | Not yet written |
| `11_TRADING_STYLES.md` | Per-strategy template | Not yet written |
| `13_DATABASE_SCHEMA.md` | Real `.data/` stores; Postgres target unwired | Not yet written |
| `14_API_SPECIFICATION.md` | Every `app/api/` route | Not yet written |
| `15_PROMPT_LIBRARY.md` | Every real prompt in the codebase | Not yet written |
| `16_ALGORITHM_LIBRARY.md` | Where each spec'd algorithm lives | Not yet written |
| `17_THINKING_AND_CURIOSITY.md` | Thinking Engine + Curiosity Engine | Not yet written |
| `18_COLLABORATION_PROTOCOL.md` | Second-opinion model protocol | Not yet written |
| `21_CODING_STANDARDS.md` | Conventions + PR checklist | Not yet written |
| `22_TESTING_AND_QA.md` | Test inventory + gaps | Not yet written |
| `23_DASHBOARD_SPEC.md` | UI surfaces | Not yet written |

Until a file exists, `CLAUDE.md` plus the inline comments in the
referenced modules are the authoritative source — this codebase
documents its *why* inline deliberately, so the code is not a poor
second to prose here.
