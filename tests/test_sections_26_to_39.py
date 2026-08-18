"""Sections 26, 27, 31, 33/35 and 39.5 — the requirements that were genuinely absent.

Each module here answers one spec section that the Sections 14-41 audit found had no
implementation at all. The tests assert the property the section asks for, and — in
every case — that the module refuses to fabricate the parts it cannot measure, because
that refusal is what distinguishes these from the four graphs whose fabrications this
same audit had to remove.
"""

from __future__ import annotations

import asyncio
import math

import pytest


# ===========================================================================
# Section 26 (Phase 43) — Market Graph Intelligence
# ===========================================================================

def _series(n: int, seed: float, noise: float = 0.0) -> list:
    """Deterministic pseudo-returns. No RNG, so the correlations are reproducible."""
    return [
        math.sin((i + seed) / 5.0) * 0.01 + math.cos(i / 3.0) * noise
        for i in range(n)
    ]


def test_the_market_graph_reuses_the_existing_correlation_primitive():
    """`algorithms/portfolio.pearson_correlation` already exists and the CIO's
    exposure cap already uses it. A second correlation implementation would let the
    cap and the graph disagree about whether BTC and ETH move together — the cap
    enforced against one number while the reasoning cites another."""
    import ast
    import inspect

    import backend.algorithms.market_graph as mg

    src = inspect.getsource(mg)
    assert "pearson_correlation" in src
    # No local re-derivation of the coefficient.
    tree = ast.parse(src)
    defined = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert not any("pearson" in name.lower() or "correl" in name.lower()
                   for name in defined), (
        f"market_graph defines its own correlation function: {defined}"
    )


def test_a_pair_with_too_little_history_gets_no_edge():
    """THE honesty property of this module. A missing edge and a measured-zero
    correlation are different facts, and only the second is a finding."""
    from backend.algorithms.market_graph import MIN_OBSERVATIONS, build_market_graph

    graph = build_market_graph({
        "BTC/USDT": _series(MIN_OBSERVATIONS - 1, 0.0),
        "ETH/USDT": _series(MIN_OBSERVATIONS - 1, 0.0),
    })
    assert graph.edges == [], "an unmeasured pair must not produce an edge"
    assert graph.unavailable
    assert "not an independent pair" in graph.unavailable[0]


def test_identical_series_are_recorded_as_correlated():
    from backend.algorithms.market_graph import (
        RELATION_CORRELATED,
        build_market_graph,
    )

    series = _series(100, 0.0)
    graph = build_market_graph({"BTC/USDT": series, "ETH/USDT": list(series)})

    assert len(graph.edges) == 1
    edge = graph.edges[0]
    assert edge.relation == RELATION_CORRELATED
    assert edge.correlation == pytest.approx(1.0, abs=1e-6)
    assert edge.observations == 100


def test_an_inverse_relationship_is_as_strong_as_a_direct_one():
    """A -0.9 correlation is just as useful for reasoning about concentration as
    +0.9 — it is the magnitude that says these two are not independent."""
    from backend.algorithms.market_graph import RELATION_INVERSE, build_market_graph

    series = _series(100, 0.0)
    graph = build_market_graph({
        "BTC/USDT": series,
        "ETH/USDT": [-x for x in series],
    })
    edge = graph.edges[0]
    assert edge.relation == RELATION_INVERSE
    assert edge.correlation < -0.9
    assert edge.weight > 0.9, "weight must be the ABSOLUTE strength"


def test_graph_nodes_are_assets_not_trading_pairs():
    """BTC/USDT and BTC/USDC are the same asset. Treating them as separate nodes
    would put an asset in a cluster with itself."""
    from backend.algorithms.market_graph import build_market_graph

    series = _series(100, 0.0)
    graph = build_market_graph({"BTC/USDT": series, "BTC/USDC": list(series)})
    assert graph.edges == [], "one asset cannot be correlated with itself"


