"""Phase 36 — the trigger kind and the poller that writes snapshots.

The poller is the ONLY component that fetches from Polymarket, which makes it the
only place two classes of bug can live:

  * a fetched number reaching the panel without going through the honest-`None`
    machinery (so a failed read looks like a measurement);
  * a stale snapshot being refreshed with a carried-forward value (so `computedAt`
    says "fresh" about data that is not).

Everything here runs against a fake client. `conftest.py`'s autouse network guard
would fail the test otherwise, which is deliberate — no live Polymarket call is
verifiable in this environment.
"""

from __future__ import annotations

import time

import pytest

from backend.algorithms import prediction_market as pm
from backend.graphs.triggers import (
    TriggerConfig,
    TriggerEvaluator,
    reset_trigger_evaluator,
)
from backend.services import polymarket_registry as registry
from backend.services import polymarket_store as store
from backend.workers import polymarket_worker as pw


# ===========================================================================
# Fixtures
# ===========================================================================

@pytest.fixture
def flag_on(monkeypatch):
    monkeypatch.setenv("POLYMARKET_ENABLED", "true")
    return True


@pytest.fixture
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SERIES_FILE", str(tmp_path / "series.json"))
    monkeypatch.setattr(store, "MARKETS_FILE", str(tmp_path / "markets.json"))
    monkeypatch.setattr(store, "SNAPSHOT_FILE", str(tmp_path / "snapshots.json"))
    return tmp_path


@pytest.fixture
def worker():
    pw.reset_polymarket_worker()
    yield pw.PolymarketWorker(poll_interval=1.0)
    pw.reset_polymarket_worker()


@pytest.fixture
def evaluator():
    reset_trigger_evaluator()
    yield TriggerEvaluator()
    reset_trigger_evaluator()


def _range_event(*specs, mutually_exclusive=True, end_days=30.0, volume=100_000.0):
    """A ccxt PredictionEvent for a BTC price-range market, real nested shape."""
    end_ms = int((time.time() + end_days * 86400) * 1000)
    return {
        "event": "BTC_RANGE_SEP",
        "title": "Bitcoin price range",
        "tags": ["crypto"],
        "mutuallyExclusive": mutually_exclusive,
        "end": end_ms,
        "markets": [
            {
                "market": f"BTC_{int(floor)}_{int(cap)}",
                "marketType": "scalar",
                "underlying": "BTC",
                "floorStrike": floor,
                "capStrike": cap,
                "volume": volume,
                "end": end_ms,
                "active": True,
                "closed": False,
                "resolved": False,
                "outcomes": [
                    {"outcome": f"BTC_{int(floor)}_{int(cap)}:YES", "label": "Yes",
                     "price": p, "bid": max(0.0, p - 0.005), "ask": min(1.0, p + 0.005)},
                    {"outcome": f"BTC_{int(floor)}_{int(cap)}:NO", "label": "No",
                     "price": 1 - p},
                ],
            }
            for p, floor, cap in specs
        ],
    }


def _fed_event(probability=0.5, end_days=2.0):
    end_ms = int((time.time() + end_days * 86400) * 1000)
    return {
        "event": "FED_SEP",
        "title": "Will the Fed cut rates in September?",
        "tags": ["macro"],
        "mutuallyExclusive": False,
        "end": end_ms,
        "markets": [{
            "market": "FED_CUT_SEP",
            "marketType": "binary",
            "title": "Will the Fed cut rates in September?",
            "end": end_ms,
            "active": True,
            "outcomes": [
                {"outcome": "FED_CUT_SEP:YES", "label": "Yes", "price": probability},
                {"outcome": "FED_CUT_SEP:NO", "label": "No", "price": 1 - probability},
            ],
        }],
    }


class FakeClient:
    def __init__(self, events, available=True):
        self._events = events
        self._available = available
        self.calls = 0

    def is_available(self):
        return self._available

    def unavailable_reason(self):
        return None if self._available else "ccxt too old"

    async def fetch_events(self, query=None, tags=None, limit=20, status="active",
                           sort="volume"):
        self.calls += 1
        return list(self._events)


