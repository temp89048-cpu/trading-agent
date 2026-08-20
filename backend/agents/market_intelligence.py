from typing import Dict, Any, List, Optional
import logging
import numpy as np
from backend.services.market_data import fetch_klines
from backend.core.agent_base import BaseAgent
from backend.models.events import (
    EventType,
    BaseEvent,
    TickReceivedEvent,
    FeaturesComputedEvent,
    MacroAnalyzedEvent,
    MarketStructureAnalyzedEvent,
)
from backend.agents.sentiment_agent import fetch_macro_data

logger = logging.getLogger(__name__)

def calculate_ema(prices: np.ndarray, period: int) -> np.ndarray:
    ema = np.zeros_like(prices)
    if len(prices) < period:
        return ema
    ema[period-1] = np.mean(prices[:period])
    multiplier = 2 / (period + 1)
    for i in range(period, len(prices)):
        ema[i] = (prices[i] - ema[i-1]) * multiplier + ema[i-1]
    return ema

def calculate_atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    tr = np.zeros_like(closes)
    atr = np.zeros_like(closes)
    if len(closes) < 2:
        return atr
    tr[0] = highs[0] - lows[0]
    for i in range(1, len(closes)):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i-1])
        lc = abs(lows[i] - closes[i-1])
        tr[i] = max(hl, hc, lc)
    if len(tr) >= period:
        atr[period-1] = np.mean(tr[:period])
        for i in range(period, len(tr)):
            atr[i] = (atr[i-1] * (period - 1) + tr[i]) / period
    return atr

def find_support_resistance(highs: np.ndarray, lows: np.ndarray, window: int = 5):
    resistances = []
    supports = []
    if len(highs) < window * 2 + 1:
        return supports, resistances
    for i in range(window, len(highs) - window):
        is_resistance = True
        is_support = True
        for j in range(1, window + 1):
            if highs[i] <= highs[i - j] or highs[i] <= highs[i + j]:
                is_resistance = False
            if lows[i] >= lows[i - j] or lows[i] >= lows[i + j]:
                is_support = False
        if is_resistance:
            resistances.append(float(highs[i]))
        if is_support:
            supports.append(float(lows[i]))
    return supports, resistances

def analyze_market_structure(klines: List[Dict[str, Any]]) -> Dict[str, Any]:
    if len(klines) < 21:
        return {"trend": "Neutral", "regime": "Unknown", "support": [], "resistance": [], "volatility": 0.0}
        
    closes = np.array([k["close"] for k in klines])
    highs = np.array([k["high"] for k in klines])
    lows = np.array([k["low"] for k in klines])
    
    ema9 = calculate_ema(closes, 9)
    ema21 = calculate_ema(closes, 21)
    atr = calculate_atr(highs, lows, closes, 14)
    
    current_price = closes[-1]
    current_ema9 = ema9[-1]
    current_ema21 = ema21[-1]
    current_atr = atr[-1]
    
    # 1. Trend Analysis
    if current_price > current_ema9 and current_ema9 > current_ema21:
        trend = "Bullish"
    elif current_price < current_ema9 and current_ema9 < current_ema21:
        trend = "Bearish"
    else:
        trend = "Ranging"
        
    # 2. Market Regime (Volatility/ATR check)
    avg_atr = np.mean(atr[-20:]) if len(atr) >= 20 else current_atr
    if trend in ["Bullish", "Bearish"] and current_atr > avg_atr * 1.1:
        regime = "Trending"
    else:
        regime = "Ranging/Consolidating"
        
    # 3. Support and Resistance
    supports, resistances = find_support_resistance(highs, lows, window=5)
    
    return {
        "trend": trend,
        "regime": regime,
        "support": supports[-3:],
        "resistance": resistances[-3:],
        "volatility": float(current_atr)
    }

async def run_multi_timeframe_analysis(symbol: str) -> Dict[str, Any]:
    timeframes = ["15m", "1h", "4h"]
    analysis = {}
    
    bullish_count = 0
    bearish_count = 0
    
    features = {}
    
    for tf in timeframes:
        klines = await fetch_klines(symbol, tf, limit=100)
        if not klines:
            analysis[tf] = {"trend": "Neutral"}
            continue
            
        tf_analysis = analyze_market_structure(klines)
        analysis[tf] = tf_analysis
        
        trend = tf_analysis["trend"]
        if trend == "Bullish":
            bullish_count += 1
        elif trend == "Bearish":
            bearish_count += 1
            
        if tf == "1h":
            features = tf_analysis
            
    if bullish_count > bearish_count:
        overall_trend = "Bullish"
    elif bearish_count > bullish_count:
        overall_trend = "Bearish"
    else:
        overall_trend = "Mixed"
        
    features["multi_tf_trend"] = overall_trend
    
    logger.info(f"Market Intelligence for {symbol} (1h base): {features}")
    return features

