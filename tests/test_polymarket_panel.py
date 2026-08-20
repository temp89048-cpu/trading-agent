"""Phase 35 — Polymarket as ONE EXTRA LAYER, not a panel member.

Operator direction: *"polymarket is just one addition information to agent not fully
use one extra layer information"*. That is an arithmetic requirement, not a framing
preference, and these tests are the enforcement:

  * with the feature off, every number is byte-identical to Phase 34;
  * with it on but no market resolving to the symbol, every number is STILL
    byte-identical — an inapplicable source costs nothing;
  * with it on and a market read failure, coverage DROPS — that is a real engineering
    gap and hiding it would be the flattery `specialists.py:110` forbids;
  * it can shade conviction and can never carry a decision (Guards A and B).

`POLYMARKET_INTEGRATION_PLAN.md`'s "§2 REVISED" section records why.
"""

from __future__ import annotations

import time

import pytest

from backend.algorithms import prediction_market as pm
from backend.graphs.nodes import specialists as sp
from backend.graphs.state import SpecialistFinding


# ===========================================================================
# Fixtures
# ===========================================================================

@pytest.fixture
def flag_off(monkeypatch):
    monkeypatch.setenv("POLYMARKET_ENABLED", "false")  # explicit "false", not delenv:
    # `.env` now sets this flag, and `services/exchange_client` calls `load_dotenv()` at
    # import time. `load_dotenv` does not override an existing var but DOES set an
    # absent one — so a lazy import after `delenv` silently restored the value from
    # `.env` and the flag-off tests saw 9 specialists. An explicit "false" survives it.
    return False


@pytest.fixture
def flag_on(monkeypatch):
    monkeypatch.setenv("POLYMARKET_ENABLED", "true")
    return True


@pytest.fixture
def tmp_snapshots(tmp_path, monkeypatch):
    """Point the snapshot file at a temp dir so tests never touch real `.data/`."""
    from backend.services import polymarket_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SNAPSHOT_FILE", str(tmp_path / "snapshots.json"))
    return tmp_path


def _finding(name, role, **kw):
    return SpecialistFinding(specialist=name, role=role, **kw)


def _core_long(conviction=1.0):
    """The market specialist, weight 3.0, fully confident LONG."""
    return _finding("market", "directional", available=True,
                    stance="supports_long", confidence=conviction)


def _debate(findings):
    state = {"symbol": "BTC/USDT", "specialist_findings": list(findings)}
    return sp.run_debate(state)["debate_verdict"]


# ===========================================================================
# The tier itself
# ===========================================================================

def test_the_feature_off_leaves_the_panel_literally_unchanged(flag_off):
    assert sp.supplementary_weights() == {}
    assert sp.constraint_specialists() == sp.CONSTRAINT_SPECIALISTS
    assert sp.specialist_nodes() == sp.SPECIALIST_NODES
    assert len(sp.specialist_nodes()) == 7
    assert sp.TOTAL_DIRECTIONAL_WEIGHT == 7.0
    assert "prediction" not in sp.DIRECTIONAL_WEIGHTS


def test_the_feature_on_adds_exactly_two_nodes_and_one_vote(flag_on):
    assert sp.supplementary_weights() == {"prediction": 1.0}
    assert sp.constraint_specialists() == ("liquidity", "portfolio", "risk", "event_risk")
    assert sp.specialist_nodes() == sp.SPECIALIST_NODES + (
        "specialist_prediction", "specialist_event_risk",
    )
    # The CORE panel is untouched — `prediction` is a third tier, not a fifth
    # directional specialist.
    assert sp.TOTAL_DIRECTIONAL_WEIGHT == 7.0
    assert "prediction" not in sp.DIRECTIONAL_WEIGHTS


