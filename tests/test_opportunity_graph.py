"""Section 8 / Phase 25 — the Trading Opportunity Graph.

    Market State -> Strategy Candidates -> Strategy Scoring
                 -> Opportunity Detection -> Trade Thesis

    Trend Following 0.91 · Breakout 0.84 · Mean Reversion 0.32
    -> Selected: Trend Following

This is where the first LLM node lands, so the tests that matter most are the ones
proving it cannot reach the numbers. `test_the_narrative_contract_cannot_declare_a_write_to_the_thesis`
is the load-bearing one: it asserts the contract system REFUSES to build such a
node, rather than trusting that nobody writes one.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from backend.algorithms.strategy_profiles import STRATEGY_PROFILES
from backend.graphs.contracts import NodeContract
from backend.graphs.nodes.opportunity import (
    HISTORICAL_UNAVAILABLE,
    MIN_SCORE_TO_SELECT,
    WEIGHT_SIGNAL,
    WEIGHT_TREND_ALIGN,
    WEIGHT_VOL_FIT,
    _gather_evidence,
    _narrative_prompt,
    _score_one,
    _volatility_fit,
    detect_opportunity,
    enumerate_candidates,
    narrate_thesis,
    score_candidates,
)
from backend.graphs.opportunity import (
    opportunity_config,
    reset_subscription,
    run_opportunity_graph,
    subscribe_to_triggers,
)
from backend.graphs.registry import all_contracts, clear_registry, get_contract
from backend.graphs.state import (
    DETERMINISTIC_ONLY_FIELDS,
    MarketRegimeState,
    MarketSnapshot,
    StrategyCandidate,
    TechnicalAnalysis,
    TradeThesis,
    TradingState,
    TriggerReason,
    new_state,
)
from backend.llm.provider import LLMProvider, LLMResult, ModelTier, reset_provider, set_provider


@pytest.fixture(autouse=True)
def _clean():
    clear_registry()
    reset_subscription()
    reset_provider()
    yield
    clear_registry()
    reset_subscription()
    reset_provider()


def _bars(n=120, base=100.0, drift=0.1, spread=1.0, volume=1000.0) -> List[Dict[str, Any]]:
    return [
        {"openTime": i * 900_000, "open": base + i * drift - drift,
         "high": base + i * drift + spread, "low": base + i * drift - spread,
         "close": base + i * drift, "volume": volume}
        for i in range(n)
    ]


def _trigger(symbol="BTC/USDT"):
    return TriggerReason(kind="price_move", symbol=symbol, detail="2.4% move",
                         observed_value=2.4, threshold=2.0)


def _full_state(
    regime="Trending Bullish",
    atr=1.5,
    price=112.0,
    mtf="Bullish",
    volatility="MEDIUM",
    confidence=1.0,
) -> TradingState:
    s = new_state("run", "BTC/USDT", _trigger(), 0.0)
    s["market_data"] = MarketSnapshot(symbol="BTC/USDT", price=price, candles={"15m": _bars()})
    s["technical_analysis"] = TechnicalAnalysis(
        trend="Bullish", multi_timeframe_trend=mtf, atr=atr, rsi=55.0,
        support=105.0, resistance=120.0,
    )
    s["market_regime"] = MarketRegimeState(
        regime=regime, volatility=volatility, liquidity="MEDIUM",
        trend_strength=0.7, confidence=confidence,
    )
    return s


class _StubProvider(LLMProvider):
    """A provider that returns fixed text, so LLM-path tests are deterministic."""

    def __init__(self, text: Optional[str] = "Narrative text.", error: Optional[str] = None):
        self._text = text
        self._error = error
        self.calls: List[Dict[str, str]] = []

    @property
    def name(self) -> str:
        return "stub"

    @property
    def available(self) -> bool:
        return True

    async def complete(self, *, system, user, tier, max_tokens=1024, temperature=0.0):
        self.calls.append({"system": system, "user": user, "tier": tier})
        if self._error:
            return LLMResult(text=None, tier=tier, error=self._error, prompt_tokens=50)
        return LLMResult(text=self._text, tier=tier, model="stub",
                         prompt_tokens=100, completion_tokens=40)


# ===========================================================================
# RULE 0 AT THE LLM BOUNDARY — the load-bearing tests
# ===========================================================================

def test_the_narrative_contract_cannot_declare_a_write_to_the_thesis():
    """The whole reason `thesis_narrative` is a separate state field.

    State writes are enforced per KEY. If the narrative lived inside
    `TradeThesis`, the model would write the whole object and could change the
    stop-loss it was asked to describe — and no contract could stop it.
    """
    with pytest.raises(ValueError, match="may not write"):
        NodeContract(
            name="sneaky_narrator",
            reads=("trade_thesis",),
            writes=("trade_thesis",),
            purpose="narrate",
            deterministic=False,
            may_call_llm=True,
        )


def test_the_thesis_and_the_scores_are_deterministic_only_fields():
    for field in ("trade_thesis", "selected_strategy", "candidate_strategies", "confidence"):
        assert field in DETERMINISTIC_ONLY_FIELDS


def test_the_narrative_node_writes_only_the_narrative():
    opportunity_config()
    contract = get_contract("trade_thesis_narrative")
    assert contract is not None
    assert contract.writes == ("thesis_narrative",)
    assert contract.may_call_llm is True
    assert contract.deterministic is False


def test_exactly_one_node_in_the_graph_may_call_a_model():
    """Eight of nine stages are computation. A drift toward LLM nodes is the
    failure mode the plan names as most likely, so the ratio is asserted."""
    opportunity_config()
    contracts = all_contracts()
    llm = [c.name for c in contracts if c.may_call_llm]
    # THE assertion that matters: exactly one node may reach a model, and it is the
    # narrator. The total node count is not the property — it grew when Phase 32
    # added `memory_loader` — but the LLM RATIO is, so that is what is pinned.
    assert llm == ["trade_thesis_narrative"]
    assert len(contracts) >= 9
    assert sum(1 for c in contracts if c.may_call_llm) == 1


def test_the_prompt_contains_no_raw_candle_data():
    """Handing over the market would invite the model to form its own view, and
    its view is not what is being asked for.

    The thesis is constructed directly rather than via detect_opportunity: this
    test is about the PROMPT, and routing through detection would make it depend
    on whether a strategy happened to signal on the synthetic series.
    """
    state = _full_state()
    thesis = TradeThesis(
        direction="LONG", strategy="Trend", entry_price=112.0,
        stop_loss=109.75, take_profit=116.5,
        supporting_evidence=["15m trend is Bullish"],
        contradicting_evidence=["high-volatility regime widens the stop"],
    )
    prompt = _narrative_prompt(state, thesis)
    assert "openTime" not in prompt
    assert "volume" not in prompt.lower() or "volume proxy" in prompt.lower()


def test_the_prompt_tells_the_model_not_to_invent_or_restate_numbers():
    """The DebateVisualizer lesson: a model given room to invent supporting
    detail will produce "EMA 9 crossed above EMA 21" whether or not it did."""
    state = _full_state()
    thesis = TradeThesis(
        direction="LONG", strategy="Trend", entry_price=112.0,
        stop_loss=109.75, take_profit=116.5,
        contradicting_evidence=["macro risk elevated"],
    )
    prompt = _narrative_prompt(state, thesis)
    assert "Evidence contradicting:" in prompt
    # The unmeasured inputs are named so the model states them as unknown.
    state["unavailable"] = ["macro risk level could not be measured"]
    assert "do not infer" in _narrative_prompt(state, thesis)


# ===========================================================================
# 1. Strategy candidates
# ===========================================================================

def test_every_strategy_is_listed_not_just_the_eligible_ones():
    """"Mean Reversion did not compete because the market is trending" and
    "Mean Reversion is absent" are different facts."""
    out = enumerate_candidates(_full_state(regime="Trending Bullish"))
    candidates = out["candidate_strategies"]
    assert len(candidates) == len(STRATEGY_PROFILES), (
        'every profiled strategy must be listed, including the gated-out ones — '
        'a gated strategy being ABSENT and being MUTED are different facts and only '
        'one of them is explainable'
    )
    assert any(not c.eligible for c in candidates)


def test_a_gated_out_candidate_carries_its_own_worst_conditions():
    out = enumerate_candidates(_full_state(regime="Trending Bullish"))
    mr = next(c for c in out["candidate_strategies"] if c.name == "MeanReversion")
    assert mr.eligible is False
    assert "muted in 'Trending Bullish'" in mr.gated_out_reason
    # The reason is the profile's own text, not a generic message.
    assert "trend" in mr.gated_out_reason.lower()


def test_mean_reversion_and_grid_are_gated_out_of_a_trend():
    out = enumerate_candidates(_full_state(regime="Trending Bullish"))
    gated = {c.name for c in out["candidate_strategies"] if not c.eligible}
    assert {"MeanReversion", "Grid", "Range"} <= gated


def test_no_regime_gates_nothing_and_says_so():
    """Muting everything when the classifier lacks history would silently stop
    the system reasoning when a new symbol starts up."""
    state = _full_state()
    state["market_regime"] = MarketRegimeState(regime=None)
    out = enumerate_candidates(state)
    assert all(c.eligible for c in out["candidate_strategies"])
    assert any("no regime" in u for u in out["unavailable"])


# ===========================================================================
# 2. Scoring
# ===========================================================================

def test_the_score_weights_sum_to_one():
    """So a score reads directly as 0-1, matching the spec's 0.91 / 0.84 / 0.32."""
    assert WEIGHT_SIGNAL + WEIGHT_TREND_ALIGN + WEIGHT_VOL_FIT == pytest.approx(1.0)


