"""Section 7 / Phase 24 — the Market State Graph.

    Market Event -> Data Validation -> Feature Generation -> Market Analysis
                 -> Regime Detection -> Market State

    { "regime": ..., "volatility": ..., "liquidity": ...,
      "trend_strength": ..., "confidence": ... }

The tests that matter most are the ones asserting the graph REPORTS what it could
not compute rather than emitting a plausible number. A market-state graph that
returns `volatility: "MEDIUM"` when it had no candles is worse than one that
returns nothing, because every downstream stage would trust it.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from backend.graphs.market_state import (
    market_state_config,
    reset_subscription,
    run_market_state_graph,
    subscribe_to_triggers,
    summarise,
)
from backend.graphs.nodes.market import (
    MIN_CANDLES_FOR_STRUCTURE,
    PRIMARY_TIMEFRAME,
    TIMEFRAMES,
    _liquidity_proxy,
    _rsi,
    _trend_strength,
    _validate_candles,
    _volatility_band,
    detect_regime,
    generate_features,
)
from backend.graphs.registry import clear_registry
from backend.graphs.state import MarketSnapshot, TradingState, TriggerReason, new_state


@pytest.fixture(autouse=True)
def _clean():
    clear_registry()
    reset_subscription()
    yield
    clear_registry()
    reset_subscription()


def _bars(n=120, base=100.0, drift=0.1, spread=1.0, volume=1000.0) -> List[Dict[str, Any]]:
    out = []
    for i in range(n):
        close = base + i * drift
        out.append({
            "openTime": i * 900_000,
            "open": close - drift, "high": close + spread,
            "low": close - spread, "close": close, "volume": volume,
        })
    return out


def _trigger(symbol="BTC/USDT", kind="price_move"):
    return TriggerReason(kind=kind, symbol=symbol, detail="2.4% move",
                         observed_value=2.4, threshold=2.0)


def _state_with(candles: Dict[str, List[Dict[str, Any]]], price=112.0) -> TradingState:
    s = new_state("run", "BTC/USDT", _trigger(), 0.0)
    s["market_data"] = MarketSnapshot(symbol="BTC/USDT", price=price, candles=candles)
    return s


def _patch_feeds(monkeypatch, candles=None, price=112.0, macro=None):
    """Stub the two external feeds the graph touches."""
    bars = _bars() if candles is None else candles

    async def fake_klines(symbol, tf, limit=100):
        return bars

    async def fake_macro():
        return macro if macro is not None else {
            "fng": 55, "fng_classification": "Greed", "funding_rate": 0.0001,
            "oi": 1_000.0, "unavailable": [],
        }

    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", fake_klines)
    monkeypatch.setattr("backend.graphs.nodes.market.get_price", lambda s: price)
    monkeypatch.setattr("backend.agents.sentiment_agent.fetch_macro_data", fake_macro)


# ===========================================================================
# The graph shape
# ===========================================================================

def test_the_graph_matches_the_spec_section_7_chain():
    """Section 7's five stages, in order.

    Asserted as a SUBSEQUENCE rather than as the whole node list, because Phase 32
    later prepended `memory_loader` — a Section 15 stage upstream of Section 7's
    chain, not a change to it. An exact-list assertion fails on any addition
    whether or not the property it tests still holds.
    """
    cfg = market_state_config()
    chain = ["data_validation", "feature_generation", "market_analysis",
             "regime_detection", "market_state"]

    positions = [cfg.nodes.index(n) for n in chain]
    assert positions == sorted(positions), (
        f"Section 7's stages are out of order in {cfg.nodes}"
    )
    # Memory is loaded BEFORE the chain, so every stage can read it.
    assert cfg.entry == "memory_loader"
    assert cfg.nodes.index("memory_loader") < positions[0]
    cfg.validate()


def test_every_node_is_deterministic():
    """Every field in the spec's example output is a computed number. An LLM here
    would make the same candles produce a different regime on a re-run, breaking
    the strategy regime gate's reproducibility."""
    from backend.graphs.registry import all_contracts

    market_state_config()
    contracts = all_contracts()
    # Section 7's five stages plus Phase 32's `memory_loader`. Asserted as a floor
    # and a determinism property rather than an exact count: the count changes
    # whenever an upstream phase adds a stage, and the count was never the point.
    assert len(contracts) >= 5
    assert {c.name for c in contracts} >= {
        "data_validation", "feature_generation", "market_analysis",
        "regime_detection", "market_state",
    }
    assert all(c.deterministic for c in contracts)
    assert not any(c.may_call_llm for c in contracts)