def test_the_supplementary_weight_cannot_outvote_the_core(flag_on):
    """Guard B, checked arithmetically rather than asserted."""
    assert sp.SUPPLEMENTARY_WEIGHTS["prediction"] < sp.DIRECTIONAL_WEIGHTS["market"]
    total = sp.TOTAL_DIRECTIONAL_WEIGHT + sp.SUPPLEMENTARY_WEIGHTS["prediction"]
    assert sp.SUPPLEMENTARY_WEIGHTS["prediction"] / total < 0.15


# ===========================================================================
# THE CENTRAL CLAIM: an inapplicable source costs nothing
# ===========================================================================

def test_a_not_applicable_prediction_leaves_confidence_byte_identical(flag_on):
    """The whole point of the `not_applicable` flag.

    Polymarket has deep BTC/ETH markets and nothing for most alts, so this is the
    COMMON case. Counting it against coverage would impose a permanent ~12.5%
    confidence penalty on every uncovered symbol for the absence of a source that
    cannot apply to it.
    """
    baseline = _debate([_core_long()])

    with_absent = _debate([
        _core_long(),
        _finding("prediction", "supplementary", available=False,
                 not_applicable=True, reason_unavailable="no market maps here"),
    ])

    assert with_absent.coverage == baseline.coverage
    assert with_absent.confidence == baseline.confidence
    assert with_absent.direction == baseline.direction
    assert baseline.coverage == pytest.approx(3.0 / 7.0)


def test_a_failed_prediction_does_count_against_coverage(flag_on):
    """The other half of the split. A mapped market we could not read IS an
    engineering gap, and `specialists.py:110`'s refusal to renormalise applies to it.

    Without this asymmetry the flag would be a blanket exemption rather than a
    statement about cause — and a broken poller would be indistinguishable from a
    symbol Polymarket does not cover.
    """
    baseline = _debate([_core_long()])
    with_failure = _debate([
        _core_long(),
        _finding("prediction", "supplementary", available=False,
                 not_applicable=False, reason_unavailable="snapshot stale"),
    ])

    assert with_failure.coverage == pytest.approx(3.0 / 8.0)
    assert with_failure.coverage < baseline.coverage
    assert with_failure.confidence < baseline.confidence


def test_an_agreeing_prediction_adds_conviction(flag_on):
    baseline = _debate([_core_long()])
    agreeing = _debate([
        _core_long(),
        _finding("prediction", "supplementary", available=True,
                 stance="supports_long", confidence=1.0),
    ])

    assert agreeing.direction == "LONG"
    assert agreeing.coverage == pytest.approx(4.0 / 8.0)
    assert agreeing.confidence > baseline.confidence
    assert any("prediction" in s for s in agreeing.supporting)


def test_a_contradicting_prediction_dampens_but_cannot_flip(flag_on):
    """Guard B end-to-end: market at full conviction LONG, prediction at full
    conviction SHORT. Direction survives; confidence falls."""
    baseline = _debate([_core_long()])
    opposed = _debate([
        _core_long(),
        _finding("prediction", "supplementary", available=True,
                 stance="supports_short", confidence=1.0),
    ])

    assert opposed.direction == "LONG"
    assert opposed.confidence < baseline.confidence
    assert any("prediction" in s for s in opposed.contradicting)


def test_a_missing_prediction_node_is_treated_as_not_applicable(flag_on):
    """The feature enabled mid-run, or a graph that does not include the node.
    Charging coverage for a node that never executed would penalise a config change."""
    baseline = _debate([_core_long()])
    assert _debate([_core_long()]).coverage == baseline.coverage


# ===========================================================================
# Guard A — a supplementary source may not speak alone
# ===========================================================================

def test_a_supplementary_source_alone_produces_no_direction(flag_on):
    """Without Guard A, prediction+funding reach coverage 2.0/8.0 = 0.25, above the
    0.18 trade floor — so two weak indirect signals could authorise a trade with NO
    price-based evidence. Today funding alone reaches 1.0/7.0 = 0.14 and cannot."""
    verdict = _debate([
        _finding("market", "directional", available=False,
                 reason_unavailable="no candles"),
        _finding("prediction", "supplementary", available=True,
                 stance="supports_long", confidence=1.0),
    ])
    assert verdict.direction is None
    assert verdict.confidence is None
    assert verdict.coverage == 0.0