async def _confirm(symbol, outcome, market, role, **kw):
    await store.save_mapping(symbol, outcome, market=market, role=role,
                             classification_reason="test", **kw)
    await store.confirm_mapping(symbol, outcome, True, set_by_human=True)


async def _seed_history(outcome, base=0.50, points=30):
    """Enough history for a z-score, INSIDE the signal window, with VARIED steps.

    Both properties are load-bearing and each was got wrong first:

      * a perfectly linear ramp has zero step variance, so `probability_volatility`
        returns 0.0 and `probability_zscore` correctly refuses to divide by it —
        the code was right and the fixture was degenerate;
      * points must fall inside SIGNAL_WINDOW_SECONDS, or `delta_probability` finds
        nothing in the window and returns None however many points exist.
    """
    now = time.time()
    for i in range(points):
        drift = 0.001 * i
        noise = 0.0003 if i % 2 else -0.0003
        await store.record_probability(
            outcome, base + drift + noise,
            ts=now - (points - i) * 60.0,
        )


# ===========================================================================
# The trigger kind
# ===========================================================================

def test_the_kind_is_distinct_from_news_event():
    """Reusing `news_event` would make `UNAVAILABLE_TRIGGERS["news_event"]`'s stated
    blocker a lie while leaving the actual news gap invisible. Two different missing
    feeds must stay two facts."""
    import typing

    from backend.graphs.state import TriggerKind
    from backend.graphs.triggers import UNAVAILABLE_TRIGGERS

    kinds = typing.get_args(TriggerKind)
    assert "prediction_market_shift" in kinds
    assert "news_event" in kinds
    # The news blocker must still be declared — this feature did not fix news.
    assert "news_event" in UNAVAILABLE_TRIGGERS
    assert "prediction_market_shift" not in UNAVAILABLE_TRIGGERS


def test_the_kind_is_only_advertised_when_the_feature_is_on(monkeypatch, evaluator):
    monkeypatch.setenv("POLYMARKET_ENABLED", "false")  # explicit "false", not delenv:
    # `.env` now sets this flag, and `services/exchange_client` calls `load_dotenv()` at
    # import time. `load_dotenv` does not override an existing var but DOES set an
    # absent one — so a lazy import after `delenv` silently restored the value from
    # `.env` and the flag-off tests saw 9 specialists. An explicit "false" survives it.
    assert "prediction_market_shift" not in evaluator.implemented_kinds()

    monkeypatch.setenv("POLYMARKET_ENABLED", "true")
    assert "prediction_market_shift" in evaluator.implemented_kinds()


def test_the_cooldown_is_long_because_repricing_is_discrete(evaluator):
    """Prediction markets reprice on discrete news, so a short cooldown buys noise:
    the same repricing observed twice is the same information."""
    assert evaluator.config.cooldown_for("prediction_market_shift") == 900.0
    assert evaluator.config.cooldown_for("prediction_market_shift") > \
        evaluator.config.cooldown_for("price_move")


def test_the_first_observation_establishes_a_baseline_and_never_fires(evaluator):
    """A baseline seeded from nothing would make the first reading look like a change
    of its whole distance from zero — same rule as `evaluate_macro`'s funding."""
    assert evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.40, 5.0) == []
    assert evaluator.baseline("BTC/USDT").prediction_probabilities["X:YES"] == 0.40


def test_an_unmeasured_probability_produces_nothing(evaluator):
    """None is not a measured 0.0, and a measured 0.0 WOULD be an extreme reading."""
    assert evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", None, 5.0) == []
    assert "X:YES" not in evaluator.baseline("BTC/USDT").prediction_probabilities


def test_a_small_move_produces_nothing(evaluator):
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.40, 5.0)
    assert evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.42, 5.0) == []


