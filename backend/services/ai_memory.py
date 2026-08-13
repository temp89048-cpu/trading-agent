import json
import os
import logging
from typing import Dict, Any, List
from backend.agents.reflection_agent import analyze_mistake

logger = logging.getLogger(__name__)

MEMORY_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "ai_memory.json")

def _load_memory() -> Dict[str, Any]:
    if not os.path.exists(MEMORY_FILE):
        return {
            "global_stats": {
                "total_trades": 0,
                "wins": 0,
                "losses": 0,
                "win_rate": 0.0,
                "total_pnl": 0.0
            },
            "assets": {},
            "successful_strategies": {},
            "mistakes": [],
            "trade_ledger": []
        }
    
    try:
        with open(MEMORY_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load AI Memory: {e}")
        return {}

def _save_memory(memory: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(MEMORY_FILE), exist_ok=True)
        with open(MEMORY_FILE, 'w') as f:
            json.dump(memory, f, indent=4)
    except Exception as e:
        logger.error(f"Failed to save AI Memory: {e}")

async def record_trade(symbol: str, side: str, pnl: float, reasons: List[str] = None, active_strategies: List[str] = None) -> None:
    """
    Level 5: AI Memory - Record a closed trade.
    """
    memory = _load_memory()
    if not memory:
        return
        
    is_win = pnl > 0
    
    # 1. Update Global Stats
    stats = memory["global_stats"]
    stats["total_trades"] += 1
    stats["total_pnl"] += pnl
    if is_win:
        stats["wins"] += 1
    else:
        stats["losses"] += 1
        
    stats["win_rate"] = (stats["wins"] / stats["total_trades"]) * 100
    
    # 2. Update Asset Preferences
    if symbol not in memory["assets"]:
        memory["assets"][symbol] = {"trades": 0, "pnl": 0.0}
    memory["assets"][symbol]["trades"] += 1
    memory["assets"][symbol]["pnl"] += pnl
    
    # 3. Update Strategies
    if active_strategies and is_win:
        for strat in active_strategies:
            if strat not in memory["successful_strategies"]:
                memory["successful_strategies"][strat] = 0
            memory["successful_strategies"][strat] += 1
            
    # 4. Record Mistakes and Trigger Level 6 Reflection
    if not is_win:
        mistake = {
            "symbol": symbol,
            "side": side,
            "pnl": pnl,
            "strategies": active_strategies or [],
            "note": "Awaiting Reflection Agent analysis"
        }
        
        # Trigger Reflection Agent
        reflection = await analyze_mistake(mistake)
        mistake["note"] = reflection
        
        memory["mistakes"].append(mistake)
        
    # 5. Ledger
    import datetime
    memory["trade_ledger"].append({
        "timestamp": datetime.datetime.utcnow().isoformat(),
        "symbol": symbol,
        "side": side,
        "pnl": pnl,
        "is_win": is_win,
        "strategies": active_strategies or []
    })
    
    # Keep ledger and mistakes from growing infinitely
    if len(memory["trade_ledger"]) > 1000:
        memory["trade_ledger"] = memory["trade_ledger"][-1000:]
    if len(memory["mistakes"]) > 100:
        memory["mistakes"] = memory["mistakes"][-100:]
        
    _save_memory(memory)
    logger.info(f"AI Memory updated. Win Rate: {stats['win_rate']:.1f}%. Total PnL: ${stats['total_pnl']:.2f}")

def get_memory_stats() -> Dict[str, Any]:
    return _load_memory()

def generate_learning_report() -> Dict[str, Any]:
    """
    Level 17: Learning Dashboard
    Crunches historical trade data into actionable insights.
    """
    memory = _load_memory()
    ledger = memory.get("trade_ledger", [])
    
    if not ledger:
        return {"error": "Not enough data to generate learning report."}
        
    total_trades = len(ledger)
    wins = [t for t in ledger if t["is_win"]]
    losses = [t for t in ledger if not t["is_win"]]
    
    win_rate = (len(wins) / total_trades) * 100 if total_trades > 0 else 0
    
    avg_win = sum(w["pnl"] for w in wins) / len(wins) if wins else 0
    avg_loss = sum(abs(l["pnl"]) for l in losses) / len(losses) if losses else 0
    
    # Expectancy = (Win % * Avg Win) - (Loss % * Avg Loss)
    expectancy = ((len(wins) / total_trades) * avg_win) - ((len(losses) / total_trades) * avg_loss) if total_trades > 0 else 0
    
    # Strategy Performance
    strategy_stats = {}
    for t in ledger:
        for s in t.get("strategies", []):
            if s not in strategy_stats:
                strategy_stats[s] = {"trades": 0, "wins": 0, "pnl": 0.0}
            strategy_stats[s]["trades"] += 1
            strategy_stats[s]["pnl"] += t["pnl"]
            if t["is_win"]:
                strategy_stats[s]["wins"] += 1
                
    for s in strategy_stats:
        strategy_stats[s]["win_rate"] = (strategy_stats[s]["wins"] / strategy_stats[s]["trades"]) * 100
        
    # Sort strategies
    sorted_strats = sorted(strategy_stats.items(), key=lambda x: x[1]["pnl"], reverse=True)
    best_strategies = [{"name": s[0], **s[1]} for s in sorted_strats[:3]]
    worst_strategies = [{"name": s[0], **s[1]} for s in sorted_strats[-3:] if s[1]["pnl"] < 0]
    
    # Calculate Peak and Max Drawdown
    peak = 0
    current = 0
    max_drawdown = 0
    returns = []
    
    for t in ledger:
        current += t["pnl"]
        returns.append(t["pnl"]) # Simple nominal returns for proxy
        if current > peak:
            peak = current
        dd = peak - current
        if dd > max_drawdown:
            max_drawdown = dd
            
    # Calculate Sharpe / Sortino (Proxy using nominal returns, assuming risk_free=0)
    import numpy as np
    
    sharpe_ratio = 0
    sortino_ratio = 0
    if len(returns) > 1:
        mean_return = np.mean(returns)
        std_dev = np.std(returns)
        if std_dev > 0:
            sharpe_ratio = mean_return / std_dev
            
        downside_returns = [r for r in returns if r < 0]
        if len(downside_returns) > 0:
            downside_std = np.std(downside_returns)
            if downside_std > 0:
                sortino_ratio = mean_return / downside_std

    return {
        "total_trades": total_trades,
        "win_rate": win_rate,
        "expectancy_usd": expectancy,
        "average_win": avg_win,
        "average_loss": avg_loss,
        "max_drawdown": max_drawdown,
        "sharpe_ratio": float(sharpe_ratio),
        "sortino_ratio": float(sortino_ratio),
        "best_strategies": best_strategies,
        "worst_strategies": worst_strategies
    }