def test_scoring_always_reports_that_track_record_was_excluded():
    """All 9 profiles carry historical_success_rate=None. A score that silently
    included an invented win rate would be the most persuasive fabrication in the
    system, because it would look like evidence."""
    state = _full_state()
    state.update(enumerate_candidates(state))
    out = score_candidates(state)
    assert any(HISTORICAL_UNAVAILABLE == u for u in out["unavailable"])


def test_a_gated_out_candidate_keeps_score_none_not_zero():
    """Zero reads as "scored and found worthless" when it was never scored."""
    state = _full_state(regime="Trending Bullish")
    state.update(enumerate_candidates(state))
    out = score_candidates(state)
    mr = next(c for c in out["candidate_strategies"] if c.name == "MeanReversion")
    assert mr.eligible is False
    assert mr.score is None


def test_a_hold_signal_scores_zero_on_the_signal_component():
    """HOLD is not a weak buy — it is the strategy declining to act, and a
    strategy with no opinion should not compete for selection."""
    flat = [{"open": 100.0, "high": 100.1, "low": 99.9, "close": 100.0, "volume": 1000.0}] * 120
    score, detail = _score_one("Trend", flat, "Bullish", "LOW")
    assert "HOLD" in detail
    assert score <= WEIGHT_TREND_ALIGN + WEIGHT_VOL_FIT