def test_a_flat_series_is_reported_as_undefined_not_uncorrelated():
    from backend.algorithms.market_graph import build_market_graph

    graph = build_market_graph({
        "BTC/USDT": _series(100, 0.0),
        "FLAT/USDT": [0.0] * 100,
    })
    assert graph.edges == []
    assert any("zero variance" in u for u in graph.unavailable)


def test_clusters_group_transitively_related_assets():
    from backend.algorithms.market_graph import build_market_graph

    series = _series(100, 0.0)
    graph = build_market_graph({
        "BTC/USDT": series,
        "ETH/USDT": list(series),
        "SOL/USDT": list(series),
        "IND/USDT": _series(100, 40.0, noise=0.05),
    })
    clusters = graph.clusters()
    assert clusters, "three identical series must form a cluster"
    biggest = max(clusters, key=len)
    assert {"BTC", "ETH", "SOL"} <= set(biggest)


def test_persisting_a_graph_reports_failure_rather_than_raising():
    """Failing to persist a market graph must not fail whatever decision was being
    made."""
    from backend.algorithms.market_graph import MarketGraph, persist_market_graph

    written, error = asyncio.run(persist_market_graph(MarketGraph()))
    assert written == 0
    assert error


# ===========================================================================
# Section 27 (Phase 44) — Institutional Footprint
# ===========================================================================

def _candles(n: int = 40, volume: float = 1000.0, **last) -> list:
    out = []
    for i in range(n):
        price = 100.0 + i * 0.1
        out.append({
            "time": i, "open": price, "high": price + 0.5,
            "low": price - 0.5, "close": price + 0.2, "volume": volume,
        })
    out[-1].update(last)
    return out


def test_all_six_named_signals_are_reported():
    """A result listing three signals reads as though three were all that exist."""
    from backend.algorithms.footprint import FOOTPRINT_SIGNALS, analyse_footprint

    result = analyse_footprint(_candles(), funding_rate=0.0)
    names = [s["name"] for s in result["signals"]]
    assert len(FOOTPRINT_SIGNALS) == 6
    for signal in FOOTPRINT_SIGNALS:
        assert signal in names, f"Section 27 names {signal!r} — it did not report"


def test_the_three_feed_blocked_signals_say_why():
    """Same treatment as the Phase 26 orderflow/liquidity specialists."""
    from backend.algorithms.footprint import analyse_footprint

    result = analyse_footprint(_candles(), funding_rate=0.0)
    by_name = {s["name"]: s for s in result["signals"]}

    for name in ("large_trades", "order_book_changes", "liquidity_absorption"):
        signal = by_name[name]
        assert signal["available"] is False
        assert signal["strength"] is None, "None means not measured, never 0.0"
        assert signal["reasonUnavailable"]

    assert "indistinguishable" in by_name["large_trades"]["reasonUnavailable"]
    assert "depth" in by_name["order_book_changes"]["reasonUnavailable"]
    assert "weaker proxy" in by_name["liquidity_absorption"]["reasonUnavailable"]


def test_no_signal_attributes_activity_to_an_institution():
    """Section 27, emphasised: "Don't claim to know exactly what an institution is
    doing — treat it as probabilistic evidence." A phrase like "smart money is
    accumulating" is unfalsifiable and feels like knowledge."""
    from backend.algorithms.footprint import analyse_footprint

    result = analyse_footprint(_candles(volume=1000.0, volume_last=None), funding_rate=0.004)
    blob = " ".join(
        [str(s.get("observation") or "") for s in result["signals"]]
        + [c for s in result["signals"] for c in s.get("consistentWith", [])]
    ).lower()

    for claim in ("institution", "smart money", "whale", "manipulat"):
        assert claim not in blob, f"attribution language leaked into a signal: {claim!r}"
    assert "probabilistic evidence" in result["attributionMeaning"]


