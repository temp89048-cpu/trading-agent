"""Phase 37 — the API surface, and the last hop to the UI.

`tests/test_stack_integration.py` records that layer 4 (LangGraph) was built,
worked, and had no API surface at all, so nothing it computed could reach the
dashboard. That was fixed by adding `/api/graphs` — and this file exists partly
because that fix stopped one hop short: `lib/backendConfig.ts` declared the graph
paths, a test asserted they matched what FastAPI serves, and **no component ever
imported them**. Reachable in principle, read by nobody.

So these tests cover both hops:

    L2 <- L3   the router is mounted and the endpoints answer
    L1 <- L2   a component actually FETCHES them, and is actually rendered

plus the one route that is not read-only — the human confirmation gate, which is
what makes `confirm_mapping`'s refusal enforceable rather than decorative.
"""

from __future__ import annotations

import asyncio
import pathlib

import pytest

from backend.api import polymarket as api
from backend.services import polymarket_registry as registry
from backend.services import polymarket_store as store


@pytest.fixture
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SERIES_FILE", str(tmp_path / "series.json"))
    monkeypatch.setattr(store, "MARKETS_FILE", str(tmp_path / "markets.json"))
    monkeypatch.setattr(store, "SNAPSHOT_FILE", str(tmp_path / "snapshots.json"))
    return tmp_path


# ===========================================================================
# L2 <- L3 : mounted and answering
# ===========================================================================

def test_the_router_is_mounted():
    """A router that exists but is not included serves nothing. `components/Agent.tsx`
    once targeted `/api/agents/tasks` with no router mounted at all, so every call
    404'd while the module looked present."""
    from backend.main import app

    paths = set(app.openapi()["paths"])
    for route in ("/api/polymarket", "/api/polymarket/signals",
                  "/api/polymarket/mappings", "/api/polymarket/snapshots",
                  "/api/polymarket/series"):
        assert route in paths, f"{route} is not served"


def test_the_router_is_mounted_even_though_the_feature_is_gated(monkeypatch):
    """Deliberate. These endpoints answer "is this feed contributing anything, and if
    not, why not?" — and the most useful time to ask is when the answer is no."""
    monkeypatch.setenv("POLYMARKET_ENABLED", "false")  # explicit "false", not delenv:
    # `.env` now sets this flag, and `services/exchange_client` calls `load_dotenv()` at
    # import time. `load_dotenv` does not override an existing var but DOES set an
    # absent one — so a lazy import after `delenv` silently restored the value from
    # `.env` and the flag-off tests saw 9 specialists. An explicit "false" survives it.
    result = asyncio.run(api.status())
    assert result["enabled"] is False
    assert "POLYMARKET_ENABLED" in result["gateMeaning"]


async def test_status_names_all_three_gates_that_must_pass(tmp_store):
    """Three independent things must hold before a number reaches the panel, and an
    operator seeing "no contribution" needs to know WHICH one is missing — the next
    action is different for each."""
    result = await api.status()
    for key in ("enabled", "adapterAvailable", "mappingsConfirmed"):
        assert key in result
    assert "HUMAN-CONFIRMED" in result["gateMeaning"]
    assert "SUPPLEMENTARY" in result["role"]
    assert "costs that symbol nothing" in result["notApplicableMeaning"]


async def test_status_reports_the_read_only_posture(tmp_store):
    result = await api.status()
    assert "never places an order" in result["readOnlyMeaning"]


async def test_the_signal_inventory_names_the_refused_path(tmp_store):
    """The most important thing this endpoint says is what the system will NOT do: a
    probability LEVEL is not a directional view, and converting one would need an
    implied-volatility model this system does not have."""
    result = await api.signals()

    assert result["total"] == len(result["signals"])
    assert "anomaly_detection" in result["unimplemented"]
    assert "unfalsifiable" in result["refusedPath"]
    # Both honest directional paths are named, with why each is limited.
    assert "NO volatility model" in result["directionalPaths"]["expected_price_drift"]
    assert "inverts the signal" in result["directionalPaths"]["delta_stance"]


async def test_the_signal_thresholds_come_from_the_algorithm_module(tmp_store):
    """Restating them here would let the two drift, and the reported number would then
    describe something other than what the code does."""
    from backend.algorithms import prediction_market as pm

    result = await api.signals()
    assert result["thresholds"]["minPointsForVolatility"] == pm.MIN_POINTS_FOR_VOLATILITY
    assert result["thresholds"]["maxEventRiskConcern"] == registry.MAX_EVENT_RISK_CONCERN


