"""Section 14 / Phase 31 — event triggers, debounce and rate ceilings.

    "Your agent should continuously ask 'did anything change?' — not just run on
     a timer. Use event triggers, not polling. ... These generate graph runs.
     This is far more efficient than 'every 5 minutes → run LLM.'"

The tests that matter most here are the SUPPRESSION ones. A trigger layer that
detects correctly but has no ceiling is worse than the 3-second tick it replaces,
because a volatile minute produces a burst of hundreds of crossings and each one
costs a reasoning run.
"""

from __future__ import annotations

import pytest

from backend.graphs.triggers import (
    BTC_ONLY_TRIGGERS,
    BTC_SYMBOL,
    UNAVAILABLE_TRIGGERS,
    TriggerConfig,
    TriggerEvaluator,
    get_trigger_evaluator,
    reset_trigger_evaluator,
)
from backend.models.events import TriggerFiredEvent


@pytest.fixture(autouse=True)
def _reset():
    reset_trigger_evaluator()
    yield
    reset_trigger_evaluator()


def _ev(**overrides) -> TriggerEvaluator:
    cfg = TriggerConfig(**overrides) if overrides else TriggerConfig()
    return TriggerEvaluator(cfg)


def _acted(decisions):
    return [d for d in decisions if d.acted]


def _suppressed(decisions):
    return [d for d in decisions if not d.acted]


# ===========================================================================
# Baselines — the first observation establishes, it does not fire
# ===========================================================================

def test_the_first_tick_establishes_a_baseline_without_firing():
    """A baseline seeded with a default would make the FIRST observation look
    like a change of exactly the default's distance from reality."""
    ev = _ev()
    assert ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0) == []
    assert ev.baseline("BTC/USDT").price == 60_000.0


def test_a_zero_price_tick_is_ignored():
    """A zero tick is missing data. Treating it as a price would fire a 100%
    price-move trigger on every open symbol at once."""
    ev = _ev()
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    assert ev.evaluate_tick("BTC/USDT", 0.0, now=1.0) == []
    # The baseline is untouched, so the next real tick compares correctly.
    assert ev.baseline("BTC/USDT").price == 60_000.0


# ===========================================================================
# Price movement
# ===========================================================================

def test_a_move_beyond_the_threshold_fires():
    ev = _ev(price_move_pct=2.0)
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    fired = _acted(ev.evaluate_tick("BTC/USDT", 61_400.0, now=1.0))  # +2.33%
    assert len(fired) == 1
    assert fired[0].reason.kind == "price_move"
    assert fired[0].reason.observed_value == pytest.approx(2.333, abs=0.01)
    assert fired[0].reason.threshold == 2.0


def test_a_move_below_the_threshold_does_not_fire():
    ev = _ev(price_move_pct=2.0)
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    assert ev.evaluate_tick("BTC/USDT", 60_600.0, now=1.0) == []  # +1%


def test_a_downward_move_fires_too():
    """Direction is irrelevant to whether the situation changed."""
    ev = _ev(price_move_pct=2.0)
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    fired = _acted(ev.evaluate_tick("BTC/USDT", 58_000.0, now=1.0))
    assert len(fired) == 1


def test_the_baseline_advances_only_on_a_fire():
    """THE trigger-storm fix. Without this, a sustained trend re-fires on every
    tick because it remains >threshold from where it started."""
    ev = _ev(price_move_pct=2.0, cooldown_seconds={"price_move": 0.0})
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)

    # Fires, baseline moves to 61_400.
    assert len(_acted(ev.evaluate_tick("BTC/USDT", 61_400.0, now=1.0))) == 1
    assert ev.baseline("BTC/USDT").price == 61_400.0

    # A further small rise is now measured from the NEW baseline, so it is quiet
    # even though it is still >2% above the original price.
    assert ev.evaluate_tick("BTC/USDT", 61_600.0, now=2.0) == []


def test_the_baseline_does_not_advance_when_suppressed():
    """If a suppressed trigger advanced the baseline, the move would be forgotten
    and would never fire once the cooldown expired."""
    ev = _ev(price_move_pct=2.0, cooldown_seconds={"price_move": 300.0})
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    _acted(ev.evaluate_tick("BTC/USDT", 61_400.0, now=1.0))          # fires
    before = ev.baseline("BTC/USDT").price
    _suppressed(ev.evaluate_tick("BTC/USDT", 63_000.0, now=2.0))     # debounced
    assert ev.baseline("BTC/USDT").price == before


# ===========================================================================
# Debounce
# ===========================================================================