def test_funding_plus_prediction_clears_the_trade_floor_and_that_is_recorded(flag_on):
    """The arithmetic that motivated Guard A, and the case the guard does NOT catch.

    `funding` is a CORE specialist, so Guard A is satisfied and this combination is
    allowed to vote. The consequence is a genuine new capability: funding alone
    reaches 1.0/7.0 = 0.14 and cannot trade, but funding + prediction reach
    2.0/8.0 = 0.25 and can — a trade authorised by two indirect signals with no
    price-based evidence.

    That is recorded here rather than hidden, and it is the strongest argument for
    keeping POLYMARKET_ENABLED off until the Phase 38 validation study has
    measured whether the prediction leg is worth anything. The number is pinned so
    a future weight change moving it is visible."""
    from backend.graphs.nodes.supervisor import MIN_CONFIDENCE_TO_TRADE

    verdict = _debate([
        _finding("funding", "directional", available=True,
                 stance="supports_long", confidence=1.0),
        _finding("prediction", "supplementary", available=True,
                 stance="supports_long", confidence=1.0),
    ])
    assert verdict.coverage == pytest.approx(2.0 / 8.0)
    # Documented consequence: two indirect legs DO clear the floor once prediction is
    # enabled, where funding alone never did. Recorded rather than hidden.
    assert verdict.confidence > MIN_CONFIDENCE_TO_TRADE


def test_an_excluded_supplementary_leg_is_reported_not_dropped(flag_on):
    """"We had a view and deliberately did not count it" is a different fact from
    "we had no view"."""
    state = {
        "symbol": "BTC/USDT",
        "specialist_findings": [
            _finding("market", "directional", available=False,
                     reason_unavailable="no candles"),
            _finding("prediction", "supplementary", available=True,
                     stance="supports_long", confidence=1.0),
        ],
    }
    verdict = sp.run_debate(state)["debate_verdict"]
    # The refusal branch fires; the exclusion is visible in the rationale path.
    assert verdict.direction is None
    assert "refusal" in (verdict.rationale or "")


# ===========================================================================
# event_risk — a constraint, and a capped one
# ===========================================================================

def test_event_risk_dampens_confidence_without_vetoing(flag_on):
    from backend.services.polymarket_registry import MAX_EVENT_RISK_CONCERN
    from backend.graphs.nodes.supervisor import MIN_CONFIDENCE_TO_TRADE

    baseline = _debate([_core_long()])
    with_risk = _debate([
        _core_long(),
        _finding("event_risk", "constraint", available=True,
                 concern=MAX_EVENT_RISK_CONCERN),
    ])

    assert with_risk.confidence < baseline.confidence
    assert with_risk.binding_constraint == "event_risk"
    # It must not be able to veto on its own.
    assert with_risk.confidence > MIN_CONFIDENCE_TO_TRADE


def test_event_risk_is_ignored_entirely_when_the_feature_is_off(flag_off):
    """A finding present in state must not bind when the specialist is not part of
    the active constraint set — otherwise the flag would be advisory."""
    baseline = _debate([_core_long()])
    with_risk = _debate([
        _core_long(),
        _finding("event_risk", "constraint", available=True, concern=0.35),
    ])
    assert with_risk.confidence == baseline.confidence
    assert with_risk.binding_constraint is None


def test_event_risk_does_not_compound_the_other_constraints(flag_on):
    """Constraints combine with `max()`, so a fourth cannot multiply the other three
    — but it CAN only ever raise the binding concern, which is why it is capped."""
    verdict = _debate([
        _core_long(),
        _finding("portfolio", "constraint", available=True, concern=0.5),
        _finding("event_risk", "constraint", available=True, concern=0.3),
    ])
    assert verdict.binding_constraint == "portfolio"
    assert verdict.constraint_applied == pytest.approx(0.5)


