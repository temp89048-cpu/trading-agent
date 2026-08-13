import logging
import math
from typing import Dict, Any, List

from backend.core.agent_os import AgentDescriptor, get_agent_os
from backend.services.market_data import fetch_klines
from backend.agents.research_agent import scan_market

logger = logging.getLogger(__name__)

async def detect_anomalies(symbol: str) -> List[str]:
    """
    Scans recent klines for volume spikes and volatility explosions.
    """
    alerts = []
    
    # Fetch 5m klines to detect very sudden events
    klines = await fetch_klines(symbol, interval="5m", limit=30)
    if not klines or len(klines) < 25:
        return alerts
        
    recent_kline = klines[-1]
    historical = klines[:-1]
    
    # 1. Unusual Volume Spike Detection
    avg_volume = sum(k['volume'] for k in historical) / len(historical)
    current_volume = recent_kline['volume']
    
    if avg_volume > 0 and current_volume > (avg_volume * 5.0):
        alerts.append(f"🚨 UNUSUAL VOLUME: {symbol} 5m volume is {current_volume/avg_volume:.1f}x higher than average!")
        
    # 2. Volatility Explosion (Price Range)
    avg_range = sum(k['high'] - k['low'] for k in historical) / len(historical)
    current_range = recent_kline['high'] - recent_kline['low']
    
    if avg_range > 0 and current_range > (avg_range * 4.0):
        alerts.append(f"🚨 VOLATILITY EXPLOSION: {symbol} price range is {current_range/avg_range:.1f}x higher than average!")
        
    # 3. Gap Openings / Massive sudden dumps
    close_prev = historical[-1]['close']
    open_curr = recent_kline['open']
    gap_pct = abs(open_curr - close_prev) / close_prev * 100
    
    if gap_pct > 1.0: # 1% gap on a 5m chart is massive
        alerts.append(f"🚨 GAP DETECTED: {symbol} gapped by {gap_pct:.2f}% between 5m candles!")
        
    return alerts

async def event_agent_tick(agent_id: str):
    """
    Level 16: Event Detection
    Wakes up and scans for massive market shocks.
    """
    # Just check the top 3 trending coins to save API limits
    trending = await scan_market()
    top_3 = trending[:3] if trending else [{"symbol": "BTCUSDT"}, {"symbol": "ETHUSDT"}, {"symbol": "SOLUSDT"}]
    
    total_alerts = 0
    
    for coin in top_3:
        symbol = coin["symbol"]
        alerts = await detect_anomalies(symbol)
        
        for alert in alerts:
            logger.warning(f"Event Agent - {alert}")
            total_alerts += 1
            
    if total_alerts > 0:
        logger.warning(f"Event Agent detected {total_alerts} extreme market anomalies!")

def register_event_agent():
    descriptor = AgentDescriptor(
        id="event_agent_01",
        name="Event Detection Radar",
        version="1.0.0",
        description="Scans for sudden volume spikes, volatility explosions, and macro events.",
        capabilities=["monitoring", "alerting"],
        dependencies=[],
        # Was "security", which is not a valid AgentCategory — the frontend
        # dropped this agent from the dashboard entirely. It scans volume,
        # volatility and macro events, so market-intelligence is its real home.
        category="market-intelligence",
        priority=2, # Very high priority
        tickIntervalMs=30000  # Runs every 30 seconds
    )
    get_agent_os().register(descriptor, event_agent_tick)
