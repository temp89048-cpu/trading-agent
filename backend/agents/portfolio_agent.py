import logging
from typing import Dict, Any, List
from backend.api.agents import _tasks
from backend.core.agent_base import BaseAgent
from backend.models.events import EventType, BaseEvent

logger = logging.getLogger(__name__)

# Portfolio Constraints
MAX_OPEN_POSITIONS = 3
MAX_DIRECTIONAL_EXPOSURE = 2

def evaluate_portfolio_risk(symbol: str, intended_side: str) -> Dict[str, Any]:
    """
    Level 13: Portfolio Intelligence
    Evaluates the macro risk of the entire portfolio before approving a new trade.
    """
    intended_side = intended_side.lower()
    
    active_positions = []
    
    # Scan all tasks for active open positions
    for task_id, task in _tasks.items():
        if task.get("status") == "running" and task.get("currentEntryPrice"):
            active_positions.append({
                "symbol": task.get("symbol"),
                "side": task.get("side", "buy").lower(),
                "qty": task.get("currentQty")
            })
            
    total_active = len(active_positions)
    
    # 1. Capital Allocation Check (Max Drawdown Protection)
    if total_active >= MAX_OPEN_POSITIONS:
        return {
            "approved": False,
            "reason": f"VETO: Maximum portfolio capital allocation reached ({MAX_OPEN_POSITIONS} open positions).",
            "size_multiplier": 0.0
        }
        
    # 2. Sector / Correlation Exposure Check
    # If we are already heavily exposed to one direction, don't open another highly correlated trade.
    directional_count = sum(1 for p in active_positions if p["side"] == intended_side)
    
    if directional_count >= MAX_DIRECTIONAL_EXPOSURE:
        return {
            "approved": False,
            "reason": f"VETO: Correlation Risk. Portfolio already has {directional_count} active {intended_side.upper()} positions.",
            "size_multiplier": 0.0
        }
        
    # 3. Risk Parity & Diversification Sizing
    # Scale down the position size based on existing portfolio exposure
    size_multiplier = 1.0
    if total_active == 1:
        size_multiplier = 0.75  # 2nd trade gets 75% size
        reason = f"APPROVED with Risk Parity: Scaled size to 75% due to 1 existing open position."
    elif total_active == 2:
        size_multiplier = 0.50  # 3rd trade gets 50% size
        reason = f"APPROVED with Risk Parity: Scaled size to 50% due to 2 existing open positions."
    else:
        reason = "APPROVED: Portfolio is completely empty. Full size allocation granted."
        
    logger.info(f"Portfolio Intelligence for {symbol}: {reason}")
    
    return {
        "approved": True,
        "reason": reason,
        "size_multiplier": size_multiplier
    }

class PortfolioAgent(BaseAgent):
    @property
    def name(self) -> str:
        return "Portfolio Intelligence"

    @property
    def purpose(self) -> str:
        return "Monitors portfolio exposure and correlation risk before allowing trades."

    @property
    def permissions(self) -> List[str]:
        return ["READ_PORTFOLIO"]

    @property
    def inputs(self) -> List[str]:
        return [
            "CONFIDENCE_CALIBRATED events",
            "Open agent tasks via api/agents._tasks (concurrent positions and direction)",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "RISK_EVALUATED events carrying a portfolio-level risk score and warnings",
        ]

    @property
    def category(self) -> str:
        return "risk"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["CONFIDENCE_CALIBRATED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["RISK_EVALUATED"]


    @property
    def responsibilities(self) -> List[str]:
        return ["Execute core duties as assigned."]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus"]

    @property
    def memory_ttl(self) -> str:
        return "Ephemeral (process lifetime)"

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Internal state"]

    @property
    def prompt_reference(self) -> str:
        return "PORTFOLIO_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["None"]

    @property
    def database_tables(self) -> List[str]:
        return ["None"]

    @property
    def metrics_reported(self) -> List[str]:
        return ["Uptime", "Events Processed"]

    @property
    def failure_recovery_strategy(self) -> str:
        return "Restart agent process"

    @property
    def health_status(self) -> str:
        return "Active"


    async def handle_event(self, event: BaseEvent) -> None:
        if event.event_type == "CONFIDENCE_CALIBRATED":
            from backend.models.events import ConfidenceCalibratedEvent, RiskEvaluatedEvent
            if isinstance(event, ConfidenceCalibratedEvent):
                # We mock the intended side as LONG for this pipeline demonstration
                result = evaluate_portfolio_risk(event.symbol, "LONG")
                
                await self.publish(RiskEvaluatedEvent(
                    symbol=event.symbol,
                    risk_score=event.calibrated_confidence * result.get("size_multiplier", 1.0),
                    warnings=[result.get("reason", "")] if not result.get("approved") else []
                ))

def get_portfolio_agent() -> PortfolioAgent:
    return PortfolioAgent()