def test_a_large_move_with_no_volatility_baseline_is_suppressed(evaluator):
    """`zscore is None` means the market has too little history to say what normal
    looks like. Firing on the absolute band alone would mean the first hours of every
    newly-discovered market produce triggers."""
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.40, 5.0)
    decisions = evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.50, None)

    assert len(decisions) == 1
    assert decisions[0].acted is False
    assert "no volatility baseline" in decisions[0].suppressed_reason
    # The baseline must NOT advance on a suppression — otherwise the move would be
    # forgotten and could never fire once history existed.
    assert evaluator.baseline("BTC/USDT").prediction_probabilities["X:YES"] == 0.40


def test_a_large_but_ordinary_move_is_suppressed(evaluator):
    """Large in absolute terms, unremarkable for this market. A fixed percentage
    threshold cannot tell the two apart."""
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.40, 5.0)
    decisions = evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.50, 0.8)

    assert decisions[0].acted is False
    assert "ordinary for this market" in decisions[0].suppressed_reason


def test_a_large_and_unusual_move_fires(evaluator):
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.40, 5.0)
    decisions = evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.50, 3.0)

    assert len(decisions) == 1
    assert decisions[0].acted is True
    assert decisions[0].reason.kind == "prediction_market_shift"
    assert decisions[0].reason.symbol == "BTC/USDT"
    assert "+0.100" in decisions[0].reason.detail
    assert decisions[0].reason.observed_value == pytest.approx(0.10)


def test_the_baseline_resets_on_fire_so_a_drift_does_not_re_fire(evaluator):
    """A sustained drift would otherwise re-fire every cooldown while still measuring
    against its original starting point — the module docstring's control 2."""
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.40, 5.0)
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.50, 3.0)
    assert evaluator.baseline("BTC/USDT").prediction_probabilities["X:YES"] == 0.50


def test_a_repeat_is_debounced_by_the_shared_gate(evaluator):
    """It goes through `_admit()` like every other automatic trigger, so
    polymarket.md §13's ">3 events per minute on the same market" rule is already
    handled — implementing it again would create two answers to "why not fire"."""
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.40, 5.0)
    evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.50, 3.0)
    decisions = evaluator.evaluate_prediction_market("BTC/USDT", "X:YES", 0.70, 3.0)

    assert decisions[0].acted is False
    assert "debounced" in decisions[0].suppressed_reason


def test_baselines_are_per_outcome_not_per_symbol(evaluator):
    """Each price bucket of a range event is one outcome. Collapsing them to a single
    scalar would mean a move in one bucket reset the reference for all of them, so the
    next genuine move elsewhere would measure against the wrong baseline."""
    evaluator.evaluate_prediction_market("BTC/USDT", "A:YES", 0.40, 5.0)
    evaluator.evaluate_prediction_market("BTC/USDT", "B:YES", 0.20, 5.0)

    probs = evaluator.baseline("BTC/USDT").prediction_probabilities
    assert probs == {"A:YES": 0.40, "B:YES": 0.20}


def test_both_thresholds_are_required_and_documented(evaluator):
    cfg = TriggerConfig()
    assert cfg.prediction_shift_abs == 0.05
    assert cfg.prediction_shift_zscore == 2.5
    # Above polymarket.md's "balanced" 3% band, because this is a supplementary
    # source and should not provoke reasoning runs at price-move sensitivity.
    assert cfg.prediction_shift_abs > 0.03


# ===========================================================================
# The worker
# ===========================================================================

async def test_the_worker_is_a_no_op_when_disabled(monkeypatch, worker, tmp_store):
    monkeypatch.setenv("POLYMARKET_ENABLED", "false")
    client = FakeClient([_range_event((0.5, 100_000.0, 110_000.0))])

    assert await worker.run_cycle(client=client) == []
    assert client.calls == 0


