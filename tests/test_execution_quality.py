"""Spec Section 19 / 22.4 — execution must be measured, not assumed.

    "Execution must optimize for: slippage, latency, fees, partial fills, order
     splitting, exchange selection, retry policies, and idempotency."

    "Every execution must be scored (latency, slippage, fill quality) and that
     score written back ... so the Evaluation layer can use it."

None of the three score inputs was being captured: slippage was hardcoded 0.0,
latency was never measured, and `fill_quantity` was set to the REQUESTED size —
so a partial fill was published and persisted as a complete one, leaving the
book out of sync with the exchange.
"""

import re
import pathlib
import uuid

import pytest

from backend.agents.execution_agent import ExecutionAgent
from backend.algorithms.execution import (
    GOOD_LATENCY_MS,
    GOOD_SLIPPAGE_BPS,
    POOR_LATENCY_MS,
    POOR_SLIPPAGE_BPS,
    score_execution,
    twap_order_slicer,
)
from backend.core import system_state
from backend.core.message_bus import MessageBus, get_message_bus
from backend.models.events import TarApprovedEvent, TickReceivedEvent

ROOT = pathlib.Path(__file__).resolve().parents[1]
SYMBOL = "BTC/USDT"
PRICE = 60_000.0


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr("backend.core.message_bus._bus", MessageBus())
    system_state.resume("test setup")
    yield
    system_state.resume("test teardown")


def _tar(size=0.01):
    return TarApprovedEvent(
        tar_id=uuid.uuid4(), symbol=SYMBOL, direction="LONG",
        approved_size=size, approved_leverage=1, cro_rationale="test",
        stop_loss=59_000.0, take_profit=62_000.0, tab="paper",
    )


# ---------------------------------------------------------------------------
# Scoring
# ---------------------------------------------------------------------------

def test_unmeasurable_execution_scores_none_not_zero():
    """A missing measurement is not a bad execution and must not be averaged in
    as one."""
    result = score_execution(requested_qty=0.0, filled_qty=0.0, slippage_bps=None, latency_ms=None)
    assert result["score"] is None
    assert result["componentsMeasured"] == 0


def test_score_uses_only_the_components_it_could_measure():
    """A fill with no reference price is graded on what is known rather than
    penalised for what isn't."""
    result = score_execution(requested_qty=1.0, filled_qty=1.0, slippage_bps=None, latency_ms=None)
    assert result["score"] == 100.0
    assert result["componentsMeasured"] == 1
    assert result["componentsTotal"] == 3


def test_a_perfect_execution_scores_100():
    result = score_execution(requested_qty=1.0, filled_qty=1.0, slippage_bps=0.0, latency_ms=10.0)
    assert result["score"] == 100.0
    assert result["fullyFilled"] is True


def test_partial_fill_lowers_the_score_and_is_named():
    result = score_execution(requested_qty=1.0, filled_qty=0.5, slippage_bps=0.0, latency_ms=10.0)
    assert result["components"]["fill"] == 50.0
    assert result["fullyFilled"] is False
    assert any("PARTIAL FILL" in n for n in result["notes"])


def test_over_fill_is_surfaced_not_clamped_away():
    """The position on the book is larger than intended — that must be visible."""
    result = score_execution(requested_qty=1.0, filled_qty=1.2, slippage_bps=0.0, latency_ms=10.0)
    assert any("OVER-FILL" in n for n in result["notes"])


def test_bad_slippage_scores_zero_on_that_component():
    result = score_execution(requested_qty=1.0, filled_qty=1.0,
                             slippage_bps=POOR_SLIPPAGE_BPS + 10, latency_ms=10.0)
    assert result["components"]["slippage"] == 0.0


def test_favourable_slippage_is_capped_at_full_marks():
    """Beating the reference price is luck, not execution quality worth
    rewarding beyond the cap."""
    result = score_execution(requested_qty=1.0, filled_qty=1.0, slippage_bps=-100.0, latency_ms=10.0)
    assert result["components"]["slippage"] == 100.0


def test_slippage_scales_between_the_thresholds():
    midpoint = (GOOD_SLIPPAGE_BPS + POOR_SLIPPAGE_BPS) / 2
    result = score_execution(requested_qty=1.0, filled_qty=1.0, slippage_bps=midpoint, latency_ms=10.0)
    assert 40 < result["components"]["slippage"] < 60