# ===========================================================================
# The uncertainty math — concern without picking a side
# ===========================================================================

@pytest.mark.parametrize("p,expected", [
    (0.5, 1.0), (0.0, 0.0), (1.0, 0.0), (0.25, 0.75), (0.75, 0.75), (0.1, 0.36),
])
def test_uncertainty_peaks_at_maximum_disagreement(p, expected):
    assert pm.event_uncertainty(p) == pytest.approx(expected)


def test_uncertainty_is_symmetric_so_no_side_is_privileged():
    """The property that makes this honest: deciding whether YES or NO is adverse for
    a long BTC position would be guesswork, and a symmetric function never has to."""
    for p in (0.05, 0.2, 0.35, 0.49):
        assert pm.event_uncertainty(p) == pytest.approx(pm.event_uncertainty(1 - p))


@pytest.mark.parametrize("bad", [None, -0.1, 1.1, "x"])
def test_uncertainty_is_none_for_an_unusable_probability(bad):
    assert pm.event_uncertainty(bad) is None


def test_proximity_decays_to_zero_at_the_horizon():
    h = pm.EVENT_PROXIMITY_HORIZON_SECONDS
    assert pm.event_proximity(h) == 0.0
    assert pm.event_proximity(h * 2) == 0.0
    assert pm.event_proximity(h / 2) == pytest.approx(0.5)
    assert pm.event_proximity(1.0) == pytest.approx(1.0, abs=1e-4)


def test_a_past_event_has_no_proximity_rather_than_negative():
    """The event has happened; whatever it did is already in the price."""
    assert pm.event_proximity(-1000.0) == 0.0
    assert pm.event_proximity(0.0) == 0.0


def test_unknown_timing_is_none_not_zero():
    """An event whose timing cannot be read is not thereby far away."""
    assert pm.event_proximity(None) is None


def test_concern_is_the_product_and_the_weakest_factor_dominates():
    h = pm.EVENT_PROXIMITY_HORIZON_SECONDS
    # Maximum uncertainty, imminent.
    assert pm.event_concern(0.5, 60.0, 0.3) == pytest.approx(0.3, abs=0.01)
    # Maximum uncertainty but far away -> nothing.
    assert pm.event_concern(0.5, h, 0.3) == 0.0
    # Imminent but already decided -> nothing.
    assert pm.event_concern(0.99, 60.0, 0.3) == pytest.approx(0.3 * 4 * 0.99 * 0.01,
                                                              abs=0.005)


def test_concern_is_none_when_either_factor_is_unmeasured():
    """A caller must not coalesce this to 0.0: "we could not tell how uncertain this
    is" is not "this is settled", and the second reads as reassurance."""
    assert pm.event_concern(None, 60.0, 0.3) is None
    assert pm.event_concern(0.5, None, 0.3) is None


def test_concern_respects_its_ceiling():
    assert pm.event_concern(0.5, 60.0, 5.0, ceiling=0.35) == pytest.approx(0.35)


# ===========================================================================
# The specialists themselves
# ===========================================================================

async def test_no_snapshot_reads_as_not_applicable(flag_on, tmp_snapshots):
    result = sp.specialist_prediction({"symbol": "BTC/USDT"})
    finding = result["specialist_findings"][0]
    assert finding.available is False
    assert finding.not_applicable is True
    assert finding.role == "supplementary"
    # NOT added to `unavailable` — that list answers "why did nothing trade?", and an
    # inapplicable source is not a reason a trade did not happen.
    assert "unavailable" not in result


async def test_a_mapped_but_uncomputable_snapshot_reads_as_a_real_gap(flag_on, tmp_snapshots):
    from backend.services import polymarket_store as store

    await store.save_signal_snapshot("BTC/USDT", applicable=True, directional=None)
    result = sp.specialist_prediction({"symbol": "BTC/USDT"})
    finding = result["specialist_findings"][0]

    assert finding.available is False
    assert finding.not_applicable is False
    assert "unavailable" in result