def test_the_same_condition_is_debounced_within_its_cooldown():
    ev = _ev(price_move_pct=2.0, cooldown_seconds={"price_move": 180.0})
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    assert len(_acted(ev.evaluate_tick("BTC/USDT", 61_400.0, now=1.0))) == 1

    sup = _suppressed(ev.evaluate_tick("BTC/USDT", 63_000.0, now=60.0))
    assert len(sup) == 1
    assert "debounced" in sup[0].suppressed_reason
    # The reason states how long remains, so it is actionable rather than opaque.
    assert "remaining" in sup[0].suppressed_reason


def test_the_same_condition_fires_again_after_the_cooldown():
    ev = _ev(price_move_pct=2.0, cooldown_seconds={"price_move": 100.0})
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    _acted(ev.evaluate_tick("BTC/USDT", 61_400.0, now=1.0))
    assert len(_acted(ev.evaluate_tick("BTC/USDT", 63_000.0, now=200.0))) == 1


def test_debounce_is_per_symbol_not_global():
    """One symbol's cooldown must not silence another's — that would make a
    quiet market able to mask a violent one."""
    ev = _ev(price_move_pct=2.0, cooldown_seconds={"price_move": 300.0})
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    ev.evaluate_tick("ETH/USDT", 3_000.0, now=0.0)

    assert len(_acted(ev.evaluate_tick("BTC/USDT", 61_400.0, now=1.0))) == 1
    assert len(_acted(ev.evaluate_tick("ETH/USDT", 3_100.0, now=2.0))) == 1


def test_debounce_is_per_kind_not_per_symbol_only():
    """A price move must not silence a regime change on the same symbol — they
    are different facts warranting different reasoning."""
    ev = _ev(price_move_pct=2.0, cooldown_seconds={"price_move": 300.0,
                                                  "volatility_regime_change": 300.0})
    ev.evaluate_tick("BTC/USDT", 60_000.0, now=0.0, regime="Ranging / Low Volatility")
    fired = _acted(ev.evaluate_tick("BTC/USDT", 61_400.0, now=1.0, regime="High Volatility"))
    kinds = {d.reason.kind for d in fired}
    assert kinds == {"price_move", "volatility_regime_change"}


def test_an_unknown_trigger_kind_gets_the_longest_cooldown_not_zero():
    """A new trigger type added without a cooldown should be conservative by
    default, not unthrottled."""
    cfg = TriggerConfig()
    assert cfg.cooldown_for("some_new_kind") == max(cfg.cooldown_seconds.values())


# ===========================================================================
# Rate ceilings — the backstop that holds even if thresholds are misconfigured
# ===========================================================================

def test_the_global_rate_ceiling_caps_runs_per_minute():
    ev = _ev(
        price_move_pct=0.01,
        cooldown_seconds={"price_move": 0.0},
        max_runs_per_minute=3,
        max_runs_per_symbol_per_minute=99,
    )
    symbols = [f"S{i}/USDT" for i in range(10)]
    for s in symbols:
        ev.evaluate_tick(s, 100.0, now=0.0)

    admitted = 0
    reasons = []
    for i, s in enumerate(symbols):
        for d in ev.evaluate_tick(s, 110.0, now=1.0 + i * 0.01):
            if d.acted:
                admitted += 1
            else:
                reasons.append(d.suppressed_reason)

    assert admitted == 3
    assert any("rate limited" in r for r in reasons)


def test_the_per_symbol_ceiling_stops_one_symbol_starving_the_others():
    """One violent symbol must not consume the whole global budget."""
    ev = _ev(
        price_move_pct=0.01,
        cooldown_seconds={"price_move": 0.0},
        max_runs_per_minute=99,
        max_runs_per_symbol_per_minute=2,
    )
    ev.evaluate_tick("BTC/USDT", 100.0, now=0.0)

    admitted = 0
    for i in range(6):
        for d in ev.evaluate_tick("BTC/USDT", 100.0 * (1.1 ** (i + 1)), now=1.0 + i):
            if d.acted:
                admitted += 1

    assert admitted == 2


def test_the_rate_window_rolls_forward():
    """The ceiling is per rolling minute, not a lifetime cap."""
    ev = _ev(
        price_move_pct=0.01,
        cooldown_seconds={"price_move": 0.0},
        max_runs_per_minute=1,
        max_runs_per_symbol_per_minute=1,
    )
    ev.evaluate_tick("BTC/USDT", 100.0, now=0.0)
    assert len(_acted(ev.evaluate_tick("BTC/USDT", 110.0, now=1.0))) == 1
    assert len(_acted(ev.evaluate_tick("BTC/USDT", 120.0, now=2.0))) == 0
    # 61s later the window has rolled.
    assert len(_acted(ev.evaluate_tick("BTC/USDT", 130.0, now=63.0))) == 1


