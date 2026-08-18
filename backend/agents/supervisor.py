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
    """DO NOT USE. Raises. The real gate is `agents/supervisor_agent.py`.

    This module is a SECOND, WEAKER implementation of the execution gate that
    nothing calls. It was found with zero callers during a dead-code audit, and
    it is kept only so that this warning exists where someone would look.

    Wiring it up would bypass every control the real Supervisor enforces. It has
    none of:

      * the un-overridable leverage ceiling (`max_leverage_ceiling`) — it never
        looks at leverage at all;
      * the mandatory stop-loss check (CLAUDE.md invariant 3) — it cannot
        produce a stop, so a position opened through it would have none;
      * the CIO's correlated-exposure cap;
      * the operator kill switch (`may_open_new_position`);
      * refusal on missing inputs — its `validate_trade` call passes whatever
        dict it was handed, so absent equity or candles simply skip checks.

    Its `side == 'sell'` branch also returns `approved=True` unconditionally
    before any risk evaluation. That is correct for CLOSING a position
    (invariant 4: exits are never blocked) but this function cannot distinguish
    a close from OPENING a short — so routing shorts through it would approve
    them with no checks whatsoever.

    Raising is deliberate rather than deleting the file: a deleted duplicate
    teaches nobody, and the same shortcut gets rebuilt. A loud failure at the
    moment of misuse is the useful outcome.
    """
    raise NotImplementedError(
        "agents/supervisor.py::review_trade_request is a dead, weaker duplicate of the "
        "execution gate and must not be used. Route trade authorization through "
        "agents/supervisor_agent.py (SupervisorAgent, or request_trade_authorization for the "
        "task-based path), which enforces the leverage ceiling, the mandatory stop-loss, the "
        "correlated-exposure cap and the operator kill switch. See this function's docstring."
    )


def _unused_original_implementation(request: Dict[str, Any]) -> SupervisorDecision:
    """The original body, preserved unreachable for reference only.

    Kept so the docstring above can be checked against what this actually did,
    rather than asking a reader to trust a summary of deleted code.
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
