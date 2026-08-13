"""Spec Section 8 — every API must actually answer.

Four routers (`market`, `exchange`, `knowledge`, `memory`) were
`router = APIRouter()` with no routes, yet mounted in `main.py`. So the prefixes
appeared in the OpenAPI schema and every documented endpoint returned 404 — the
API looked present and answered nothing. These tests assert each one has routes
and that the safety-relevant ones behave correctly.
"""

import pytest
from fastapi.testclient import TestClient

from backend.main import app

# Spec Section 8's nine APIs.
REQUIRED_PREFIXES = [
    "/api/market",
    "/api/exchange",
    "/api/ai",
    "/api/knowledge",
    "/api/memory",
    "/api/research",
    "/api/execution",
    "/api/monitoring",
    "/api/dashboard",
]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _schema() -> dict:
    """Route table from the OpenAPI schema.

    NOT from `app.routes`: this FastAPI version (0.141.x) keeps
    `include_router` results as opaque `_IncludedRouter` wrappers whose `.path`
    is None, so walking `app.routes` finds only the four built-in doc routes and
    reports every mounted API as empty. The schema is what FastAPI actually
    serves and is stable across versions.
    """
    return app.openapi()


def _paths_under(prefix: str) -> list:
    return sorted(p for p in _schema().get("paths", {}) if p.startswith(prefix))


def _methods_for(path: str) -> set:
    return {m.upper() for m in _schema()["paths"].get(path, {})}


@pytest.mark.parametrize("prefix", REQUIRED_PREFIXES)
def test_every_spec_api_is_mounted_with_at_least_one_route(prefix):
    """A mounted router with zero routes is worse than an absent one: it
    advertises a prefix that answers nothing."""
    paths = _paths_under(prefix)
    assert paths, f"{prefix} is mounted but has no routes"


def test_the_four_previously_stubbed_apis_now_have_routes():
    """Regression guard naming the specific four."""
    for prefix in ("/api/market", "/api/exchange", "/api/knowledge", "/api/memory"):
        assert len(_paths_under(prefix)) >= 2, (
            f"{prefix} should expose more than a single route; found {_paths_under(prefix)}"
        )


# ---------------------------------------------------------------------------
# The chokepoint rule
# ---------------------------------------------------------------------------

def test_no_http_route_can_place_an_order():
    """Spec Section 8: *"the Execution API is a hard chokepoint — no agent talks
    to an exchange directly, ever."*

    An HTTP endpoint that placed an order would be a path to the exchange that
    bypasses the Supervisor, the CRO and the leverage ceiling, reachable by
    anything that can reach the port.
    """
    order_like = []
    for path in _schema()["paths"]:
        if not path.startswith("/api"):
            continue
        methods = _methods_for(path)
        if methods & {"POST", "PUT", "PATCH"}:
            lowered = path.lower()
            if any(word in lowered for word in ("order", "buy", "sell", "trade/execute", "position/open")):
                order_like.append(f"{sorted(methods)} {path}")
    assert not order_like, f"routes that look like order placement: {order_like}"


def test_exchange_api_exposes_no_write_routes():
    """The exchange router is read-only by design."""
    writes = [
        f"{sorted(_methods_for(p))} {p}"
        for p in _paths_under("/api/exchange")
        if _methods_for(p) & {"POST", "PUT", "PATCH", "DELETE"}
    ]
    assert not writes, f"/api/exchange must be read-only, found: {writes}"


# ---------------------------------------------------------------------------
# Market API
# ---------------------------------------------------------------------------

def test_unknown_symbol_price_is_404_not_zero(client):
    """`get_price` returns 0.0 for an unknown symbol. Passing that through would
    let a caller size a position against zero."""
    r = client.get("/api/market/price/NOSUCH/PAIR")
    assert r.status_code == 404
    assert "No price available" in r.json()["detail"]


def test_invalid_timeframe_is_rejected(client):
    r = client.get("/api/market/klines/BTC/USDT", params={"timeframe": "7s"})
    assert r.status_code == 422


def test_prices_endpoint_returns_a_copy_not_the_live_cache(client):
    """Handing out the module's dict would let a caller mutate the price cache
    every agent reads from."""
    from backend.services import market_data

    market_data._prices["TEST/USDT"] = 123.0
    try:
        body = client.get("/api/market/prices").json()
        body["prices"]["TEST/USDT"] = 999.0
        assert market_data._prices["TEST/USDT"] == 123.0
    finally:
        market_data._prices.pop("TEST/USDT", None)