async def test_the_worker_reports_an_unavailable_adapter_without_crashing(
    flag_on, worker, tmp_store,
):
    assert await worker.run_cycle(client=FakeClient([], available=False)) == []


async def test_no_confirmed_mapping_writes_an_explicit_not_applicable_snapshot(
    flag_on, worker, tmp_store,
):
    """An explicit snapshot rather than none. Both make the specialist report
    `not_applicable`, but this records WHEN the check was last made — the difference
    between "we looked and there is nothing" and "nothing has ever run"."""
    client = FakeClient([_range_event((0.5, 100_000.0, 110_000.0))])
    snapshot = await worker.poll_symbol("BTC/USDT", client)

    assert snapshot is not None
    assert snapshot["applicable"] is False
    assert "CONFIRMED" in snapshot["reasonNotApplicable"]
    # No API call needed to establish that: the mapping check comes first.
    assert client.calls == 0


async def test_an_unconfirmed_mapping_is_not_enough(flag_on, worker, tmp_store):
    """Discovery writes UNCONFIRMED. Only an operator promotes it, and the worker must
    honour that rather than treating discovery's guess as an attestation."""
    await store.save_mapping("BTC/USDT", "BTC_100000_110000:YES",
                             market="BTC_100000_110000",
                             role=registry.ROLE_DIRECTIONAL,
                             classification_reason="test")
    snapshot = await worker.poll_symbol(
        "BTC/USDT", FakeClient([_range_event((0.5, 100_000.0, 110_000.0))])
    )
    assert snapshot["applicable"] is False


async def test_a_confirmed_partition_produces_a_directional_signal(
    flag_on, worker, tmp_store, monkeypatch,
):
    monkeypatch.setattr(
        "backend.services.market_data.get_price", lambda symbol: 110_000.0
    )
    await _confirm("BTC/USDT", "BTC_100000_110000:YES", "BTC_100000_110000",
                   registry.ROLE_DIRECTIONAL,
                   floor_strike=100_000.0, cap_strike=110_000.0,
                   directional_basis=registry.BASIS_EXPECTED_PRICE)

    event = _range_event(
        (0.25, 100_000.0, 110_000.0),
        (0.50, 110_000.0, 120_000.0),
        (0.25, 120_000.0, 130_000.0),
    )
    client = FakeClient([event])

    # First cycle records probabilities but has no volatility baseline, so the
    # trustworthiness of the move is unmeasurable and the signal is withheld.
    first = await worker.poll_symbol("BTC/USDT", client)
    assert first["applicable"] is True
    assert first["directional"] is None

    # Seed history for the CONFIRMED outcome — `_driver_stats` judges the move by
    # that one, so seeding a different bucket leaves the driver with no baseline.
    await _seed_history("BTC_100000_110000:YES", base=0.25)
    second = await worker.poll_symbol("BTC/USDT", client)

    assert second["directional"] is not None
    signal = second["directional"]
    # E[price] = .25*105k + .50*115k + .25*125k = 115k, spot 110k -> LONG
    assert signal["expectedPrice"] == pytest.approx(115_000.0)
    assert signal["direction"] == "LONG"
    assert signal["driftPct"] > 0
    assert signal["bucketsUsed"] == 3
    assert 0.0 <= signal["confidence"] <= 1.0


async def test_no_spot_price_means_no_signal_not_a_zero_drift(
    flag_on, worker, tmp_store, monkeypatch,
):
    """A drift of 0.0 would read as "the market agrees with spot"."""
    monkeypatch.setattr("backend.services.market_data.get_price", lambda symbol: 0.0)
    await _confirm("BTC/USDT", "BTC_100000_110000:YES", "BTC_100000_110000",
                   registry.ROLE_DIRECTIONAL)

    snapshot = await worker.poll_symbol(
        "BTC/USDT", FakeClient([_range_event((0.5, 100_000.0, 110_000.0),
                                             (0.5, 110_000.0, 120_000.0))])
    )
    assert snapshot["applicable"] is True
    assert snapshot["directional"] is None


