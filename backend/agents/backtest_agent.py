import logging
from typing import Dict, Any, List
from datetime import datetime

logger = logging.getLogger(__name__)

def calculate_ema(prices: List[float], period: int) -> List[float]:
    if not prices:
        return []
    ema = [prices[0]]
    multiplier = 2 / (period + 1)
    for price in prices[1:]:
        ema.append((price - ema[-1]) * multiplier + ema[-1])
    return ema

def calculate_rsi(prices: List[float], period: int = 14) -> List[float]:
    if len(prices) < period + 1:
        return [50] * len(prices)
        
    rsi = [50] * period
    gains = []
    losses = []
    
    for i in range(1, period + 1):
        change = prices[i] - prices[i - 1]
        gains.append(max(0, change))
        losses.append(max(0, -change))
        
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period
    
    if avg_loss == 0:
        rsi.append(100)
    else:
        rs = avg_gain / avg_loss
        rsi.append(100 - (100 / (1 + rs)))
        
    for i in range(period + 1, len(prices)):
        change = prices[i] - prices[i - 1]
        gain = max(0, change)
        loss = max(0, -change)
        
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        
        if avg_loss == 0:
            rsi.append(100)
        else:
            rs = avg_gain / avg_loss
            rsi.append(100 - (100 / (1 + rs)))
            
    return rsi

def run_backtest(
    symbol: str, 
    strategy_name: str, 
    klines: List[Dict[str, Any]],
    ema_length: int = 20,
    rsi_length: int = 14,
    rsi_threshold: int = 30,
    tp_pct: float = 5.0,
    sl_pct: float = 2.0
) -> Dict[str, Any]:
    """
    Level 11: Backtesting Agent
    Simulates a strategy over historical klines and returns metrics.
    Supports dynamic parameters for optimization.
    """
    if not klines or len(klines) < 50:
        return {"error": "Not enough data for backtest."}
        
    closes = [k['close'] for k in klines]
    
    # Calculate indicators
    ema_val = calculate_ema(closes, ema_length)
    rsi_val = calculate_rsi(closes, rsi_length)
    
    in_trade = False
    entry_price = 0.0
    
    trades = 0
    wins = 0
    gross_profit = 0.0
    gross_loss = 0.0
    
    peak_equity = 10000.0
    current_equity = 10000.0
    max_drawdown_pct = 0.0
    
    for i in range(20, len(closes)):
        price = closes[i]
        
        # Dynamic EMA + RSI Logic
        if not in_trade:
            if closes[i] > ema_val[i] and rsi_val[i] < rsi_threshold: # Buy signal
                in_trade = True
                entry_price = price
        else:
            # Sell signal
            if price >= entry_price * (1 + (tp_pct / 100)) or price <= entry_price * (1 - (sl_pct / 100)):
                in_trade = False
                trades += 1
                
                pnl = price - entry_price
                if pnl > 0:
                    wins += 1
                    gross_profit += pnl
                else:
                    gross_loss += abs(pnl)
                    
                # Update equity curve
                pnl_pct = pnl / entry_price
                current_equity *= (1 + pnl_pct)
                
                if current_equity > peak_equity:
                    peak_equity = current_equity
                    
                drawdown = (peak_equity - current_equity) / peak_equity
                if drawdown > max_drawdown_pct:
                    max_drawdown_pct = drawdown
                    
    win_rate = (wins / trades * 100) if trades > 0 else 0
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (99.9 if gross_profit > 0 else 0)
    
    start_time = datetime.fromtimestamp(klines[0]['timestamp'] / 1000).strftime('%Y-%m-%d')
    end_time = datetime.fromtimestamp(klines[-1]['timestamp'] / 1000).strftime('%Y-%m-%d')
    period_str = f"{start_time} to {end_time}"
    
    formatted_output = (
        f"Strategy:          {strategy_name}\n"
        f"Asset:             {symbol}\n"
        f"Period:            {period_str}\n"
        f"Trades:            {trades}\n"
        f"Win Rate:          {win_rate:.0f}%\n"
        f"Profit Factor:     {profit_factor:.2f}\n"
        f"Maximum Drawdown:  {max_drawdown_pct * 100:.1f}%\n"
    )
    
    logger.info(f"\n{formatted_output}")
    
    return {
        "strategy": strategy_name,
        "asset": symbol,
        "period": period_str,
        "trades": trades,
        "win_rate": win_rate,
        "profit_factor": profit_factor,
        "max_drawdown": max_drawdown_pct * 100,
        "formatted_output": formatted_output
    }
