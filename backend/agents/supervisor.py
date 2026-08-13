from typing import Dict, Any, List, Optional
from pydantic import BaseModel
from backend.core.risk_manager import validate_trade, RiskValidation

class SupervisorDecision(BaseModel):
    approved: bool
    urgency: str
    reasons: List[str]
    conflict_notes: List[str]
    caution_notes: List[str]
    risk_validation: Optional[RiskValidation] = None

def review_trade_request(request: Dict[str, Any]) -> SupervisorDecision:
    """
    The main execution gate. Coordinates risk rules and cross-agent signals.
    """
    conflict_notes = []
    
    # Resolving conflicts (stub for phase 2)
    debate = request.get("debateRecommendation")
    side = request.get("side")
    blocked_by_debate = None
    
    if side == 'buy' and debate and debate.get("recommendation") == 'SELL':
        if debate.get("compositeConfidencePct", 0) >= 60:
            blocked_by_debate = "Debate System recommends SELL at high confidence."
            
    # Sell/Close is never blocked by Supervisor
    if side == 'sell':
        return SupervisorDecision(
            approved=True,
            urgency="high",
            reasons=[],
            conflict_notes=conflict_notes,
            caution_notes=[]
        )
        
    if blocked_by_debate:
        return SupervisorDecision(
            approved=False,
            urgency="critical",
            reasons=[blocked_by_debate],
            conflict_notes=conflict_notes,
            caution_notes=[]
        )
        
    # Standard Risk Check
    risk = validate_trade(request)
    
    return SupervisorDecision(
        approved=risk.approved,
        urgency="normal" if risk.approved else "critical",
        reasons=risk.rejection_reasons,
        conflict_notes=conflict_notes,
        caution_notes=risk.caution_notes,
        risk_validation=risk
    )
