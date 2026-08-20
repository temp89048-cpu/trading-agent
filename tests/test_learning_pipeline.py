"""Spec Section 12 — the learning pipeline, and the path it must never take.

    Required:  Trade -> Reflection -> Research Queue -> Hypothesis -> Backtest
               -> Walk-Forward -> Paper -> Evaluation -> Human Approval -> Production

    Forbidden: Loss -> AI rewrites strategy -> Live Trading

The forbidden path is the one worth testing hardest, because it is the one that
turns a single unlucky trade into a permanent change to what happens to real
capital. These tests assert it by inspecting imports rather than trusting
comments — a docstring promising not to write config is not a control.
"""

import ast
import pathlib

import pytest

from backend.agents.hypothesis_agent import HypothesisAgent, get_active_hypotheses
from backend.models.events import ReflectionCompletedEvent
from backend.services import research_store

ROOT = pathlib.Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"

# Modules that make up the learning/research path. None may reach trading config.
LEARNING_MODULES = [
    BACKEND / "agents" / "hypothesis_agent.py",
    BACKEND / "agents" / "reflection_agent.py",
    BACKEND / "services" / "research_store.py",
    BACKEND / "workers" / "curiosity_worker.py",
    BACKEND / "agents" / "research_agent.py",
]

# Symbols that would let a learning module change how the system trades.
FORBIDDEN_SYMBOLS = {
    "ABSOLUTE_MAX_LEVERAGE",
    "ABSOLUTE_MAX_LEVERAGE_PAPER",
    "max_leverage_ceiling",
    "check_leverage",
    "create_market_order",
    "close_position",
    "TarSubmittedEvent",
    "TarApprovedEvent",
    "update_portfolio",
    "buy_paper",
    "sell_paper",
}


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    """Point the store at a temp directory so tests never touch real .data/."""
    monkeypatch.setattr(research_store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(research_store, "HYPOTHESES_FILE", str(tmp_path / "hypotheses.json"))
    monkeypatch.setattr(research_store, "RESEARCH_TASKS_FILE", str(tmp_path / "research_tasks.json"))


def _reflection(trade_id="t1", pnl=-50.0, delta=-2.5, lesson="stop was too tight"):
    return ReflectionCompletedEvent(
        trade_id=trade_id,
        pnl=pnl,
        lesson_learned=lesson,
        confidence_calibration_delta=delta,
    )


# ---------------------------------------------------------------------------
# The forbidden path
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", LEARNING_MODULES, ids=lambda p: p.name)
def test_no_learning_module_imports_anything_that_can_change_trading(path):
    """CLAUDE.md invariant 5, enforced structurally.

    If a learning module cannot even import the symbols that write risk config
    or place orders, it cannot take the forbidden path regardless of what its
    logic does.
    """
    if not path.exists():
        pytest.skip(f"{path.name} does not exist")
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)

    violations = imported & FORBIDDEN_SYMBOLS
    assert not violations, (
        f"{path.name} imports {sorted(violations)} — a learning module must not be able to "
        f"change how the system trades (spec Section 12's forbidden path)."
    )


def test_hypothesis_agent_holds_no_config_or_execution_permission():
    agent = HypothesisAgent()
    forbidden = {"WRITE_CONFIG", "SET_STRATEGY", "WRITE_RISK_LIMITS", "ROUTE_ORDERS",
                 "SUBMIT_TAR", "APPROVE_TAR", "CLOSE_POSITIONS"}
    assert not (set(agent.permissions) & forbidden)


def test_hypothesis_agent_publishes_no_events():
    """A hypothesis is not an instruction. An event inviting other agents to act
    on one would be the start of the auto-deploy path."""
    assert HypothesisAgent().events_published == []


# ---------------------------------------------------------------------------
# The human approval gate
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_new_hypothesis_starts_as_proposed():
    record = await research_store.add_hypothesis(
        trade_id="t1", symbol="BTC/USDT", claim="c", suggested_test="t",
        validation_plan=["1. backtest"], evidence={},
    )
    assert record["status"] == "proposed"
    assert record["appliedAutomatically"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["validated", "rejected", "applied", "dismissed"])
async def test_automated_caller_cannot_set_a_human_only_status(status):
    """The enforcement point for Section 12's approval gate. An automated caller
    must not be able to mark its own hypothesis reviewed."""
    record = await research_store.add_hypothesis(
        trade_id="t1", symbol="BTC/USDT", claim="c", suggested_test="t",
        validation_plan=["1. backtest"], evidence={},
    )
    with pytest.raises(PermissionError) as exc:
        await research_store.update_hypothesis_status(record["id"], status, "note", set_by_human=False)
    assert "human operator" in str(exc.value)


