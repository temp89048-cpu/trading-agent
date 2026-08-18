import logging
from typing import Dict, Any, List
from backend.agents.backtest_agent import run_backtest

logger = logging.getLogger(__name__)

def optimize_strategy(symbol: str, strategy_name: str, klines: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Level 12: Strategy Optimizer
    Runs a grid search over historical data to find the mathematically optimal parameters.
    """
    logger.info(f"Starting Strategy Optimization for {strategy_name} on {symbol}...")
    
    # Define Parameter Grid
    ema_lengths = [20, 50, 100]
    rsi_thresholds = [20, 30, 40]
    tp_pcts = [2.0, 5.0, 10.0]
    sl_pcts = [1.0, 2.0, 5.0]
    
    best_profit_factor = -1.0
    best_params = {}
    best_result = {}
    
    total_combinations = len(ema_lengths) * len(rsi_thresholds) * len(tp_pcts) * len(sl_pcts)
    count = 0
    
    for ema in ema_lengths:
        for rsi in rsi_thresholds:
            for tp in tp_pcts:
                for sl in sl_pcts:
                    count += 1
                    
                    # Silence the backtester logs during optimization
                    # run_backtest already logs the formatted string, but we want to ignore it
                    # (in production, we'd pass a quiet flag)
                    
                    result = run_backtest(
                        symbol=symbol,
                        strategy_name=strategy_name,
                        klines=klines,
                        ema_length=ema,
                        rsi_threshold=rsi,
                        tp_pct=tp,
                        sl_pct=sl
                    )
                    
                    if "error" in result:
                        continue
                        
                    pf = result["profit_factor"]
                    
                    # We want a positive profit factor and at least 5 trades to avoid overfitting
                    if pf > best_profit_factor and result["trades"] >= 5:
                        best_profit_factor = pf
                        best_params = {
                            "ema_length": ema,
                            "rsi_threshold": rsi,
                            "tp_pct": tp,
                            "sl_pct": sl
                        }
                        best_result = result
                        
    if not best_params:
        return {"error": "Failed to find a profitable parameter combination."}
        
    formatted_output = (
        f"Optimization Complete for {symbol} ({strategy_name})!\n"
        f"Best Profit Factor: {best_profit_factor:.2f}\n"
        f"Optimal Parameters:\n"
        f"  - EMA Length:    {best_params['ema_length']}\n"
        f"  - RSI Threshold: {best_params['rsi_threshold']}\n"
        f"  - Take Profit:   {best_params['tp_pct']}%\n"
        f"  - Stop Loss:     {best_params['sl_pct']}%\n"
    )
    
    logger.info(f"\n{formatted_output}")
    
    return {
        "best_profit_factor": best_profit_factor,
        "best_params": best_params,
        "best_metrics": best_result,
        "formatted_output": formatted_output
    }


# ---------------------------------------------------------------------------
# UNWIRED — zero callers, and it must stay that way until a human gate exists.
#
# `optimize_strategy` searches strategy parameters for better historical
# performance. Wiring its output into live strategy configuration would BE spec
# Section 12's forbidden path:
#
#     Loss -> AI rewrites strategy -> Live Trading
#
# An optimizer is not dangerous because it is wrong; it is dangerous because it
# is persuasive. It reliably finds parameters that would have worked on the data
# it was given, which is overfitting with a confidence figure attached.
#
# The legitimate route already exists: run it as RESEARCH, record the result as a
# hypothesis via `services/research_store.add_hypothesis` (status 'proposed'),
# and let a human validate and apply it through
# POST /api/research/hypotheses/{id}/status. Until it is called that way it stays
# unwired, and `tests/test_learning_pipeline.py` asserts no learning module can
# import anything that writes trading configuration.
# ---------------------------------------------------------------------------