def test_only_the_validation_node_writes_market_data():
    """Section 39.4: one fetch point, or a resumed run reasons over a different
    market than the decision it is continuing."""
    from backend.graphs.registry import all_contracts

    market_state_config()
    writers = [c.name for c in all_contracts() if "market_data" in c.writes]
    assert writers == ["data_validation"]


# ===========================================================================
# Data validation — reject, don't repair
# ===========================================================================

def test_malformed_candles_are_discarded_and_reported():
    """A validation node that forward-fills a gap produces a snapshot that looks
    complete and is not."""
    bars = _bars(30)
    bars[5]["high"] = bars[5]["low"] - 10       # high below low
    bars[9]["close"] = 0.0                       # non-positive
    bars[12]["volume"] = -5.0                    # negative volume

    clean, rejected = _validate_candles(bars, "15m")
    assert len(clean) == 27
    assert len(rejected) == 3
    assert any("high" in r and "below low" in r for r in rejected)
    assert any("non-positive" in r for r in rejected)
    assert any("negative volume" in r for r in rejected)


def test_a_large_move_is_not_discarded_as_an_outlier():
    """A 20% candle is not invalid data, it is a 20% move. Discarding it would
    hide exactly the event the system should reason about."""
    bars = _bars(30)
    bars[15]["high"] = bars[15]["close"] * 1.2
    clean, rejected = _validate_candles(bars, "15m")
    assert len(clean) == 30
    assert rejected == []


def test_a_candle_with_missing_keys_is_rejected_not_defaulted():
    bars = _bars(5)
    del bars[2]["high"]
    clean, rejected = _validate_candles(bars, "15m")
    assert len(clean) == 4
    assert "missing or non-numeric" in rejected[0]


@pytest.mark.asyncio
async def test_no_usable_data_yields_no_snapshot_and_a_stated_reason(monkeypatch):
    """The graph continues so the record of WHY survives, rather than aborting."""
    async def empty(symbol, tf, limit=100):
        return []

    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", empty)
    monkeypatch.setattr("backend.graphs.nodes.market.get_price", lambda s: 0.0)

    from backend.graphs.nodes.market import validate_market_data

    out = await validate_market_data(new_state("r", "NOPE/USDT", _trigger(), 0.0))
    assert "market_data" not in out
    assert any("market_data" in u for u in out["unavailable"])
    assert any("no live price" in u for u in out["unavailable"])


@pytest.mark.asyncio
async def test_market_data_is_fetched_once_for_every_timeframe(monkeypatch):
    calls = []

    async def counting(symbol, tf, limit=100):
        calls.append(tf)
        return _bars()

    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", counting)
    monkeypatch.setattr("backend.graphs.nodes.market.get_price", lambda s: 112.0)

    from backend.graphs.nodes.market import validate_market_data

    out = await validate_market_data(new_state("r", "BTC/USDT", _trigger(), 0.0))
    assert calls == list(TIMEFRAMES)
    assert set(out["market_data"].candles) == set(TIMEFRAMES)


@pytest.mark.asyncio
async def test_the_snapshot_timestamp_comes_from_state_not_the_wall_clock(monkeypatch):
    """Section 39.4: a wall-clock read inside a node returns a different value on
    replay, so the resumed run would disagree about when data was fetched."""
    _patch_feeds(monkeypatch)
    from backend.graphs.nodes.market import validate_market_data

    state = new_state("r", "BTC/USDT", _trigger(), 12345.0)
    out = await validate_market_data(state)
    assert out["market_data"].fetched_at == 12345.0


# ===========================================================================
# Feature generation
# ===========================================================================

def test_features_are_computed_from_the_stored_candles():
    out = generate_features(_state_with({PRIMARY_TIMEFRAME: _bars()}))
    t = out["technical_analysis"]
    assert t.trend in ("Bullish", "Bearish", "Ranging")
    assert t.atr is not None and t.atr > 0
    assert t.rsi is not None
    assert t.features["candles_used"] == 120


def test_features_report_unavailable_with_no_snapshot():
    out = generate_features(new_state("r", "BTC/USDT", _trigger(), 0.0))
    assert "technical_analysis" not in out
    assert any("no market data" in u for u in out["unavailable"])


def test_features_report_unavailable_on_thin_data_rather_than_emitting_zeros():
    """A zero ATR would be read downstream as "no volatility"."""
    out = generate_features(_state_with({PRIMARY_TIMEFRAME: _bars(10)}))
    assert "technical_analysis" not in out
    assert any(str(MIN_CANDLES_FOR_STRUCTURE) in u for u in out["unavailable"])