@pytest.mark.asyncio
async def test_human_can_set_status():
    record = await research_store.add_hypothesis(
        trade_id="t1", symbol="BTC/USDT", claim="c", suggested_test="t",
        validation_plan=["1. backtest"], evidence={},
    )
    updated = await research_store.update_hypothesis_status(
        record["id"], "validated", "checked the backtest myself", set_by_human=True
    )
    assert updated["status"] == "validated"
    assert updated["reviewNote"] == "checked the backtest myself"


@pytest.mark.asyncio
async def test_invalid_status_is_rejected():
    record = await research_store.add_hypothesis(
        trade_id="t1", symbol="BTC/USDT", claim="c", suggested_test="t",
        validation_plan=["1. backtest"], evidence={},
    )
    with pytest.raises(ValueError):
        await research_store.update_hypothesis_status(record["id"], "deployed", "x", set_by_human=True)


def test_only_http_routes_pass_set_by_human():
    """`set_by_human=True` must be passed ONLY from an HTTP route an operator drives.
    Anywhere else would be a backdoor around the gate.

    Checks real call arguments via `ast`, not raw text. A text search also
    matched `backend/core/auth.py`, whose docstring discusses this very gate —
    prose about a rule is not a violation of it, and a test that can't tell the
    difference would push authors toward not documenting the rule.

    WIDENED FROM ONE FILE TO ONE LAYER.
    -----------------------------------
    This originally asserted the set was exactly `["backend/api/research.py"]`, and it
    failed when `backend/api/polymarket.py` added the same gate for the Polymarket
    market-mapping confirmation — a second, legitimate instance of the identical
    pattern for a different store.

    Pinning the exact filename made the test a record of WHICH gate existed rather
    than of the rule the gate enforces, so a correct addition read as a violation. The
    rule is about the layer: a service, worker, graph node or algorithm must never
    pass it, because that is automated code confirming its own guess, which makes the
    human step decorative. An `api/` module is by definition a route a person drives.
    """
    hits = []
    for path in BACKEND.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            for kw in node.keywords:
                if (
                    kw.arg == "set_by_human"
                    and isinstance(kw.value, ast.Constant)
                    and kw.value.value is True
                ):
                    hits.append(path.relative_to(ROOT).as_posix())

    found = sorted(set(hits))
    # The research gate must still exist — this test's original subject.
    assert "backend/api/research.py" in found, (
        "backend/api/research.py no longer passes set_by_human=True, so Section 12's "
        f"human-approval gate is unreachable. Found: {found}"
    )
    non_route = [f for f in found if not f.startswith("backend/api/")]
    assert not non_route, (
        f"set_by_human=True is passed outside an HTTP route: {non_route}. Automated "
        f"code may not satisfy the human gate."
    )


# ---------------------------------------------------------------------------
# Section 12's nine artifacts
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_reflection_produces_a_hypothesis_with_a_validation_plan():
    """REFLECTION_COMPLETED previously had no consumer — the learning loop ended
    at "a lesson was written to a file"."""
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-plan"))

    rows = await research_store.get_hypotheses()
    assert len(rows) == 1
    assert rows[0]["claim"]
    # A claim without a test is an opinion.
    assert rows[0]["validationPlan"]


@pytest.mark.asyncio
async def test_validation_plan_includes_the_explicit_human_approval_step():
    """Listed as a step someone performs, not an implied afterthought."""
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-approval"))
    plan = (await research_store.get_hypotheses())[0]["validationPlan"]
    joined = " ".join(plan).upper()
    assert "HUMAN APPROVAL" in joined
    assert "WALK-FORWARD" in joined
    assert "PAPER" in joined


@pytest.mark.asyncio
async def test_reflection_queues_research_tasks():
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-tasks"))
    tasks = await research_store.get_research_tasks()
    assert tasks
    assert all(t["status"] == "open" for t in tasks)


@pytest.mark.asyncio
async def test_a_large_calibration_delta_adds_a_calibration_question():
    """Being confidently wrong is a different problem from being unlucky."""
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-cal", delta=-4.0))
    questions = " ".join(t["question"] for t in await research_store.get_research_tasks())
    assert "calibration" in questions.lower()


@pytest.mark.asyncio
async def test_a_winning_trade_also_produces_a_hypothesis():
    """Section 12: every completed trade, not just the losses. Learning only
    from losses biases the system toward explaining failure."""
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-win", pnl=120.0, delta=1.0))
    rows = await research_store.get_hypotheses()
    assert len(rows) == 1
    assert "profitably" in rows[0]["claim"]


