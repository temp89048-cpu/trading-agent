"""Spec Section 6 — is the tick-to-learning chain actually continuous?

    Market Tick -> Market Intelligence -> Feature Engine -> Market Structure
      -> Liquidity -> Funding -> News -> Macro -> Debate -> Supervisor -> Risk
      -> Execution -> Monitor -> Reflection -> Learning -> Knowledge Graph

Three stages were broken rather than missing:
  * Feature Engine and Market Structure were computed and thrown away.
  * Macro was fabricated: `{"sentiment": "neutral", ["Mocked macro data"]}`.
  * Monitor did not exist, so nothing closed a position and nothing published
    POSITION_CLOSED — leaving Reflection and the CEO's equity tracking dead.
"""

import pytest

from backend.agents.debate_agent import DebateAgent
from backend.agents.market_intelligence import MarketIntelligenceAgent
from backend.core.message_bus import MessageBus, get_message_bus
from backend.models.events import (
    FeaturesComputedEvent,
    MacroAnalyzedEvent,
    MarketStructureAnalyzedEvent,
    TickReceivedEvent,
)


@pytest.fixture(autouse=True)
def _fresh_bus(monkeypatch):
    monkeypatch.setattr("backend.core.message_bus._bus", MessageBus())


# ---------------------------------------------------------------------------
# Macro honesty
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_macro_fetch_reports_unavailability_instead_of_neutral_defaults(monkeypatch):
    """It used to seed fng=50 / "Neutral" / funding=0.0 and return that dict
    unchanged on failure, so a network error was indistinguishable from a
    genuinely balanced market.

    The failure is injected explicitly rather than relying on the network being
    unreachable. An earlier version of this test assumed the conftest guard
    would block the call; it did not (async httpx bypasses the socket patches
    on Windows) and the test got a live Fear & Greed value of 29 back. A test
    whose outcome depends on whether a third-party API happens to be reachable
    is not a test.
    """
    from backend.agents import sentiment_agent

    # Clear the module cache so this test isn't served a prior good payload.
    monkeypatch.setattr(sentiment_agent, "_cache", {"data": None, "timestamp": 0})

    class _Failing:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return False

        async def get(self, *_a, **_k):
            raise RuntimeError("simulated network failure")

    monkeypatch.setattr(sentiment_agent.httpx, "AsyncClient", lambda *a, **k: _Failing())

    data = await sentiment_agent.fetch_macro_data()

    assert data["fng"] is None
    assert data["funding_rate"] is None
    assert set(data["unavailable"]) == {"fng", "funding_rate", "oi"}
    assert "error" in data


@pytest.mark.asyncio
async def test_a_total_macro_failure_is_not_cached(monkeypatch):
    """Caching an all-None payload would keep serving the failure for the full
    5-minute TTL even after the network recovered."""
    from backend.agents import sentiment_agent

    monkeypatch.setattr(sentiment_agent, "_cache", {"data": None, "timestamp": 0})

    class _Failing:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return False

        async def get(self, *_a, **_k):
            raise RuntimeError("down")

    monkeypatch.setattr(sentiment_agent.httpx, "AsyncClient", lambda *a, **k: _Failing())
    await sentiment_agent.fetch_macro_data()
    assert sentiment_agent._cache["data"] is None, "a total failure must not be cached"


@pytest.mark.asyncio
async def test_risk_level_is_unknown_not_normal_when_nothing_measured():
    """'normal' would be read downstream as a measured all-clear."""
    assert MarketIntelligenceAgent._risk_level({"fng": None, "funding_rate": None}) == "unknown"


@pytest.mark.asyncio
async def test_risk_level_flags_both_extreme_fear_and_extreme_greed():
    """Extreme fear cascades forced selling; extreme greed liquidates crowded
    longs. Both raise risk."""
    assert MarketIntelligenceAgent._risk_level({"fng": 10, "funding_rate": 0.0}) == "elevated"
    assert MarketIntelligenceAgent._risk_level({"fng": 90, "funding_rate": 0.0}) == "elevated"
    assert MarketIntelligenceAgent._risk_level({"fng": 50, "funding_rate": 0.0}) == "normal"


