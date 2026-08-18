# Agent Registry

This registry maps our existing Swarm agents to their future LangGraph Nodes.

## Cognitive Plane Agents
| Agent | Current File | LangGraph Destination |
|-------|--------------|-----------------------|
| Event Agent | `event_agent.py` | Market Intelligence Graph (Trigger Node) |
| Regime Agent | `regime_agent.py` | Market Intelligence Graph (Node) |
| Market Intelligence | `market_intelligence.py` | Market Intelligence Graph (Node) |
| Strategy Ensemble | `strategy_ensemble.py` | Trade Decision Graph (Strategy Selection Node) |
| Debate Agent | `debate_agent.py` | Trade Decision Graph (Debate Node) |
| Supervisor Agent | `supervisor_agent.py` | Trade Decision Graph (Supervisor Node) |
| Reflection Agent | `reflection_agent.py` | Reflection Graph (Node) |
| Research Agent | `research_agent.py` | Research Graph (Node) |
| Portfolio Agent | `portfolio_agent.py` | Position Monitoring Graph (Node) |
| Sentiment Agent | `sentiment_agent.py` | Market Intelligence Graph (Node) |

## Control Plane (Deterministic)
| Component | Current File | Destination |
|-----------|--------------|-------------|
| Risk Manager | `risk_manager.py` | Risk Gateway (Control Plane) |
| Auth/Security | `auth.py`, `security.py`| Governance Gateway |

## Execution Plane (Deterministic)
| Component | Current File | Destination |
|-----------|--------------|-------------|
| Execution Agent | `execution_agent.py` | Execution Graph |
| Exchange Agent | `exchange_agent.py` | Execution Graph |
