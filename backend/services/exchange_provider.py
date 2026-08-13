from abc import ABC, abstractmethod
from typing import List, Dict, Any

class ExchangeProvider(ABC):
    """
    Level 13: Exchange Abstraction
    Adding a new exchange should require only a new connector — no strategy changes.
    """
    @abstractmethod
    async def fetch_prices(self) -> Dict[str, float]:
        pass
        
    @abstractmethod
    async def fetch_klines(self, symbol: str, interval: str, limit: int) -> List[Dict[str, Any]]:
        pass
        
    @abstractmethod
    async def execute_order(self, symbol: str, side: str, qty: float, price: float) -> bool:
        pass

class BinanceProvider(ExchangeProvider):
    async def fetch_prices(self) -> Dict[str, float]:
        from backend.services.market_data import fetch_prices as fetch_b_prices
        from backend.services.market_data import _prices
        await fetch_b_prices()
        return _prices
        
    async def fetch_klines(self, symbol: str, interval: str, limit: int) -> List[Dict[str, Any]]:
        from backend.services.market_data import fetch_klines as fetch_b_klines
        return await fetch_b_klines(symbol, interval, limit)
        
    async def execute_order(self, symbol: str, side: str, qty: float, price: float) -> bool:
        from backend.services.portfolio_store import buy_paper, sell_paper
        if side.lower() == "buy":
            return await buy_paper(symbol, qty, price)
        else:
            return await sell_paper(symbol, qty, price)

# Factory pattern for exchange injection
_active_provider = BinanceProvider()

def get_exchange() -> ExchangeProvider:
    return _active_provider
