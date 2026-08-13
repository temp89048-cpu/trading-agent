import asyncio
import logging
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

class ReplayEngine:
    """
    Level 8: Replay Engine
    One of the most valuable tools — the ability to replay history for debugging and validation.
    """
    def __init__(self):
        self.is_replaying = False
        self.historical_data: List[Dict[str, Any]] = []
        self.current_index = 0

    def load_history(self, klines: List[Dict[str, Any]]):
        self.historical_data = klines
        self.current_index = 0
        self.is_replaying = True
        logger.info(f"Loaded {len(klines)} historical candles for replay.")

    async def step(self) -> Dict[str, Any]:
        """Advances the replay by one candle and returns it."""
        if not self.is_replaying or self.current_index >= len(self.historical_data):
            self.is_replaying = False
            return None
            
        candle = self.historical_data[self.current_index]
        self.current_index += 1
        return candle

    async def run_full_replay(self, callback) -> None:
        """Runs the entire loaded history through a callback function."""
        while self.is_replaying:
            candle = await self.step()
            if candle:
                await callback(candle)

_replay = ReplayEngine()

def get_replay_engine() -> ReplayEngine:
    return _replay
