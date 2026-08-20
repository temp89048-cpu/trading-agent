"""Phase 38 — the validation study, and the bus-isolation fix it needed first.

Two subjects, both about a study being unable to change what it studies:

  * `OPERATOR_GUIDE.md` §6.4 — `HistoricalBacktestEngine` cleared the LIVE message
    bus, so a validation run silently disabled trading;
  * CLAUDE.md invariant 5 — a study may produce understanding and must not deploy
    anything, so its output is a `proposed` hypothesis and nothing else.

The statistical tests are mostly about refusing to report a number: with no stored
probability history this study cannot run, and the failure mode worth guarding is a
hit rate computed over three observations being presented as a finding.
"""

from __future__ import annotations

import math
import pathlib

import pytest

from backend.tools import polymarket_validation as val


# ===========================================================================
# §6.4 — the bus-isolation fix
# ===========================================================================

def test_the_backtest_engine_no_longer_touches_the_live_bus():
    """It used to call `self.bus._subscribers.clear()` on the GLOBAL bus, which
    unsubscribed the trigger worker, the CRO, the execution agent and the position
    monitor. A validation run silently disabled trading, and nothing surfaced it —
    every component just stopped receiving events."""
    from backend.core.backtest_engine import HistoricalBacktestEngine
    from backend.core.message_bus import get_message_bus

    live = get_message_bus()

    def canary(_event):
        return None

    live.subscribe("LIVE_CANARY", canary)

    engine = HistoricalBacktestEngine("BTC/USDT")
    try:
        assert engine.bus is not live, "the engine must not share the live bus"
        assert "LIVE_CANARY" in live._subscribers
        assert canary in live._subscribers["LIVE_CANARY"]
    finally:
        engine.restore_agent_buses()


def test_the_engine_rebinds_rather_than_only_subscribing():
    """Subscribing alone is NOT enough, and would have been worse than the original
    bug. `BaseAgent.__init__` captures the bus, so `publish()` goes to whatever bus the
    agent was CONSTRUCTED with — two of the three agents are process singletons wired
    to the global bus, so they would have consumed simulated ticks and published the
    resulting orders onto the LIVE bus."""
    from backend.core.backtest_engine import HistoricalBacktestEngine

    engine = HistoricalBacktestEngine("BTC/USDT")
    try:
        assert engine.supervisor.bus is engine.bus
        assert engine.market_intelligence.bus is engine.bus
    finally:
        engine.restore_agent_buses()


def test_restoring_puts_the_singletons_back():
    """Otherwise a live singleton stays pointed at a discarded simulation bus for the
    rest of the process's life, publishing into nothing and looking simply broken with
    no connection to the backtest that caused it."""
    from backend.core.backtest_engine import HistoricalBacktestEngine
    from backend.core.message_bus import get_message_bus

    live = get_message_bus()
    engine = HistoricalBacktestEngine("BTC/USDT")
    engine.restore_agent_buses()

    assert engine.supervisor.bus is live
    assert engine.market_intelligence.bus is live


def test_restoring_does_not_double_subscribe():
    """THE BUG THE FIX ITSELF INTRODUCED.

    `rebind_bus` subscribes on the bus it moves to, so restoring re-subscribed the
    agent on the global bus — taking `DEBATE_CONCLUDED` from one handler to two. The
    supervisor would then evaluate every signal twice and could submit two trade
    requests for one decision. Nothing raised.

    Fixed by making `MessageBus.subscribe` idempotent, which is where the hazard
    belongs: this codebase already guards against double-subscription by hand in
    `analysis`, `execution_service` and `trigger_worker`, so each new subscriber had
    to remember.
    """
    from backend.core.backtest_engine import HistoricalBacktestEngine
    from backend.core.message_bus import get_message_bus

    live = get_message_bus()

    # The baseline is taken BEFORE constructing the engine, and that matters. An
    # earlier version measured it after, which was correct only while `rebind_bus`
    # left the agent subscribed to both buses — once rebinding started unsubscribing,
    # the count during a simulation became 0 and the test compared restore against
    # the wrong reference.
    from backend.agents.supervisor_agent import get_supervisor

    supervisor = get_supervisor()
    topic = supervisor.events_consumed[0]
    before = len(live._subscribers.get(topic, []))

    engine = HistoricalBacktestEngine("BTC/USDT")
    engine.restore_agent_buses()
    engine.restore_agent_buses()  # idempotent
    assert len(live._subscribers.get(topic, [])) == before