async def test_a_non_partition_event_yields_no_directional_signal(
    flag_on, worker, tmp_store, monkeypatch,
):
    monkeypatch.setattr(
        "backend.services.market_data.get_price", lambda symbol: 110_000.0
    )
    await _confirm("BTC/USDT", "BTC_100000_110000:YES", "BTC_100000_110000",
                   registry.ROLE_DIRECTIONAL)

    event = _range_event((0.5, 100_000.0, 110_000.0), (0.5, 110_000.0, 120_000.0),
                         mutually_exclusive=False)
    snapshot = await worker.poll_symbol("BTC/USDT", FakeClient([event]))
    assert snapshot["directional"] is None


async def test_the_worker_records_every_bucket_not_only_the_confirmed_one(
    flag_on, worker, tmp_store, monkeypatch,
):
    """The z-score baseline needs each bucket's own history, and `expected_price`
    reads the whole partition. Recording a subset would leave the other buckets
    without a volatility baseline and their triggers permanently suppressed."""
    monkeypatch.setattr(
        "backend.services.market_data.get_price", lambda symbol: 110_000.0
    )
    await _confirm("BTC/USDT", "BTC_100000_110000:YES", "BTC_100000_110000",
                   registry.ROLE_DIRECTIONAL)

    await worker.poll_symbol("BTC/USDT", FakeClient([_range_event(
        (0.4, 100_000.0, 110_000.0), (0.6, 110_000.0, 120_000.0),
    )]))

    tracked = await store.tracked_outcomes()
    assert "BTC_100000_110000:YES" in tracked
    assert "BTC_110000_120000:YES" in tracked
    # NO outcomes are recorded too — they are real observations of a real market.
    assert "BTC_100000_110000:NO" in tracked


async def test_event_risk_concern_comes_from_uncertainty_and_proximity(
    flag_on, worker, tmp_store,
):
    await _confirm("BTC/USDT", "FED_CUT_SEP:YES", "FED_CUT_SEP",
                   registry.ROLE_EVENT_RISK, event_risk_key="monetary_policy")

    # Maximally undecided, resolving in 2 days -> high concern.
    imminent = worker._event_risk_signal([_fed_event(0.5, end_days=2.0)],
                                         await store.get_mappings("BTC/USDT"))
    assert imminent is not None
    assert imminent["key"] == "monetary_policy"
    assert imminent["concern"] > 0.2

    # Same market, already decided -> near zero.
    decided = worker._event_risk_signal([_fed_event(0.99, end_days=2.0)],
                                        await store.get_mappings("BTC/USDT"))
    assert decided["concern"] < imminent["concern"]

    # Same uncertainty, far away -> nothing.
    distant = worker._event_risk_signal([_fed_event(0.5, end_days=60.0)],
                                        await store.get_mappings("BTC/USDT"))
    assert distant is None or distant["concern"] == 0.0


async def test_event_risk_takes_the_highest_not_the_sum(flag_on, worker, tmp_store):
    """`run_debate` combines constraints with `max()` because the binding constraint
    binds. Summing here would misreport three small doubts as one big one, and the two
    aggregations must agree."""
    await _confirm("BTC/USDT", "FED_CUT_SEP:YES", "FED_CUT_SEP",
                   registry.ROLE_EVENT_RISK, event_risk_key="monetary_policy")
    rows = await store.get_mappings("BTC/USDT")

    two = worker._event_risk_signal(
        [_fed_event(0.5, end_days=2.0), _fed_event(0.5, end_days=1.0)], rows,
    )
    one = worker._event_risk_signal([_fed_event(0.5, end_days=1.0)], rows)
    assert two["concern"] == pytest.approx(one["concern"])
    assert two["concern"] <= registry.MAX_EVENT_RISK_CONCERN


async def test_event_risk_is_none_without_a_confirmed_market(flag_on, worker, tmp_store):
    assert worker._event_risk_signal([_fed_event()], []) is None