def test_rsi_is_none_not_fifty_when_history_is_short():
    """A neutral-looking 50 is indistinguishable from a measured neutral reading —
    the same bug as fetch_macro_data returning fng=50 on a failure."""
    import numpy as np

    assert _rsi(np.array([100.0] * 5)) is None


def test_support_and_resistance_are_the_nearest_levels_not_the_extremes():
    """min/max of the whole window would give window extremes, which are not
    actionable levels for a stop or target."""
    out = generate_features(_state_with({PRIMARY_TIMEFRAME: _bars(120)}))
    t = out["technical_analysis"]
    price = 100.0 + 119 * 0.1
    if t.support is not None:
        assert t.support < price
    if t.resistance is not None:
        assert t.resistance > price


def test_multi_timeframe_trend_needs_at_least_two_timeframes():
    """A "multi-timeframe" trend from one timeframe is that timeframe's trend
    wearing a more authoritative name."""
    one = generate_features(_state_with({PRIMARY_TIMEFRAME: _bars()}))
    assert one["technical_analysis"].multi_timeframe_trend is None

    many = generate_features(_state_with({tf: _bars() for tf in TIMEFRAMES}))
    assert many["technical_analysis"].multi_timeframe_trend in ("Bullish", "Bearish", "Mixed")


# ===========================================================================
# Regime detection — the Section 7 output
# ===========================================================================

def test_regime_detection_produces_every_spec_field():
    state = _state_with({PRIMARY_TIMEFRAME: _bars()})
    state["technical_analysis"] = generate_features(state)["technical_analysis"]
    r = detect_regime(state)["market_regime"]

    assert r.regime is not None
    assert r.volatility in ("LOW", "MEDIUM", "HIGH")
    assert r.liquidity in ("LOW", "MEDIUM", "HIGH")
    assert 0.0 <= r.trend_strength <= 1.0
    assert 0.0 <= r.confidence <= 1.0


def test_confidence_is_data_coverage_not_a_forecast():
    """The spec shows confidence: 0.87 without defining it. Defined here as the
    fraction of output fields actually computed, which is verifiable — a model's
    belief about being right would not be."""
    full = _state_with({PRIMARY_TIMEFRAME: _bars()})
    full["technical_analysis"] = generate_features(full)["technical_analysis"]
    assert detect_regime(full)["market_regime"].confidence == 1.0

    # 25 candles: enough for regime/vol/liquidity/strength? liquidity needs 20,
    # strength needs 21, regime needs 20 — so all four, still 1.0. Use 16 to drop
    # regime, liquidity and strength but keep volatility.
    thin = _state_with({PRIMARY_TIMEFRAME: _bars(16)})
    partial = detect_regime(thin)["market_regime"]
    assert partial.confidence < 1.0
    assert partial.unavailable


def test_an_unknown_regime_is_reported_unavailable_not_as_a_regime_name():
    """'Unknown' is the classifier saying "not enough history", not a regime."""
    r = detect_regime(_state_with({PRIMARY_TIMEFRAME: _bars(5)}))["market_regime"]
    assert r.regime is None
    assert any("regime" in u for u in r.unavailable)


def test_no_market_data_yields_no_regime_and_a_reason():
    out = detect_regime(new_state("r", "BTC/USDT", _trigger(), 0.0))
    assert out["market_regime"].regime is None
    assert any("no market data" in u for u in out["unavailable"])


def test_volatility_bands_respond_to_actual_dispersion():
    quiet = _bars(60, drift=0.0001, spread=0.01)
    wild = []
    for i in range(60):
        close = 100.0 * (1.06 if i % 2 else 0.94)
        wild.append({"open": close, "high": close * 1.03, "low": close * 0.97,
                     "close": close, "volume": 1000.0})

    assert _volatility_band(quiet)[0] == "LOW"
    assert _volatility_band(wild)[0] == "HIGH"


def test_volatility_is_none_on_insufficient_history():
    assert _volatility_band(_bars(5))[0] is None


def test_liquidity_is_labelled_a_proxy_not_order_book_depth():
    """True liquidity is depth and spread; there is no depth feed. Mislabelling
    volume as liquidity would let a caller size against measured depth that does
    not exist."""
    band, detail = _liquidity_proxy(_bars(40))
    assert band in ("LOW", "MEDIUM", "HIGH")
    assert "NOT order-book depth" in detail


def test_liquidity_is_none_when_no_volume_is_reported():
    bars = [{**b, "volume": 0.0} for b in _bars(40)]
    band, detail = _liquidity_proxy(bars)
    assert band is None
    assert "no volume" in detail


