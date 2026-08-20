"""Polymarket integration, Phases 32-34 — POLYMARKET_INTEGRATION_PLAN.md.

These tests are organised around the ways this feature could produce a confident
wrong number, rather than around the modules:

  * the read-only client could reach an order call (§1's non-goal);
  * `implied_drift`/`expected_price` could invent the one input it is most
     sensitive to (§5 risk 2);
  * a mapping could attribute a probability to the wrong symbol (§5 risk 4);
  * a resolved market's collapsed probability could read as a huge signal
    (§5 risk 7);
  * the store could grow without bound (Phase 33) or store a fabricated 0.0;
  * enabling the feature could silently change every confidence number (§2).

Nothing here needs a network. `conftest.py`'s autouse guard would fail the test if
it tried, which is deliberate: no live call is verifiable in this environment.
"""

from __future__ import annotations

import ast
import asyncio
import os
import pathlib
import time

import pytest

from backend.algorithms import prediction_market as pm
from backend.services import polymarket_registry as reg
from backend.services import polymarket_store as store
from backend.services.polymarket_client import (
    _READ_METHODS,
    PolymarketClient,
    get_polymarket_client,
)

POLYMARKET_MODULES = (
    "backend/services/polymarket_client.py",
    "backend/services/polymarket_store.py",
    "backend/services/polymarket_registry.py",
    "backend/algorithms/prediction_market.py",
    # Added as each phase landed. Every module that can touch the ccxt adapter — even
    # transitively — is checked, because `create_order` sits on the same class as the
    # read methods.
    "backend/workers/polymarket_worker.py",
    "backend/api/polymarket.py",
)


# ===========================================================================
# Read-only enforcement — §1's non-goal, three independent guards
# ===========================================================================