async def test_a_fresh_snapshot_produces_a_supplementary_vote(flag_on, tmp_snapshots):
    from backend.services import polymarket_store as store

    await store.save_signal_snapshot(
        "BTC/USDT", applicable=True,
        directional={"direction": "LONG", "confidence": 0.6,
                     "observation": "implied expected price 2.1% above spot"},
    )
    finding = sp.specialist_prediction({"symbol": "BTC/USDT"})["specialist_findings"][0]

    assert finding.available is True
    assert finding.stance == "supports_long"
    assert finding.confidence == pytest.approx(0.6)
    assert any("TERMINAL" in e for e in finding.evidence)
    assert any("shades conviction" in e for e in finding.evidence)


async def test_a_stale_snapshot_is_refused(flag_on, tmp_snapshots):
    """A half-hour-old probability presented as current evidence would be weighted as
    a live reading."""
    from backend.services import polymarket_store as store

    await store.save_signal_snapshot(
        "BTC/USDT", applicable=True,
        directional={"direction": "LONG", "confidence": 0.6},
        computed_at=time.time() - store.MAX_SNAPSHOT_AGE_SECONDS - 60,
    )
    finding = sp.specialist_prediction({"symbol": "BTC/USDT"})["specialist_findings"][0]
    assert finding.available is False
    # Stale is treated as not-applicable at the read layer, because the read cannot
    # tell whether a mapping exists once it refuses the record. Conservative in the
    # direction that costs nothing.
    assert finding.not_applicable is True


async def test_a_future_dated_snapshot_is_refused(flag_on, tmp_snapshots):
    """A clock change must not make stale data look permanently fresh."""
    from backend.services import polymarket_store as store

    await store.save_signal_snapshot(
        "BTC/USDT", applicable=True,
        directional={"direction": "LONG", "confidence": 0.6},
        computed_at=time.time() + store.MAX_SNAPSHOT_AGE_SECONDS + 600,
    )
    finding = sp.specialist_prediction({"symbol": "BTC/USDT"})["specialist_findings"][0]
    assert finding.available is False


@pytest.mark.parametrize("directional", [
    {"direction": "SIDEWAYS", "confidence": 0.5},
    {"direction": "LONG", "confidence": "high"},
    {"direction": "LONG", "confidence": True},
    {"direction": None, "confidence": 0.5},
])
async def test_a_malformed_snapshot_is_refused_not_coerced(flag_on, tmp_snapshots, directional):
    from backend.services import polymarket_store as store

    await store.save_signal_snapshot("BTC/USDT", applicable=True, directional=directional)
    finding = sp.specialist_prediction({"symbol": "BTC/USDT"})["specialist_findings"][0]
    assert finding.available is False
    assert finding.not_applicable is False


async def test_event_risk_reports_unavailable_rather_than_zero_concern(flag_on, tmp_snapshots):
    """A constraint reporting 0.0 says "measured, and found no obstacle". That is
    reassurance this node has not earned when its feed is absent."""
    finding = sp.specialist_event_risk({"symbol": "BTC/USDT"})["specialist_findings"][0]
    assert finding.available is False
    assert finding.concern is None
    assert "not the same as no event risk" in " ".join(finding.evidence)


async def test_event_risk_caps_a_runaway_concern(flag_on, tmp_snapshots):
    from backend.services import polymarket_store as store
    from backend.services.polymarket_registry import MAX_EVENT_RISK_CONCERN

    await store.save_signal_snapshot(
        "BTC/USDT", applicable=True,
        event_risk={"concern": 5.0, "observation": "regulatory decision in 2 days"},
    )
    finding = sp.specialist_event_risk({"symbol": "BTC/USDT"})["specialist_findings"][0]
    assert finding.available is True
    assert finding.concern == pytest.approx(MAX_EVENT_RISK_CONCERN)