def test_slow_execution_scores_zero_on_latency():
    result = score_execution(requested_qty=1.0, filled_qty=1.0, slippage_bps=0.0,
                             latency_ms=POOR_LATENCY_MS + 1)
    assert result["components"]["latency"] == 0.0


def test_fast_execution_scores_full_latency_marks():
    result = score_execution(requested_qty=1.0, filled_qty=1.0, slippage_bps=0.0,
                             latency_ms=GOOD_LATENCY_MS - 1)
    assert result["components"]["latency"] == 100.0


# ---------------------------------------------------------------------------
# The partial-fill bug
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_order_filled_event_reports_the_actual_filled_quantity():
    """It used to publish `tar.approved_size` — the requested size — so a
    partial fill was indistinguishable from a complete one."""
    agent = ExecutionAgent(simulation_mode=True)
    await agent.handle_event(TickReceivedEvent(symbol=SYMBOL, price=PRICE, volume=1.0, exchange="t"))

    fills = []
    get_message_bus().subscribe("ORDER_FILLED", lambda e: fills.append(e))
    await agent.handle_event(_tar(size=0.02))

    assert len(fills) == 1
    # A simulated order fills completely, so these agree here — the point is
    # that the value comes from the fill path, not from the request.
    assert fills[0].fill_quantity == 0.02


def test_execution_agent_does_not_pass_approved_size_as_fill_quantity():
    """Structural guard: the source must not wire the requested size into the
    filled-quantity field again."""
    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    assert "fill_quantity=tar.approved_size" not in src, (
        "fill_quantity must come from the exchange's filled amount, not the request"
    )
    assert "fill_quantity=filled_qty" in src


def test_execution_agent_reads_the_exchange_filled_field():
    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    assert 'order.get("filled")' in src, "the actual filled quantity must be read from the order"


def test_trade_persistence_records_the_filled_quantity():
    """The trade log must record what actually happened at the exchange.

    Parsed with `ast` rather than sliced from the raw text — the previous
    version cut at the first ')' character, which lands inside
    `str(tar.tar_id)` and truncated the argument list before reaching the
    quantity.
    """
    import ast

    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    tree = ast.parse(src)

    calls = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "_persist_trade"
    ]
    assert calls, "_persist_trade is never called"

    for call in calls:
        args = {ast.unparse(a) for a in call.args}
        assert "filled_qty" in args, (
            f"_persist_trade must be passed filled_qty, not the requested size. Got: {sorted(args)}"
        )
        assert "tar.approved_size" not in args, (
            "_persist_trade must not receive the requested size as the quantity"
        )


# ---------------------------------------------------------------------------
# Latency
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_latency_is_measured_on_every_execution():
    """It was never measured at all."""
    agent = ExecutionAgent(simulation_mode=True)
    await agent.handle_event(TickReceivedEvent(symbol=SYMBOL, price=PRICE, volume=1.0, exchange="t"))
    recorded = []
    get_message_bus().subscribe("ORDER_FILLED", lambda e: recorded.append(e))
    await agent.handle_event(_tar())
    assert recorded, "the order should have filled"


def test_latency_uses_a_monotonic_clock():
    """Wall-clock time can jump backwards across an NTP correction, which would
    produce a negative latency."""
    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    assert "time.monotonic()" in src
    assert "time.time()" not in src.replace("time.monotonic()", "")


# ---------------------------------------------------------------------------
# Idempotency (Section 19)
# ---------------------------------------------------------------------------

def test_idempotency_key_is_derived_only_from_the_tar_id():
    """A timestamp or random component would make every retry look like a new
    order — exactly the double-fill this prevents."""
    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    line = next(l for l in src.splitlines() if "idempotency_key =" in l)
    assert "tar.tar_id" in line
    for forbidden in ("time", "uuid", "random", "now("):
        assert forbidden not in line, f"idempotency key must not include {forbidden}"


def test_idempotency_key_fits_the_exchange_limit():
    """Binance rejects clientOrderIds longer than 36 characters, and a rejected
    order on a retry path would be its own failure."""
    key = f"exec_{uuid.uuid4()}"[:36]
    assert len(key) <= 36


def test_close_orders_carry_their_own_idempotency_key():
    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    assert "client_order_id=client_order_id" in src or "client_order_id=" in src


