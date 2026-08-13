import logging
import httpx
import asyncio
from typing import Dict, Any, List

logger = logging.getLogger(__name__)

async def fetch_binance(symbol: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    try:
        resp = await client.get(f"https://api.binance.com/api/v3/ticker/bookTicker?symbol={symbol}", timeout=3.0)
        if resp.status_code == 200:
            data = resp.json()
            return {
                "exchange": "Binance",
                "bid": float(data['bidPrice']),
                "ask": float(data['askPrice'])
            }
    except Exception:
        pass
    return None

async def fetch_bybit(symbol: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    try:
        resp = await client.get(f"https://api.bybit.com/v5/market/tickers?category=spot&symbol={symbol}", timeout=3.0)
        if resp.status_code == 200:
            data = resp.json()
            if data['result']['list']:
                item = data['result']['list'][0]
                return {
                    "exchange": "Bybit",
                    "bid": float(item['bid1Price']),
                    "ask": float(item['ask1Price'])
                }
    except Exception:
        pass
    return None

async def fetch_coinbase(symbol: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    # Convert BTCUSDT to BTC-USD
    cb_symbol = symbol.replace("USDT", "-USD")
    try:
        resp = await client.get(f"https://api.exchange.coinbase.com/products/{cb_symbol}/book?level=1", timeout=3.0)
        if resp.status_code == 200:
            data = resp.json()
            return {
                "exchange": "Coinbase",
                "bid": float(data['bids'][0][0]),
                "ask": float(data['asks'][0][0])
            }
    except Exception:
        pass
    return None

async def fetch_kraken(symbol: str, client: httpx.AsyncClient) -> Dict[str, Any]:
    # Convert BTCUSDT to BTCUSD
    kr_symbol = symbol.replace("USDT", "USD")
    try:
        resp = await client.get(f"https://api.kraken.com/0/public/Ticker?pair={kr_symbol}", timeout=3.0)
        if resp.status_code == 200:
            data = resp.json()
            if not data.get('error'):
                pair_key = list(data['result'].keys())[0]
                item = data['result'][pair_key]
                return {
                    "exchange": "Kraken",
                    "bid": float(item['b'][0]),
                    "ask": float(item['a'][0])
                }
    except Exception:
        pass
    return None

async def scan_global_exchanges(symbol: str) -> Dict[str, Any]:
    """
    Level 14: Multi-Exchange Intelligence
    Fetches the best bid/ask across multiple global exchanges to calculate true liquidity and arbitrage spread.
    """
    logger.info(f"Scanning Global Exchanges for {symbol}...")
    
    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(
            fetch_binance(symbol, client),
            fetch_bybit(symbol, client),
            fetch_coinbase(symbol, client),
            fetch_kraken(symbol, client),
            return_exceptions=True
        )
        
    valid_results = [r for r in results if r and not isinstance(r, Exception)]
    
    if not valid_results:
        return {"error": "Failed to fetch multi-exchange data"}
        
    highest_bid = {"exchange": "None", "price": 0.0}
    lowest_ask = {"exchange": "None", "price": float('inf')}
    
    log_lines = [f"\n--- Multi-Exchange Intelligence ({symbol}) ---"]
    
    for r in valid_results:
        exc = r["exchange"]
        bid = r["bid"]
        ask = r["ask"]
        log_lines.append(f"{exc.ljust(10)} | Bid: {bid:.2f} | Ask: {ask:.2f}")
        
        if bid > highest_bid["price"]:
            highest_bid = {"exchange": exc, "price": bid}
            
        if ask < lowest_ask["price"]:
            lowest_ask = {"exchange": exc, "price": ask}
            
    # Calculate Arbitrage Spread
    arb_spread = highest_bid["price"] - lowest_ask["price"]
    arb_pct = (arb_spread / lowest_ask["price"]) * 100 if lowest_ask["price"] > 0 else 0
    
    log_lines.append("-" * 45)
    log_lines.append(f"Lowest Ask (Buy Here):  {lowest_ask['exchange']} @ {lowest_ask['price']:.2f}")
    log_lines.append(f"Highest Bid (Sell Here): {highest_bid['exchange']} @ {highest_bid['price']:.2f}")
    
    if arb_spread > 0:
        log_lines.append(f"⚠️ ARBITRAGE DETECTED! Spread: +{arb_pct:.4f}% (${arb_spread:.2f})")
    else:
        log_lines.append(f"No Arbitrage. Gap: {arb_pct:.4f}% (${arb_spread:.2f})")
        
    formatted_output = "\n".join(log_lines)
    logger.info(formatted_output)
    
    return {
        "symbol": symbol,
        "exchanges_scanned": len(valid_results),
        "lowest_ask": lowest_ask,
        "highest_bid": highest_bid,
        "arbitrage_spread_pct": arb_pct,
        "arbitrage_spread_usd": arb_spread,
        "formatted_output": formatted_output,
        "raw_data": valid_results
    }
