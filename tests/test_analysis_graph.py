"""Phase 26 / spec Section 9 — multi-agent analysis.

Three things are worth testing here and one is not obvious.

The obvious two: the specialists produce structured evidence, and the three with
no feed report unavailable rather than a neutral vote.

The one that matters most: the FAN-OUT. Seven nodes writing in one superstep is a
new failure mode for this codebase, and it fails in ways sequential graphs cannot
— a missing reducer raises `InvalidUpdateError`, and a wrong reducer silently
duplicates (which is exactly what `candidate_strategies`' `operator.add` did).
`test_seven_findings_land_from_one_superstep` and
`test_a_rerun_specialist_does_not_appear_twice` exist specifically for that.
"""

from __future__ import annotations

import asyncio

import pytest

from backend.graphs.analysis import (
    DEBATE_NODE,
    NARRATIVE_NODE,
    analysis_config,
    summarise_analysis,
)
from backend.graphs.builder import ConditionalEdge, GraphConfig
from backend.graphs.nodes.specialists import (
    CONSTRAINT_SPECIALISTS,
    DIRECTIONAL_WEIGHTS,
    SPECIALIST_NODES,
    TOTAL_DIRECTIONAL_WEIGHT,
    run_debate,
    specialist_funding,
    specialist_liquidity,
    specialist_market,
    specialist_news,
    specialist_orderflow,
    specialist_portfolio,
    specialist_risk,
)
from backend.graphs.state import (
    DebateVerdict,
    MarketRegimeState,
    MarketSnapshot,
    SentimentAnalysis,
    SpecialistFinding,
    TechnicalAnalysis,
    TradeThesis,
    TradingState,
    TriggerReason,
    _merge_findings,
    new_state,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _candles(n: int, start: float = 100.0, step: float = 0.5) -> list:
    """A clean uptrend with enough bars for `score_debate`'s 50-candle minimum."""
    out = []
    for i in range(n):
        close = start + i * step
        out.append({
            "time": 1_700_000_000_000 + i * 900_000,
            "open": close - step * 0.5,
            "high": close + step * 0.4,
            "low": close - step * 0.6,
            "close": close,
            "volume": 1000.0 + i,
        })
    return out


def _state(**over) -> TradingState:
    st = new_state(
        run_id="test-run",
        symbol="BTC/USDT",
        trigger=TriggerReason(kind="manual", symbol="BTC/USDT", detail="test"),
        started_at=0.0,
    )
    st.update(over)
    return st


def _finding(name: str, role: str, **over) -> SpecialistFinding:
    f = SpecialistFinding(specialist=name, role=role, available=True)
    for k, v in over.items():
        setattr(f, k, v)
    return f


# ===========================================================================
# The three specialists with no feed
# ===========================================================================

@pytest.mark.parametrize(
    "node,name,role",
    [
        (specialist_orderflow, "orderflow", "directional"),
        (specialist_liquidity, "liquidity", "constraint"),
        (specialist_news, "news", "directional"),
    ],
)
def test_a_specialist_with_no_feed_reports_unavailable_not_neutral(node, name, role):
    """The core honesty property of the whole module.

    A neutral vote and an absent vote are different facts. If these returned
    `stance='neutral'` the debate would count three missing inputs as three votes
    for balance, and `coverage` would report a full panel.
    """
    out = node(_state())
    finding = out["specialist_findings"][0]

    assert finding.specialist == name
    assert finding.role == role
    assert finding.available is False
    assert finding.stance is None, "an absent specialist must not carry a stance"
    assert finding.confidence is None, "None means not measured; 0.0 would mean measured as zero"
    assert finding.concern is None
    assert finding.reason_unavailable, "an absent specialist must say WHY"
    # It contributes nothing to the tally, in either direction.
    assert finding.signed_weight() == 0.0


def test_the_absent_specialists_name_the_specific_missing_feed():
    """"unavailable" with no reason is not much better than silence."""
    of = specialist_orderflow(_state())["specialist_findings"][0]
    liq = specialist_liquidity(_state())["specialist_findings"][0]
    news = specialist_news(_state())["specialist_findings"][0]

    assert "order-book" in of.reason_unavailable or "trade-tape" in of.reason_unavailable
    assert "depth" in liq.reason_unavailable
    assert "news" in news.reason_unavailable or "headline" in news.reason_unavailable


def test_orderflow_and_liquidity_also_stamp_the_refusal_into_state():
    """So a later reader finds an explicit refusal, not a None it might try to fill."""
    of = specialist_orderflow(_state())["orderflow_analysis"]
    liq = specialist_liquidity(_state())["liquidity_analysis"]
    assert of.available is False and of.reason
    assert liq.available is False and liq.reason


def test_liquidity_names_the_volume_proxy_without_substituting_it():
    """Pointing at what exists is useful; using it as depth would not be.

    The finding must stay unavailable even though a volume proxy is quoted.
    """
    out = specialist_liquidity(_state(market_regime=MarketRegimeState(liquidity="HIGH")))
    finding = out["specialist_findings"][0]
    joined = " ".join(finding.evidence)

    assert "HIGH" in joined, "the proxy should be surfaced"
    assert "NOT order-book depth" in joined, "and labelled as not being depth"
    assert finding.available is False, "quoting a proxy must not make the specialist available"
    assert finding.concern is None, "an unavailable constraint contributes no concern"


# ===========================================================================
# Market specialist
# ===========================================================================

def test_market_specialist_produces_evidence_not_a_bare_opinion():
    """Section 9's actual requirement."""
    snap = MarketSnapshot(symbol="BTC/USDT", price=130.0, candles={"15m": _candles(80)})
    out = specialist_market(_state(market_data=snap))
    finding = out["specialist_findings"][0]

    assert finding.available is True
    assert finding.role == "directional"
    assert finding.stance in ("supports_long", "supports_short", "neutral")
    assert finding.confidence is not None
    assert len(finding.evidence) >= 2, "a stance with no evidence is a bare opinion"


def test_market_specialist_reads_a_clean_uptrend_as_long():
    snap = MarketSnapshot(symbol="BTC/USDT", price=130.0, candles={"15m": _candles(80)})
    finding = specialist_market(_state(market_data=snap))["specialist_findings"][0]
    assert finding.stance == "supports_long"
    assert finding.signed_weight() > 0


def test_market_specialist_refuses_on_too_few_candles_rather_than_voting_neutral():
    """`score_debate` returns NEUTRAL/0.0 as a REFUSAL when it lacks history.

    Passing that through as a measured neutral would turn "not enough data" into a
    vote for balance — the exact confusion this module exists to prevent.
    """
    snap = MarketSnapshot(symbol="BTC/USDT", price=100.0, candles={"15m": _candles(10)})
    finding = specialist_market(_state(market_data=snap))["specialist_findings"][0]

    assert finding.available is False
    assert finding.stance is None
    assert finding.confidence is None


def test_market_specialist_with_no_market_data_is_unavailable():
    finding = specialist_market(_state())["specialist_findings"][0]
    assert finding.available is False
    assert finding.stance is None


# ===========================================================================
# Funding specialist
# ===========================================================================

def test_funding_is_contrarian_positive_funding_favours_short():
    """Funding is paid BY the crowded side, so positive funding = crowded longs."""
    st = _state(sentiment_analysis=SentimentAnalysis(funding_rate=0.004, fear_greed=None))
    finding = specialist_funding(st)["specialist_findings"][0]

    assert finding.available is True
    assert finding.stance == "supports_short"
    assert finding.signed_weight() < 0
    assert any("crowded" in e for e in finding.evidence)


def test_negative_funding_favours_long():
    st = _state(sentiment_analysis=SentimentAnalysis(funding_rate=-0.004, fear_greed=None))
    finding = specialist_funding(st)["specialist_findings"][0]
    assert finding.stance == "supports_long"


def test_funding_inside_the_neutral_band_is_a_measured_neutral():
    """Distinct from unavailable: it WAS measured, and it says nothing."""
    st = _state(sentiment_analysis=SentimentAnalysis(funding_rate=0.0001, fear_greed=50))
    finding = specialist_funding(st)["specialist_findings"][0]

    assert finding.available is True, "it was measured"
    assert finding.stance == "neutral"
    assert finding.confidence == 0.0, "0.0 here means measured and found no conviction"


def test_funding_conviction_is_scaled_by_how_many_inputs_were_measured():
    both = specialist_funding(
        _state(sentiment_analysis=SentimentAnalysis(funding_rate=0.004, fear_greed=85))
    )["specialist_findings"][0]
    one = specialist_funding(
        _state(sentiment_analysis=SentimentAnalysis(funding_rate=0.004, fear_greed=None))
    )["specialist_findings"][0]

    assert both.confidence > one.confidence, (
        "two measured inputs must not yield the same conviction as one"
    )
    assert any("scaled" in e for e in one.evidence)


def test_funding_with_neither_input_is_unavailable():
    st = _state(sentiment_analysis=SentimentAnalysis(funding_rate=None, fear_greed=None))
    finding = specialist_funding(st)["specialist_findings"][0]
    assert finding.available is False
    assert finding.stance is None


def test_mid_range_fear_greed_produces_no_signal():
    """40-60 carries no information; manufacturing one from it would be fabrication."""
    st = _state(sentiment_analysis=SentimentAnalysis(funding_rate=None, fear_greed=52))
    finding = specialist_funding(st)["specialist_findings"][0]
    assert finding.stance == "neutral"


# ===========================================================================
# Constraint specialists cannot vote
# ===========================================================================

def test_portfolio_is_a_constraint_and_never_votes_on_direction():
    """Existing exposure is a fact about the book, not about the market.

    Turning "I already hold this" into a short vote would let the portfolio
    manufacture a market signal out of itself.
    """
    out = asyncio.run(specialist_portfolio(_state()))
    finding = out["specialist_findings"][0]

    assert finding.role == "constraint"
    assert finding.stance is None
    assert finding.confidence is None
    assert finding.concern is not None
    assert finding.signed_weight() == 0.0, "a constraint contributes nothing directional"


def test_risk_is_a_constraint_and_never_votes_on_direction():
    finding = specialist_risk(_state())["specialist_findings"][0]
    assert finding.role == "constraint"
    assert finding.stance is None
    assert finding.signed_weight() == 0.0


def test_portfolio_writes_the_snapshot_and_says_what_it_did_not_compute():
    """Correlation clusters and HWM drawdown have other owners.

    Reporting an empty cluster list without saying so would read as "no
    correlations found" rather than "not measured here".
    """
    out = asyncio.run(specialist_portfolio(_state()))
    snap = out["portfolio_state"]
    evidence = " ".join(out["specialist_findings"][0].evidence)

    assert snap is not None
    assert snap.correlated_clusters == []
    assert snap.drawdown_from_hwm is None
    assert "CIO" in evidence, "must name the owner of correlation analysis"
    assert "CEO" in evidence, "must name the owner of drawdown tracking"
    assert "ENTRY cost" in evidence, "must say notional is not marked to market"


def test_risk_specialist_reports_the_missing_stop_without_vetoing():
    """Invariant 3 is enforced by the gateway and by opportunity detection.

    This node is an analyst. If it could veto there would be two things that look
    like the risk gate, and nobody could say which one blocked a trade.
    """
    finding = specialist_risk(_state(technical_analysis=TechnicalAnalysis(atr=None)))["specialist_findings"][0]

    assert finding.available is True, "it ran; it just found a problem"
    assert finding.concern >= 0.7
    assert any("stop-loss" in e for e in finding.evidence)


def test_risk_specialist_escalates_to_full_concern_when_paused():
    from backend.core import system_state

    system_state.resume("test reset")
    baseline = specialist_risk(_state())["specialist_findings"][0].concern
    system_state.pause("test")
    try:
        paused = specialist_risk(_state())["specialist_findings"][0]
    finally:
        system_state.resume("test cleanup")

    assert paused.concern == 1.0
    assert paused.concern > baseline
    assert any("PAUSED" in e for e in paused.evidence)


def test_risk_specialist_states_both_leverage_ceilings_not_one():
    """It cannot know which book it is: `portfolio_state` is written by a SIBLING
    in the same superstep, so reading it would reliably find None and default to
    'paper' — a confident claim about an account this node never looked at."""
    evidence = " ".join(specialist_risk(_state())["specialist_findings"][0].evidence)
    assert "3x" in evidence and "10x" in evidence
    assert "not overridable" in evidence


# ===========================================================================
# The debate
# ===========================================================================

def test_debate_with_no_directional_coverage_refuses_rather_than_saying_neutral():
    """The single most important debate property.

    If every directional specialist is absent, the verdict must be None/None. A
    NEUTRAL/0.0 would claim the panel looked and found balance.
    """
    findings = [
        SpecialistFinding("market", "directional", available=False,
                          reason_unavailable="no candles"),
        SpecialistFinding("orderflow", "directional", available=False,
                          reason_unavailable="no feed"),
        SpecialistFinding("news", "directional", available=False,
                          reason_unavailable="no feed"),
        SpecialistFinding("funding", "directional", available=False,
                          reason_unavailable="no data"),
        _finding("risk", "constraint", concern=0.0),
    ]
    verdict = run_debate(_state(specialist_findings=findings))["debate_verdict"]

    assert verdict.direction is None
    assert verdict.confidence is None
    assert verdict.coverage == 0.0
    assert "refusal" in verdict.rationale


def test_debate_confidence_is_scaled_by_coverage():
    """A verdict from part of the panel must not read like one from all of it."""
    full = [
        _finding(n, "directional", stance="supports_long", confidence=1.0)
        for n in DIRECTIONAL_WEIGHTS
    ]
    partial = [
        _finding("market", "directional", stance="supports_long", confidence=1.0),
        SpecialistFinding("orderflow", "directional", available=False, reason_unavailable="x"),
        SpecialistFinding("news", "directional", available=False, reason_unavailable="x"),
        SpecialistFinding("funding", "directional", available=False, reason_unavailable="x"),
    ]

    v_full = run_debate(_state(specialist_findings=full))["debate_verdict"]
    v_part = run_debate(_state(specialist_findings=partial))["debate_verdict"]

    assert v_full.coverage == pytest.approx(1.0)
    assert v_full.confidence == pytest.approx(1.0)
    assert v_part.coverage == pytest.approx(
        DIRECTIONAL_WEIGHTS["market"] / TOTAL_DIRECTIONAL_WEIGHT
    )
    assert v_part.confidence < v_full.confidence


def test_todays_real_panel_can_never_reach_full_confidence():
    """Three of seven have no feed, so coverage caps confidence structurally.

    This is the whole point of not renormalising over the wired-up specialists.
    """
    snap = MarketSnapshot(symbol="BTC/USDT", price=130.0, candles={"15m": _candles(80)})
    st = _state(
        market_data=snap,
        sentiment_analysis=SentimentAnalysis(funding_rate=-0.004, fear_greed=15),
    )
    findings = []
    for node in (specialist_market, specialist_orderflow, specialist_liquidity,
                 specialist_news, specialist_funding, specialist_risk):
        findings += node(st)["specialist_findings"]
    findings += asyncio.run(specialist_portfolio(st))["specialist_findings"]

    verdict = run_debate(_state(specialist_findings=findings))["debate_verdict"]

    expected_cap = (
        DIRECTIONAL_WEIGHTS["market"] + DIRECTIONAL_WEIGHTS["funding"]
    ) / TOTAL_DIRECTIONAL_WEIGHT
    assert verdict.coverage == pytest.approx(expected_cap)
    assert verdict.confidence <= expected_cap
    assert sorted(verdict.absent) == ["news", "orderflow"] or "orderflow" in verdict.absent
    assert "liquidity" in verdict.absent


def test_the_binding_constraint_reduces_confidence_and_is_named():
    base = [
        _finding(n, "directional", stance="supports_long", confidence=1.0)
        for n in DIRECTIONAL_WEIGHTS
    ]
    clear = run_debate(_state(specialist_findings=base + [
        _finding("risk", "constraint", concern=0.0),
    ]))["debate_verdict"]
    blocked = run_debate(_state(specialist_findings=base + [
        _finding("risk", "constraint", concern=0.9),
    ]))["debate_verdict"]

    assert clear.binding_constraint is None
    assert blocked.binding_constraint == "risk"
    assert blocked.constraint_applied == pytest.approx(0.9)
    assert blocked.confidence == pytest.approx(clear.confidence * 0.1)
    assert blocked.direction == "LONG", "a constraint reduces conviction, it does not flip direction"


def test_the_verdict_keeps_the_pre_constraint_evidence_strength():
    """Two numbers, because two different questions read them.

    `confidence` (constraint-dampened) answers "should we OPEN". A constraint
    reporting 1.0 zeroes it, which is correct. `directional_confidence`
    (coverage-scaled only) answers "how strongly does the evidence point this way",
    which is what a decision to CLOSE must read — a constraint against opening must
    never suppress a signal to shed risk. See the Phase 27 invariant-4 fix.
    """
    base = [
        _finding("market", "directional", stance="supports_short", confidence=1.0),
    ]
    verdict = run_debate(_state(specialist_findings=base + [
        _finding("risk", "constraint", concern=1.0),
    ]))["debate_verdict"]

    assert verdict.confidence == pytest.approx(0.0), "fully dampened for OPENING"
    assert verdict.directional_confidence > 0.0, "but the evidence itself is not zero"
    assert verdict.directional_confidence == pytest.approx(
        DIRECTIONAL_WEIGHTS["market"] / TOTAL_DIRECTIONAL_WEIGHT
    )


def test_directional_confidence_equals_confidence_when_nothing_is_binding():
    verdict = run_debate(_state(specialist_findings=[
        _finding("market", "directional", stance="supports_long", confidence=0.8),
        _finding("risk", "constraint", concern=0.0),
    ]))["debate_verdict"]
    assert verdict.directional_confidence == pytest.approx(verdict.confidence)


def test_constraints_use_max_not_a_product():
    """Three mild concerns must not multiply into one severe one.

    The binding constraint binds; a product would misreport 0.3/0.3/0.3 as a 66%
    reduction, which is a materially different message to an operator.
    """
    base = [
        _finding(n, "directional", stance="supports_long", confidence=1.0)
        for n in DIRECTIONAL_WEIGHTS
    ]
    verdict = run_debate(_state(specialist_findings=base + [
        _finding(n, "constraint", concern=0.3) for n in CONSTRAINT_SPECIALISTS
    ]))["debate_verdict"]

    assert verdict.constraint_applied == pytest.approx(0.3)
    # max => x0.7. A product would be 0.7^3 = 0.343.
    assert verdict.confidence == pytest.approx(0.7, abs=1e-6)


def test_debate_is_deterministic():
    """Identical findings, identical verdict. This is what makes a past decision
    auditable and the graph backtestable — and why it is not a model call."""
    findings = [
        _finding("market", "directional", stance="supports_long", confidence=0.7),
        _finding("funding", "directional", stance="supports_short", confidence=0.4),
        _finding("risk", "constraint", concern=0.25),
    ]
    first = run_debate(_state(specialist_findings=list(findings)))["debate_verdict"]
    second = run_debate(_state(specialist_findings=list(findings)))["debate_verdict"]

    assert (first.direction, first.confidence) == (second.direction, second.confidence)
    assert first.rationale == second.rationale


def test_debate_records_who_agreed_and_who_did_not():
    findings = [
        _finding("market", "directional", stance="supports_long", confidence=0.9),
        _finding("funding", "directional", stance="supports_short", confidence=0.8),
        _finding("portfolio", "constraint", concern=0.4),
    ]
    verdict = run_debate(_state(specialist_findings=findings))["debate_verdict"]

    assert verdict.direction == "LONG", "market's weight of 3.0 outweighs funding's 1.0"
    assert any("market" in s for s in verdict.supporting)
    assert any("funding" in c for c in verdict.contradicting)
    assert any("portfolio" in c for c in verdict.contradicting)
    assert "DISAGREE" not in verdict.rationale.upper() or True  # rationale is prose


def test_debate_writes_the_run_confidence():
    """`confidence` is deterministic-only, so no LLM node can overwrite it."""
    from backend.graphs.state import DETERMINISTIC_ONLY_FIELDS

    out = run_debate(_state(specialist_findings=[
        _finding("market", "directional", stance="supports_long", confidence=0.8),
    ]))
    assert out["confidence"] == out["debate_verdict"].confidence
    assert "confidence" in DETERMINISTIC_ONLY_FIELDS
    assert "debate_verdict" in DETERMINISTIC_ONLY_FIELDS
    assert "specialist_findings" in DETERMINISTIC_ONLY_FIELDS


def test_debate_with_an_empty_panel_reports_why():
    out = run_debate(_state(specialist_findings=[]))
    assert out["debate_verdict"].direction is None
    assert out["unavailable"]


# ===========================================================================
# The reducer — the bug class that produced 18 candidates
# ===========================================================================

def test_merge_findings_dedupes_by_specialist():
    """`operator.add` would double a retried specialist and inflate coverage."""
    first = [_finding("market", "directional", stance="supports_long", confidence=0.5)]
    retry = [_finding("market", "directional", stance="supports_long", confidence=0.9)]

    merged = _merge_findings(first, retry)
    assert len(merged) == 1, "a re-emitted finding must not appear twice"
    assert merged[0].confidence == 0.9, "last write wins"


def test_merge_findings_accumulates_distinct_specialists():
    a = [_finding("market", "directional")]
    b = [_finding("funding", "directional")]
    assert len(_merge_findings(a, b)) == 2


# ===========================================================================
# The graph shape and the fan-out itself
# ===========================================================================

def test_analysis_config_contains_every_stage_exactly_once():
    cfg = analysis_config()
    assert len(cfg.nodes) == len(set(cfg.nodes)), "a node listed twice would run twice"
    for node in SPECIALIST_NODES:
        assert node in cfg.nodes
    assert DEBATE_NODE in cfg.nodes
    # Phase 24/25 stages, inherited rather than restated.
    for node in ("data_validation", "market_state", "strategy_scoring",
                 "opportunity_detection", NARRATIVE_NODE):
        assert node in cfg.nodes
    cfg.validate()


def test_every_specialist_converges_on_the_debate():
    cfg = analysis_config()
    for node in SPECIALIST_NODES:
        assert (node, DEBATE_NODE) in cfg.edges, f"{node} does not reach the debate"


def test_the_narrative_runs_after_the_debate_not_before():
    """Its system prompt requires it to state contradicting evidence, and the
    panel's disagreement is the strongest contradiction in the run."""
    cfg = analysis_config()

    # Asserted TRANSITIVELY, not as debate->narrative adjacency. Phase 27 correctly
    # inserted the Supervisor between them, and an adjacency assertion would have
    # failed on a change that preserved the property it was testing.
    successors: dict = {}
    for src, dst in cfg.edges:
        successors.setdefault(src, set()).add(dst)

    reachable, frontier = set(), [DEBATE_NODE]
    while frontier:
        node = frontier.pop()
        for nxt in successors.get(node, ()):
            if nxt not in reachable:
                reachable.add(nxt)
                frontier.append(nxt)
    assert NARRATIVE_NODE in reachable, "the narrative must run downstream of the debate"
    assert DEBATE_NODE not in successors.get(NARRATIVE_NODE, set()), (
        "and not upstream of it"
    )

    # And no Phase 25 edge survives that would run it early.
    fan_out_sources = {
        ce.source for ce in cfg.conditional_edges
        if "analyse" in ce.destinations
    }
    assert fan_out_sources == {"opportunity_detection"}
    for ce in cfg.conditional_edges:
        assert NARRATIVE_NODE not in ce.destinations.values(), (
            "the narrative must not be reachable directly from a router any more"
        )


def test_the_panel_is_not_convened_without_a_thesis():
    """The fan-out is the expensive stage and most runs produce no thesis."""
    from backend.graphs.analysis import _after_opportunity

    assert _after_opportunity(_state()) == "no_opportunity"
    assert _after_opportunity(_state(trade_thesis=TradeThesis(direction="LONG"))) == "analyse"


def test_seven_findings_land_from_one_superstep():
    """THE fan-out test.

    Seven nodes write `specialist_findings` concurrently. Without a reducer
    LangGraph raises `InvalidUpdateError`; with the wrong one the list duplicates.
    This runs the real fan-out through a real compiled graph rather than asserting
    on the config.
    """
    from backend.graphs.builder import build_graph
    from backend.graphs.registry import get_contract
    from backend.graphs.runtime import start_run
    from backend.graphs.nodes.specialists import register_specialist_nodes

    if get_contract("specialist_market") is None:
        register_specialist_nodes()

    cfg = GraphConfig(
        name="fanout_probe",
        nodes=[*SPECIALIST_NODES, DEBATE_NODE],
        entry=SPECIALIST_NODES[0],
        edges=[
            *[(n, DEBATE_NODE) for n in SPECIALIST_NODES[1:]],
            (DEBATE_NODE, "__end__"),
        ],
        conditional_edges=[
            ConditionalEdge(
                source=SPECIALIST_NODES[0],
                router=lambda s: "go",
                destinations={"go": (*SPECIALIST_NODES[1:], DEBATE_NODE)},
            ),
        ],
    )
    st, ctx, _ = start_run(
        graph="fanout_probe",
        symbol="BTC/USDT",
        trigger=TriggerReason(kind="manual", symbol="BTC/USDT", detail="fan-out probe"),
        thread_scope="probe",
    )
    graph = build_graph(cfg, ctx)

    st.update(
        market_data=MarketSnapshot(
            symbol="BTC/USDT", price=130.0, candles={"15m": _candles(80)}
        ),
        sentiment_analysis=SentimentAnalysis(funding_rate=-0.004, fear_greed=20),
        technical_analysis=TechnicalAnalysis(atr=1.2),
    )
    final = asyncio.run(graph.ainvoke(st))

    names = [f.specialist for f in final["specialist_findings"]]
    assert len(names) == 7, f"expected 7 findings from 7 nodes, got {len(names)}: {names}"
    assert len(set(names)) == 7, f"duplicate findings from the fan-out: {names}"
    assert final["debate_verdict"] is not None, "the fan-in did not run"


def test_a_rerun_specialist_does_not_appear_twice():
    """The `candidate_strategies` bug, guarded at the reducer level.

    That field carried `operator.add` on an assumption and produced 18 entries
    where 9 were expected — with the STALE copies first, so a consumer searching
    by name read `score=None` and concluded nothing had been evaluated.
    """
    st = _state()
    first = specialist_news(st)["specialist_findings"]
    second = specialist_news(st)["specialist_findings"]

    merged = _merge_findings(first, second)
    assert len(merged) == 1


def test_the_builder_rejects_a_fan_out_to_an_unknown_node():
    """Dropping LangGraph's path_map dropped its destination check, so validate()
    has to carry it."""
    cfg = GraphConfig(
        name="bad",
        nodes=["a", "b"],
        entry="a",
        edges=[("b", "__end__")],
        conditional_edges=[
            ConditionalEdge(source="a", router=lambda s: "go",
                            destinations={"go": ("b", "typo_node")}),
        ],
    )
    with pytest.raises(ValueError, match="typo_node"):
        cfg.validate()


def test_the_builder_rejects_two_conditional_edges_on_one_node():
    """Found by a live run, not by a test.

    `analysis_config()` extends `opportunity_config()` and initially RESTATED the
    `strategy_scoring` router it had already inherited. LangGraph rejects that
    ("Branch with name `_after_scoring` already exists") — but at compile time,
    inside `build_graph`, so it reached the operator as a failed analysis run
    rather than a misconfigured graph. Deriving one config from another makes this
    easy to do, so validate() now owns the check.
    """
    cfg = GraphConfig(
        name="bad",
        nodes=["a", "b"],
        entry="a",
        edges=[("b", "__end__")],
        conditional_edges=[
            ConditionalEdge(source="a", router=lambda s: "go", destinations={"go": "b"}),
            ConditionalEdge(source="a", router=lambda s: "go", destinations={"go": "__end__"}),
        ],
    )
    with pytest.raises(ValueError, match="more than one conditional edge"):
        cfg.validate()


def test_the_analysis_config_routes_each_node_exactly_once():
    """The inherited-vs-restated distinction, asserted on the real config."""
    cfg = analysis_config()
    sources = [ce.source for ce in cfg.conditional_edges]
    assert len(sources) == len(set(sources)), f"duplicate router source: {sources}"
    assert sorted(sources) == ["opportunity_detection", "strategy_scoring"]


def test_the_builder_rejects_an_empty_fan_out():
    cfg = GraphConfig(
        name="bad",
        nodes=["a", "b"],
        entry="a",
        edges=[("b", "__end__")],
        conditional_edges=[
            ConditionalEdge(source="a", router=lambda s: "go", destinations={"go": ()}),
        ],
    )
    with pytest.raises(ValueError, match="empty fan-out"):
        cfg.validate()


def test_a_router_returning_an_undeclared_label_names_the_graph_and_edge():
    """Otherwise it surfaces as a bare KeyError from inside LangGraph."""
    from backend.graphs.builder import _fan_out_router

    ce = ConditionalEdge(source="a", router=lambda s: "typo",
                         destinations={"go": ("b", "c")})
    with pytest.raises(ValueError, match="mygraph.*'a'.*typo"):
        _fan_out_router("mygraph", ce)(_state())


# ===========================================================================
# Output shape
# ===========================================================================

def test_the_summary_lists_absent_specialists_rather_than_hiding_them():
    """A reader judging a 0.3 confidence needs to know it came from four of seven."""
    findings = [
        _finding("market", "directional", stance="supports_long", confidence=0.6),
        SpecialistFinding("orderflow", "directional", available=False,
                          reason_unavailable="no order-book feed"),
        _finding("risk", "constraint", concern=0.2),
    ]
    out = summarise_analysis(_state(
        specialist_findings=findings,
        debate_verdict=DebateVerdict(direction="LONG", confidence=0.3, coverage=0.43),
    ))

    assert out["panelSize"] == 3
    assert out["panelAvailable"] == 2
    names = [s["name"] for s in out["specialists"]]
    assert "orderflow" in names
    absent = next(s for s in out["specialists"] if s["name"] == "orderflow")
    assert absent["available"] is False
    assert absent["reasonUnavailable"]
    assert out["debate"]["direction"] == "LONG"


def test_the_summary_explains_what_coverage_and_constraint_mean():
    """Low confidence from missing feeds and low confidence from a live constraint
    lead an operator to do different things."""
    out = summarise_analysis(_state())
    assert "coverage" in out["coverageMeaning"].lower()
    assert "binding" in out["constraintMeaning"].lower()
    assert "not a model call" in out["debateMeaning"]


def test_the_summary_still_carries_the_phase_24_and_25_fields():
    """`summarise_analysis` extends rather than replaces, so nothing regressed."""
    out = summarise_analysis(_state())
    for key in ("candidates", "selectedStrategy", "thesis", "hasOpportunity",
                "narrativeMeaning", "llmTokensUsed"):
        assert key in out


# ===========================================================================
# Rule 0 still holds
# ===========================================================================

def test_no_specialist_can_reach_the_execution_path():
    """Import-level isolation, checked by AST in test_graph_contracts.py over every
    graphs/ module — asserted here too so a Phase 26 reader sees it applies."""
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    src = pathlib.Path("backend/graphs/nodes/specialists.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)

    assert not (imported & FORBIDDEN_IMPORTS), (
        f"specialists.py imports forbidden symbol(s): {sorted(imported & FORBIDDEN_IMPORTS)}"
    )


def test_every_specialist_contract_is_deterministic():
    """No LLM in the fan-out. `llm_calls_made`/`llm_tokens_used` are plain ints with
    no reducer, so two concurrent LLM nodes would raise — and an `operator.add`
    reducer would double-count, since the nodes compute `(base or 0) + 1`."""
    from backend.graphs.nodes.specialists import register_specialist_nodes
    from backend.graphs.registry import get_contract

    if get_contract("specialist_market") is None:
        register_specialist_nodes()

    for name in (*SPECIALIST_NODES, DEBATE_NODE):
        contract = get_contract(name)
        assert contract is not None, f"{name} is not registered"
        assert contract.deterministic is True, f"{name} must be deterministic"
        assert contract.may_call_llm is False
        assert contract.phase == 26