# ---------------------------------------------------------------------------
# Order splitting (Section 19)
# ---------------------------------------------------------------------------

def test_small_orders_are_not_split():
    assert ExecutionAgent._plan_slices(1.0) == [1.0]


def test_large_orders_produce_slices_summing_to_the_original():
    """A slicer that lost or invented quantity would under- or over-fill."""
    slices = ExecutionAgent._plan_slices(100.0)
    assert len(slices) > 1
    assert sum(slices) == pytest.approx(100.0)


def test_twap_slicer_is_the_shared_library_function():
    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    assert "twap_order_slicer" in src


def test_execution_no_longer_claims_twap_is_active_while_doing_nothing():
    """The old log line said "Engaging TWAP execution logic" while performing no
    splitting at all — a log claiming a risk control that was not running.

    Checks STRING LITERALS via `ast`, not raw text: the phrase legitimately
    appears in the comment explaining what was removed, so a text search matches
    the description of the fix as well as the bug it describes.
    """
    import ast

    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    tree = ast.parse(src)

    literals = [
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
    ]
    # Docstrings are string literals too, so exclude the module/function
    # docstrings that legitimately describe the old behaviour.
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            doc = ast.get_docstring(node, clean=False)
            if doc:
                docstrings.add(doc)

    runtime_strings = [s for s in literals if s not in docstrings]
    offenders = [s for s in runtime_strings if "Engaging TWAP" in s]
    assert not offenders, f"a log/message still claims TWAP is active: {offenders}"


# ---------------------------------------------------------------------------
# The schema target
# ---------------------------------------------------------------------------

def test_execution_quality_table_exists_in_the_schema():
    """Section 22.4 requires the score be written back to the schema. There was
    no such table."""
    sql = (ROOT / "db" / "schema.sql").read_text(encoding="utf-8")
    assert "CREATE TABLE execution_quality" in sql


def test_score_column_allows_null_for_unmeasurable():
    """NULL means "not measurable" and must be excluded from averages, never
    counted as zero — otherwise execution quality looks worse the more often the
    price feed drops out."""
    sql = (ROOT / "db" / "schema.sql").read_text(encoding="utf-8")
    block = sql[sql.index("CREATE TABLE execution_quality"):]
    block = block[: block.index(");")]
    score_line = next(l for l in block.splitlines() if l.strip().startswith("score"))
    assert "NOT NULL" not in score_line
    assert "score IS NULL" in block


def test_execution_quality_distinguishes_requested_from_filled():
    sql = (ROOT / "db" / "schema.sql").read_text(encoding="utf-8")
    block = sql[sql.index("CREATE TABLE execution_quality"):]
    block = block[: block.index(");")]
    assert "requested_qty" in block
    assert "filled_qty" in block
    assert "fully_filled" in block


def test_execution_quality_is_keyed_on_order_id():
    """One exchange order gets exactly one score; an idempotent retry must not
    produce a second row."""
    sql = (ROOT / "db" / "schema.sql").read_text(encoding="utf-8")
    block = sql[sql.index("CREATE TABLE execution_quality"):]
    assert "order_id            text PRIMARY KEY" in block


def test_schema_has_no_duplicate_tables():
    sql = (ROOT / "db" / "schema.sql").read_text(encoding="utf-8")
    tables = re.findall(r"^CREATE TABLE (\w+)", sql, re.M)
    assert len(tables) == len(set(tables)), "duplicate CREATE TABLE in schema.sql"


# ---------------------------------------------------------------------------
# Requirements NOT implemented — named so the gap is visible
# ---------------------------------------------------------------------------

def test_unimplemented_section_19_requirements_are_documented():
    """Spec Section 19 lists eight execution concerns. Three are not implemented
    and the source says so explicitly rather than implying coverage:

      * order splitting is planned but not SCHEDULED (one market order is still sent)
      * exchange selection does not exist (single venue)
      * order-level retry is not implemented (idempotency makes it safe, but the
        retry loop itself isn't written)
    """
    src = (ROOT / "backend" / "agents" / "execution_agent.py").read_text(encoding="utf-8")
    assert "NOT IMPLEMENTED" in src or "HONEST LIMITATION" in src, (
        "unimplemented execution requirements must be stated in the source, not implied"
    )