def test_a_broken_strategy_scores_none_not_zero(monkeypatch):
    """It was not evaluated. Zero would rank it against strategies that were."""
    from backend.agents import strategy_ensemble

    def boom(_bars):
        raise RuntimeError("exploded")

    monkeypatch.setitem(strategy_ensemble.STRATEGY_FUNCTIONS, "Trend", boom)
    score, detail = _score_one("Trend", _bars(), "Bullish", "MEDIUM")
    assert score is None
    assert "errored" in detail


def test_an_unknown_higher_timeframe_contributes_neutrally_not_zero():
    """Scoring a missing measurement as a failure would systematically penalise
    every strategy whenever higher-timeframe data was thin."""
    score_known, _ = _score_one("Trend", _bars(), "Bullish", "MEDIUM")
    score_unknown, detail = _score_one("Trend", _bars(), None, "MEDIUM")
    assert "neutral contribution" in detail
    assert score_unknown is not None
    assert score_unknown < score_known


def test_volatility_fit_is_derived_from_the_profiles_own_regimes():
    """One source of truth: a strategy declaring the high-volatility regime is by
    its own account suited to it. A separate table could disagree with the gate."""
    high_ok, detail_ok = _volatility_fit("Scalping", "HIGH")
    high_bad, detail_bad = _volatility_fit("Swing", "HIGH")
    assert high_ok > high_bad
    assert "suits" in detail_ok


def test_unknown_volatility_contributes_neutrally():
    fit, detail = _volatility_fit("Trend", None)
    assert fit == 0.5
    assert "unknown" in detail


def test_a_weak_best_score_selects_nothing_rather_than_the_least_bad():
    """The highest of several weak scores is still a weak setup, and proposing it
    would turn "nothing is happening" into a trade."""
    state = _full_state()
    state["candidate_strategies"] = [
        StrategyCandidate(name="Trend", eligible=True),
    ]
    flat = [{"open": 100.0, "high": 100.05, "low": 99.95, "close": 100.0, "volume": 1.0}] * 120
    state["market_data"] = MarketSnapshot(symbol="BTC/USDT", price=100.0, candles={"15m": flat})

    out = score_candidates(state)
    if "selected_strategy" in out:
        assert out["selected_strategy"].score >= MIN_SCORE_TO_SELECT
    else:
        assert any("below the" in u for u in out["unavailable"])