def test_no_polymarket_module_imports_an_order_call():
    """Guard 3. The ccxt Polymarket adapter carries `create_order`,
    `cancel_order`, `fetch_balance` and `fetch_positions` on the SAME class we
    import for reads, so read-only has to be enforced rather than intended.

    Trading on Polymarket would be a second execution venue, breaking CLAUDE.md
    invariant 1 and sitting entirely outside ABSOLUTE_MAX_LEVERAGE, the mandatory
    stop, and the Risk Gateway.
    """
    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    banned = set(FORBIDDEN_IMPORTS)
    for path in POLYMARKET_MODULES:
        tree = ast.parse(pathlib.Path(path).read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                imported.update(a.name for a in node.names)
            elif isinstance(node, ast.Import):
                imported.update(a.name.split(".")[-1] for a in node.names)
        assert not (imported & banned), f"{path} imports {sorted(imported & banned)}"


def test_no_polymarket_module_calls_an_order_method_by_name():
    """A stricter check than the import ban: the adapter's order methods are
    ATTRIBUTES of an object we legitimately hold, so no import is needed to reach
    one. This walks actual attribute accesses and call targets.

    Docstrings are deliberately not searched. Grepping source text for a forbidden
    literal has matched the comment documenting the fix three times in this
    project, so the check is AST-based.
    """
    forbidden = {
        "create_order", "create_orders", "create_market_order",
        "create_market_buy_order_with_cost", "cancel_order", "cancel_orders",
        "cancel_all_orders", "fetch_balance", "fetch_positions", "fetch_position",
        "fetch_my_trades", "fetch_open_orders", "edit_order",
    }
    for path in POLYMARKET_MODULES:
        tree = ast.parse(pathlib.Path(path).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in forbidden:
                pytest.fail(f"{path} accesses .{node.attr}")
            # `getattr(exchange, "create_order")` would evade the check above.
            if isinstance(node, ast.Constant) and isinstance(node.value, str):
                if node.value in forbidden:
                    pytest.fail(f"{path} names '{node.value}' as a string literal")


def test_the_read_allowlist_contains_nothing_order_shaped():
    """Guard 1's data. An allowlist rather than a denylist of order methods,
    because a denylist silently permits whatever a future ccxt release adds."""
    # `fetch_order_book` is a read despite containing "order", so it is named as the
    # one allowed exception rather than the substring check being loosened — a
    # looser check would also pass `fetch_open_orders`.
    assert "fetch_order_book" in _READ_METHODS
    for method in _READ_METHODS:
        assert method.startswith("fetch_"), method
        if method == "fetch_order_book":
            continue
        for word in ("order", "balance", "position", "cancel", "create", "edit"):
            assert word not in method, f"{method} contains {word!r}"


def test_the_client_exposes_no_accessor_for_the_raw_exchange():
    """Guard 1. Handing a caller the ccxt object would hand them `create_order`
    regardless of what this class does or does not wrap."""
    public = [n for n in dir(PolymarketClient) if not n.startswith("_")]
    assert "exchange" not in public
    for name in public:
        assert "exchange" not in name.lower(), name


async def test_the_client_passes_no_credentials():
    """Guard 2. Every private endpoint must fail closed even if guards 1 and 3
    were bypassed, so no key is ever handed to the constructor."""
    client = PolymarketClient()
    exchange = await client._get()
    if exchange is None:
        pytest.skip(PolymarketClient.unavailable_reason() or "no adapter")
    try:
        assert not exchange.apiKey
        assert not exchange.secret
        assert exchange.enableRateLimit is True
    finally:
        await client.close()


async def test_the_generic_call_path_refuses_a_non_read_method():
    """`_call` is generic, so without the allowlist check
    `_call("create_order", ...)` would work."""
    client = PolymarketClient()
    try:
        with pytest.raises(ValueError, match="read-only"):
            await client._call("create_order", "BTC", "buy", 1)
        with pytest.raises(ValueError, match="read-only"):
            await client._call("fetch_balance")
    finally:
        await client.close()


async def test_fetch_events_refuses_an_unscoped_search():
    """ccxt requires a scope. Refusing here names the real reason instead of
    surfacing an ArgumentsRequired from inside the library."""
    client = PolymarketClient()
    try:
        assert await client.fetch_events() == []
    finally:
        await client.close()


def test_the_singleton_is_shared():
    assert get_polymarket_client() is get_polymarket_client()


# ===========================================================================
# Store — Phase 33
# ===========================================================================

@pytest.fixture
def tmp_store(tmp_path, monkeypatch):
    """Redirect the store at a temp dir so tests never touch the real `.data/`."""
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SERIES_FILE", str(tmp_path / "series.json"))
    monkeypatch.setattr(store, "MARKETS_FILE", str(tmp_path / "markets.json"))
    return tmp_path


async def test_a_missing_probability_is_refused_not_stored_as_zero(tmp_store):
    """`None` means the fetch failed. Storing it as 0.0 would put "this event will
    definitely not happen" into the series ΔP is computed from — CLAUDE.md
    invariant 6, and the largest possible ΔP at that."""
    assert await store.record_probability("X:YES", None) is False
    assert await store.get_series("X:YES") == []


@pytest.mark.parametrize("bad", [-0.01, 1.01, 42.0, "1.5", object()])
async def test_an_out_of_range_probability_is_refused_not_clamped(tmp_store, bad):
    """Clamping would turn a units change in the upstream API into a confident
    0% or 100% — exactly the values that produce the largest ΔP."""
    assert await store.record_probability("X:YES", bad) is False
    assert await store.get_series("X:YES") == []


@pytest.mark.parametrize("value", [True, False])
async def test_a_bool_probability_is_refused(tmp_store, value):
    """`bool` is an `int` subclass, so `float(True)` is 1.0 and a naive range check
    admits it as a 100% probability — the most extreme value the series can hold,
    from something that is not a measurement.

    Found by this test: the store originally coerced it and only the reader in
    `algorithms.prediction_market._series_prices` skipped bools, so the value would
    have been persisted and then permanently invisible.
    """
    assert await store.record_probability("X:YES", value) is False
    assert await store.get_series("X:YES") == []


async def test_a_numeric_string_probability_is_accepted(tmp_store):
    """ccxt types these fields `Num = Union[None, str, float, int]` and genuinely
    returns strings for some venues, so refusing one would drop real observations."""
    assert await store.record_probability("X:YES", "0.42") is True
    assert (await store.get_series("X:YES"))[0]["p"] == 0.42


async def test_a_valid_probability_round_trips(tmp_store):
    assert await store.record_probability("X:YES", 0.42, volume=1000.0, market="M") is True
    series = await store.get_series("X:YES")
    assert len(series) == 1
    assert series[0]["p"] == 0.42
    assert series[0]["volume"] == 1000.0


async def test_zero_and_one_are_legitimate_and_stored(tmp_store):
    """0.0 and 1.0 are inside the probability range. They are refused for DRIFT
    purposes by `is_degenerate`, which is a different decision made elsewhere —
    the store must not silently drop real observations."""
    assert await store.record_probability("A:YES", 0.0) is True
    assert await store.record_probability("B:YES", 1.0) is True


def test_retention_drops_points_outside_the_window():
    """`state.py` grew `_append_bounded` because an unbounded accumulator reached
    ~8,000 entries a week. This file is rewritten in full on every write, so the
    same bug would be worse here.

    `_prune` is exercised directly rather than through thousands of
    `record_probability` calls. That is not test convenience — it is the store's
    real cost profile: every observation reads, appends to and rewrites the WHOLE
    file, so writing 2,000 points costs O(n^2) and a loop doing it hangs. In
    production the poller writes once per outcome per 5 minutes, which is fine; the
    caps therefore bound write cost as well as file size, and testing them by
    looping writes would take minutes to assert what one call asserts.
    """
    now = 1_000_000.0
    inside = [{"ts": now - i * 3600, "p": 0.5} for i in range(24)]
    outside = [{"ts": now - store.RETENTION_SECONDS - i, "p": 0.5} for i in range(1, 50)]

    kept = store._prune(outside + inside, now)
    assert len(kept) == len(inside)
    assert min(p["ts"] for p in kept) >= now - store.RETENTION_SECONDS


def test_the_point_count_is_capped_even_within_the_window():
    """The count cap is the backstop for a caller polling faster than the declared
    5-minute resolution — every point below is inside the retention window."""
    now = 1_000_000.0
    points = [{"ts": now - i, "p": 0.5} for i in range(store.MAX_POINTS_PER_OUTCOME + 250)]
    kept = store._prune(points, now)
    assert len(kept) == store.MAX_POINTS_PER_OUTCOME
    # The NEWEST are kept — dropping recent points would make ΔP unmeasurable while
    # leaving a full-looking series.
    assert kept[-1]["ts"] == points[-1]["ts"]


async def test_retention_is_applied_on_write(tmp_store):
    """The pure-function tests above prove `_prune`'s logic; this proves the write
    path actually calls it."""
    now = time.time()
    await store.record_probability("X:YES", 0.5, ts=now - store.RETENTION_SECONDS - 5000)
    await store.record_probability("X:YES", 0.6, ts=now)

    series = await store.get_series("X:YES")
    assert [p["p"] for p in series] == [0.6]


async def test_a_full_store_refuses_new_outcomes_rather_than_evicting(tmp_store):
    """Evicting would drop the history the volatility baseline needs, turning a
    visible capacity problem into a silently degraded signal."""
    monkey_cap = 3
    original = store.MAX_TRACKED_OUTCOMES
    store.MAX_TRACKED_OUTCOMES = monkey_cap
    try:
        for i in range(monkey_cap):
            assert await store.record_probability(f"O{i}:YES", 0.5) is True
        assert await store.record_probability("OVERFLOW:YES", 0.5) is False
        # The existing series survive.
        for i in range(monkey_cap):
            assert len(await store.get_series(f"O{i}:YES")) == 1
    finally:
        store.MAX_TRACKED_OUTCOMES = original


async def test_a_mapping_is_stored_unconfirmed(tmp_store):
    row = await store.save_mapping(
        "BTC/USDT", "BTC_ABOVE_130K:YES",
        market="M", role=reg.ROLE_DIRECTIONAL, classification_reason="test",
    )
    assert row["confirmed"] is False
    assert row["confirmedBy"] is None


async def test_automated_code_cannot_confirm_its_own_mapping(tmp_store):
    """Mirrors `research_store.update_hypothesis_status`'s `set_by_human` gate.
    There the risk is a module validating its own hypothesis; here it is discovery
    confirming its own guess, which would make the step decorative.

    A wrong confirmation means a probability about one asset reported as evidence
    about another, with a real stance and a real confidence, and nothing downstream
    can detect it.
    """
    await store.save_mapping(
        "BTC/USDT", "X:YES", market="M",
        role=reg.ROLE_DIRECTIONAL, classification_reason="test",
    )
    with pytest.raises(PermissionError, match="human operator"):
        await store.confirm_mapping("BTC/USDT", "X:YES", True)

    row = await store.confirm_mapping("BTC/USDT", "X:YES", True, set_by_human=True)
    assert row["confirmed"] is True

    # Un-confirming does not need the flag: withdrawing trust must never be harder
    # than granting it.
    row = await store.confirm_mapping("BTC/USDT", "X:YES", False)
    assert row["confirmed"] is False


async def test_a_refresh_preserves_a_human_confirmation(tmp_store):
    """Rediscovery must not silently revoke a confirmation every time the poller
    runs — metadata is re-read, the human's decision is not re-derived."""
    await store.save_mapping("BTC/USDT", "X:YES", market="M",
                             role=reg.ROLE_DIRECTIONAL, classification_reason="a")
    await store.confirm_mapping("BTC/USDT", "X:YES", True, set_by_human=True)

    await store.save_mapping("BTC/USDT", "X:YES", market="M",
                             role=reg.ROLE_DIRECTIONAL, classification_reason="b",
                             cap_strike=131000.0)
    rows = await store.get_mappings("BTC/USDT", confirmed_only=True)
    assert len(rows) == 1
    assert rows[0]["confirmed"] is True
    assert rows[0]["capStrike"] == 131000.0
    assert rows[0]["classificationReason"] == "b"


async def test_an_unreadable_series_file_degrades_to_empty(tmp_store):
    """Losing the history must make the specialist report unavailable — the honest
    outcome — not fail the trading run that triggered the read."""
    pathlib.Path(store.SERIES_FILE).write_text("{ not json", encoding="utf-8")
    assert await store.get_series("X:YES") == []
    assert await store.tracked_outcomes() == []


# ===========================================================================
# Registry — classification, §5 risks 4 and 7
# ===========================================================================

def _market(**over):
    base = {
        "market": "BTC_RANGE_SEP",
        "marketType": "scalar",
        "underlying": "BTC",
        "floorStrike": 120000.0,
        "capStrike": 130000.0,
        "title": "Bitcoin price range on September 30",
        "active": True,
        "closed": False,
        "resolved": False,
        "end": int((time.time() + 30 * 86400) * 1000),
    }
    base.update(over)
    return base


def _outcome(**over):
    base = {"outcome": "BTC_RANGE_SEP:120-130K", "price": 0.42, "active": True,
            "winner": None}
    base.update(over)
    return base


@pytest.mark.parametrize("symbol,expected", [
    ("BTC/USDT", "BTC"), ("ETH/USDT", "ETH"), ("BTC/USDT:USDT", "BTC"),
    ("btc/usdt", "BTC"), ("", None),
])
def test_base_asset_extraction(symbol, expected):
    assert reg.base_asset(symbol) == expected


def test_an_unknown_symbol_has_no_keywords():
    """None rather than a derived search term: a 'SOL'-style ticker search matches
    'solar' and 'solution', returning unrelated markets that then get classified."""
    assert reg.keywords_for("FARTCOIN/USDT") is None
    assert reg.keywords_for("BTC/USDT") is not None


def test_a_bounded_bucket_in_a_mutually_exclusive_event_is_directional():
    """The ONE classification that yields a usable signal today: a bounded bucket
    inside a partition, which `expected_price` can average over with no volatility
    assumption."""
    c = reg.classify_market(_market(), _outcome(), "BTC/USDT",
                            event_mutually_exclusive=True)
    assert c.role == reg.ROLE_DIRECTIONAL
    assert c.directional_basis == reg.BASIS_EXPECTED_PRICE
    assert c.floor_strike == 120000.0
    assert c.cap_strike == 130000.0


def test_a_bounded_bucket_with_no_partition_is_unusable():
    """Averaging over a non-partition yields an expectation conditioned on an event
    that may not occur, reported as if unconditional."""
    for flag in (None, False):
        c = reg.classify_market(_market(), _outcome(), "BTC/USDT",
                                event_mutually_exclusive=flag)
        assert c.role == reg.ROLE_UNUSABLE
        assert "partition" in c.reason


def test_a_single_strike_market_is_unusable_because_neither_path_can_run():
    """Phase 33 and Phase 34 disagreed without this branch: the registry called such
    a market directional while `expected_price` (unbounded) and `delta_stance`
    (unknown above/below) could both do nothing with it. A confirmed mapping that
    produced no signal would read as a bug in the specialist."""
    c = reg.classify_market(
        _market(marketType="binary", capStrike=None), _outcome(), "BTC/USDT",
        event_mutually_exclusive=True,
    )
    assert c.role == reg.ROLE_UNUSABLE
    assert c.directional_basis is None
    assert "unbounded" in c.reason
    assert "invert" in c.reason


def test_every_directional_classification_declares_a_computable_basis():
    """The invariant that keeps the two phases consistent: role directional implies
    some function in `algorithms.prediction_market` can consume it."""
    valid = {reg.BASIS_EXPECTED_PRICE}
    for flag in (True, False, None):
        for over in ({}, {"capStrike": None}, {"floorStrike": None},
                     {"marketType": "binary"}):
            c = reg.classify_market(_market(**over), _outcome(), "BTC/USDT",
                                    event_mutually_exclusive=flag)
            if c.role == reg.ROLE_DIRECTIONAL:
                assert c.directional_basis in valid, (over, flag, c.directional_basis)
            else:
                assert c.directional_basis is None


def test_a_resolved_market_is_unusable():
    """§5 risk 7. A resolved market prices at 0 or 1 by definition, so admitting
    one hands the specialist a maximal signal about an event that has settled."""
    c = reg.classify_market(_market(resolved=True), _outcome(price=0.99), "BTC/USDT")
    assert c.role == reg.ROLE_UNUSABLE
    assert "RESOLVED" in c.reason


def test_a_winning_outcome_is_unusable_even_if_the_market_is_not_flagged():
    c = reg.classify_market(_market(), _outcome(winner=True), "BTC/USDT")
    assert c.role == reg.ROLE_UNUSABLE


def test_a_losing_outcome_is_not_mistaken_for_unresolved():
    """`winner=False` means resolved-and-lost, priced ~0.0 — the most extreme
    directional reading available. A truthiness test would let it through; the
    market-level `resolved` flag is what catches it."""
    c = reg.classify_market(_market(resolved=True), _outcome(winner=False, price=0.002),
                            "BTC/USDT")
    assert c.role == reg.ROLE_UNUSABLE


@pytest.mark.parametrize("over", [
    {"closed": True}, {"active": False},
])
def test_a_closed_or_inactive_market_is_unusable(over):
    assert reg.classify_market(_market(**over), _outcome(), "BTC/USDT").role == reg.ROLE_UNUSABLE


def test_an_expired_market_is_unusable_even_without_a_resolved_flag():
    past = int((time.time() - 86400) * 1000)
    c = reg.classify_market(_market(end=past), _outcome(), "BTC/USDT")
    assert c.role == reg.ROLE_UNUSABLE
    assert "ended" in c.reason


def test_a_matching_underlying_with_no_strike_is_refused_not_guessed():
    """The branch that exists because the §8 probe has not run. If crypto markets
    come back with `underlying` set and no strikes, the honest answer is that
    direction cannot be established — NOT a threshold parsed out of the title.

    Misreading 'above' as 'below' inverts the signal, and an inverted probability
    is undetectable downstream: it looks exactly like a strong opposite view.
    """
    c = reg.classify_market(
        _market(marketType="binary", floorStrike=None, capStrike=None,
                title="Will Bitcoin close above $130,000 on September 30?"),
        _outcome(), "BTC/USDT",
    )
    assert c.role == reg.ROLE_UNUSABLE
    assert "no floorStrike or capStrike" in c.reason
    assert "invert" in c.reason


def test_a_market_about_another_asset_is_not_directional_for_this_one():
    """§5 risk 4. 'Will ETH flip BTC?' matches a Bitcoin keyword search, is
    genuinely about BTC's price, and is not a BTC-long signal."""
    c = reg.classify_market(
        _market(underlying="ETH", title="Will Ethereum flip Bitcoin by 2027?"),
        _outcome(), "BTC/USDT",
    )
    assert c.role != reg.ROLE_DIRECTIONAL


def test_a_macro_market_is_event_risk_and_never_directional():
    c = reg.classify_market(
        _market(marketType="binary", underlying=None, floorStrike=None, capStrike=None,
                title="Will the Fed cut rates in September?"),
        _outcome(), "BTC/USDT",
    )
    assert c.role == reg.ROLE_EVENT_RISK
    assert c.event_risk_key == "monetary_policy"
    assert c.max_concern is not None
    assert "says nothing about direction" in c.reason


def test_event_risk_concern_is_capped_below_a_veto():
    """§5 risk 5. Constraints combine with `max()`, so a fourth one can only ever
    RAISE the binding concern — a miscalibrated score would quietly suppress
    trading system-wide with nothing looking broken.

    The ceiling arithmetic, checked rather than trusted: best achievable coverage
    with the prediction specialist available is 5.0/8.0 = 0.625, and
    0.625 * (1 - MAX_EVENT_RISK_CONCERN) must stay above the 0.18 trade floor.
    """
    from backend.graphs.nodes.supervisor import MIN_CONFIDENCE_TO_TRADE

    assert reg.MAX_EVENT_RISK_CONCERN < 1.0
    for profile in reg.EVENT_RISK_PROFILES:
        assert 0.0 < profile.weight <= reg.MAX_EVENT_RISK_CONCERN, profile.key

    best_coverage = 5.0 / 8.0
    assert best_coverage * (1 - reg.MAX_EVENT_RISK_CONCERN) > MIN_CONFIDENCE_TO_TRADE


def test_an_unrelated_market_is_unusable():
    c = reg.classify_market(
        _market(marketType="binary", underlying=None, floorStrike=None,
                capStrike=None, title="Who will win the Super Bowl?"),
        _outcome(), "BTC/USDT",
    )
    assert c.role == reg.ROLE_UNUSABLE


def test_an_outcome_with_no_handle_is_unusable():
    c = reg.classify_market(_market(), {"price": 0.5}, "BTC/USDT")
    assert c.role == reg.ROLE_UNUSABLE
    assert "handle" in c.reason


def test_every_classification_states_a_reason():
    """`unusable` is the expected outcome for most markets, so an operator needs
    to tell "this is about the Super Bowl" from "this is about Bitcoin but has no
    strike" — only the second indicates something worth fixing."""
    cases = [
        (_market(), _outcome()),
        (_market(resolved=True), _outcome()),
        (_market(underlying=None, floorStrike=None, capStrike=None,
                 title="Fed rate decision"), _outcome()),
        (_market(underlying=None, floorStrike=None, capStrike=None,
                 title="Super Bowl"), _outcome()),
    ]
    for market, outcome in cases:
        c = reg.classify_market(market, outcome, "BTC/USDT",
                                event_mutually_exclusive=True)
        assert c.role in reg.ROLES
        assert c.reason and len(c.reason) > 20


async def test_discovery_reports_unavailable_for_an_unmapped_symbol():
    result = await reg.discover_for_symbol("FARTCOIN/USDT")
    assert result.available is False
    assert "SYMBOL_KEYWORDS" in (result.reason_unavailable or "")


async def test_discovery_reports_unavailable_when_the_adapter_is_missing():
    class _NoAdapter:
        @staticmethod
        def is_available():
            return False

        @staticmethod
        def unavailable_reason():
            return "ccxt too old"

    result = await reg.discover_for_symbol("BTC/USDT", client=_NoAdapter())
    assert result.available is False
    assert result.reason_unavailable == "ccxt too old"


async def test_discovery_persists_only_usable_mappings(tmp_store):
    """Storing every Super Bowl outcome would fill MAX_TRACKED_OUTCOMES with
    markets nothing reads."""

    class _FakeClient:
        @staticmethod
        def is_available():
            return True

        @staticmethod
        def unavailable_reason():
            return None

        async def fetch_events(self, query=None, tags=None, limit=20, status="active",
                               sort="volume"):
            # `outcomes` nested inside each market, matching ccxt's PredictionMarket.
            # An earlier version of this test omitted them and discovery returned
            # nothing at all — markets_seen=2, everything else empty — which is the
            # correct behaviour for a market with no outcomes and was a bug in the
            # fixture, not the code.
            return [{
                "title": "Bitcoin in September",
                "tags": ["crypto"],
                "mutuallyExclusive": True,
                "markets": [
                    _market(outcomes=[_outcome()]),
                    _market(market="SB", marketType="binary", underlying=None,
                            floorStrike=None, capStrike=None,
                            title="Who will win the Super Bowl?",
                            outcomes=[_outcome(outcome="SB:CHIEFS")]),
                ],
            }]

    result = await reg.discover_for_symbol("BTC/USDT", client=_FakeClient())
    assert result.available is True
    assert len(result.directional) == 1
    assert len(result.unusable) == 1

    rows = await store.get_mappings("BTC/USDT")
    assert len(rows) == 1
    assert rows[0]["role"] == reg.ROLE_DIRECTIONAL
    assert rows[0]["directionalBasis"] == reg.BASIS_EXPECTED_PRICE
    assert rows[0]["confirmed"] is False

    payload = result.as_dict()
    assert payload["unusableCount"] == 1
    assert "UNCONFIRMED" in payload["confirmationRequired"]


# ===========================================================================
# Signals — §5 risk 2, the fabrication surface
# ===========================================================================

def _points(values, start=0.0, step=300.0):
    return [{"ts": start + i * step, "p": v} for i, v in enumerate(values)]


def test_delta_is_none_not_zero_without_enough_history():
    """A caller reading 0.0 would conclude the market is quiet, which is a claim.
    None is the absence of one."""
    assert pm.delta_probability([], 3600) is None
    assert pm.delta_probability(_points([0.4]), 3600) is None
    assert pm.delta_probability(_points([0.4, 0.5]), 3600) is None


def test_delta_is_measured_across_the_window():
    pts = _points([0.40, 0.42, 0.45, 0.50])
    assert pm.delta_probability(pts, 3600, now=900.0) == pytest.approx(0.10)


def test_delta_only_considers_points_inside_the_window():
    pts = _points([0.10, 0.40, 0.42, 0.45, 0.50])
    # A 1200s window at now=1200 keeps the last four points (ts 0..1200 -> >=0),
    # so widen the exclusion by asking for a tighter window.
    d = pm.delta_probability(pts, 900, now=1200.0)
    assert d == pytest.approx(0.10)


def test_a_zero_delta_is_reported_as_zero_not_none():
    """The other half of the None/0.0 contract: a market that genuinely did not
    move must say so."""
    assert pm.delta_probability(_points([0.4, 0.4, 0.4]), 3600) == 0.0


def test_volatility_needs_a_real_sample():
    assert pm.probability_volatility(_points([0.4] * 5)) is None
    assert pm.probability_volatility(
        _points([0.4 + 0.001 * i for i in range(pm.MIN_POINTS_FOR_VOLATILITY + 1)])
    ) is not None


def test_a_never_moving_market_has_no_zscore_rather_than_an_infinite_one():
    """Dividing by zero volatility would report a huge z-score for the first move
    a stale market makes — precisely backwards."""
    flat = _points([0.5] * (pm.MIN_POINTS_FOR_VOLATILITY + 5))
    assert pm.probability_volatility(flat) == 0.0
    assert pm.probability_zscore(flat, 3600) is None


def test_zscore_normalises_against_the_markets_own_step_size():
    """A 3-point move in a market that habitually moves 3 points is not news, and a
    fixed ΔP threshold cannot tell the two apart.

    Both series carry the SAME underlying drift (+0.001 per step). They differ only
    in background noise, so a percentage threshold would score them identically
    while the z-score correctly calls one significant and the other not.

    Note the z-score is deliberately scale-INVARIANT: doubling both the move and the
    noise leaves it unchanged. That is the property being relied on, so the test has
    to vary them independently — an earlier version scaled both and found the two
    z-scores identical, which was the code being right rather than wrong.
    """
    n = pm.MIN_POINTS_FOR_VOLATILITY + 10
    calm = _points([0.20 + 0.001 * i + (0.0002 if i % 2 else -0.0002) for i in range(n)])
    choppy = _points([0.20 + 0.001 * i + (0.04 if i % 2 else -0.04) for i in range(n)])

    z_calm = pm.probability_zscore(calm, 1e9)
    z_choppy = pm.probability_zscore(choppy, 1e9)
    assert z_calm is not None and z_choppy is not None
    assert abs(z_calm) > 10 * abs(z_choppy), (z_calm, z_choppy)


def test_corrupt_points_are_skipped_not_fatal():
    pts = [
        {"ts": 0, "p": 0.4}, {"ts": 1, "p": None}, {"ts": 2, "p": "x"},
        {"ts": 3, "p": 5.0}, {"ts": 4, "p": True}, {"ts": 5, "p": 0.5},
        {"ts": 6, "p": 0.6},
    ]
    assert pm.delta_probability(pts, 1e9) == pytest.approx(0.2)


# --- expected price: the function most able to invent its key input ---------

def _bucket(p, floor, cap):
    return pm.PriceBucket(probability=p, floor=floor, cap=cap)


def _range_event(*specs, mutually_exclusive=True):
    """A ccxt PredictionEvent for a price-range market, in the REAL nested shape:
    event -> markets (each with floor/cap strikes) -> outcomes (YES/NO)."""
    return {
        "event": "BTC_RANGE_SEP",
        "mutuallyExclusive": mutually_exclusive,
        "markets": [
            {
                "market": f"BTC_{floor}_{cap}",
                "marketType": "scalar",
                "underlying": "BTC",
                "floorStrike": floor,
                "capStrike": cap,
                "outcomes": [
                    {"outcome": f"BTC_{floor}_{cap}:YES", "label": "Yes", "price": p},
                    {"outcome": f"BTC_{floor}_{cap}:NO", "label": "No", "price": 1 - p},
                ],
            }
            for p, floor, cap in specs
        ],
    }


def test_strikes_live_on_the_market_not_the_outcome():
    """THE REGRESSION GUARD.

    `expected_price` originally read `floorStrike`/`capStrike` off each ccxt OUTCOME
    dict. `PredictionOutcome` has no such fields — they are `PredictionMarket`
    fields, "scalar only". So on every real payload it would have found no strikes
    and returned None, leaving `expected_price_drift` permanently unavailable while
    looking merely blocked.

    That is the failure mode worth a dedicated test: it would not have crashed and
    would not have fabricated anything, so the honest-degradation path would have
    hidden a dead signal indefinitely.
    """
    from ccxt.base import types as ccxt_types

    outcome_fields = set(ccxt_types.PredictionOutcome.__annotations__)
    market_fields = set(ccxt_types.PredictionMarket.__annotations__)

    for field_name in ("floorStrike", "capStrike", "strikeType", "underlying"):
        assert field_name not in outcome_fields, (
            f"{field_name} is on PredictionOutcome after all — revisit PriceBucket"
        )
        assert field_name in market_fields, f"{field_name} is not on PredictionMarket"
    assert "price" in outcome_fields  # the probability itself IS per-outcome


def test_expected_price_rejects_raw_ccxt_dicts_loudly():
    """A caller going round `buckets_from_event` gets a TypeError, not None. None is
    indistinguishable from "this market has no buckets", which is what let the shape
    bug above hide."""
    with pytest.raises(TypeError, match="PriceBucket"):
        pm.expected_price(
            [{"price": 0.5, "floorStrike": 100.0, "capStrike": 110.0}],
            spot=105.0, horizon_seconds=7 * 86400,
        )


def test_buckets_are_built_from_an_events_markets():
    buckets = pm.buckets_from_event(
        _range_event((0.25, 100.0, 110.0), (0.50, 110.0, 120.0), (0.25, 120.0, 130.0))
    )
    assert buckets is not None
    assert [b.probability for b in buckets] == [0.25, 0.50, 0.25]
    assert [b.midpoint for b in buckets] == [105.0, 115.0, 125.0]


def test_buckets_require_a_mutually_exclusive_event():
    """Without the flag the markets are not a partition, so their probabilities are
    not a distribution and a weighted average over them is not an expectation. Not
    inferred from the sum, because unrelated markets can coincidentally sum to 1."""
    event = _range_event((0.5, 100.0, 110.0), (0.5, 110.0, 120.0),
                         mutually_exclusive=False)
    assert pm.buckets_from_event(event) is None


def test_buckets_refuse_an_unbounded_market():
    """THE key refusal. "above $130k" has no upper bound, so its midpoint is not a
    number. Substituting a cap — 2x the strike, say — would invent the single input
    the answer is most sensitive to."""
    event = _range_event((0.4, 130000.0, 140000.0))
    event["markets"][0]["capStrike"] = None
    assert pm.buckets_from_event(event) is None

    event = _range_event((0.4, 130000.0, 140000.0))
    event["markets"][0]["floorStrike"] = None
    assert pm.buckets_from_event(event) is None


def test_buckets_refuse_a_market_with_no_yes_outcome():
    event = _range_event((0.4, 100.0, 110.0))
    event["markets"][0]["outcomes"] = [
        {"outcome": "X:NO", "label": "No", "price": 0.6}
    ]
    assert pm.buckets_from_event(event) is None


def test_buckets_refuse_rather_than_dropping_a_bad_market():
    """A partial partition biases the expectation toward whichever buckets parsed."""
    event = _range_event((0.5, 100.0, 110.0), (0.5, 110.0, 120.0))
    event["markets"][1]["capStrike"] = None
    assert pm.buckets_from_event(event) is None


def test_a_yes_outcome_is_found_by_handle_when_the_label_is_missing():
    event = _range_event((0.4, 100.0, 110.0))
    for outcome in event["markets"][0]["outcomes"]:
        outcome.pop("label")
    buckets = pm.buckets_from_event(event)
    assert buckets is not None and buckets[0].probability == 0.4


def test_expected_price_is_a_probability_weighted_midpoint():
    """The one level-based path that needs NO volatility model:
    E[price] = Σ p_i × midpoint_i over bounded buckets."""
    buckets = [
        _bucket(0.25, 100.0, 110.0),   # mid 105
        _bucket(0.50, 110.0, 120.0),   # mid 115
        _bucket(0.25, 120.0, 130.0),   # mid 125
    ]
    ep = pm.expected_price(buckets, spot=110.0, horizon_seconds=7 * 86400)
    assert ep is not None
    assert ep.expected_price == pytest.approx(0.25 * 105 + 0.50 * 115 + 0.25 * 125)
    assert ep.buckets_used == 3
    assert ep.probability_sum == pytest.approx(1.0)
    assert ep.direction == "LONG"
    assert ep.drift_pct > 0


def test_the_end_to_end_path_from_a_ccxt_event_to_a_drift():
    """The seam the shape bug lived in: real nested payload -> buckets -> drift.
    Every component was testable in isolation and the join was where it broke."""
    event = _range_event((0.25, 100.0, 110.0), (0.50, 110.0, 120.0),
                         (0.25, 120.0, 130.0))
    buckets = pm.buckets_from_event(event)
    ep = pm.expected_price(buckets or [], spot=110.0, horizon_seconds=7 * 86400)
    assert ep is not None
    assert ep.expected_price == pytest.approx(115.0)
    assert ep.direction == "LONG"


def test_expected_price_refuses_a_short_probability_sum():
    """A sum of 0.7 means a bucket was not fetched, and averaging over the
    remainder biases the expectation toward whichever buckets were visible."""
    buckets = [_bucket(0.35, 100.0, 110.0), _bucket(0.35, 110.0, 120.0)]
    assert pm.expected_price(buckets, spot=110.0, horizon_seconds=7 * 86400) is None


@pytest.mark.parametrize("spot", [None, 0.0, -5.0, "abc"])
def test_expected_price_refuses_without_a_usable_spot(spot):
    """A drift of 0.0 would read as "the market agrees with spot"."""
    assert pm.expected_price([_bucket(1.0, 100.0, 110.0)], spot=spot,
                             horizon_seconds=7 * 86400) is None


@pytest.mark.parametrize("horizon", [60.0, 400 * 86400])
def test_expected_price_refuses_a_useless_horizon(horizon):
    """Below the floor the probability is settlement mechanics; above the ceiling a
    terminal distribution says nothing about the next hour."""
    assert pm.expected_price([_bucket(1.0, 100.0, 110.0)], spot=105.0,
                             horizon_seconds=horizon) is None


def test_expected_price_refuses_a_malformed_bucket():
    buckets = [_bucket(1.0, 120.0, 100.0)]  # cap below floor
    assert pm.expected_price(buckets, spot=110.0, horizon_seconds=7 * 86400) is None


def test_a_small_drift_is_neutral_rather_than_a_weak_call():
    ep = pm.expected_price([_bucket(1.0, 109.95, 110.05)], spot=110.0,
                           horizon_seconds=7 * 86400)
    assert ep is not None
    assert ep.direction == "NEUTRAL"


# --- delta stance: the inversion risk --------------------------------------

def test_delta_stance_refuses_an_unknown_threshold_direction():
    """Defaulting to 'above' because most markets are phrased that way would invert
    the signal on every 'below' market — and an inverted probability is
    undetectable downstream."""
    assert pm.delta_stance(0.05, None) is None
    assert pm.delta_stance(0.05, "") is None
    assert pm.delta_stance(0.05, "maybe") is None


def test_delta_stance_inverts_for_a_below_threshold():
    above = pm.delta_stance(0.05, pm.DIRECTION_ABOVE)
    below = pm.delta_stance(0.05, pm.DIRECTION_BELOW)
    assert above is not None and below is not None
    assert above.direction == "LONG"
    assert below.direction == "SHORT"


def test_delta_stance_is_neutral_inside_the_band():
    s = pm.delta_stance(0.001, pm.DIRECTION_ABOVE)
    assert s is not None and s.direction == "NEUTRAL"


def test_delta_stance_is_none_without_a_delta():
    assert pm.delta_stance(None, pm.DIRECTION_ABOVE) is None


# --- confidence ------------------------------------------------------------

def test_confidence_is_bounded_and_multiplicative():
    """polymarket.md §4's `(|ΔP|/σP) * sqrt(volume)` is unbounded and lets a big
    enough volume rescue an insignificant move, which is backwards."""
    strong = pm.confidence_from_liquidity(3.0, 100_000.0, spread=0.0)
    assert strong == pytest.approx(1.0)

    thin = pm.confidence_from_liquidity(3.0, 100.0, spread=0.0)
    assert thin is not None and thin < 0.01

    weak_move = pm.confidence_from_liquidity(0.1, 100_000.0, spread=0.0)
    assert weak_move is not None and weak_move < 0.05

    for z in (0.0, 1.0, 5.0, 50.0):
        for v in (0.0, 1.0, 1e9):
            c = pm.confidence_from_liquidity(z, v, spread=0.01)
            assert c is not None and 0.0 <= c <= 1.0


def test_confidence_is_none_when_volume_is_unmeasured():
    """Not 0.5 and not a volume-free fallback: an unmeasured input means the
    trustworthiness is unknown, and the specialist reports unavailable rather than
    a hedged number that looks like a measurement."""
    assert pm.confidence_from_liquidity(3.0, None) is None
    assert pm.confidence_from_liquidity(None, 100_000.0) is None


def test_a_wide_spread_discounts_confidence():
    tight = pm.confidence_from_liquidity(3.0, 100_000.0, spread=0.0)
    wide = pm.confidence_from_liquidity(3.0, 100_000.0, spread=pm.SPREAD_FULL_PENALTY)
    assert tight is not None and wide is not None
    assert wide < tight
    assert wide == pytest.approx(0.0)


def test_an_absent_spread_is_no_penalty_and_that_is_stated():
    assert pm.confidence_from_liquidity(3.0, 100_000.0, None) == pytest.approx(1.0)
    assert "no penalty when absent" in (pm.confidence_from_liquidity.__doc__ or "")


@pytest.mark.parametrize("p,expected", [
    (0.0, True), (0.005, True), (1.0, True), (0.995, True),
    (0.5, False), (0.05, False), (None, False),
])
def test_degenerate_probabilities_are_identified(p, expected):
    assert pm.is_degenerate(p) is expected


# --- signal inventory ------------------------------------------------------

def test_every_named_signal_is_reported_available_or_blocked():
    """Same convention as `footprint.FOOTPRINT_SIGNALS`: a signal that silently
    never fires is indistinguishable from one that fires and finds nothing."""
    signals = pm.evaluate_signals(_points([0.4, 0.45, 0.5]), 3600)
    assert [s.name for s in signals] == list(pm.PREDICTION_SIGNALS)
    for s in signals:
        if s.available:
            assert s.value is not None
            assert s.observation
        else:
            assert s.reason_unavailable, s.name


def test_the_unimplemented_signal_is_named_with_its_reason():
    """§4's learned anomaly detector is declined on explainability and
    reproducibility grounds, not effort — so the reason is recorded."""
    signals = {s.name: s for s in pm.evaluate_signals([], 3600)}
    anomaly = signals["anomaly_detection"]
    assert anomaly.available is False
    assert "deterministic equivalent" in (anomaly.reason_unavailable or "")


def test_signals_degrade_individually_rather_than_all_at_once():
    """With three points there is a ΔP but no volatility baseline, so the z-score
    and everything depending on it must be blocked while ΔP is reported."""
    signals = {s.name: s for s in pm.evaluate_signals(_points([0.4, 0.45, 0.5]), 3600)}
    assert signals["delta_probability"].available is True
    assert signals["probability_zscore"].available is False
    assert signals["move_confidence"].available is False
    assert "no z-score" in (signals["move_confidence"].reason_unavailable or "")


def test_a_full_signal_set_is_computable_with_complete_inputs():
    n = pm.MIN_POINTS_FOR_VOLATILITY + 20
    values = [0.40 + 0.002 * i for i in range(n)]
    signals = {s.name: s for s in pm.evaluate_signals(
        _points(values),
        window_seconds=1e9,
        spot=110.0,
        buckets=[_bucket(0.5, 100.0, 110.0), _bucket(0.5, 110.0, 120.0)],
        threshold_direction=pm.DIRECTION_ABOVE,
        quote_volume=100_000.0,
        spread=0.005,
        horizon_seconds=7 * 86400,
    )}
    for name in ("delta_probability", "probability_zscore", "expected_price_drift",
                 "delta_stance", "move_confidence"):
        assert signals[name].available is True, (name, signals[name].reason_unavailable)


# ===========================================================================
# The gate — §2's whole safety argument
# ===========================================================================

def test_the_feature_defaults_off(monkeypatch):
    """Turning it on changes every confidence number the system produces, because
    `coverage = available_weight / TOTAL_DIRECTIONAL_WEIGHT` and a new directional
    specialist raises the denominator on EVERY run — including the common case
    where Polymarket has no market for the symbol (4.0/8.0 = 0.500 against today's
    4.0/7.0 = 0.571). That must be an operator decision, not a side effect of
    installing a dependency."""
    from backend.core.config import settings

    monkeypatch.setenv("POLYMARKET_ENABLED", "false")  # explicit "false", not delenv:
    # `.env` now sets this flag, and `services/exchange_client` calls `load_dotenv()` at
    # import time. `load_dotenv` does not override an existing var but DOES set an
    # absent one — so a lazy import after `delenv` silently restored the value from
    # `.env` and the flag-off tests saw 9 specialists. An explicit "false" survives it.
    assert settings.POLYMARKET_ENABLED is False

    monkeypatch.setenv("POLYMARKET_ENABLED", "true")
    assert settings.POLYMARKET_ENABLED is True

    monkeypatch.setenv("POLYMARKET_ENABLED", "yes")  # only "true" counts
    assert settings.POLYMARKET_ENABLED is False


def test_the_core_panel_is_unchanged_with_the_feature_off(monkeypatch):
    """The plan's checkpoint, still enforced after Phase 35 landed: with
    POLYMARKET_ENABLED off the CORE panel is exactly what it always was.

    Phase 35 adds a third SUPPLEMENTARY tier rather than a fifth directional
    specialist, so `DIRECTIONAL_WEIGHTS` and `TOTAL_DIRECTIONAL_WEIGHT` stay
    untouched in both flag states — see tests/test_polymarket_panel.py for the
    flag-on behaviour."""
    monkeypatch.setenv("POLYMARKET_ENABLED", "false")
    from backend.graphs.nodes.specialists import (
        DIRECTIONAL_WEIGHTS,
        SPECIALIST_NODES,
        TOTAL_DIRECTIONAL_WEIGHT,
    )

    assert TOTAL_DIRECTIONAL_WEIGHT == 7.0
    assert "prediction" not in DIRECTIONAL_WEIGHTS
    assert len(SPECIALIST_NODES) == 7
    assert not any("prediction" in n or "event_risk" in n for n in SPECIALIST_NODES)


def test_no_graph_node_can_fetch_from_polymarket():
    """Phase 35 lets `graphs/` READ the snapshot store. It must never reach the
    CLIENT.

    This replaces a Phase-34 test that asserted `graphs/` referenced nothing
    Polymarket at all — true then, and obsolete the moment the specialists landed.
    The invariant that survives is the one that actually matters:

      * reading `polymarket_store` is fine — it parses a local file;
      * importing `polymarket_client` is not — it holds a ccxt object with
        `create_order` on it, and it would put a network call inside a seven-way
        fan-out, making the panel's latency the sum of seven timeouts.

    `specialists.specialist_funding` established the same rule for a different feed:
    a specialist reads what was already fetched, it does not fetch.
    """
    import ast
    import pathlib

    for path in pathlib.Path("backend/graphs").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names = []
            if isinstance(node, ast.ImportFrom):
                names = [node.module or ""] + [a.name for a in node.names]
            elif isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            for name in names:
                assert "polymarket_client" not in name, (
                    f"{path} imports the Polymarket CLIENT — a graph node must read "
                    f"the snapshot store, never fetch"
                )
                assert "get_polymarket_client" not in name, path