async def test_mappings_explains_why_attribution_is_not_automated(tmp_store):
    result = await api.mappings()
    assert result["count"] == 0
    assert "ETH flip BTC" in result["confirmationMeaning"]
    assert "directionalBasis" in result["basisMeaning"]


async def test_mappings_can_be_filtered_to_confirmed_only(tmp_store):
    await store.save_mapping("BTC/USDT", "A:YES", market="A",
                             role=registry.ROLE_DIRECTIONAL,
                             classification_reason="test")
    await store.save_mapping("BTC/USDT", "B:YES", market="B",
                             role=registry.ROLE_DIRECTIONAL,
                             classification_reason="test")
    await store.confirm_mapping("BTC/USDT", "A:YES", True, set_by_human=True)

    assert (await api.mappings())["count"] == 2
    confirmed = await api.mappings(confirmed_only=True)
    assert confirmed["count"] == 1
    assert confirmed["mappings"][0]["outcome"] == "A:YES"


async def test_snapshots_reports_a_missing_snapshot_rather_than_omitting_it(tmp_store):
    """An empty response cannot distinguish "the poller stopped" from "it never
    started"."""
    result = await api.snapshots()
    assert result["snapshots"], "watched symbols must always be listed"
    for row in result["snapshots"]:
        assert row["present"] is False
        assert row["fresh"] is False
        assert "has not run" in row["reason"]


async def test_snapshots_returns_a_stale_record_flagged_rather_than_hidden(tmp_store):
    """The store's GETTER refuses a stale record because a caller would present it as
    current. A monitoring endpoint has the opposite job: show that the poller
    stopped."""
    import time

    from backend.workers.polymarket_worker import WATCH_SYMBOLS

    symbol = WATCH_SYMBOLS[0]
    await store.save_signal_snapshot(
        symbol, applicable=True,
        directional={"direction": "LONG", "confidence": 0.5},
        computed_at=time.time() - store.MAX_SNAPSHOT_AGE_SECONDS - 600,
    )

    row = next(r for r in (await api.snapshots())["snapshots"] if r["symbol"] == symbol)
    assert row["present"] is True
    assert row["fresh"] is False
    assert row["ageSeconds"] > store.MAX_SNAPSHOT_AGE_SECONDS

    # And the store's own getter still refuses it — the two are not in conflict, they
    # answer different questions.
    assert await store.get_signal_snapshot(symbol) is None


async def test_snapshots_distinguishes_inapplicable_from_uncomputable(tmp_store):
    """The distinction the whole supplementary tier rests on. Rendering them the same
    way would erase the only thing an operator acts on."""
    result = await api.snapshots()
    assert "costs the panel nothing" in result["applicableMeaning"]
    assert "count against coverage" in result["applicableMeaning"]


async def test_an_empty_series_says_no_history_not_no_movement(tmp_store):
    result = await api.series(outcome="NOPE:YES")
    assert result["count"] == 0
    assert "NO HISTORY" in result["emptyMeaning"]


async def test_the_series_endpoint_trims_rather_than_dumping_everything(tmp_store):
    for i in range(50):
        await store.record_probability("X:YES", 0.5, ts=1_000_000.0 + i)

    result = await api.series(outcome="X:YES", limit=10)
    assert result["count"] == 10
    assert result["totalStored"] == 50


# ===========================================================================
# The human gate — the one route that is not read-only
# ===========================================================================

def test_only_the_confirm_and_discover_routes_are_auth_gated():
    """Reads must not require auth or the panel cannot render for an operator who is
    just looking. Writes must, because one changes what the reasoning layer treats as
    evidence and the other spends API quota."""
    import inspect

    for name in ("status", "signals", "mappings", "snapshots", "series"):
        sig = inspect.signature(getattr(api, name))
        assert "_auth" not in sig.parameters, f"{name} should be readable without auth"

    for name in ("confirm", "discover"):
        sig = inspect.signature(getattr(api, name))
        assert "_auth" in sig.parameters, f"{name} must be auth-gated"