def test_scoring_with_no_market_data_reports_unavailable():
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    state["candidate_strategies"] = [StrategyCandidate(name="Trend", eligible=True)]
    out = score_candidates(state)
    assert any("no market data" in u for u in out["unavailable"])


# ===========================================================================
# 3. Opportunity detection — invariant 3 at the cognitive layer
# ===========================================================================

def test_no_atr_means_no_opportunity():
    """Invariant 3. A thesis with no computable stop is a hope, not an
    opportunity — and catching it here means it appears in traces as a setup that
    was never viable, rather than as a trade the risk layer rejected."""
    state = _full_state(atr=None)
    state["selected_strategy"] = StrategyCandidate(name="Trend", score=0.8, eligible=True)
    out = detect_opportunity(state)
    assert "trade_thesis" not in out
    assert any("no ATR" in u and "stop-loss" in u for u in out["unavailable"])


def test_no_price_means_no_opportunity():
    state = _full_state()
    state["market_data"] = MarketSnapshot(symbol="BTC/USDT", price=None, candles={"15m": _bars()})
    state["selected_strategy"] = StrategyCandidate(name="Trend", score=0.8, eligible=True)
    out = detect_opportunity(state)
    assert any("no price" in u for u in out["unavailable"])


def test_no_selected_strategy_means_no_opportunity():
    out = detect_opportunity(_full_state())
    assert any("no strategy was selected" in u for u in out["unavailable"])


def test_a_thesis_carries_a_stop_on_the_protective_side():
    state = _full_state()
    state["selected_strategy"] = StrategyCandidate(name="Trend", score=0.8, eligible=True)
    out = detect_opportunity(state)
    thesis = out.get("trade_thesis")
    if thesis is None:
        pytest.skip("the Trend strategy did not signal on this synthetic series")
    if thesis.direction == "LONG":
        assert thesis.stop_loss < thesis.entry_price < thesis.take_profit
    else:
        assert thesis.take_profit < thesis.entry_price < thesis.stop_loss


def test_the_thesis_narrative_starts_none_not_empty():
    """An empty string would read as "the model had nothing to say"."""
    state = _full_state()
    state["selected_strategy"] = StrategyCandidate(name="Trend", score=0.8, eligible=True)
    out = detect_opportunity(state)
    if out.get("trade_thesis"):
        assert out["trade_thesis"].narrative is None


# ===========================================================================
# Evidence gathering
# ===========================================================================

def test_evidence_is_gathered_from_state_not_invented():
    """The DebateVisualizer bug in reverse: the LLM narrates real evidence
    because the evidence is computed before it is asked."""
    state = _full_state(mtf="Bearish")
    for_, against = _gather_evidence(state, "buy", "Trend")
    assert any("multi-timeframe trend is Bearish" in a for a in against)
    assert any("15m trend is Bullish" in f for f in for_)


def test_low_data_coverage_is_evidence_against_acting():
    """This is why confidence was defined as coverage in Phase 24 — so it can be
    used as evidence rather than mistaken for a probability."""
    state = _full_state(confidence=0.5)
    _, against = _gather_evidence(state, "buy", "Trend")
    assert any("confidence 0.50" in a for a in against)


def test_an_unmeasured_macro_risk_level_is_evidence_against():
    state = _full_state()
    from backend.graphs.state import SentimentAnalysis

    state["sentiment_analysis"] = SentimentAnalysis(risk_level="unknown")
    _, against = _gather_evidence(state, "buy", "Trend")
    assert any("could not be measured" in a for a in against)


def test_an_overbought_rsi_is_evidence_against_a_long():
    state = _full_state()
    state["technical_analysis"].rsi = 78.0
    _, against = _gather_evidence(state, "buy", "Trend")
    assert any("overbought" in a for a in against)


# ===========================================================================
# 4. The LLM node
# ===========================================================================

