from typing import Dict, Any, List
import copy

# Starting paper cash. THE SAME FIGURE AS EVERYWHERE ELSE — 25,000.
#
# This was 1,000,000, making it the third disagreeing definition of one quantity:
# `lib/types.ts` opened the browser's book with 1,000,000, `PAPER_STARTING_EQUITY`
# said 25,000, and `db/schema.sql` seeds `paper_account` with 25,000 under a comment
# that explicitly claims it "matches PAPER_STARTING_EQUITY". Two of the three were
# wrong and the comment asserting agreement was the only thing that was right.
#
# 40x of phantom buying power changes what the agent can size into, so this is not
# cosmetic.
PAPER_STARTING_CASH = 25_000.0

# Global IN-MEMORY portfolio for backend agents.
#
# KNOWN GAP, documented in CLAUDE.md: nothing persists this. A restart resets cash
# to the figure above and forgets every open position, while Postgres has a
# `positions` table built for exactly this that nothing writes to. For paper that
# loses P&L continuity; for real money the position still exists at the exchange
# with nobody enforcing its stop. `tests/test_post_trade_chain.py` pins the current
# behaviour — invert those tests when this is fixed rather than deleting them.
_portfolio = {
    "paper": {
        "cash": PAPER_STARTING_CASH,
        "positions": []
    },
    "real": {
        "positions": []
    }
}

async def get_portfolio() -> Dict[str, Any]:
    return copy.deepcopy(_portfolio)

async def update_portfolio(updates: Dict[str, Any]):
    global _portfolio
    _portfolio = copy.deepcopy(updates)
    return _portfolio

async def buy_paper(symbol: str, qty: float, price: float, leverage: float = 1.0) -> bool:
    global _portfolio
    notional = qty * price
    margin_required = notional / leverage if leverage > 0 else notional
    
    if margin_required > _portfolio["paper"]["cash"]:
        return False
        
    _portfolio["paper"]["cash"] -= margin_required
    
    # Check if position already exists
    positions = _portfolio["paper"]["positions"]
    idx = next((i for i, p in enumerate(positions) if p["symbol"] == symbol), -1)
    
    if idx >= 0:
        ex = positions[idx]
        new_qty = ex["qty"] + qty
        new_avg = (ex["qty"] * ex["avgCost"] + notional) / new_qty
        new_margin = ex.get("marginLocked", ex["qty"] * ex["avgCost"]) + margin_required
        positions[idx] = {
            "symbol": symbol,
            "qty": new_qty,
            "avgCost": new_avg,
            "marginLocked": new_margin
        }
    else:
        positions.append({
            "symbol": symbol,
            "qty": qty,
            "avgCost": price,
            "marginLocked": margin_required
        })
        
    return True

async def sell_paper(symbol: str, qty: float, price: float) -> bool:
    global _portfolio
    positions = _portfolio["paper"]["positions"]
    idx = next((i for i, p in enumerate(positions) if p["symbol"] == symbol), -1)
    
    if idx < 0 or positions[idx]["qty"] < qty:
        return False
        
    ex = positions[idx]
    realized_pnl = (price - ex["avgCost"]) * qty
    remaining_qty = ex["qty"] - qty
    proportion_closed = qty / ex["qty"]
    margin_released = ex.get("marginLocked", ex["qty"] * ex["avgCost"]) * proportion_closed
    
    if remaining_qty > 0.0000001:
        positions[idx]["qty"] = remaining_qty
        positions[idx]["marginLocked"] = ex.get("marginLocked", ex["qty"] * ex["avgCost"]) - margin_released
    else:
        positions.pop(idx)
        
    _portfolio["paper"]["cash"] += margin_released + realized_pnl
    return True