def test_a_volume_anomaly_lists_several_interpretations():
    """A single interpretation would be a conclusion wearing a hedge."""
    from backend.algorithms.footprint import VOLUME_ANOMALY_MULTIPLE, analyse_footprint

    candles = _candles(volume=1000.0)
    candles[-1]["volume"] = 1000.0 * VOLUME_ANOMALY_MULTIPLE * 2

    signal = next(s for s in analyse_footprint(candles)["signals"]
                  if s["name"] == "volume_anomalies")
    assert signal["available"] is True
    assert signal["strength"] > 0
    assert len(signal["consistentWith"]) >= 2, "one interpretation is a conclusion"


def test_ordinary_volume_is_measured_as_zero_strength_not_unavailable():
    """0.0 means measured and found nothing unusual; None means not measured. Both
    exist here and they are different."""
    from backend.algorithms.footprint import analyse_footprint

    signal = next(s for s in analyse_footprint(_candles())["signals"]
                  if s["name"] == "volume_anomalies")
    assert signal["available"] is True
    assert signal["strength"] == 0.0


def test_the_liquidation_signal_names_itself_a_proxy_everywhere():
    """No liquidation feed is subscribed, so the wick/volume shape is a proxy that
    other things also produce."""
    from backend.algorithms.footprint import analyse_footprint

    candles = _candles(volume=1000.0)
    candles[-1].update({"open": 104.0, "close": 104.2, "high": 104.5,
                        "low": 100.0, "volume": 5000.0})
    signal = next(s for s in analyse_footprint(candles)["signals"]
                  if s["name"] == "liquidation_clusters")
    assert signal["available"] is True
    assert "PROXY" in signal["observation"]
    assert len(signal["consistentWith"]) >= 2


def test_funding_is_supplied_never_fetched():
    from backend.algorithms.footprint import analyse_footprint

    absent = next(s for s in analyse_footprint(_candles())["signals"]
                  if s["name"] == "funding_anomalies")
    assert absent["available"] is False
    assert "second market-data path" in absent["reasonUnavailable"]

    present = next(s for s in analyse_footprint(_candles(), funding_rate=0.005)["signals"]
                   if s["name"] == "funding_anomalies")
    assert present["available"] is True
    assert present["strength"] > 0


def test_a_doji_makes_the_wick_ratio_undefined_not_zero():
    from backend.algorithms.footprint import analyse_footprint

    candles = _candles()
    candles[-1].update({"open": 100.0, "close": 100.0, "high": 105.0, "low": 95.0})
    signal = next(s for s in analyse_footprint(candles)["signals"]
                  if s["name"] == "liquidation_clusters")
    assert signal["available"] is False
    assert "undefined" in signal["reasonUnavailable"]


# ===========================================================================
# Section 31 (Phase 48) — External AI Consultation
# ===========================================================================

class _Provider:
    def __init__(self, name, text="AGREE\nBecause the trend is intact.", available=True,
                 fail=False):
        self.name = name
        self.available = available
        self._text = text
        self._fail = fail

    async def complete(self, system, user, tier, max_tokens, temperature):
        from backend.llm.provider import LLMResult

        if self._fail:
            raise RuntimeError("provider exploded")
        return LLMResult(text=self._text, prompt_tokens=10, completion_tokens=20)


def test_the_result_contains_nothing_a_gate_can_read():
    """THE enforcement of "advisory evidence, not authority". No approved, no size,
    no stop_loss, no confidence that sizing consumes — so an external model cannot
    change what happens even if every response agreed."""
    import dataclasses

    from backend.services.ai_consultation import ConsultationResult

    fields = {f.name for f in dataclasses.fields(ConsultationResult)}
    for authority in ("approved", "size", "leverage", "stop_loss", "confidence",
                      "direction", "action", "verdict"):
        assert authority not in fields, (
            f"ConsultationResult.{authority} would turn advice into authority"
        )


def test_nothing_in_graphs_imports_the_consultation_service():
    """`consultation` is not a TradingState field either, so a node cannot write one
    and the Supervisor cannot read one. Wiring it in must be a deliberate diff."""
    import pathlib

    from backend.graphs.state import STATE_FIELDS

    assert not any("consult" in f for f in STATE_FIELDS)

    for path in pathlib.Path("backend/graphs").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "ai_consultation" not in text, (
            f"{path} imports the consultation service — it must stay outside the "
            f"reasoning graph until wiring it is reviewed deliberately"
        )