async def test_a_failing_symbol_does_not_stop_the_others(
    flag_on, worker, tmp_store, monkeypatch,
):
    """And critically: a failure writes NO snapshot. Writing a failure record would
    refresh `computedAt` and make stale data look current."""
    calls = []

    async def boom(symbol, client):
        calls.append(symbol)
        if symbol == "BTC/USDT":
            raise RuntimeError("simulated")
        return {"symbol": symbol}

    monkeypatch.setattr(worker, "poll_symbol", boom)
    written = await worker.run_cycle(client=FakeClient([]))

    assert calls == list(pw.WATCH_SYMBOLS)
    assert [w["symbol"] for w in written] == ["ETH/USDT"]


async def test_a_symbol_with_no_keywords_is_reported_not_silently_skipped(
    flag_on, worker, tmp_store, monkeypatch,
):
    monkeypatch.setattr(pw, "WATCH_SYMBOLS", ("FARTCOIN/USDT",))
    assert await worker.run_cycle(client=FakeClient([])) == []


# ===========================================================================
# The bus seam — the one that passed 43 tests while being broken
# ===========================================================================

@pytest.fixture
def isolated_bus(monkeypatch):
    """A REAL `MessageBus` instance with NO other subscribers.

    The real CLASS matters; the global INSTANCE must not be used, and the second half
    of that was learned the hard way. Publishing `TRIGGER_FIRED` with `acted=True`
    onto the global bus reached `analysis.subscribe_to_triggers`'s handler —
    registered by an earlier test in the same session — which started a full analysis
    graph run, which retried market-data fetches against the blocked network with
    exponential backoff. The suite went from 110 seconds to a timeout, and this test
    passed in isolation.

    That is exactly the hazard `tests/conftest.py` documents, arriving through the bus
    instead of through a direct call. A fresh instance keeps the real two-argument
    `publish` under test — the whole point, since a one-argument call once passed 43
    tests because every double also took one argument — while isolating the subscriber
    set.

    Worth noting the production behaviour this exposes is CORRECT: a fired trigger is
    supposed to start a reasoning run. The 900s cooldown on
    `prediction_market_shift` is what bounds how often.
    """
    from backend.core import message_bus

    fresh = message_bus.MessageBus()
    monkeypatch.setattr(message_bus, "_bus", fresh)
    monkeypatch.setattr(message_bus, "get_message_bus", lambda: fresh)
    return fresh


async def test_the_worker_publishes_on_the_REAL_bus(
    flag_on, worker, tmp_store, isolated_bus,
):
    """`MessageBus.publish` takes (topic, payload). A one-argument call once passed 43
    tests because every test double ALSO took one argument, so the real call raised a
    TypeError that the publisher's own exception handling swallowed.

    So this uses a real `MessageBus`, not a double. That is the entire point of it.
    """
    from backend.graphs.state import TriggerReason
    from backend.graphs.triggers import TriggerDecision

    received = []

    async def handler(event):
        received.append(event)

    isolated_bus.subscribe("TRIGGER_FIRED", handler)

    await worker._publish([
        TriggerDecision(
            reason=TriggerReason(
                kind="prediction_market_shift", symbol="BTC/USDT",
                detail="X:YES repriced +0.100", observed_value=0.10, threshold=0.05,
            ),
            acted=True,
        )
    ])

    assert len(received) == 1
    assert received[0].kind == "prediction_market_shift"
    assert received[0].acted is True
    assert worker.triggers_published == 1