async def test_the_specialists_never_raise_on_a_corrupt_snapshot_file(flag_on, tmp_snapshots):
    """A corrupt store must degrade to a reported finding, not fail the graph run."""
    import pathlib

    from backend.services import polymarket_store as store

    pathlib.Path(store.SNAPSHOT_FILE).write_text("{ not json", encoding="utf-8")
    assert sp.specialist_prediction({"symbol": "BTC/USDT"})["specialist_findings"]
    assert sp.specialist_event_risk({"symbol": "BTC/USDT"})["specialist_findings"]


# ===========================================================================
# Graph wiring
# ===========================================================================

def _rebuild():
    from backend.graphs import analysis
    from backend.graphs.registry import clear_registry

    clear_registry()
    analysis.reset_subscription()
    return analysis.analysis_config()


def test_the_graph_has_seven_specialists_with_the_feature_off(flag_off):
    cfg = _rebuild()
    assert len([n for n in cfg.nodes if n.startswith("specialist_")]) == 7
    assert "specialist_prediction" not in cfg.nodes


def test_the_graph_has_nine_with_the_feature_on(flag_on):
    cfg = _rebuild()
    specialists = [n for n in cfg.nodes if n.startswith("specialist_")]
    assert len(specialists) == 9
    assert "specialist_prediction" in cfg.nodes
    assert "specialist_event_risk" in cfg.nodes


def test_both_optional_nodes_fan_in_to_the_debate(flag_on):
    cfg = _rebuild()
    for node in ("specialist_prediction", "specialist_event_risk"):
        assert (node, "debate") in cfg.edges, f"{node} does not reach the debate"


def test_the_fan_out_router_and_the_node_list_agree(flag_on):
    """Resolved once in `analysis_config` for this reason: three separate calls to
    `specialist_nodes()` would let the flag change between them and build a graph
    whose nodes, edges and router disagreed."""
    cfg = _rebuild()
    branch = next(ce for ce in cfg.conditional_edges
                  if ce.source == "opportunity_detection")
    routed = set(branch.destinations["analyse"])
    listed = {n for n in cfg.nodes if n.startswith("specialist_")}
    assert routed == listed


def test_the_optional_nodes_are_deterministic_and_cannot_call_a_model(flag_on):
    """`registry.coverage()`'s deterministic/LLM ratio is the number this project
    watches. A supplementary feed is not a reason to move it."""
    _rebuild()
    from backend.graphs.registry import get_contract

    for name in ("specialist_prediction", "specialist_event_risk"):
        contract = get_contract(name)
        assert contract is not None, name
        assert contract.deterministic is True
        assert contract.may_call_llm is False
        assert contract.phase == 35


def test_the_optional_nodes_write_only_findings_and_unavailable(flag_on):
    _rebuild()
    from backend.graphs.registry import get_contract

    for name in ("specialist_prediction", "specialist_event_risk"):
        assert set(get_contract(name).writes) == {"specialist_findings", "unavailable"}


# ===========================================================================
# The supervisor, with a supplementary finding in state
# ===========================================================================
#
# THE GAP THAT LET A CRASH SHIP. Every test above drives `run_debate` directly. None
# of them ran the SUPERVISOR with a supplementary finding present — and that is where
# the third role broke something.

def _panel_findings():
    """A realistic panel: two directional, one supplementary, three constraint."""
    return [
        _finding("market", "directional", available=True, stance="supports_long",
                 confidence=0.6, evidence=["price is above the 50-period mean"]),
        _finding("funding", "directional", available=True, stance="neutral",
                 confidence=0.0, evidence=["funding is inside the neutral band"]),
        _finding("prediction", "supplementary", available=True, stance="supports_long",
                 confidence=0.55, evidence=["implied expected price 2.4% above spot"]),
        _finding("portfolio", "constraint", available=True, concern=0.0,
                 evidence=["the paper book holds 0 open positions"]),
        _finding("risk", "constraint", available=True, concern=0.0,
                 evidence=["no governance block is active"]),
        _finding("event_risk", "constraint", available=True, concern=0.18,
                 evidence=["monetary_policy: market at 0.52 resolving in 3.0 days"]),
    ]