# ---------------------------------------------------------------------------
# Exchange API
# ---------------------------------------------------------------------------

def test_exchange_status_never_echoes_a_credential(client):
    """Spec Section 16 requires credentials be protected. Even a masked key
    confirms its length and prefix."""
    body = client.get("/api/exchange/status").json()
    assert body["credentialsConfigured"] in (True, False)
    serialized = str(body).lower()
    for leak in ("apikey", "api_key", "secret"):
        assert leak not in serialized, f"status response mentions {leak}"


def test_exchange_status_reports_testnet_and_live_separately(client):
    """Collapsing them into one 'mode' string hides which is which."""
    body = client.get("/api/exchange/status").json()
    assert "useTestnet" in body
    assert "liveTradingEnabled" in body


def test_balance_without_credentials_is_503_not_an_empty_account(client):
    """`{}` would be indistinguishable from a genuinely empty account."""
    from backend.services.exchange_client import get_exchange_client

    client_obj = get_exchange_client()
    if client_obj.has_credentials():
        pytest.skip("credentials are configured in this environment")
    r = client.get("/api/exchange/balance")
    assert r.status_code == 503
    assert "unauthenticated" in r.json()["detail"]


# ---------------------------------------------------------------------------
# Knowledge API
# ---------------------------------------------------------------------------

def test_knowledge_graph_returns_its_base_rules(client):
    body = client.get("/api/knowledge").json()
    assert body["edgeCount"] >= 4
    edges = {(e["from"], e["to"]) for e in body["edges"]}
    assert ("High Funding", "High Liquidation Risk") in edges


def test_unknown_state_is_404_not_an_empty_implication_list(client):
    """An empty list reads as "this state implies nothing", a much stronger
    claim than "we have never heard of this state"."""
    r = client.get("/api/knowledge/implications/Nonsense State")
    assert r.status_code == 404
    assert "not a known state" in r.json()["detail"]


def test_implications_include_second_degree(client):
    body = client.get("/api/knowledge/implications/High Funding").json()
    assert "High Liquidation Risk" in body["implications"]
    assert "Lower Position Size" in body["implications"], "second-degree implication missing"


def test_relationship_write_requires_attribution(client):
    """An unattributed assertion is indistinguishable from a shipped rule."""
    r = client.post(
        "/api/knowledge/relationship",
        json={"source_state": "A", "implies": "B", "weight": 0.5},
    )
    assert r.status_code == 422


def test_self_referential_relationship_is_rejected(client):
    r = client.post(
        "/api/knowledge/relationship",
        json={"source_state": "X", "implies": "X", "weight": 1.0, "attributed_to": "test"},
    )
    assert r.status_code == 422


def test_relationship_write_states_it_does_not_affect_trading(client):
    """CLAUDE.md invariant 5 — the graph holds understanding, not config."""
    r = client.post(
        "/api/knowledge/relationship",
        json={
            "source_state": "Test State",
            "implies": "Test Implication",
            "weight": 0.6,
            "attributed_to": "pytest",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["affectsTrading"] is False
    assert body["attributedTo"] == "pytest"


# ---------------------------------------------------------------------------
# Memory API
# ---------------------------------------------------------------------------

def test_memory_api_has_no_route_that_writes_a_trade_outcome():
    """The ledger feeds the win rate the Confidence Agent calibrates against,
    which scales the confidence that drives position sizing. A writable outcome
    endpoint is a direct path from "post fake wins" to "the system sizes up"."""
    writable = [
        p for p in _paths_under("/api/memory")
        if _methods_for(p) & {"POST", "PUT", "PATCH", "DELETE"}
    ]
    # Only the operator-lesson route may write, and it touches `mistakes` only.
    assert writable == ["/api/memory/lesson"], f"unexpected writable memory routes: {writable}"


def test_memory_summary_reports_calibration_sufficiency(client):
    body = client.get("/api/memory").json()
    assert "sufficientForCalibration" in body


def test_learning_report_with_no_data_is_200_not_an_error(client):
    """"Not enough data yet" is a normal state for a new deployment."""
    body = client.get("/api/memory/report").json()
    assert body["status"] == "success"
    assert isinstance(body["sufficientData"], bool)
    if not body["sufficientData"]:
        assert body["reason"]
