import logging
import httpx
import json
import os
import asyncio
from datetime import datetime
from typing import Dict, Any, List

from backend.core.agent_os import AgentDescriptor, get_agent_os
from backend.agents.market_intelligence import run_multi_timeframe_analysis

logger = logging.getLogger(__name__)

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
REPORT_FILE = os.path.join(DATA_DIR, "research_report.json")

# Create data dir if it doesn't exist
os.makedirs(DATA_DIR, exist_ok=True)

async def scan_market() -> List[Dict[str, Any]]:
    """
    Scans the Binance API for the top volume USDT pairs.
    """
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get("https://api.binance.com/api/v3/ticker/24hr", timeout=10.0)
            if resp.status_code == 200:
                data = resp.json()
                # Filter for USDT pairs
                usdt_pairs = [d for d in data if d['symbol'].endswith('USDT')]
                
                # Sort by quoteVolume descending
                usdt_pairs.sort(key=lambda x: float(x['quoteVolume']), reverse=True)
                
                # Take Top 5
                top_5 = usdt_pairs[:5]
                
                results = []
                for pair in top_5:
                    symbol = pair['symbol']
                    pct_change = float(pair['priceChangePercent'])
                    vol = float(pair['quoteVolume'])
                    
                    # Discover setup using MTF Analysis
                    mtf = await run_multi_timeframe_analysis(symbol)
                    trend = mtf.get("overall", "Mixed")
                    
                    setup = "None"
                    if trend == "Bullish" and pct_change > 0:
                        setup = "Strong Long Setup"
                    elif trend == "Bearish" and pct_change < 0:
                        setup = "Strong Short Setup"
                        
                    results.append({
                        "symbol": symbol,
                        "change_24h": f"{pct_change:.2f}%",
                        "volume": f"${vol:,.0f}",
                        "mtf_trend": trend,
                        "discovered_setup": setup
                    })
                    
                return results
    except Exception as e:
        logger.error(f"Error scanning market: {e}")
        
    return []

async def research_agent_tick(agent_id: str):
    """
    Wakes up periodically to discover new setups and write them to disk.
    """
    logger.info("Research Agent waking up to scan the market...")
    
    findings = await scan_market()
    
    if findings:
        report = {
            "last_updated": datetime.utcnow().isoformat(),
            "trending_coins": findings
        }
        
        with open(REPORT_FILE, "w") as f:
            json.dump(report, f, indent=4)
            
        logger.info(f"Research Agent discovered {len(findings)} trending setups. Saved to memory.")
        for f in findings:
            logger.info(f"  - {f['symbol']}: {f['mtf_trend']} trend | {f['discovered_setup']}")
    else:
        logger.warning("Research Agent failed to find any setups.")

def register_research_agent():
    descriptor = AgentDescriptor(
        id="research_agent_01",
        name="Autonomous Research Agent",
        version="1.0.0",
        description="Scans the market in the background for new setups.",
        capabilities=["research", "discovery"],
        dependencies=[],
        # Was "research", which is not a valid AgentCategory, so this agent
        # never appeared on the dashboard. Research feeds the learning
        # pipeline (spec Section 12), which is the closest valid category.
        category="learning",
        priority=5,
        tickIntervalMs=60000  # Runs every 60 seconds (for demo purposes)
    )
    get_agent_os().register(descriptor, research_agent_tick)