def test_rebinding_unsubscribes_from_the_old_bus():
    """THE RESIDUE THE UNIT TESTS MISSED.

    The first version of `rebind_bus` only subscribed to the new bus, leaving the
    agent on BOTH. During a backtest a live `TICK_RECEIVED` therefore still reached
    the market-intelligence agent, which then published its result to the SIMULATION
    bus — live analysis silently stopped working for the duration, and the simulation
    was polluted with live data. Same cross-contamination as §6.4, opposite direction.

    The earlier tests checked that the live bus's *subscribers survived* and never
    checked what the *rebound agent was still listening to*. It was found by an
    independent end-to-end verification instead, which is the argument for running
    one.
    """
    from backend.core.backtest_engine import HistoricalBacktestEngine
    from backend.core.message_bus import get_message_bus

    live = get_message_bus()
    engine = HistoricalBacktestEngine("BTC/USDT")
    try:
        for agent in (engine.supervisor, engine.market_intelligence):
            for topic in agent.events_consumed:
                assert agent.handle_event not in live._subscribers.get(topic, []), (
                    f"{agent.name} is still on the LIVE bus for {topic} during a "
                    f"simulation — a live event would be handled and its result "
                    f"published into the simulation"
                )
                assert agent.handle_event in engine.bus._subscribers.get(topic, [])
    finally:
        engine.restore_agent_buses()

    # And restoring is symmetric: back on live, off the simulation bus.
    for topic in engine.supervisor.events_consumed:
        assert engine.supervisor.handle_event in live._subscribers.get(topic, [])
        assert engine.supervisor.handle_event not in engine.bus._subscribers.get(topic, [])


def test_unsubscribe_reports_whether_it_removed_anything():
    from backend.core.message_bus import MessageBus

    bus = MessageBus()

    def handler(_e):
        return None

    assert bus.unsubscribe("T", handler) is False
    bus.subscribe("T", handler)
    assert bus.unsubscribe("T", handler) is True
    assert bus.unsubscribe("T", handler) is False


def test_unsubscribe_removes_empty_topics():
    """`len(_subscribers)` must stay an honest count of topics that actually have
    listeners — a monitoring view reading it would otherwise report topics served by
    nobody."""
    from backend.core.message_bus import MessageBus

    bus = MessageBus()

    def a(_e):
        return None

    def b(_e):
        return None

    bus.subscribe("T", a)
    bus.subscribe("T", b)
    bus.unsubscribe("T", a)
    assert "T" in bus._subscribers
    bus.unsubscribe("T", b)
    assert "T" not in bus._subscribers


def test_subscribe_is_idempotent():
    from backend.core.message_bus import MessageBus

    bus = MessageBus()

    def handler(_e):
        return None

    bus.subscribe("T", handler)
    bus.subscribe("T", handler)
    bus.subscribe("T", handler)
    assert len(bus._subscribers["T"]) == 1

    def other(_e):
        return None

    bus.subscribe("T", other)
    assert len(bus._subscribers["T"]) == 2


def test_rebind_bus_is_not_used_in_the_live_path():
    """It exists for simulation only. A live caller rebinding an agent would move it
    off the bus every other component publishes on."""
    import ast

    callers = set()
    for path in pathlib.Path("backend").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr == "rebind_bus":
                callers.add(path.as_posix())

    assert callers <= {
        "backend/core/agent_base.py",       # the definition
        "backend/core/backtest_engine.py",  # the simulation harness
    }, sorted(callers)


# ===========================================================================
# Statistics — mostly about refusing to report
# ===========================================================================

def test_a_fair_coin_is_not_significant():
    p = val.binomial_p_value(50, 100)
    assert p is not None and p > 0.9


def test_a_strong_result_is_significant():
    p = val.binomial_p_value(70, 100)
    assert p is not None and p < 0.001


def test_the_p_value_is_two_sided():
    """A signal that is reliably WRONG is as interesting as one that is right, and a
    one-sided test would score it as unremarkable."""
    high = val.binomial_p_value(70, 100)
    low = val.binomial_p_value(30, 100)
    assert high == pytest.approx(low)


def test_the_p_value_of_the_most_likely_outcome_is_one():
    """The float-comparison guard. Without `cutoff = observed * (1 + 1e-12)`, the
    symmetric partner of the observed outcome can be excluded by a rounding
    difference, which halves the p-value of the most common case."""
    assert val.binomial_p_value(5, 10) == pytest.approx(1.0)
    assert val.binomial_p_value(50, 100) == pytest.approx(1.0, abs=0.02)


def test_the_p_value_is_none_for_an_empty_sample():
    assert val.binomial_p_value(0, 0) is None