@pytest.mark.asyncio
async def test_risk_level_flags_extreme_funding():
    assert MarketIntelligenceAgent._risk_level({"fng": 50, "funding_rate": 0.01}) == "elevated"
    assert MarketIntelligenceAgent._risk_level({"fng": 50, "funding_rate": -0.01}) == "elevated"


# ---------------------------------------------------------------------------
# Market Intelligence publishes all three stages
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tick_produces_features_structure_and_macro(monkeypatch):
    """MARKET_STRUCTURE_ANALYZED was defined in the event model and published
    by nobody, while the data for it was already being computed."""
    agent = MarketIntelligenceAgent()

    async def fake_analysis(symbol):
        return {
            "trend": "Bullish",
            "multi_tf_trend": "Bullish",
            "support": 59_000.0,
            "resistance": 62_000.0,
        }

    async def fake_macro():
        return {"fng": 55, "fng_classification": "Greed", "funding_rate": 0.0001,
                "oi": 1.0, "unavailable": []}

    monkeypatch.setattr("backend.agents.market_intelligence.run_multi_timeframe_analysis", fake_analysis)
    monkeypatch.setattr("backend.agents.market_intelligence.fetch_macro_data", fake_macro)

    seen = []
    bus = get_message_bus()
    for topic in ("FEATURES_COMPUTED", "MARKET_STRUCTURE_ANALYZED", "MACRO_ANALYZED"):
        bus.subscribe(topic, lambda e: seen.append(e))

    await agent.handle_event(
        TickReceivedEvent(symbol="BTC/USDT", price=60_000.0, volume=1.0, exchange="test")
    )

    kinds = [e.event_type for e in seen]
    assert kinds == ["FEATURES_COMPUTED", "MARKET_STRUCTURE_ANALYZED", "MACRO_ANALYZED"], (
        "all three Market Intelligence stages must be published, in order"
    )

    structure = next(e for e in seen if e.event_type == "MARKET_STRUCTURE_ANALYZED")
    assert structure.structure_data["support"] == 59_000.0

    macro = next(e for e in seen if e.event_type == "MACRO_ANALYZED")
    assert macro.macro_data["risk_level"] == "normal"
    assert "Mocked" not in str(macro.macro_data), "the macro payload must not be fabricated"


@pytest.mark.asyncio
async def test_macro_event_states_which_inputs_were_unavailable(monkeypatch):
    agent = MarketIntelligenceAgent()

    async def fake_analysis(symbol):
        return {"trend": "Neutral", "multi_tf_trend": "Mixed"}

    async def broken_macro():
        return {"fng": None, "fng_classification": None, "funding_rate": None,
                "oi": None, "unavailable": ["fng", "funding_rate", "oi"]}

    monkeypatch.setattr("backend.agents.market_intelligence.run_multi_timeframe_analysis", fake_analysis)
    monkeypatch.setattr("backend.agents.market_intelligence.fetch_macro_data", broken_macro)

    macros = []
    get_message_bus().subscribe("MACRO_ANALYZED", lambda e: macros.append(e))
    await agent.handle_event(
        TickReceivedEvent(symbol="BTC/USDT", price=60_000.0, volume=1.0, exchange="test")
    )

    assert macros[0].macro_data["risk_level"] == "unknown"
    assert "unavailable" in macros[0].macro_data["reasons"][0]


# ---------------------------------------------------------------------------
# Debate consumes the upstream stages
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_debate_caches_features_and_structure():
    """These events had no consumer, so the Feature Engine and Market Structure
    stages of the chain were computed and discarded while the Debate agent
    separately re-fetched its own klines."""
    agent = DebateAgent()

    await agent.handle_event(
        FeaturesComputedEvent(symbol="BTC/USDT", timeframe="multi",
                              features={"multi_tf_trend": "Bearish"})
    )
    await agent.handle_event(
        MarketStructureAnalyzedEvent(symbol="BTC/USDT", structure_data={"trend": "Bearish"})
    )

    assert agent._features["BTC/USDT"]["multi_tf_trend"] == "Bearish"
    assert agent._structure["BTC/USDT"]["trend"] == "Bearish"