@pytest.mark.asyncio
async def test_one_reflection_produces_at_most_one_hypothesis():
    """A redelivered event must not fill the queue with duplicates of the same
    claim — the operator could not then tell how many distinct lessons existed."""
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-dup"))
    await agent.handle_event(_reflection(trade_id="t-dup"))
    assert len(await research_store.get_hypotheses()) == 1


@pytest.mark.asyncio
async def test_hypothesis_does_not_invent_a_symbol():
    """ReflectionCompletedEvent carries no symbol. The Reflection agent used to
    hardcode "BTC/USDT" for exactly this reason."""
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-sym"))
    assert (await research_store.get_hypotheses())[0]["symbol"] == "unknown"


@pytest.mark.asyncio
async def test_queue_summary_reports_zero_applied_automatically():
    agent = HypothesisAgent()
    await agent.handle_event(_reflection(trade_id="t-sum"))
    summary = await research_store.queue_summary()
    assert summary["appliedAutomatically"] == 0
    assert summary["awaitingHumanReview"] == 1


@pytest.mark.asyncio
async def test_get_active_hypotheses_returns_proposed_only():
    """This function used to be `return []`."""
    await research_store.add_hypothesis(
        trade_id="a", symbol="X", claim="c", suggested_test="t", validation_plan=["p"], evidence={}
    )
    record = await research_store.add_hypothesis(
        trade_id="b", symbol="Y", claim="c", suggested_test="t", validation_plan=["p"], evidence={}
    )
    await research_store.update_hypothesis_status(record["id"], "dismissed", "no", set_by_human=True)

    active = await get_active_hypotheses()
    assert len(active) == 1
    assert active[0]["tradeId"] == "a"


# ---------------------------------------------------------------------------
# Research findings
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_task_cannot_be_closed_without_a_finding():
    """Section 22.5 requires a written finding. Closing a task empty would be
    indistinguishable from nobody having looked at it."""
    created = await research_store.add_research_tasks(None, "t1", "BTC/USDT", ["why?"])
    with pytest.raises(ValueError):
        await research_store.record_finding(created[0]["id"], "   ", 0.8)


@pytest.mark.asyncio
async def test_recording_a_finding_answers_the_task():
    created = await research_store.add_research_tasks(None, "t1", "BTC/USDT", ["why?"])
    answered = await research_store.record_finding(created[0]["id"], "Because of X.", 0.7)
    assert answered["status"] == "answered"
    assert answered["confidence"] == 0.7


@pytest.mark.asyncio
async def test_duplicate_research_questions_are_not_re_queued():
    await research_store.add_research_tasks(None, "t1", "BTC/USDT", ["why?"])
    second = await research_store.add_research_tasks(None, "t1", "BTC/USDT", ["why?"])
    assert second == []


# ---------------------------------------------------------------------------
# Sections 14 & 15 — the loops actually run
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_monitor_cycle_reports_real_state_not_a_hardcoded_position():
    """It used to return `[{"symbol": "BTC-USDT", "pnl_pct": -2.5}]` hardcoded."""
    from backend.workers.monitor_worker import ContinuousMonitorWorker

    cycle = await ContinuousMonitorWorker().run_cycle()
    assert "BTC-USDT" not in str(cycle.get("positions")), "hardcoded position still present"
    # It is a reporting loop, not a second decision loop.
    assert cycle["actionsTaken"] == []
    assert "observations" in cycle


@pytest.mark.asyncio
async def test_curiosity_cycle_claims_no_anomaly_without_enough_data():
    """It used to emit a hardcoded anomaly about VIX — which this system does not
    track at all."""
    from backend.workers.curiosity_worker import CuriosityEngineWorker

    cycle = await CuriosityEngineWorker().run_cycle()
    assert "VIX" not in str(cycle), "hardcoded VIX hypothesis still present"
    assert cycle["affectsProduction"] is False


@pytest.mark.asyncio
async def test_curiosity_worker_only_queues_questions():
    """Section 17: research never directly affects production."""
    from backend.workers.curiosity_worker import CuriosityEngineWorker

    cycle = await CuriosityEngineWorker().run_cycle()
    assert set(cycle) >= {"anomalies", "questionsQueued", "affectsProduction"}
    assert cycle["affectsProduction"] is False


def test_workers_are_started_from_the_application_lifespan():
    """Both existed with mocked bodies AND were never started, so neither loop
    ran at all."""
    main_src = (BACKEND / "main.py").read_text(encoding="utf-8")
    assert "get_monitor_worker" in main_src
    assert "get_curiosity_worker" in main_src
    assert "monitor_worker.start()" in main_src
    assert "curiosity_worker.start()" in main_src