def test_the_exact_test_is_used_rather_than_a_normal_approximation():
    """The approximation is poor at small n — exactly where this study operates — and
    it understates the p-value, making a weak result look strong."""
    n, hits = 10, 9
    exact = val.binomial_p_value(hits, n)
    # Normal approximation, for comparison only.
    z = (hits - n * 0.5) / math.sqrt(n * 0.25)
    approx = 2 * (1 - 0.5 * (1 + math.erf(z / math.sqrt(2))))
    assert exact is not None
    assert exact > approx, (exact, approx)


# ===========================================================================
# Lookahead bias — the error that silently inflates every metric
# ===========================================================================

def _candles(n=200, start=100.0, step=0.5, hour_ms=3_600_000):
    return [
        {"openTime": i * hour_ms, "open": start + i * step,
         "high": start + i * step + 1, "low": start + i * step - 1,
         "close": start + i * step, "volume": 100.0}
        for i in range(n)
    ]


def test_price_lookup_never_returns_a_future_candle():
    """LAST AT OR BEFORE, never nearest. A nearest-match could return a candle from
    AFTER the timestamp, leaking future information into the signal — the classic
    lookahead bias, which inflates every metric silently."""
    candles = _candles(10)
    hour = 3600.0

    # Exactly on a boundary: that candle, not the next.
    assert val._price_at(candles, 5 * hour) == candles[5]["close"]
    # Just after: still that candle.
    assert val._price_at(candles, 5 * hour + 1) == candles[5]["close"]
    # Just before: the PREVIOUS candle.
    assert val._price_at(candles, 5 * hour - 1) == candles[4]["close"]
    # Before all data: nothing, rather than the first candle.
    assert val._price_at(candles, -1.0) is None


def test_the_signal_is_computed_only_from_data_available_at_the_time():
    """`evaluate_cell` slices `series[: i + 1]`. Passing the whole series would let a
    later observation set the ΔP for an earlier timestamp, which is the same class of
    error as the price lookup above and just as invisible in the output."""
    import inspect

    src = inspect.getsource(val.evaluate_cell)
    assert "series[: i + 1]" in src


# ===========================================================================
# Refusing to report
# ===========================================================================

def _points(values, start=0.0, step=300.0):
    return [{"ts": start + i * step, "p": v} for i, v in enumerate(values)]


def test_a_cell_with_too_few_observations_reports_no_metrics():
    """The failure mode this guards: a hit rate of 0.67 over three observations being
    read as a finding."""
    cell = val.evaluate_cell(
        _points([0.4, 0.5, 0.6]), _candles(), 3600.0, 3600.0, 0.02,
    )
    assert cell.hit_rate is None
    assert cell.p_value is None
    assert "coin flip" in cell.reason_unavailable


def test_a_cell_with_no_candles_reports_why():
    cell = val.evaluate_cell(_points([0.4] * 100), [], 3600.0, 3600.0, 0.02)
    assert cell.reason_unavailable == "no probability history or no price candles"


async def test_the_study_refuses_without_enough_history(tmp_path, monkeypatch):
    """The state this will be in for a while: it needs the poller to have run, which
    needs the flag, a confirmed mapping and network access to Polymarket."""
    from backend.services import polymarket_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SERIES_FILE", str(tmp_path / "series.json"))

    result = await val.run_study("X:YES", "BTC/USDT", candles=_candles())
    assert result.available is False
    assert result.cells == []
    assert "minutes of live polling" in result.reason_unavailable


async def test_the_study_runs_the_full_grid_when_data_exists(tmp_path, monkeypatch):
    from backend.services import polymarket_store as store

    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SERIES_FILE", str(tmp_path / "series.json"))

    # 400 observations at 5-minute spacing, drifting upward with noise.
    for i in range(400):
        await store.record_probability(
            "X:YES",
            min(0.95, 0.20 + 0.0015 * i + (0.004 if i % 2 else -0.004)),
            ts=i * 300.0,
        )

    result = await val.run_study("X:YES", "BTC/USDT", candles=_candles(400))
    assert result.available is True
    expected = (
        len(val.ABLATION_WINDOWS_SECONDS)
        * len(val.ABLATION_HORIZONS_SECONDS)
        * len(val.ABLATION_THRESHOLDS)
    )
    assert len(result.cells) == expected

    payload = result.as_dict()
    assert "Bonferroni" in payload["multipleComparisons"]
    assert "1.0 of 8.0 panel weight" in payload["notMeasured"]["sharpe"]