def test_no_majority_is_computed_from_the_panel():
    """Models trained on overlapping data agreeing is not independent confirmation,
    and collapsing the spread to one number would hide that."""
    from backend.services.ai_consultation import consult

    result = asyncio.run(consult(
        "Is this LONG sound?", "trend up, funding neutral",
        providers=[_Provider("a"), _Provider("b"), _Provider("c")],
    ))
    aggregate = result.aggregate()

    assert aggregate["stances"]["agree"] == 3
    for verdict in ("consensus", "majority", "recommendation", "verdict"):
        assert verdict not in aggregate, f"aggregate() produced a {verdict!r}"
    assert "not authority" in aggregate["authorityMeaning"]
    assert "independent confirmation" in aggregate["consensusMeaning"]


def test_a_single_provider_is_not_reported_as_a_panel():
    """Asking one provider three times is one prior sampled repeatedly. Reporting it
    as multi-model consensus would manufacture agreement."""
    from backend.services.ai_consultation import consult

    result = asyncio.run(consult("q", "view", providers=[_Provider("solo")]))
    assert any("not a panel" in u or "SINGLE outside opinion" in u
               for u in result.unavailable)


def test_no_providers_refuses_rather_than_falling_back():
    from backend.services.ai_consultation import consult

    result = asyncio.run(consult("q", "view", providers=[]))
    assert result.consulted is False
    assert any("no default panel" in u for u in result.unavailable)


def test_one_failing_provider_does_not_lose_the_others():
    from backend.services.ai_consultation import consult

    result = asyncio.run(consult("q", "view", providers=[
        _Provider("good"), _Provider("bad", fail=True), _Provider("also_good"),
    ]))
    assert len(result.responded) == 2
    assert any(o.error for o in result.opinions)


def test_an_unparseable_answer_becomes_unclear_not_agreement():
    """Inferring a stance from prose would be reading agreement into text that does
    not state it."""
    from backend.services.ai_consultation import consult

    result = asyncio.run(consult("q", "view", providers=[
        _Provider("a", text="Well, it depends on several factors."),
        _Provider("b", text="Well, it depends on several factors."),
    ]))
    assert all(o.stance == "unclear" for o in result.responded)
    assert all("did not begin with" in (o.rationale or "") for o in result.responded)


def test_consultation_is_gated_on_genuine_uncertainty():
    """Section 39.6: a multi-model graph can consume tens of thousands of tokens per
    decision. Consulting on every trigger would do that while adding nothing when the
    internal evidence is already one-sided."""
    from backend.services.ai_consultation import (
        CONSULT_CONFIDENCE_CEILING,
        CONSULT_CONFIDENCE_FLOOR,
        should_consult,
    )

    mid = (CONSULT_CONFIDENCE_FLOOR + CONSULT_CONFIDENCE_CEILING) / 2
    assert should_consult(mid)[0] is True
    assert should_consult(CONSULT_CONFIDENCE_FLOOR - 0.01)[0] is False
    assert should_consult(CONSULT_CONFIDENCE_CEILING + 0.01)[0] is False

    # Unmeasured confidence is NOT uncertainty an outside model can resolve.
    consult_it, reason = should_consult(None)
    assert consult_it is False
    assert "cannot substitute for missing evidence" in reason

    # Disagreement overrides the band — it is the case most worth an outside view.
    assert should_consult(CONSULT_CONFIDENCE_CEILING + 0.2, directions_disagree=True)[0] is True


def test_every_should_consult_answer_carries_a_reason():
    from backend.services.ai_consultation import should_consult

    for confidence in (None, 0.0, 0.2, 0.9):
        _, reason = should_consult(confidence)
        assert reason, f"no reason given for confidence={confidence!r}"


# ===========================================================================
# Sections 33 + 35 — Meta-Learning / Graph 7
# ===========================================================================