class MarketIntelligenceAgent(BaseAgent):
    @property
    def name(self) -> str:
        return "Market Intelligence"

    @property
    def purpose(self) -> str:
        return "Continuously analyzes multiple timeframes to determine the market structure, support/resistance, and volatility."

    @property
    def permissions(self) -> List[str]:
        return ["READ_MARKET_DATA"]

    @property
    def inputs(self) -> List[str]:
        return [
            "TICK_RECEIVED events (symbol, price, volume)",
            "Multi-timeframe klines via services/market_data.fetch_klines",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "FEATURES_COMPUTED events (EMA, ATR, support/resistance, structure)",
            "MACRO_ANALYZED events (the trigger for the Debate stage)",
        ]

    @property
    def category(self) -> str:
        return "market-intelligence"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["TICK_RECEIVED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["FEATURES_COMPUTED", "MARKET_STRUCTURE_ANALYZED", "MACRO_ANALYZED"]


    @property
    def responsibilities(self) -> List[str]:
        return ["Execute core duties as assigned."]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus"]

    @property
    def memory_ttl(self) -> str:
        return "Ephemeral (process lifetime)"

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Internal state"]

    @property
    def prompt_reference(self) -> str:
        return "MARKET_INTELLIGENCE_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["None"]

    @property
    def database_tables(self) -> List[str]:
        return ["None"]

    @property
    def metrics_reported(self) -> List[str]:
        return ["Uptime", "Events Processed"]

    @property
    def failure_recovery_strategy(self) -> str:
        return "Restart agent process"

    @property
    def health_status(self) -> str:
        return "Active"


    async def handle_event(self, event: BaseEvent) -> None:
        """Publish the Feature Engine, Market Structure and Macro stages of
        spec Section 6's chain.

        WHAT CHANGED. This used to publish FEATURES_COMPUTED (real) and then:

            # Mock the rest of the chain for this example to trigger Debate
            await self.publish(MacroAnalyzedEvent(
                symbol=event.symbol,
                macro_data={"sentiment": "neutral", "reasons": ["Mocked macro data"]}
            ))

        Two problems. The macro payload was invented, and because the Debate
        agent triggers on MACRO_ANALYZED, every debate in the system was
        triggered by fabricated data. And MARKET_STRUCTURE_ANALYZED — an event
        that already exists in the model, whose data this agent already
        computes — was never published at all, so that stage of the chain was
        skipped entirely.
        """
        if event.event_type != "TICK_RECEIVED" or not isinstance(event, TickReceivedEvent):
            return

        features = await run_multi_timeframe_analysis(event.symbol)

        await self.publish(FeaturesComputedEvent(
            symbol=event.symbol,
            timeframe="multi",
            features=features
        ))

        # Market Structure stage. The data was already computed above; it just
        # had nowhere to go.
        await self.publish(MarketStructureAnalyzedEvent(
            symbol=event.symbol,
            structure_data={
                "trend": features.get("trend"),
                "multi_tf_trend": features.get("multi_tf_trend"),
                "support": features.get("support"),
                "resistance": features.get("resistance"),
            },
        ))

        # Macro stage, from the real Fear & Greed / funding / open-interest
        # feed in agents/sentiment_agent.py. That function existed and nothing
        # called it. Unavailable fields arrive as None with an `unavailable`
        # list rather than as plausible neutral defaults, so the Debate agent
        # can scale conviction by coverage instead of trusting a full-looking
        # payload.
        macro = await fetch_macro_data()
        unavailable = macro.get("unavailable") or []
        await self.publish(MacroAnalyzedEvent(
            symbol=event.symbol,
            macro_data={
                **macro,
                # Named so a consumer can distinguish "elevated risk" from
                # "we could not measure risk" — see DebateAgent._macro_note.
                "risk_level": self._risk_level(macro),
                "reasons": (
                    [f"{len(unavailable)} of 3 macro inputs unavailable: {', '.join(unavailable)}"]
                    if unavailable
                    else ["all macro inputs available"]
                ),
            }
        ))

    @staticmethod
    def _risk_level(macro: Dict[str, Any]) -> str:
        """Derive a risk level, or say it is unknown.

        Returns 'unknown' rather than 'normal' when nothing could be measured.
        'normal' would be read downstream as a measured all-clear.
        """
        fng = macro.get("fng")
        funding = macro.get("funding_rate")
        if fng is None and funding is None:
            return "unknown"

        # Extreme fear or extreme greed both raise risk: the first because
        # forced selling cascades, the second because crowded longs liquidate.
        if fng is not None and (fng <= 20 or fng >= 80):
            return "elevated"
        # Funding far from zero means one side is paying heavily to hold, which
        # is where liquidation cascades start.
        if funding is not None and abs(funding) > 0.001:
            return "elevated"
        return "normal"

# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------
#
# MEMOISED, and it was not before. `get_market_intelligence_agent()` used to be `return MarketIntelligenceAgent()`, so
# every call built a NEW agent — and `BaseAgent.__init__` subscribes on construction,
# with nothing ever unsubscribing. So each call added a permanent duplicate handler to
# the global bus, and the agent then processed every matching event once per call ever
# made.
#
# Latent in production, because `main.py` calls this exactly once at startup. It
# became live the moment `HistoricalBacktestEngine` also called it: running a backtest
# in-process left a SECOND agent handling every live event for the rest of the
# process's life — for the supervisor, two trade-authorization requests per debate.
#
# Found by an independent end-to-end verification of the Phase 38 bus-isolation work,
# not by the test suite, which had constructed one engine per test and never checked
# what accumulated across them.
#
# Every other accessor of this shape already memoises — `cio_agent`,
# `hypothesis_agent`, `get_exchange_client`, `get_polymarket_client`. These two were
# the exceptions.

_instance: Optional[MarketIntelligenceAgent] = None


def get_market_intelligence_agent() -> MarketIntelligenceAgent:
    global _instance
    if _instance is None:
        _instance = MarketIntelligenceAgent()
    return _instance


def reset_market_intelligence_agent() -> None:
    """For tests. Drops the singleton WITHOUT unsubscribing it.

    Deliberate: a test that wants a clean bus should build its own `MessageBus`, which
    is what `isolated_bus` does. Silently unsubscribing here would make this function
    mutate global routing as a side effect of asking for a fresh object.
    """
    global _instance
    _instance = None