def test_trend_strength_is_price_normalised():
    """An absolute EMA gap would make every high-priced asset look strongly
    trending."""
    cheap = _bars(60, base=0.02, drift=0.0002, spread=0.0002)
    expensive = _bars(60, base=60_000.0, drift=600.0, spread=600.0)
    assert _trend_strength(cheap, None) == pytest.approx(_trend_strength(expensive, None), abs=0.1)


def test_trend_strength_is_unsigned():
    """Direction is carried by technical_analysis.trend. A signed value here would
    give two fields that could disagree about direction."""
    up = _trend_strength(_bars(60, drift=0.5), None)
    down = _trend_strength(_bars(60, drift=-0.5), None)
    assert up >= 0 and down >= 0


# ===========================================================================
# The terminal node
# ===========================================================================

def test_the_terminal_node_does_not_duplicate_the_regime_into_a_second_object():
    """Two representations of one market state can disagree — the exact problem
    TradingState exists to prevent."""
    from backend.graphs.nodes.market import assemble_market_state

    state = _state_with({PRIMARY_TIMEFRAME: _bars()})
    state["technical_analysis"] = generate_features(state)["technical_analysis"]
    state["market_regime"] = detect_regime(state)["market_regime"]
    assert assemble_market_state(state) is None


def test_the_terminal_node_flags_a_run_that_determined_no_regime():
    from backend.graphs.nodes.market import assemble_market_state

    out = assemble_market_state(new_state("r", "BTC/USDT", _trigger(), 0.0))
    assert any("no regime" in u for u in out["unavailable"])


# ===========================================================================
# End to end
# ===========================================================================

@pytest.mark.asyncio
async def test_the_graph_runs_end_to_end_and_returns_the_spec_shape(monkeypatch):
    _patch_feeds(monkeypatch)
    result = await run_market_state_graph("BTC/USDT", _trigger())

    assert result["ok"] is True
    for field in ("regime", "volatility", "liquidity", "trend_strength", "confidence"):
        assert field in result, f"spec Section 7 field '{field}' missing from the result"
    # Section 7's five stages all ran, in order. Checked as a subsequence: Phase 32's
    # `memory_loader` now runs first, and an exact-list assertion fails on any
    # upstream addition regardless of whether Section 7's chain is intact.
    visited = result["nodesVisited"]
    chain = ["data_validation", "feature_generation", "market_analysis",
             "regime_detection", "market_state"]
    positions = [visited.index(n) for n in chain]
    assert positions == sorted(positions), f"Section 7 ran out of order: {visited}"
    assert visited[0] == "memory_loader", "memory must load before anything reads it"
    assert result["errors"] == []


@pytest.mark.asyncio
async def test_the_result_states_what_confidence_and_liquidity_actually_mean(monkeypatch):
    """A consumer must not mistake data coverage for a probability, or a volume
    proxy for measured depth."""
    _patch_feeds(monkeypatch)
    result = await run_market_state_graph("BTC/USDT", _trigger())
    assert "not a forecast" in result["confidenceMeaning"]
    assert "NOT order-book depth" in result["liquidityMeaning"]


@pytest.mark.asyncio
async def test_the_graph_degrades_rather_than_failing_when_macro_is_down(monkeypatch):
    """A dead sentiment feed must not prevent a regime being determined."""
    _patch_feeds(monkeypatch, macro={
        "fng": None, "fng_classification": None, "funding_rate": None,
        "oi": None, "unavailable": ["fng", "funding_rate", "oi"],
    })
    result = await run_market_state_graph("BTC/USDT", _trigger())

    assert result["ok"] is True
    assert result["regime"] is not None          # still determined
    assert result["riskLevel"] == "unknown"      # not "normal"
    assert any("sentiment" in u for u in result["unavailable"])


@pytest.mark.asyncio
async def test_the_graph_never_raises_into_the_caller(monkeypatch):
    """It is invoked from a bus subscriber; an exception would propagate into the
    event bus and disturb agents handling live positions."""
    async def explode(symbol, tf, limit=100):
        raise RuntimeError("feed on fire")

    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", explode)
    monkeypatch.setattr("backend.graphs.nodes.market.get_price", lambda s: 100.0)
    _patch_feeds(monkeypatch)
    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", explode)

    result = await run_market_state_graph("BTC/USDT", _trigger())
    # Either ok with unavailable fields, or a clean ok=False — never an exception.
    assert result["ok"] in (True, False)


# ===========================================================================
# Trigger wiring (Section 14 -> Section 7)
# ===========================================================================