def test_only_http_routes_pass_set_by_human():
    """This is what makes `confirm_mapping`'s PermissionError meaningful rather than
    decorative: the flag can only be satisfied from a route a person drives.

    The invariant is about the LAYER, not a single file. An earlier version of this
    test asserted `backend/api/polymarket.py` was the ONLY file, and it failed —
    correctly — because `backend/api/research.py` passes it too, for
    `research_store`'s hypothesis gate. That is the same pattern for a different
    store, and it is fine.

    What must never happen is a service, worker, graph node or algorithm passing it:
    that would be automated code confirming its own guess, and the human step would
    become decorative.

    AST-based rather than a text grep — grepping source for a literal has matched the
    comment documenting a fix three times in this project.
    """
    import ast

    found = set()
    for path in pathlib.Path("backend").rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            for kw in node.keywords:
                if kw.arg == "set_by_human" and isinstance(kw.value, ast.Constant) \
                        and kw.value.value is True:
                    found.add(path.as_posix())

    assert "backend/api/polymarket.py" in found, (
        "the confirm route must pass set_by_human=True, or the gate is unreachable "
        "and no mapping could ever be confirmed"
    )
    non_route = sorted(f for f in found if not f.startswith("backend/api/"))
    assert not non_route, (
        f"automated code passes set_by_human=True: {non_route}. Only an HTTP route a "
        f"human drives may satisfy that flag."
    )


async def test_confirming_an_unknown_mapping_is_a_404_with_the_next_step(tmp_store):
    from fastapi import HTTPException

    body = api.ConfirmRequest(symbol="BTC/USDT", outcome="NOPE:YES", confirmed=True)
    with pytest.raises(HTTPException) as exc:
        await api.confirm(body)
    assert exc.value.status_code == 404
    assert "discover" in exc.value.detail


async def test_confirming_a_known_mapping_promotes_it(tmp_store):
    await store.save_mapping("BTC/USDT", "A:YES", market="A",
                             role=registry.ROLE_DIRECTIONAL,
                             classification_reason="test")

    result = await api.confirm(api.ConfirmRequest(
        symbol="BTC/USDT", outcome="A:YES", confirmed=True, note="checked the title",
    ))
    assert result["mapping"]["confirmed"] is True
    assert result["confirmedBy"] == "operator"


async def test_un_confirming_is_never_harder_than_confirming(tmp_store):
    await store.save_mapping("BTC/USDT", "A:YES", market="A",
                             role=registry.ROLE_DIRECTIONAL,
                             classification_reason="test")
    await api.confirm(api.ConfirmRequest(symbol="BTC/USDT", outcome="A:YES",
                                         confirmed=True))
    result = await api.confirm(api.ConfirmRequest(symbol="BTC/USDT", outcome="A:YES",
                                                  confirmed=False))
    assert result["mapping"]["confirmed"] is False


async def test_discovery_refuses_while_the_feature_is_disabled(monkeypatch, tmp_store):
    """It would write mappings nothing reads, and enabling the feature later changes
    every confidence number — so that is an explicit decision, not a side effect of
    calling a route."""
    from fastapi import HTTPException

    monkeypatch.setenv("POLYMARKET_ENABLED", "false")
    with pytest.raises(HTTPException) as exc:
        await api.discover("BTC/USDT")
    assert exc.value.status_code == 409
    assert "explicit decision" in exc.value.detail


async def test_discovery_cannot_confirm_what_it_finds(monkeypatch, tmp_store):
    """The whole point of the gate. Discovery is automated; attribution is not."""
    monkeypatch.setenv("POLYMARKET_ENABLED", "true")

    class _Fake:
        @staticmethod
        def is_available():
            return True

        @staticmethod
        def unavailable_reason():
            return None

        async def fetch_events(self, **kw):
            return [{
                "title": "Bitcoin",
                "tags": ["crypto"],
                "mutuallyExclusive": True,
                "markets": [{
                    "market": "M", "marketType": "scalar", "underlying": "BTC",
                    "floorStrike": 100.0, "capStrike": 110.0, "active": True,
                    "outcomes": [{"outcome": "M:YES", "label": "Yes", "price": 0.5}],
                }],
            }]

    monkeypatch.setattr(registry, "get_polymarket_client", lambda: _Fake())
    result = await registry.discover_for_symbol("BTC/USDT", client=_Fake())

    assert len(result.directional) == 1
    rows = await store.get_mappings("BTC/USDT")
    assert rows and all(r["confirmed"] is False for r in rows)


# ===========================================================================
# Read-only, checked by AST
# ===========================================================================