@pytest.mark.asyncio
async def test_no_thesis_means_no_model_call():
    """Most runs end without an opportunity; spending a call on nothing would be
    the single easiest way to waste the budget."""
    stub = _StubProvider()
    set_provider(stub)
    assert await narrate_thesis(new_state("r", "BTC/USDT", _trigger(), 0.0)) is None
    assert stub.calls == []


@pytest.mark.asyncio
async def test_an_unconfigured_provider_degrades_with_a_stated_reason():
    """A thesis without prose is still a complete, tradeable thesis — the numbers
    were never the model's to produce."""
    reset_provider()  # NullProvider
    state = _full_state()
    state["trade_thesis"] = TradeThesis(direction="LONG", strategy="Trend",
                                        entry_price=100.0, stop_loss=98.0, take_profit=104.0)
    out = await narrate_thesis(state)
    assert "thesis_narrative" not in out
    assert any("no LLM provider configured" in u for u in out["unavailable"])
    assert any("numbers are unaffected" in u for u in out["unavailable"])


@pytest.mark.asyncio
async def test_a_successful_call_writes_only_the_narrative():
    stub = _StubProvider(text="  Trend is up and the stop is close.  ")
    set_provider(stub)
    state = _full_state()
    state["trade_thesis"] = TradeThesis(direction="LONG", strategy="Trend",
                                        entry_price=100.0, stop_loss=98.0, take_profit=104.0)
    out = await narrate_thesis(state)

    assert out["thesis_narrative"] == "Trend is up and the stop is close."
    # It cannot have touched the numbers.
    assert "trade_thesis" not in out
    assert out["llm_calls_made"] == 1
    assert out["llm_tokens_used"] == 140


@pytest.mark.asyncio
async def test_a_failed_call_still_consumes_budget():
    """Not counting a failure would let a node retry indefinitely in one run."""
    set_provider(_StubProvider(text=None, error="timeout"))
    state = _full_state()
    state["trade_thesis"] = TradeThesis(direction="LONG", strategy="Trend",
                                        entry_price=100.0, stop_loss=98.0, take_profit=104.0)
    out = await narrate_thesis(state)

    assert "thesis_narrative" not in out
    assert out["llm_calls_made"] == 1
    assert out["llm_tokens_used"] == 50
    assert any("model call failed: timeout" in u for u in out["unavailable"])


@pytest.mark.asyncio
async def test_the_narrative_uses_the_narrative_tier_not_the_reasoning_tier():
    """Section 39.6: reserve the strongest model for the Supervisor and debate.
    Narration over computed evidence does not need it."""
    stub = _StubProvider()
    set_provider(stub)
    state = _full_state()
    state["trade_thesis"] = TradeThesis(direction="LONG", strategy="Trend",
                                        entry_price=100.0, stop_loss=98.0, take_profit=104.0)
    await narrate_thesis(state)
    assert stub.calls[0]["tier"] == ModelTier.NARRATIVE


# ===========================================================================
# The graph
# ===========================================================================

def test_the_graph_contains_both_phases():
    """Phase 24's chain then Phase 25's, in that order.

    Indexed slices were brittle by construction — Phase 32 prepended
    `memory_loader` and both slices shifted, failing a test whose property was
    unaffected. Asserted by relative position instead.
    """
    cfg = opportunity_config()
    phase_24 = ["data_validation", "feature_generation", "market_analysis",
                "regime_detection", "market_state"]
    phase_25 = ["strategy_candidates", "strategy_scoring",
                "opportunity_detection", "trade_thesis_narrative"]

    for stage in phase_24 + phase_25:
        assert stage in cfg.nodes, f"{stage} is missing from the graph"

    positions = [cfg.nodes.index(n) for n in phase_24 + phase_25]
    assert positions == sorted(positions), (
        f"Phase 24 must precede Phase 25; got {cfg.nodes}"
    )
    cfg.validate()


def test_the_graph_exits_early_when_nothing_is_selected():
    cfg = opportunity_config()
    scoring = next(ce for ce in cfg.conditional_edges if ce.source == "strategy_scoring")
    from langgraph.graph import END

    assert scoring.destinations["no_opportunity"] == END


def test_the_narrative_node_is_skipped_when_there_is_no_thesis():
    """Checked by a router, not inside the node: an entered-then-returned node
    still costs a superstep and a checkpoint write, and appears in the trace as
    though it ran."""
    cfg = opportunity_config()
    opp = next(ce for ce in cfg.conditional_edges if ce.source == "opportunity_detection")
    from langgraph.graph import END

    assert opp.destinations["no_opportunity"] == END
    assert opp.destinations["narrate"] == "trade_thesis_narrative"


