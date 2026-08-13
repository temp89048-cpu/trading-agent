from backend.core.agent_os import AgentDescriptor, get_agent_os
from backend.api.agents import _tasks, save_tasks
from backend.services.market_data import fetch_prices, get_price, fetch_klines
from backend.services.exchange_provider import get_exchange
from backend.core.message_bus import get_message_bus
from backend.core.agent_engine import agent_tick
from backend.core.risk_manager import validate_trade, calculate_atr, calculate_position_size, compute_stop_loss_take_profit
from backend.services.ai_memory import record_trade
from backend.agents.supervisor_agent import request_trade_authorization
from backend.agents.planner_agent import generate_plan
from backend.api.admin import is_system_paused
import logging

logger = logging.getLogger(__name__)

async def trading_agent_tick(agent_id: str):
    # Fetch latest market data
    await fetch_prices()
    
    for task_id, task in _tasks.items():
        if task.get("status") != "running":
            continue
            
        symbol = task["symbol"]
        price = get_price(symbol)
        
        if price <= 0:
            continue
            
        # 1. Level 7: Planner Agent - Generate a plan if we are in conditional-watch and don't have one
        intended_side = task.get("side", "buy").lower()
        if not task.get("currentEntryPrice") and task.get("mode") == "conditional-watch" and not task.get("execution_plan"):
            klines = await fetch_klines(symbol, "15m", limit=30)
            plan = generate_plan(klines, price, intended_side)
            task["execution_plan"] = plan
            logger.info(f"Task {task_id} generated execution plan: {plan['description']}")
            
        # 2. Evaluate Engine Logic (Checks TP/SL if in trade, or evaluates Plan triggers if not)
        tick_result = agent_tick(task, 0, price)
        
        # 3. If engine says "open", the condition is met. NOW we run the heavy AI gating.
        if tick_result.action == "open" and not task.get("currentEntryPrice"):
            if is_system_paused():
                logger.warning(f"Task {task_id} ignored 'open' signal because SYSTEM IS PAUSED.")
                continue
                
            logger.info(f"Task {task_id} plan condition met. Running pre-trade AI gates...")
            
            # Level 19: Request Authorization from Supervisor AI
            auth_result = await request_trade_authorization(task_id, task, symbol, price, intended_side)
            
            if auth_result["approved"]:
                optimal_qty = auth_result["optimal_qty"]
                tp_sl = auth_result["tp_sl"]
                
                task["ai_receipt"] = auth_result["receipt"]
                
                success = await get_exchange().execute_order(symbol, intended_side, optimal_qty, price)
                if success:
                    task["currentEntryPrice"] = price
                    task["currentQty"] = optimal_qty
                    task["dynamic_tp_price"] = tp_sl["takeProfit"]
                    task["dynamic_sl_price"] = tp_sl["stopLoss"]
                    task["active_strategies"] = task.pop("_pending_strategies", [])
                    save_tasks()
                    logger.info(f"Task {task_id} bought {optimal_qty} {symbol} at {price}. TP: {tp_sl['takeProfit']}, SL: {tp_sl['stopLoss']}")
                    
                    # Level 3 & 20: Event Bus Publish
                    bus = get_message_bus()
                    await bus.publish("TRADE_EXECUTED", {
                        "agent": "TradingAgent",
                        "decision": "APPROVED",
                        "confidence": 100,
                        "reason": ["Supervisor Approved"],
                        "metadata": {"task_id": task_id, "symbol": symbol, "side": intended_side, "qty": optimal_qty, "price": price}
                    })
            else:
                logger.info(f"Task {task_id} blocked by Supervisor: {auth_result.get('reason')}")
                
        elif tick_result.action == "close":
            success = await get_exchange().execute_order(symbol, "sell", tick_result.qty, price)
            if success:
                realized = tick_result.pnl or 0
                task["realizedTotal"] = task.get("realizedTotal", 0) + realized
                task["executedTrades"] = task.get("executedTrades", 0) + 1
                
                logger.info(f"Task {task_id} closed {tick_result.qty} {symbol} at {price}. PnL: ${realized:.2f}")
                
                # Event Bus Publish
                bus = get_message_bus()
                await bus.publish("TRADE_CLOSED", {
                    "agent": "TradingAgent",
                    "decision": "CLOSED",
                    "confidence": 100,
                    "reason": ["Exit Condition Met"],
                    "metadata": {"task_id": task_id, "symbol": symbol, "pnl": realized}
                })
                
                # Level 5: Record to AI Memory
                await record_trade(
                    symbol=symbol,
                    side=task.get("side", "buy"),
                    pnl=realized,
                    reasons=[],
                    active_strategies=task.get("active_strategies", [])
                )
                
                task.pop("currentEntryPrice", None)
                task.pop("currentQty", None)
                task.pop("active_strategies", None)
                task.pop("execution_plan", None) # Clear the plan so a new one generates next trade
                
                if task["executedTrades"] >= task.get("totalTrades", 1):
                    task["status"] = "completed"
                    logger.info(f"Task {task_id} completed all trades.")
                
                save_tasks()
                


def register_trading_agent():
    descriptor = AgentDescriptor(
        id="trading_agent_01",
        name="Main Trading Agent",
        version="1.0.0",
        description="Executes trading tasks autonomously",
        capabilities=["execution", "monitoring"],
        dependencies=[],
        category="execution",
        priority=10,
        tickIntervalMs=3000
    )
    get_agent_os().register(descriptor, trading_agent_tick)