def test_cooldown_is_reported_before_rate_limiting():
    """Order matters: a repeated condition should read as debounced, not rate
    limited — the latter suggests the system is busy when it is ignoring a
    duplicate."""
    ev = _ev(price_move_pct=0.01, cooldown_seconds={"price_move": 300.0}, max_runs_per_minute=1)
    ev.evaluate_tick("BTC/USDT", 100.0, now=0.0)
    _acted(ev.evaluate_tick("BTC/USDT", 110.0, now=1.0))
    sup = _suppressed(ev.evaluate_tick("BTC/USDT", 120.0, now=2.0))
    assert "debounced" in sup[0].suppressed_reason


# ===========================================================================
# A manual request is never throttled
# ===========================================================================

def test_an_operator_request_is_never_debounced_or_rate_limited():
    """Throttling a human's explicit request would make the system feel broken at
    exactly the moment someone is trying to understand it."""
    ev = _ev(max_runs_per_minute=0, max_runs_per_symbol_per_minute=0)
    for _ in range(5):
        assert ev.manual("BTC/USDT").acted is True


# ===========================================================================
# Macro triggers — funding and OI
# ===========================================================================

def test_funding_change_fires_beyond_the_threshold():
    ev = _ev(funding_change_abs=0.0005)
    ev.evaluate_macro({"funding_rate": 0.0001, "oi": None})
    fired = _acted(ev.evaluate_macro({"funding_rate": 0.0010, "oi": None}))
    assert len(fired) == 1
    assert fired[0].reason.kind == "funding_change"
    # Attributed to BTC, because the endpoint queries BTCUSDT specifically.
    assert fired[0].reason.symbol == BTC_SYMBOL


def test_an_unmeasured_funding_rate_fires_nothing():
    """`fetch_macro_data` returns None for unavailable fields (it was fixed to
    stop returning plausible neutral defaults). None means not measured, so
    nothing fires — unlike a measured zero, which would."""
    ev = _ev()
    ev.evaluate_macro({"funding_rate": 0.0001, "oi": 1000.0})
    assert ev.evaluate_macro({"funding_rate": None, "oi": None}) == []


def test_oi_spike_fires_on_the_ratio():
    ev = _ev(oi_spike_ratio=1.5)
    ev.evaluate_macro({"funding_rate": None, "oi": 1_000.0})
    assert _acted(ev.evaluate_macro({"funding_rate": None, "oi": 1_400.0})) == []
    fired = _acted(ev.evaluate_macro({"funding_rate": None, "oi": 1_600.0}))
    assert len(fired) == 1
    assert fired[0].reason.kind == "oi_spike"


def test_btc_only_triggers_are_declared_as_such():
    """Firing an ETH run off BTC funding would attribute a condition to the wrong
    instrument, so the limitation is named rather than hidden."""
    assert set(BTC_ONLY_TRIGGERS) == {"funding_change", "oi_spike"}


# ===========================================================================
# Position risk
# ===========================================================================

def test_a_position_pnl_swing_fires():
    ev = _ev(position_risk_change_pct=3.0)
    ev.evaluate_position("BTC/USDT", 0.0)
    assert ev.evaluate_position("BTC/USDT", -2.0) == []
    fired = _acted(ev.evaluate_position("BTC/USDT", -4.0))
    assert len(fired) == 1
    assert fired[0].reason.kind == "position_risk_change"


def test_an_unknown_pnl_fires_nothing():
    ev = _ev()
    ev.evaluate_position("BTC/USDT", 0.0)
    assert ev.evaluate_position("BTC/USDT", None) == []


# ===========================================================================
# Exchange health
# ===========================================================================

def test_exchange_recovery_fires_as_well_as_failure():
    """Coming back online is exactly when the system should re-examine what
    happened while it was blind."""
    ev = _ev(cooldown_seconds={"exchange_event": 0.0})
    ev.evaluate_exchange(True, "ok", now=0.0)                              # baseline
    down = _acted(ev.evaluate_exchange(False, "timeout", now=1.0))
    up = _acted(ev.evaluate_exchange(True, "ok", now=2.0))
    assert len(down) == 1 and "unreachable" in down[0].reason.detail
    assert len(up) == 1 and "recovered" in up[0].reason.detail


def test_unchanged_exchange_state_fires_nothing():
    ev = _ev()
    ev.evaluate_exchange(True, "ok", now=0.0)
    assert ev.evaluate_exchange(True, "ok", now=1.0) == []


# ===========================================================================
# Honest gaps
# ===========================================================================

def test_feed_blocked_triggers_are_named_with_a_concrete_blocker():
    """A feed-blocked trigger that simply never fires is indistinguishable from a
    working one in a quiet market."""
    assert set(UNAVAILABLE_TRIGGERS) == {"liquidation_spike", "news_event"}
    for kind, reason in UNAVAILABLE_TRIGGERS.items():
        assert len(reason) > 80, f"{kind} blocker is too vague to act on"


def test_the_evaluator_does_not_claim_to_implement_blocked_triggers():
    ev = _ev()
    implemented = set(ev.implemented_kinds())
    assert implemented.isdisjoint(UNAVAILABLE_TRIGGERS)