def _patch_feeds(monkeypatch, price=112.0):
    async def fake_klines(symbol, tf, limit=100):
        return _bars()

    async def fake_macro():
        return {"fng": 55, "fng_classification": "Greed", "funding_rate": 0.0001,
                "oi": 1_000.0, "unavailable": []}

    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", fake_klines)
    monkeypatch.setattr("backend.graphs.nodes.market.get_price", lambda s: price)
    monkeypatch.setattr("backend.agents.sentiment_agent.fetch_macro_data", fake_macro)


@pytest.mark.asyncio
async def test_the_graph_runs_end_to_end(monkeypatch, tmp_path):
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))
    _patch_feeds(monkeypatch)
    set_provider(_StubProvider())

    result = await run_opportunity_graph("BTC/USDT", _trigger())

    assert result["ok"] is True
    assert "candidates" in result
    assert len(result["candidates"]) == len(STRATEGY_PROFILES)
    assert "hasOpportunity" in result
    # Market-state fields still present — one run, one snapshot.
    assert "regime" in result and "confidence" in result


@pytest.mark.asyncio
async def test_the_result_reports_the_losing_candidates_with_their_scores(monkeypatch, tmp_path):
    """The spec's own example shows Mean Reversion at 0.32. "Trend Following was
    chosen over Breakout 0.84" is a different statement from "Trend Following was
    chosen"."""
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))
    _patch_feeds(monkeypatch)
    set_provider(_StubProvider())

    result = await run_opportunity_graph("BTC/USDT", _trigger())
    names = {c["name"] for c in result["candidates"]}
    assert len(names) == len(STRATEGY_PROFILES)
    # Exactly nine entries, not eighteen — the candidate list is REPLACED by the
    # scoring node, not appended to. See the reducer note in state.py.
    assert len(result["candidates"]) == len(STRATEGY_PROFILES)
    # Every eligible candidate carries a score; every ineligible one carries the
    # reason it was muted. Neither may be silently blank.
    for c in result["candidates"]:
        if c["eligible"]:
            assert c["score"] is not None, f"{c['name']} is eligible but unscored"
        else:
            assert c["gatedOutReason"], f"{c['name']} is muted with no reason"


@pytest.mark.asyncio
async def test_the_result_states_what_the_narrative_is(monkeypatch, tmp_path):
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))
    _patch_feeds(monkeypatch)
    set_provider(_StubProvider())

    result = await run_opportunity_graph("BTC/USDT", _trigger())
    assert "structurally unable to alter" in result["narrativeMeaning"]


@pytest.mark.asyncio
async def test_a_run_with_no_opportunity_is_not_an_error(monkeypatch, tmp_path):
    """No opportunity is the expected outcome of most runs."""
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))

    async def empty(symbol, tf, limit=100):
        return []

    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", empty)
    monkeypatch.setattr("backend.graphs.nodes.market.get_price", lambda s: 0.0)

    result = await run_opportunity_graph("NOPE/USDT", _trigger("NOPE/USDT"))
    assert result["ok"] is True
    assert result["hasOpportunity"] is False
    assert result["unavailable"]


@pytest.mark.asyncio
async def test_no_model_call_happens_when_no_opportunity_is_found(monkeypatch, tmp_path):
    """The early-exit router must actually prevent the spend."""
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))

    async def empty(symbol, tf, limit=100):
        return []

    monkeypatch.setattr("backend.graphs.nodes.market.fetch_klines", empty)
    monkeypatch.setattr("backend.graphs.nodes.market.get_price", lambda s: 0.0)
    stub = _StubProvider()
    set_provider(stub)

    result = await run_opportunity_graph("NOPE/USDT", _trigger("NOPE/USDT"))
    assert result["llmCallsMade"] == 0
    assert stub.calls == []


# ===========================================================================
# Trigger wiring
# ===========================================================================

def test_the_subscription_is_idempotent():
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


def test_the_opportunity_nodes_cannot_reach_the_execution_plane():
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    src = (pathlib.Path(__file__).resolve().parents[1]
           / "backend" / "graphs" / "nodes" / "opportunity.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
            if node.module:
                imported.add(node.module.split(".")[-1])
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)
    assert not (imported & FORBIDDEN_IMPORTS)
