from typing import Dict, Any, Optional
from pydantic import BaseModel

class AgentTickResult(BaseModel):
    action: str  # 'none', 'stage', 'open', 'close', 'complete'
    qty: Optional[float] = None
    price: Optional[float] = None
    marginUsed: Optional[float] = None
    entryPrice: Optional[float] = None
    pnl: Optional[float] = None
    planStage: Optional[str] = None
    patch: Optional[Dict[str, Any]] = None

def compute_live_unrealized_pnl(entry: float, qty: float, live_price: float, side: str) -> Dict[str, float]:
    sign = 1 if side == 'buy' else -1
    pnl = (live_price - entry) * qty * sign
    pct_move = 0.0
    if entry > 0:
        pct_move = sign * ((live_price - entry) / entry) * 100
    return {"pnl": pnl, "pctMove": pct_move}

def agent_tick(
    task: Dict[str, Any],
    now: float,
    live_price: Optional[float],
    vol_ctx: Optional[Dict[str, Any]] = None,
    thesis: Optional[Dict[str, Any]] = None
) -> AgentTickResult:
    """
    Evaluates what a task should do right now given current price.
    This replaces components/Agent.tsx tick loop.
    """
    if task.get("status") != "running":
        return AgentTickResult(action="none")
        
    if task.get("executedTrades", 0) >= task.get("totalTrades", 1):
        return AgentTickResult(action="complete")
        
    if not live_price or live_price <= 0:
        return AgentTickResult(action="none")
        
    # Check if there is an open position for this task
    entry_price = task.get("currentEntryPrice")
    qty = task.get("currentQty")
    if entry_price and qty:
        # We are currently in a position. Check for exit conditions.
        pnl_stats = compute_live_unrealized_pnl(entry_price, qty, live_price, task.get("side", "buy"))
        
        # Dynamic TP/SL Check (Level 3 Risk Intelligence)
        tp_price = task.get("dynamic_tp_price")
        sl_price = task.get("dynamic_sl_price")
        
        # If they aren't set, fallback to 5% / 2%
        if not tp_price or not sl_price:
            tp_pct = task.get("tpPercent", 5.0)
            sl_pct = task.get("slPercent", 2.0)
            side = task.get("side", "buy")
            if side == "buy":
                tp_price = entry_price * (1 + (tp_pct / 100))
                sl_price = entry_price * (1 - (sl_pct / 100))
            else:
                tp_price = entry_price * (1 - (tp_pct / 100))
                sl_price = entry_price * (1 + (sl_pct / 100))
                
        side = task.get("side", "buy")
        if side == "buy":
            if live_price >= tp_price or live_price <= sl_price:
                return AgentTickResult(action="close", qty=qty, price=live_price, pnl=pnl_stats["pnl"])
        else:
            if live_price <= tp_price or live_price >= sl_price:
                return AgentTickResult(action="close", qty=qty, price=live_price, pnl=pnl_stats["pnl"])
                
        # Continues holding
        return AgentTickResult(action="none")

    mode = task.get("mode", "take-profit")
    if mode == "interval":
        next_run = task.get("nextRunAt")
        if next_run and now < next_run:
            return AgentTickResult(action="none")
        return AgentTickResult(action="open", price=live_price)
        
    if mode == "take-profit" or mode == "conditional-watch":
        # Level 7: Planner Agent evaluation
        if mode == "conditional-watch":
            plan = task.get("execution_plan")
            if plan:
                p_type = plan.get("type")
                target = plan.get("target_price")
                if p_type == "price_cross_above" and target:
                    if live_price < target:
                        return AgentTickResult(action="none")
                elif p_type == "price_cross_below" and target:
                    if live_price > target:
                        return AgentTickResult(action="none")
                        
        # Condition met (or immediate mode), trigger entry evaluation.
        # This will be called by trading_agent_tick and gated by Sentiment/Debate.
        return AgentTickResult(action="open", price=live_price)

    return AgentTickResult(action="none")