def test_all_six_meta_questions_are_answered_or_explained():
    from backend.graphs.learning_graph import META_QUESTIONS, run_meta_learning

    report = asyncio.run(run_meta_learning())
    assert len(META_QUESTIONS) == 6
    assert report["questionsTotal"] == 6
    names = [f["question"] for f in report["findings"]]
    for question in META_QUESTIONS:
        assert question in names

    for finding in report["findings"]:
        assert finding["answered"] or finding["reasonUnanswered"], (
            f"{finding['question']} was neither answered nor explained"
        )


def test_meta_learning_writes_nothing_and_has_no_apply_function():
    """CLAUDE.md invariant 5. There is deliberately no apply(), not even disabled."""
    import backend.graphs.learning_graph as lg

    public = {n for n in dir(lg) if not n.startswith("_")}
    for mutator in ("apply", "apply_findings", "deploy", "update_config",
                    "set_risk_config", "promote"):
        assert mutator not in public, f"learning_graph exposes {mutator}()"

    report = asyncio.run(run := lg.run_meta_learning())
    assert "invariant 5" in report["deploymentMeaning"]
    assert "writes to nothing" in report["deploymentMeaning"]


def test_a_finding_is_withheld_below_the_sample_floor():
    """A confident claim about the system's own reliability from four trades would be
    the most persuasive wrong answer this module could produce."""
    from backend.graphs.learning_graph import (
        MIN_TRADES_FOR_FINDING,
        _systematically_wrong,
    )

    tiny = [{"side": "buy", "is_win": False, "pnl": -1.0}] * 4
    finding = _systematically_wrong(tiny, None)
    assert finding.answered is False
    assert finding.sample_size == 4
    assert str(MIN_TRADES_FOR_FINDING) in finding.reason_unanswered


def test_a_directional_bias_is_reported_once_the_sample_is_large_enough():
    from backend.graphs.learning_graph import _systematically_wrong

    ledger = (
        [{"side": "buy", "is_win": True, "pnl": 1.0}] * 15
        + [{"side": "sell", "is_win": False, "pnl": -1.0}] * 15
    )
    finding = _systematically_wrong(ledger, None)
    assert finding.answered is True
    assert "sell" in finding.finding
    assert "below break-even" in finding.finding
    assert finding.sample_size == 30


def test_degradation_is_a_trend_not_a_low_win_rate():
    """A strategy that always lost is not degrading — that is a different finding
    with a different response."""
    from backend.graphs.learning_graph import _degrading_strategies

    # Good early, bad recent -> degrading.
    degrading = (
        [{"strategies": ["Trend"], "is_win": True}] * 10
        + [{"strategies": ["Trend"], "is_win": False}] * 10
    )
    result = _degrading_strategies(degrading, None)
    assert result.answered is True
    assert "Trend" in result.finding

    # Consistently bad -> NOT degrading.
    flat = [{"strategies": ["Grid"], "is_win": False}] * 20
    result2 = _degrading_strategies(flat, None)
    assert result2.answered is True
    assert "Grid" not in (result2.finding or "")


def test_calibration_refuses_to_derive_accuracy_from_pnl():
    """P&L magnitude is not prediction accuracy — a lucky win on a wrong read would
    score as well calibrated. Same limitation reflection_agent documents."""
    from backend.graphs.learning_graph import _confidence_calibration

    ledger = [{"side": "buy", "is_win": True, "pnl": 500.0}] * 40
    finding = _confidence_calibration(ledger, None)

    assert finding.answered is False
    assert "cannot be derived from P&L" in finding.reason_unanswered
    assert "record entry confidence" in finding.reason_unanswered


def test_failing_conditions_names_the_missing_field_rather_than_inferring_it():
    from backend.graphs.learning_graph import _failing_conditions

    ledger = [{"side": "buy", "is_win": False, "pnl": -1.0}] * 40
    finding = _failing_conditions(ledger, None)
    assert finding.answered is False
    assert "regime at entry" in finding.reason_unanswered
    assert "rather than inferring it afterwards" in finding.reason_unanswered