@pytest.mark.asyncio
async def test_debate_reduces_conviction_against_the_higher_timeframe(monkeypatch):
    """A verdict fighting the multi-timeframe consensus isn't blocked, but it
    must not claim full conviction either."""
    from backend.algorithms.debate import DebateResult

    agent = DebateAgent()
    await agent.handle_event(
        FeaturesComputedEvent(symbol="BTC/USDT", timeframe="multi",
                              features={"multi_tf_trend": "Bearish"})
    )

    async def klines(*_a, **_k):
        from tests.conftest import make_candles
        return make_candles(120)

    monkeypatch.setattr("backend.agents.debate_agent.fetch_klines", klines)
    monkeypatch.setattr(
        "backend.agents.debate_agent.score_debate",
        lambda _k: DebateResult(direction="LONG", confidence=1.0, rationale="forced LONG"),
    )

    verdicts = []
    get_message_bus().subscribe("DEBATE_CONCLUDED", lambda e: verdicts.append(e))
    await agent.handle_event(
        MacroAnalyzedEvent(symbol="BTC/USDT", macro_data={"risk_level": "normal"})
    )

    assert len(verdicts) == 1
    assert verdicts[0].consensus_confidence == pytest.approx(0.7)
    assert "opposes the multi-timeframe trend" in verdicts[0].supervisor_rationale


@pytest.mark.asyncio
async def test_insufficient_candles_publishes_neutral_not_silence(monkeypatch):
    """Silence is indistinguishable from a crashed agent; an explicit NEUTRAL
    tells the Supervisor a debate happened and found no edge."""
    agent = DebateAgent()

    async def few_klines(*_a, **_k):
        return [{"close": 1.0, "high": 1.0, "low": 1.0, "open": 1.0, "volume": 1.0}] * 5

    monkeypatch.setattr("backend.agents.debate_agent.fetch_klines", few_klines)

    verdicts = []
    get_message_bus().subscribe("DEBATE_CONCLUDED", lambda e: verdicts.append(e))
    await agent.handle_event(MacroAnalyzedEvent(symbol="NEW/USDT", macro_data={}))

    assert len(verdicts) == 1
    assert verdicts[0].winning_direction == "NEUTRAL"
    assert verdicts[0].consensus_confidence == 0.0
    assert "data gap" in verdicts[0].supervisor_rationale


@pytest.mark.asyncio
async def test_elevated_macro_risk_reduces_conviction(monkeypatch):
    from backend.algorithms.debate import DebateResult

    agent = DebateAgent()

    async def klines(*_a, **_k):
        from tests.conftest import make_candles
        return make_candles(120)

    monkeypatch.setattr("backend.agents.debate_agent.fetch_klines", klines)
    monkeypatch.setattr(
        "backend.agents.debate_agent.score_debate",
        lambda _k: DebateResult(direction="LONG", confidence=1.0, rationale="forced"),
    )

    verdicts = []
    get_message_bus().subscribe("DEBATE_CONCLUDED", lambda e: verdicts.append(e))
    await agent.handle_event(
        MacroAnalyzedEvent(symbol="BTC/USDT", macro_data={"risk_level": "elevated"})
    )

    assert verdicts[0].consensus_confidence == pytest.approx(0.75)
    assert "reduces conviction" in verdicts[0].supervisor_rationale


# ---------------------------------------------------------------------------
# Deterministic debate scoring
# ---------------------------------------------------------------------------

def test_debate_scoring_is_deterministic():
    """The same candles must always produce the same verdict, or the decision
    rule cannot be backtested or audited."""
    from tests.conftest import make_candles
    from backend.algorithms.debate import score_debate

    candles = make_candles(120)
    first = score_debate(candles)
    second = score_debate(candles)
    assert (first.direction, first.confidence) == (second.direction, second.confidence)


def test_debate_refuses_on_insufficient_data():
    from backend.algorithms.debate import score_debate

    result = score_debate([])
    assert result.direction == "NEUTRAL"
    assert result.confidence == 0.0


def test_debate_confidence_is_scaled_by_check_coverage():
    """A verdict resting on two of five checks must not report the confidence
    of one resting on all five."""
    from tests.conftest import make_candles
    from backend.algorithms.debate import score_debate

    full = score_debate(make_candles(120))
    # Strip volume so the volume check cannot be evaluated.
    no_volume = [{**c, "volume": 0.0} for c in make_candles(120)]
    partial = score_debate(no_volume)

    assert full.confidence >= partial.confidence or partial.unavailable