async def test_suppressions_are_published_too(
    flag_on, worker, tmp_store, isolated_bus,
):
    """An operator asking "why didn't the system react?" must be able to tell a missed
    detection from a deliberate debounce, and silence cannot distinguish them."""
    from backend.graphs.state import TriggerReason
    from backend.graphs.triggers import TriggerDecision

    received = []

    async def handler(event):
        received.append(event)

    isolated_bus.subscribe("TRIGGER_FIRED", handler)

    await worker._publish([
        TriggerDecision(
            reason=TriggerReason(kind="prediction_market_shift", symbol="BTC/USDT",
                                 detail="moved"),
            acted=False,
            suppressed_reason="debounced",
        )
    ])

    assert len(received) == 1
    assert received[0].acted is False
    assert received[0].suppressed_reason == "debounced"
    assert worker.suppressions_published == 1


# ===========================================================================
# End to end: worker -> snapshot -> specialist
# ===========================================================================

async def test_the_worker_output_is_readable_by_the_specialist(
    flag_on, worker, tmp_store, monkeypatch,
):
    """The seam Phase 35 and Phase 36 meet at. Every component was testable alone;
    the join is where the shape bug in `expected_price` lived."""
    from backend.graphs.nodes.specialists import specialist_prediction

    monkeypatch.setattr(
        "backend.services.market_data.get_price", lambda symbol: 110_000.0
    )
    await _confirm("BTC/USDT", "BTC_110000_120000:YES", "BTC_110000_120000",
                   registry.ROLE_DIRECTIONAL,
                   directional_basis=registry.BASIS_EXPECTED_PRICE)

    await _seed_history("BTC_110000_120000:YES", base=0.50)

    event = _range_event((0.25, 100_000.0, 110_000.0), (0.50, 110_000.0, 120_000.0),
                         (0.25, 120_000.0, 130_000.0))
    snapshot = await worker.poll_symbol("BTC/USDT", FakeClient([event]))
    assert snapshot["directional"] is not None

    finding = specialist_prediction({"symbol": "BTC/USDT"})["specialist_findings"][0]
    assert finding.available is True
    assert finding.role == "supplementary"
    assert finding.stance == "supports_long"
    assert finding.confidence is not None


async def test_a_symbol_the_worker_marked_not_applicable_costs_the_panel_nothing(
    flag_on, worker, tmp_store,
):
    """The operator's framing, end to end: an inapplicable source must not reduce
    confidence."""
    from backend.graphs.nodes.specialists import run_debate, specialist_prediction
    from backend.graphs.state import SpecialistFinding

    await worker.poll_symbol("SOL/USDT", FakeClient([]))

    finding = specialist_prediction({"symbol": "SOL/USDT"})["specialist_findings"][0]
    assert finding.not_applicable is True

    market = SpecialistFinding(specialist="market", role="directional", available=True,
                               stance="supports_long", confidence=1.0)
    baseline = run_debate({"symbol": "SOL/USDT",
                           "specialist_findings": [market]})["debate_verdict"]
    withit = run_debate({"symbol": "SOL/USDT",
                         "specialist_findings": [market, finding]})["debate_verdict"]

    assert withit.confidence == baseline.confidence
    assert withit.coverage == pytest.approx(3.0 / 7.0)


# ===========================================================================
# Read-only, still
# ===========================================================================

def test_the_worker_cannot_reach_an_order_call():
    """It is the one component holding the client, so it is the one place an order
    call could be reached from."""
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    tree = ast.parse(pathlib.Path("backend/workers/polymarket_worker.py")
                     .read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)
    assert not (imported & set(FORBIDDEN_IMPORTS)), sorted(imported & set(FORBIDDEN_IMPORTS))

    forbidden_attrs = {"create_order", "create_orders", "cancel_order",
                       "fetch_balance", "fetch_positions"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            assert node.attr not in forbidden_attrs, node.attr


def test_the_worker_is_started_only_when_the_feature_is_enabled():
    """Gated rather than started-and-idle: a feature that is off should be ABSENT from
    the running task list, not quietly present."""
    import inspect

    import backend.main as main

    src = inspect.getsource(main.lifespan)
    assert "POLYMARKET_ENABLED" in src
    assert "get_polymarket_worker" in src
    # And the session is released on shutdown regardless of the flag.
    assert "close_polymarket_client" in src