def test_data_source_reliability_is_answerable_from_the_unavailable_discipline():
    """The question the system is best equipped to answer, because every component
    already records what it could not measure."""
    from backend.graphs.learning_graph import _unreliable_data_sources

    traces = [
        {"unavailable": ["news specialist (no feed)", "liquidity specialist (no depth)"]},
        {"unavailable": ["news specialist (no feed)"]},
        {"unavailable": []},
    ]
    finding = _unreliable_data_sources(traces, None)
    assert finding.answered is True
    assert "news specialist" in finding.finding
    assert any("2/3" in e for e in finding.evidence)


def test_agent_disagreement_admits_it_measures_reliability_instead():
    """Traces record nodes and errors, not stances. Reporting node reliability AS
    disagreement would answer a different question than the one asked."""
    from backend.graphs.learning_graph import _agent_disagreement

    finding = _agent_disagreement([{"errors": ["specialist_news: boom"]}], None)
    assert finding.answered is True
    assert any("not specialist disagreement" in e for e in finding.evidence)


def test_an_unreadable_source_is_reported_not_treated_as_empty():
    from backend.graphs.learning_graph import _systematically_wrong

    finding = _systematically_wrong([], "trade ledger unreadable: disk on fire")
    assert finding.answered is False
    assert "disk on fire" in finding.reason_unanswered


# ===========================================================================
# Section 39.5 — streaming
# ===========================================================================

def test_streaming_yields_one_event_per_node():
    """39.5: "the AI is currently in multi_agent_analysis, 4 of 6 specialists
    reporting" — the live visibility that makes a 24/7 system watchable."""
    from backend.graphs.runtime import stream_run

    class FakeGraph:
        nodes = {"a": 1, "b": 2}

        async def astream(self, state, config=None):
            yield {"a": {"unavailable": ["x"]}}
            yield {"b": {"errors": []}}

    async def collect():
        return [event async for event in stream_run(FakeGraph(), {})]

    events = asyncio.run(collect())
    assert [e["node"] for e in events] == ["a", "b"]
    assert [e["progress"] for e in events] == [1, 2]
    assert events[0]["total"] == 2
    assert events[0]["unavailableCount"] == 1


def test_streaming_reports_counts_not_the_whole_state():
    """The state holds candles, findings and a portfolio snapshot. Streaming it per
    node would push megabytes over a WebSocket for a 19-node run."""
    from backend.graphs.runtime import stream_run

    class FakeGraph:
        nodes = {"a": 1}

        async def astream(self, state, config=None):
            yield {"a": {"market_data": "a very large object", "unavailable": ["x", "y"]}}

    async def collect():
        return [event async for event in stream_run(FakeGraph(), {})]

    event = asyncio.run(collect())[0]
    assert event["wroteKeys"] == ["market_data", "unavailable"]
    assert event["unavailableCount"] == 2
    assert "a very large object" not in str(event)


def test_a_broken_stream_yields_an_error_event_rather_than_raising():
    """The run itself may still have completed; only the stream broke. A dashboard
    should show "streaming stopped", not have its connection die."""
    from backend.graphs.runtime import stream_run

    class FakeGraph:
        nodes = {"a": 1}

        async def astream(self, state, config=None):
            yield {"a": {}}
            raise RuntimeError("socket died")

    async def collect():
        return [event async for event in stream_run(FakeGraph(), {})]

    events = asyncio.run(collect())
    assert events[-1]["streamError"] == "socket died"
    assert events[-1]["progress"] == 1


def test_streaming_is_separate_from_the_invoking_runners():
    """`ainvoke` returns a final state and `astream` returns a sequence of updates.
    One function doing both would return a union every caller has to branch on."""
    import inspect

    from backend.graphs import analysis, runtime

    assert inspect.isasyncgenfunction(runtime.stream_run)
    assert "astream" not in inspect.getsource(analysis.run_analysis_graph), (
        "the invoking runner must stay an invoking runner"
    )