def test_all_eight_spec_triggers_are_accounted_for():
    """Section 14 names eight. Each must be implemented or explicitly blocked."""
    spec_triggers = {
        "price_move", "oi_spike", "funding_change", "liquidation_spike",
        "volatility_regime_change", "news_event", "position_risk_change",
        "exchange_event",
    }
    ev = _ev()
    covered = set(ev.implemented_kinds()) | set(UNAVAILABLE_TRIGGERS)
    missing = spec_triggers - covered
    assert not missing, f"Section 14 triggers neither implemented nor declared blocked: {missing}"


# ===========================================================================
# Introspection
# ===========================================================================

def test_stats_report_the_suppression_rate():
    """Consistently high suppression means thresholds are too sensitive and real
    triggers are hiding behind the ceilings."""
    ev = _ev(price_move_pct=0.01, cooldown_seconds={"price_move": 300.0})
    ev.evaluate_tick("BTC/USDT", 100.0, now=0.0)
    for i in range(4):
        ev.evaluate_tick("BTC/USDT", 100.0 * (1.1 ** (i + 1)), now=1.0 + i)

    s = ev.stats()
    assert s["detected"] == 4
    assert s["admitted"] == 1
    assert s["suppressed"] == 3
    assert s["suppressionRate"] == 0.75


def test_the_singleton_shares_baselines_across_callers():
    """Each caller establishing its own baseline would mean nothing is ever
    detected as a change."""
    a = get_trigger_evaluator()
    b = get_trigger_evaluator()
    assert a is b
    a.evaluate_tick("BTC/USDT", 60_000.0, now=0.0)
    assert b.baseline("BTC/USDT").price == 60_000.0


# ===========================================================================
# The published event
# ===========================================================================

def test_the_trigger_event_requires_an_explicit_acted_flag():
    """Defaulting acted=True would hide every suppression, and an operator asking
    "why didn't it react?" needs to tell a missed detection from a deliberate
    debounce."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        TriggerFiredEvent(symbol="BTC/USDT", kind="price_move", detail="x")


def test_a_suppressed_event_carries_its_reason():
    e = TriggerFiredEvent(
        symbol="BTC/USDT", kind="price_move", detail="x",
        acted=False, suppressed_reason="debounced: 30s remaining",
    )
    assert e.acted is False
    assert "debounced" in e.suppressed_reason


# ===========================================================================
# The worker
# ===========================================================================

@pytest.mark.asyncio
async def test_the_worker_publishes_both_fires_and_suppressions(monkeypatch):
    """Suppressions go on the bus too — silence cannot distinguish a missed
    detection from a deliberate one."""
    from backend.core.message_bus import MessageBus, get_message_bus
    from backend.workers.trigger_worker import TriggerWorker

    monkeypatch.setattr("backend.core.message_bus._bus", MessageBus())
    reset_trigger_evaluator()

    published = []
    get_message_bus().subscribe("TRIGGER_FIRED", lambda e: published.append(e))

    worker = TriggerWorker()
    ev = get_trigger_evaluator()
    ev.config.price_move_pct = 1.0
    ev.config.cooldown_seconds["price_move"] = 300.0

    ev.evaluate_tick("BTC/USDT", 100.0, now=0.0)
    await worker._publish(ev.evaluate_tick("BTC/USDT", 105.0, now=1.0))   # fires
    await worker._publish(ev.evaluate_tick("BTC/USDT", 120.0, now=2.0))   # debounced

    assert len(published) == 2
    assert published[0].acted is True
    assert published[1].acted is False
    assert published[1].suppressed_reason


@pytest.mark.asyncio
async def test_the_worker_starts_no_graph_runs():
    """It publishes TRIGGER_FIRED and nothing else, so the trigger layer is
    complete and testable before any graph exists."""
    import ast
    import pathlib

    src = (pathlib.Path(__file__).resolve().parents[1]
           / "backend" / "workers" / "trigger_worker.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
    for forbidden in ("build_graph", "GraphConfig", "start_run"):
        assert forbidden not in imported, (
            f"trigger_worker imports {forbidden} — it must publish triggers, not run graphs"
        )


def test_the_worker_subscription_is_idempotent():
    """Subscribing twice would evaluate every tick twice, and the second pass
    would see the baseline the first just reset — so half the triggers would
    silently vanish rather than duplicate."""
    from backend.core.message_bus import MessageBus
    from backend.workers.trigger_worker import TriggerWorker
    import backend.core.message_bus as mb

    fresh = MessageBus()
    original = mb._bus
    mb._bus = fresh
    try:
        w = TriggerWorker()
        w.subscribe()
        w.subscribe()
        assert len(fresh._subscribers.get("TICK_RECEIVED", [])) == 1
    finally:
        mb._bus = original