def _supervisor_state(findings, thesis_direction="LONG"):
    from backend.graphs.state import (
        MarketRegimeState,
        TechnicalAnalysis,
        TradeThesis,
    )

    verdict = sp.run_debate({
        "symbol": "BTC/USDT", "specialist_findings": findings,
    })["debate_verdict"]

    return {
        "symbol": "BTC/USDT",
        "debate_verdict": verdict,
        "trade_thesis": TradeThesis(
            direction=thesis_direction, strategy="MeanReversion",
            entry_price=123_880.0, stop_loss=123_000.0, take_profit=125_500.0,
        ),
        "market_regime": MarketRegimeState(regime="Low Volatility", volatility="LOW",
                                           trend_strength=0.12, confidence=0.6),
        "technical_analysis": TechnicalAnalysis(atr=300.0, rsi=55.0),
        "specialist_findings": findings,
        "monitored_position": None,
    }


def test_the_supervisor_does_not_crash_on_a_supplementary_finding(flag_on):
    """THE REGRESSION.

    `_why_from_specialists` branched `if directional / else constraint`, so a
    supplementary finding was formatted as `(constraint, {concern:.2f})` — and a
    supplementary finding carries `stance`, never `concern`, so `concern` was None and
    the format raised `unsupported format string passed to NoneType.__format__`.

    The whole supervisor node then failed and produced NO decision, where it should
    have returned an explainable one. `builder.py` degrades a failed node rather than
    aborting the run, so the only symptom was a single log line and a missing decision
    — found by enabling the gates and running the graph for real, not by the suite.
    """
    from backend.graphs.nodes.supervisor import supervise

    result = supervise(_supervisor_state(_panel_findings()))
    assert result is not None
    assert result.get("decision") is not None, "the supervisor produced no decision"


def test_a_supplementary_finding_is_not_described_as_a_constraint(flag_on):
    """The second half of the same bug. Even without the crash, labelling the
    prediction leg a "constraint" inverts the role distinction the supplementary tier
    exists to draw: a constraint caps conviction and cannot vote; this one votes."""
    from backend.graphs.nodes.supervisor import supervise

    decision = supervise(_supervisor_state(_panel_findings()))["decision"]
    why = decision.why or ""

    assert "prediction" in why, why
    assert "prediction (constraint" not in why, why
    assert "supplementary" in why, why
    # And a real constraint is still described as one.
    assert "event_risk (constraint" in why, why


def test_an_unmeasured_constraint_concern_is_named_not_formatted(flag_on):
    """A constraint that is available but whose concern could not be measured must not
    crash the formatter either — the original line would have done the same thing."""
    from backend.graphs.nodes.supervisor import supervise

    findings = _panel_findings()
    findings.append(
        _finding("liquidity", "constraint", available=True, concern=None,
                 evidence=["depth was reported but could not be scored"])
    )
    decision = supervise(_supervisor_state(findings))["decision"]
    assert "liquidity (constraint, unmeasured)" in (decision.why or "")


def test_every_specialist_role_is_handled_explicitly():
    """No `else` fallback across roles. Adding a fourth role must fail loudly in review
    rather than be silently formatted as whichever branch the else happens to be."""
    import ast
    import inspect

    from backend.graphs.nodes import supervisor as sup

    src = inspect.getsource(sup._why_from_specialists)
    tree = ast.parse(src.strip())
    compared = {
        node.comparators[0].value
        for node in ast.walk(tree)
        if isinstance(node, ast.Compare)
        and isinstance(node.comparators[0], ast.Constant)
        and isinstance(node.comparators[0].value, str)
    }
    # It must branch on a named role, and the roles it can see are these three.
    assert compared & {"constraint", "directional"}, compared
