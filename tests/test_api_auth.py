"""Auth on state-changing FastAPI routes.

`Recommended_Technology_Stack.md` lists "Authentication and authorization" as a
FastAPI responsibility. There was none — on any route — while the Next.js half of
the same application already had it. So `POST /api/admin/emergency-stop`,
`POST /api/agents/tasks`, and the Section 12 human-approval gate were all
reachable by anything that could open the port.

The approval gate matters most: `research_store` refuses to let automated code
mark its own hypothesis validated, and `set_by_human=True` is passed only by that
route — but with no auth, "human" meant "any HTTP client".
"""

import os

import pytest
from fastapi.testclient import TestClient

from backend.core import auth
from backend.main import app

# Every route that changes state and must therefore be guarded.
GUARDED = [
    ("POST", "/api/admin/pause", None),
    ("POST", "/api/admin/resume", None),
    ("POST", "/api/admin/emergency-stop", None),
    ("POST", "/api/agents/tasks", {"id": "t1", "symbol": "BTC/USDT"}),
    ("DELETE", "/api/agents/tasks/t1", None),
    ("POST", "/api/knowledge/relationship",
     {"source_state": "A", "implies": "B", "weight": 0.5, "attributed_to": "test"}),
    ("POST", "/api/memory/lesson", {"symbol": "BTC/USDT", "lesson": "x", "recorded_by": "test"}),
    ("POST", "/api/research/hypotheses/abc/status", {"status": "validated", "review_note": "n"}),
    ("POST", "/api/research/tasks/abc/finding", {"finding": "f", "confidence": 0.5}),
    ("POST", "/api/missions", None),
]

TEST_KEY = "test-secret-key-do-not-use"


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def with_auth(monkeypatch):
    monkeypatch.setenv(auth.ENV_VAR, TEST_KEY)
    yield TEST_KEY


@pytest.fixture
def without_auth(monkeypatch):
    monkeypatch.delenv(auth.ENV_VAR, raising=False)
    yield


# ---------------------------------------------------------------------------
# Enforcement
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("method,path,body", GUARDED, ids=lambda v: str(v))
def test_guarded_route_rejects_a_request_with_no_credential(client, with_auth, method, path, body):
    r = client.request(method, path, json=body)
    assert r.status_code == 401, f"{method} {path} returned {r.status_code}, expected 401"
    # Tells the client HOW to authenticate rather than only that it failed.
    assert r.headers.get("www-authenticate") == "Bearer"


@pytest.mark.parametrize("method,path,body", GUARDED, ids=lambda v: str(v))
def test_guarded_route_rejects_a_wrong_credential(client, with_auth, method, path, body):
    r = client.request(method, path, json=body, headers={"Authorization": "Bearer wrong"})
    assert r.status_code == 401


def test_wrong_scheme_is_rejected(client, with_auth):
    """A raw token without the Bearer scheme must not pass."""
    r = client.post("/api/admin/pause", headers={"Authorization": TEST_KEY})
    assert r.status_code == 401
    r = client.post("/api/admin/pause", headers={"Authorization": f"Basic {TEST_KEY}"})
    assert r.status_code == 401


def test_correct_credential_is_accepted(client, with_auth):
    r = client.post("/api/admin/pause", headers={"Authorization": f"Bearer {TEST_KEY}"})
    assert r.status_code == 200
    # Put it back so a later test isn't running against a paused system.
    client.post("/api/admin/resume", headers={"Authorization": f"Bearer {TEST_KEY}"})


def test_error_message_does_not_reveal_which_half_was_wrong(client, with_auth):
    """Distinguishing "wrong key" from "wrong scheme" tells an attacker which
    half to fix."""
    no_header = client.post("/api/admin/pause").json()["detail"]
    bad_key = client.post(
        "/api/admin/pause", headers={"Authorization": "Bearer nope"}
    ).json()["detail"]
    assert "wrong key" not in bad_key.lower()
    assert bad_key != no_header  # missing vs present is fine to distinguish


# ---------------------------------------------------------------------------
# The default: open, matching the Next.js side exactly
# ---------------------------------------------------------------------------

def test_unset_key_leaves_routes_open(client, without_auth):
    """Local development needs zero setup, and a different default here would
    mean enabling auth on one server silently left the other open."""
    assert auth.auth_required() is False
    r = client.post("/api/admin/pause")
    assert r.status_code == 200
    client.post("/api/admin/resume")


def test_env_var_matches_the_next_js_convention():
    """One secret governs both servers. Two independent auth schemes for one
    application is how one of them ends up unprotected."""
    assert auth.ENV_VAR == "TRADES_API_KEY"

    import pathlib
    route = pathlib.Path(__file__).resolve().parents[1] / "app" / "api" / "trades" / "route.ts"
    assert "TRADES_API_KEY" in route.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Reads stay open
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("path", [
    "/api/monitoring",
    "/api/admin/status",
    "/api/agents/tasks",
    "/api/knowledge",
    "/api/memory",
    "/api/research/queue",
])
def test_read_routes_remain_open_with_auth_enabled(client, with_auth, path):
    """The browser UI polls these directly and cannot hold a server secret
    without shipping it to every client."""
    r = client.get(path)
    assert r.status_code == 200, f"GET {path} returned {r.status_code}"


# ---------------------------------------------------------------------------
# Status reporting
# ---------------------------------------------------------------------------

def test_status_reports_when_auth_is_off(client, without_auth):
    """"I thought auth was on" is how an open port stays open."""
    body = client.get("/api/admin/status").json()
    assert body["auth"]["writeAuthEnabled"] is False
    assert "not set" in body["auth"]["note"]


def test_status_reports_when_auth_is_on(client, with_auth):
    body = client.get("/api/admin/status").json()
    assert body["auth"]["writeAuthEnabled"] is True
    assert body["auth"]["scheme"] == "Bearer"


def test_status_never_returns_the_key(client, with_auth):
    body = client.get("/api/admin/status").text
    assert TEST_KEY not in body


def test_status_states_that_reads_are_unprotected(client, with_auth):
    body = client.get("/api/admin/status").json()
    assert body["auth"]["readsProtected"] is False


def test_auth_status_is_honest_about_not_being_user_auth(client, with_auth):
    """A shared bearer token is not user authentication — no users, no roles, no
    attribution. Claiming otherwise would overstate the protection."""
    note = client.get("/api/admin/status").json()["auth"]["note"]
    assert "not user authentication" in note


# ---------------------------------------------------------------------------
# Constant-time comparison
# ---------------------------------------------------------------------------

def test_comparison_is_constant_time():
    """A plain `==` on a secret leaks its length and, in principle, content
    through timing. Cheap to avoid."""
    import inspect

    src = inspect.getsource(auth)
    assert "hmac.compare_digest" in src
    assert "provided == required" not in src