@pytest.mark.asyncio
async def test_an_acted_trigger_starts_a_graph_run(monkeypatch):
    from backend.core.message_bus import MessageBus, get_message_bus
    from backend.models.events import TriggerFiredEvent

    monkeypatch.setattr("backend.core.message_bus._bus", MessageBus())
    _patch_feeds(monkeypatch)

    runs: List[str] = []
    original = run_market_state_graph

    async def spy(symbol, trigger, checkpointer=None, budget=None):
        runs.append(symbol)
        return await original(symbol, trigger, checkpointer, budget)

    monkeypatch.setattr("backend.graphs.market_state.run_market_state_graph", spy)
    subscribe_to_triggers()

    await get_message_bus().publish("TRIGGER_FIRED", TriggerFiredEvent(
        symbol="BTC/USDT", kind="price_move", detail="2.4% move", acted=True,
    ))
    assert runs == ["BTC/USDT"]


@pytest.mark.asyncio
async def test_a_suppressed_trigger_starts_no_run(monkeypatch):
    """The trigger layer already applied debounce and the ceilings; re-deciding
    here would duplicate or contradict that."""
    from backend.core.message_bus import MessageBus, get_message_bus
    from backend.models.events import TriggerFiredEvent

    monkeypatch.setattr("backend.core.message_bus._bus", MessageBus())
    _patch_feeds(monkeypatch)

    runs: List[str] = []

    async def spy(symbol, trigger, checkpointer=None, budget=None):
        runs.append(symbol)
        return {"ok": True}

    monkeypatch.setattr("backend.graphs.market_state.run_market_state_graph", spy)
    subscribe_to_triggers()

    await get_message_bus().publish("TRIGGER_FIRED", TriggerFiredEvent(
        symbol="BTC/USDT", kind="price_move", detail="x", acted=False,
        suppressed_reason="debounced",
    ))
    assert runs == []


@pytest.mark.asyncio
async def test_the_exchange_health_trigger_starts_no_symbol_run(monkeypatch):
    """An exchange event is not about one instrument, so there is no symbol to
    analyse."""
    from backend.core.message_bus import MessageBus, get_message_bus
    from backend.models.events import TriggerFiredEvent

    monkeypatch.setattr("backend.core.message_bus._bus", MessageBus())
    runs: List[str] = []

    async def spy(symbol, trigger, checkpointer=None, budget=None):
        runs.append(symbol)
        return {"ok": True}

    monkeypatch.setattr("backend.graphs.market_state.run_market_state_graph", spy)
    subscribe_to_triggers()

    await get_message_bus().publish("TRIGGER_FIRED", TriggerFiredEvent(
        symbol="__exchange__", kind="exchange_event", detail="down", acted=True,
    ))
    assert runs == []


def test_the_subscription_is_idempotent():
    """Subscribing twice would run the graph twice per trigger, doubling cost for
    an identical result."""
    from backend.core.message_bus import MessageBus
    import backend.core.message_bus as mb

    fresh = MessageBus()
    original = mb._bus
    mb._bus = fresh
    try:
        subscribe_to_triggers()
        subscribe_to_triggers()
        assert len(fresh._subscribers.get("TRIGGER_FIRED", [])) == 1
    finally:
        mb._bus = original


# ===========================================================================
# Rule 0 still holds
# ===========================================================================

def test_the_market_nodes_cannot_reach_the_execution_plane():
    """Re-asserted for the new module specifically. The blanket AST test in
    test_graph_contracts covers backend/graphs/ including nodes/, but this names
    the Phase 24 module so a regression points at the right place."""
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    src = (pathlib.Path(__file__).resolve().parents[1]
           / "backend" / "graphs" / "nodes" / "market.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
            if node.module:
                imported.add(node.module.split(".")[-1])
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)

    assert not (imported & FORBIDDEN_IMPORTS)


@pytest.mark.asyncio
async def test_a_successful_run_is_not_labelled_no_decision(monkeypatch, tmp_path):
    """Phase 24's job is market state, not decisions.

    `finish_run` auto-fills "no decision produced" for graphs that decide. Applying
    that here labelled a completely successful run as though something had gone
    wrong — the kind of misleading trace that makes an operator distrust the whole
    trace store.
    """
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))
    _patch_feeds(monkeypatch)

    await run_market_state_graph("BTC/USDT", _trigger())
    runs = tracing.list_recent_runs(limit=1)
    assert len(runs) == 1
    assert runs[0]["outcome"] == "completed"
    assert runs[0]["no_decision_reason"] is None, (
        f"a successful market-state run should carry no no_decision_reason, got "
        f"{runs[0]['no_decision_reason']!r}"
    )
