from fastapi import APIRouter
from backend.core.audit import get_audit_trail
from backend.core.db import get_db_pool
import sqlite3
import json

router = APIRouter()

# Note: This is the Execution API chokepoint. No agent may bypass this to talk to an exchange.

@router.get("/audit")
async def get_audit_logs(limit: int = 50):
    """
    Level 10: Explainability Dashboard API
    For every trade, show why it was entered (Trend, RSI, News, Confidence, Risk)
    """
    audit = get_audit_trail()
    logs = []
    try:
        with sqlite3.connect(audit.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute('''
                SELECT id, timestamp, symbol, decision, confidence, context, reasoning 
                FROM audit_logs 
                ORDER BY timestamp DESC 
                LIMIT ?
            ''', (limit,))
            rows = cursor.fetchall()
            for row in rows:
                logs.append({
                    "id": row[0],
                    "timestamp": row[1],
                    "symbol": row[2],
                    "decision": row[3],
                    "confidence": row[4],
                    "context": json.loads(row[5]) if row[5] else {},
                    "reasoning": row[6]
                })
    except Exception as e:
        return {"status": "error", "message": str(e)}
        
    return {"status": "success", "logs": logs}

@router.get("")
async def get_trades(tab: str = None, limit: int = 50):
    """
    Get trades from PostgreSQL `trades` table.
    """
    pool = get_db_pool()
    if not pool:
        return {"status": "error", "message": "Database not initialized"}
        
    trades = []
    try:
        async with pool.acquire() as conn:
            if tab:
                rows = await conn.fetch('''
                    SELECT id, ts, tab, symbol, side, qty, price, note, pnl, entry_context, debate_id, origin_tag, exchange_order_id, created_at 
                    FROM trades 
                    WHERE tab = $1
                    ORDER BY ts DESC 
                    LIMIT $2
                ''', tab, limit)
            else:
                rows = await conn.fetch('''
                    SELECT id, ts, tab, symbol, side, qty, price, note, pnl, entry_context, debate_id, origin_tag, exchange_order_id, created_at 
                    FROM trades 
                    ORDER BY ts DESC 
                    LIMIT $1
                ''', limit)
                
            for row in rows:
                trades.append({
                    "id": row["id"],
                    "ts": row["ts"].timestamp() * 1000 if row["ts"] else None, # Convert to JS timestamp ms
                    "tab": row["tab"],
                    "symbol": row["symbol"],
                    "side": row["side"],
                    "qty": float(row["qty"]),
                    "price": float(row["price"]),
                    "note": row["note"],
                    "pnl": float(row["pnl"]) if row["pnl"] is not None else None,
                    "entry_context": row["entry_context"],
                    "debate_id": row["debate_id"],
                    "origin_tag": row["origin_tag"],
                    "exchange_order_id": row["exchange_order_id"],
                    "created_at": row["created_at"].isoformat() if row["created_at"] else None
                })
    except Exception as e:
        return {"status": "error", "message": str(e)}
        
    return {"status": "success", "trades": trades}