def test_the_report_names_what_it_deliberately_does_not_measure():
    """Sharpe, AUC and walk-forward are each refused with a reason. A study that
    quietly omits them invites the reader to assume they were fine."""
    payload = val.StudyResult(outcome="X", symbol="BTC/USDT", available=False).as_dict()
    for key in ("sharpe", "auc", "walkForward"):
        assert payload["notMeasured"][key]
    assert "invariant 5" in payload["deploymentMeaning"]


# ===========================================================================
# Invariant 5 — the study cannot deploy itself
# ===========================================================================

def test_the_study_cannot_reach_the_panel_weights():
    """A backtest showing weight 2.0 beats 1.0 must NOT write SUPPLEMENTARY_WEIGHTS.
    Checked by AST rather than text so the docstring explaining the rule is not
    mistaken for a breach of it."""
    import ast

    tree = ast.parse(
        pathlib.Path("backend/tools/polymarket_validation.py").read_text(encoding="utf-8")
    )

    forbidden_names = {
        "DIRECTIONAL_WEIGHTS", "SUPPLEMENTARY_WEIGHTS", "TOTAL_DIRECTIONAL_WEIGHT",
        "MIN_CONFIDENCE_TO_TRADE", "MAX_EVENT_RISK_CONCERN",
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id in forbidden_names:
            pytest.fail(f"the study references {node.id}")
        if isinstance(node, ast.Attribute) and node.attr in forbidden_names:
            pytest.fail(f"the study references {node.attr}")
        # No import of the specialists module at all — reading a weight is the first
        # step toward writing one.
        if isinstance(node, ast.ImportFrom) and node.module:
            assert "specialists" not in node.module, node.module


def test_the_study_writes_only_to_the_research_queue():
    """`add_hypothesis` writes status `proposed`, and
    `update_hypothesis_status` refuses validated/applied without `set_by_human`. So
    `study -> weight change -> live trading` has no automated segment."""
    import ast

    tree = ast.parse(
        pathlib.Path("backend/tools/polymarket_validation.py").read_text(encoding="utf-8")
    )
    calls = {
        node.func.attr for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    assert "add_hypothesis" in calls
    for forbidden in ("update_hypothesis_status", "save_mapping", "confirm_mapping",
                      "record_probability", "save_signal_snapshot"):
        assert forbidden not in calls, f"the study calls {forbidden}"


async def test_a_study_that_could_not_run_records_nothing(tmp_path, monkeypatch):
    """Filling the operator's queue with "insufficient data" entries would bury the
    ones that say something."""
    result = val.StudyResult(outcome="X:YES", symbol="BTC/USDT", available=False)
    assert await val.record_as_hypothesis(result) is None


async def test_a_recorded_hypothesis_is_proposed_and_carries_the_caveat(
    tmp_path, monkeypatch,
):
    from backend.services import research_store

    monkeypatch.setattr(research_store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(research_store, "HYPOTHESES_FILE", str(tmp_path / "h.json"))

    result = val.StudyResult(
        outcome="X:YES", symbol="BTC/USDT", available=True,
        probability_points=400, price_points=400,
        best_cell=val.CellResult(
            window_seconds=3600.0, horizon_seconds=14400.0, threshold=0.05,
            observations=120, hits=78, hit_rate=0.65, p_value=0.0012,
            mean_forward_return_pct=0.4,
        ).as_dict(),
    )

    row = await val.record_as_hypothesis(result)
    assert row is not None
    assert row["status"] == "proposed"
    assert row["appliedAutomatically"] is False
    assert "Bonferroni" in row["claim"]
    assert "best of 18 cells" in row["evidence"]["honestCaveat"]
    # The validation plan must require the SAME cell to hold, not whichever is best
    # next time — otherwise re-running the grid re-selects the extreme every round.
    assert any("previously-best cell" in step for step in row["validationPlan"])


async def test_one_hypothesis_per_outcome_not_per_run(tmp_path, monkeypatch):
    """`add_hypothesis` dedupes on trade_id, and the study's id is per-outcome — so
    re-running does not fill the queue with copies of the same claim."""
    from backend.services import research_store

    monkeypatch.setattr(research_store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(research_store, "HYPOTHESES_FILE", str(tmp_path / "h.json"))

    result = val.StudyResult(
        outcome="X:YES", symbol="BTC/USDT", available=True,
        best_cell=val.CellResult(
            window_seconds=3600.0, horizon_seconds=3600.0, threshold=0.05,
            observations=50, hits=30, hit_rate=0.6, p_value=0.2,
        ).as_dict(),
    )

    assert await val.record_as_hypothesis(result) is not None
    assert await val.record_as_hypothesis(result) is None
    assert len(await research_store.get_hypotheses()) == 1