def test_the_api_module_cannot_reach_an_order_call():
    """It sits in `api/`, so `graphs/`'s import ban does not apply by location. The
    ccxt Polymarket adapter carries `create_order` on the same class we import for
    reads, and an HTTP route is the last place that should be reachable from."""
    import ast

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    tree = ast.parse(pathlib.Path("backend/api/polymarket.py").read_text(encoding="utf-8"))

    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)
    assert not (imported & set(FORBIDDEN_IMPORTS))

    forbidden = {"create_order", "create_orders", "cancel_order", "cancel_all_orders",
                 "fetch_balance", "fetch_positions"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            assert node.attr not in forbidden, node.attr


# ===========================================================================
# L1 <- L2 : the hop that was missed last time
# ===========================================================================

def test_every_declared_polymarket_path_is_really_served():
    """`lib/backendConfig.ts` exists because several hardcoded URLs pointed at paths
    FastAPI does not serve — `/api/health` and `/api/trades` are real routes of the
    NEXT.JS app, so the calls 404'd against the Python host while looking correct."""
    import re

    from backend.main import app

    config = pathlib.Path("lib/backendConfig.ts").read_text(encoding="utf-8")
    served = set(app.openapi()["paths"])

    declared = set(re.findall(r"'(/api/polymarket[a-z/-]*)'", config))
    assert declared, "backendConfig declares no Polymarket paths"
    for path in declared:
        assert path in served, f"backendConfig points at {path}, which FastAPI does not serve"


def test_a_component_actually_fetches_the_declared_paths():
    """THE GAP THIS TEST CLOSES.

    `BACKEND_PATHS` was imported by NOTHING. The graph endpoints added earlier were
    declared, asserted to match what FastAPI serves, and read by no component — so the
    original audit finding ("layer 4 has no API surface") was fixed one hop short of
    the UI it existed to reach.

    Declaring five more paths with no consumer would have repeated exactly that, so
    this asserts the consumer exists.
    """
    panel = pathlib.Path("components/PolymarketPanel.tsx").read_text(encoding="utf-8")

    assert "@/lib/backendConfig" in panel, "the panel must not hardcode a host"
    assert "BACKEND_PATHS.polymarket" in panel
    assert "backendUrl(" in panel

    # No hardcoded host — the class of bug backendConfig was created to remove.
    #
    # Comments are stripped first. The panel's own header explains that six components
    # once had localhost hardcoded, and an unstripped check matched that explanation —
    # the same "the grep found the comment documenting the fix" trap this project has
    # hit three times before, arriving in a TSX file this time.
    code = "\n".join(
        line for line in panel.splitlines()
        if not line.strip().startswith(("//", "*", "/*"))
    )
    assert "localhost" not in code
    assert "127.0.0.1" not in code


def test_the_panel_is_actually_rendered():
    """A component that exists but is never mounted shows nothing. The last hop is
    only complete when something renders it.

    THE MOUNT POINT MOVED. This used to assert against `components/TradingSidebar.tsx`,
    which was the old single-page terminal's rail. That file is deleted; the panel is
    now mounted by `components/operator/PolymarketOperator.tsx`, which the `/polymarket`
    route renders. The assertion follows the mount rather than being deleted with the
    file, because "is it mounted anywhere" is the thing worth checking — and this test
    failing when the sidebar went away is exactly it doing its job.
    """
    wrapper = pathlib.Path("components/operator/PolymarketOperator.tsx").read_text(
        encoding="utf-8"
    )
    assert "import { PolymarketPanel }" in wrapper
    assert "<PolymarketPanel />" in wrapper

    # ...and the wrapper must itself be reached by a route, or it is just a second
    # unmounted component.
    page = pathlib.Path("app/(terminal)/polymarket/page.tsx").read_text(encoding="utf-8")
    assert "PolymarketOperator" in page
    assert "<PolymarketOperator />" in page


def test_the_panel_distinguishes_the_states_that_matter():
    """It must not collapse "no market for this symbol" and "the read failed" into one
    "no data" state: the first costs the panel nothing and the second reduces its
    confidence, and only one of them is worth acting on."""
    panel = pathlib.Path("components/PolymarketPanel.tsx").read_text(encoding="utf-8")

    assert "not applicable" in panel
    assert "STALE" in panel
    assert "uncomputable" in panel
    assert "count against panel coverage" in panel


def test_the_panel_explains_itself_when_the_backend_is_absent():
    """Running only the Next.js half is a normal state for this app, so an unreachable
    backend is a plain explanation rather than an error."""
    panel = pathlib.Path("components/PolymarketPanel.tsx").read_text(encoding="utf-8")
    assert "unreachable" in panel
    assert "isn&apos;t reachable" in panel or "isn't reachable" in panel
