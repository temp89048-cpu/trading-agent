"""Graph runtime — checkpointer, thread ids, node wrapping, error handling.

Covers spec Section 6's "LangGraph Runtime / Checkpointer / Error Handling"
deliverables and Section 39.1-39.4.

SECTION 39.1 — DURABLE FROM DAY ONE, AND A DELIBERATE THREAD SCHEME
-------------------------------------------------------------------
    "Use a durable backend — PostgresSaver or a Redis-backed saver — not the
     in-memory default, from day one of Phase 23. Design your thread_id scheme
     deliberately: one thread per open position (for the monitoring graph) and
     one thread per decision cycle (for the trade-decision graph), not one giant
     thread for the whole system."

Both are implemented: SQLite by default (durable across restart, no server), with
Postgres available; and `thread_id_for()` builds the scheme rather than leaving
each caller to invent one.

Why one giant thread would be wrong: LangGraph organises checkpoints per thread,
so a single thread makes every decision a continuation of the previous one. Two
unrelated symbols would share reasoning history, and resuming after a restart
would replay the wrong decision.

SECTION 39.3 — WHAT THE CHECKPOINTER DOES *NOT* GIVE US
-------------------------------------------------------
    "checkpointing gives you graph-state recovery, not full durable execution
     across side effects — if two processes try to resume the same thread_id
     after a crash, LangGraph has no built-in coordination to stop both from
     running."

This is the single most important caveat in Section 39, and it is why Section
36's three-plane split is load-bearing rather than decorative. Consequences
enforced here:

  * `ExecutionPlan.idempotency_basis` is derived from **decision identity**, not
    `thread_id`. Two processes resuming the same thread would produce the same
    basis and the exchange would reject the duplicate — whereas a thread-derived
    key plus a retry would look like two different orders.
  * The graph never places an order, so a double-resume can at worst produce two
    identical *requests*, which the deterministic execution plane deduplicates.

SECTION 39.4 — REPLAY SAFETY
----------------------------
    "node functions should avoid non-deterministic operations (wall-clock reads,
     random values, uncached external calls) directly in their body"

`market_data` is a write-once field (enforced in `contracts.py`), and the run's
`started_at` is stamped once by the runtime and read from state by nodes. A node
calling `time.time()` itself would get a different answer on replay.
"""

from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Dict, List, Optional

from backend.graphs.contracts import NodeContract, NodeContractViolation, validate_node_output
from backend.graphs.state import NodeError, TradingState, TriggerReason, new_state
from backend.graphs.tracing import NodeTrace, RunTrace, record_run
from backend.llm.budget import RunBudget

logger = logging.getLogger(__name__)

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHECKPOINT_DIR = os.path.join(_ROOT, ".data")
SQLITE_CHECKPOINT_PATH = os.path.join(CHECKPOINT_DIR, "graph_checkpoints.sqlite")


# ---------------------------------------------------------------------------
# Thread ids (Section 39.1)
# ---------------------------------------------------------------------------

def thread_id_for(graph: str, scope: str) -> str:
    """Build a thread id.

    `scope` is what makes the thread meaningful, and it differs by graph:

      * monitoring graph  -> one thread per OPEN POSITION, so a position's
        reasoning history survives a restart and resumes for that position only
      * trade-decision    -> one thread per DECISION CYCLE, so two decisions
        never share state
      * reflection        -> one thread per CLOSED TRADE

    Never one thread for the whole system: that would make every decision a
    continuation of the last, and a resume would replay the wrong one.
    """
    if not graph or not scope:
        raise ValueError("thread_id requires both a graph name and a scope")
    return f"{graph}:{scope}"


# ---------------------------------------------------------------------------
# Checkpointer (Section 39.1)
# ---------------------------------------------------------------------------

def build_checkpointer(kind: Optional[str] = None):
    """Return a durable ASYNC checkpointer context manager, or None.

    ASYNC IS NOT A PREFERENCE HERE — IT IS REQUIRED.
    The synchronous `SqliteSaver` raises `NotImplementedError` the moment a graph
    is driven with `ainvoke`:

        NotImplementedError: The SqliteSaver does not support async methods.

    Every agent in this backend is async and FastAPI drives everything on an
    event loop, so `ainvoke` is the only realistic call path. A sync saver would
    have worked in a synchronous unit test and failed on the first real run —
    which is exactly how it was caught here.

    Returns the CONTEXT MANAGER unentered, so a long-lived app can hold one
    connection open for its whole life rather than opening one per graph run.
    Callers use `async with`.

    Default is SQLite: durable across a restart with no server to run, which is
    what makes Section 39.1's "durable from day one" achievable rather than a
    step deferred until Postgres is set up.

    Returns None rather than falling back to `MemorySaver`. An in-memory
    checkpointer looks identical in tests and silently loses every graph's state
    on restart — for the monitoring graph that means losing an open position's
    reasoning history, exactly the failure Section 39.1 warns about. Explicit
    None makes the caller decide.
    """
    choice = (kind or os.getenv("GRAPH_CHECKPOINTER") or "sqlite").strip().lower()

    if choice == "none":
        logger.warning(
            "GRAPH_CHECKPOINTER=none — graph state will NOT survive a restart. A "
            "monitoring graph run interrupted by a restart will lose its reasoning "
            "history for that position."
        )
        return None

    if choice == "sqlite":
        try:
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

            os.makedirs(CHECKPOINT_DIR, exist_ok=True)
            return AsyncSqliteSaver.from_conn_string(SQLITE_CHECKPOINT_PATH)
        except Exception as e:
            logger.error(
                "Could not build the async SQLite checkpointer (%s). Requires the "
                "aiosqlite package.",
                e,
            )
            return None

    if choice == "postgres":
        try:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver

            from backend.core.config import settings

            return AsyncPostgresSaver.from_conn_string(settings.DATABASE_URL)
        except Exception as e:
            logger.error(
                "Could not build the async Postgres checkpointer (%s). Install "
                "langgraph-checkpoint-postgres and ensure DATABASE_URL is reachable.",
                e,
            )
            return None

    logger.error("Unknown GRAPH_CHECKPOINTER=%r; no checkpointer configured.", choice)
    return None


# ---------------------------------------------------------------------------
# Node wrapping — contract enforcement + error handling + budget
# ---------------------------------------------------------------------------

@dataclass
class RunContext:
    """Per-run objects the wrapper needs but the state should not carry.

    The budget and trace live here rather than in `TradingState` because they
    are not reasoning inputs — putting them in state would send them through the
    checkpointer on every superstep, and a node could then read its own budget
    and change behaviour based on it.
    """

    run_id: str
    graph: str
    budget: RunBudget
    trace: RunTrace


def wrap_node(
    contract: NodeContract,
    fn: Callable[[TradingState], Any],
    ctx: RunContext,
) -> Callable[[TradingState], Any]:
    """Wrap a node with contract validation, error capture and tracing.

    ERROR HANDLING (spec Section 6's deliverable): a node that raises does NOT
    abort the run. The failure is recorded into `state['errors']` and the graph
    continues, so a broken sentiment node cannot prevent the risk checks from
    running or a position from being monitored.

    The one exception is `NodeContractViolation`, which re-raises. A contract
    breach means the safety model was bypassed rather than that data was bad, and
    continuing a run whose node just wrote outside its permissions would be
    trusting state that is no longer known to be sound.
    """

    async def wrapped(state: TradingState) -> Dict[str, Any]:
        started = time.monotonic()
        node_trace = NodeTrace(node=contract.name, started_at=time.time(), duration_ms=0.0)

        try:
            result = fn(state)
            # Support both sync and async node functions. Nodes wrapping existing
            # async agents need await; pure-computation nodes should not be
            # forced to be async for no reason.
            if hasattr(result, "__await__"):
                result = await result

            delta = validate_node_output(contract, result, state)

            node_trace.wrote = sorted(k for k in delta if k not in
                                      {"errors", "unavailable", "nodes_visited"})
            node_trace.duration_ms = (time.monotonic() - started) * 1000.0
            ctx.trace.nodes.append(node_trace)

            # Appended by the runtime, not the node: a node should not have to
            # remember to record that it ran, and one that crashed still needs
            # to appear in the visited list.
            delta.setdefault("nodes_visited", [])
            if contract.name not in delta["nodes_visited"]:
                delta["nodes_visited"] = list(delta["nodes_visited"]) + [contract.name]

            return delta

        except NodeContractViolation:
            node_trace.duration_ms = (time.monotonic() - started) * 1000.0
            node_trace.error = "contract violation"
            ctx.trace.nodes.append(node_trace)
            # Re-raised deliberately — see the docstring.
            raise

        except Exception as e:
            node_trace.duration_ms = (time.monotonic() - started) * 1000.0
            node_trace.error = str(e)
            ctx.trace.nodes.append(node_trace)
            ctx.trace.errors.append(f"{contract.name}: {e}")

            logger.error(
                "Graph node '%s' failed in run %s: %s. The run continues degraded.",
                contract.name, ctx.run_id, e,
            )
            # Degrade, don't abort.
            return {
                "errors": [NodeError(node=contract.name, error=str(e))],
                "unavailable": [f"{contract.name} (errored: {e})"],
                "nodes_visited": [contract.name],
            }

    return wrapped


# ---------------------------------------------------------------------------
# Run construction
# ---------------------------------------------------------------------------

def start_run(
    graph: str,
    symbol: str,
    trigger: TriggerReason,
    thread_scope: str,
    budget: Optional[RunBudget] = None,
) -> tuple[TradingState, RunContext, str]:
    """Build the initial state, run context and thread id for one run.

    `started_at` is stamped HERE, once, and nodes read it from state. Section
    39.4: a node calling `time.time()` in its own body would get a different
    answer on replay, so a resumed run's "how long have we held this" would
    change between the original and the replay.
    """
    run_id = uuid.uuid4().hex
    started_at = time.time()
    thread_id = thread_id_for(graph, thread_scope)

    state = new_state(run_id=run_id, symbol=symbol, trigger=trigger, started_at=started_at)

    trace = RunTrace(
        run_id=run_id,
        graph=graph,
        symbol=symbol,
        thread_id=thread_id,
        trigger=f"{trigger.kind}: {trigger.detail}",
        started_at=started_at,
    )
    ctx = RunContext(
        run_id=run_id,
        graph=graph,
        budget=budget or RunBudget(),
        trace=trace,
    )
    return state, ctx, thread_id


def finish_run(
    ctx: RunContext,
    final_state: Optional[TradingState],
    outcome: str = "completed",
    no_decision_reason: Optional[str] = None,
    produces_decision: bool = True,
) -> RunTrace:
    """Close out a run and persist its trace.

    `no_decision_reason` is the field that answers "why did nothing trade?".
    Filled from the state's `unavailable` list when the caller did not supply
    one, so a run that produced no decision always says why rather than simply
    ending.

    `produces_decision=False` for graphs whose job is not to decide.

    Not every graph decides. The Market State graph (Phase 24) produces market
    state; the Reflection graph produces a lesson. Auto-filling
    "no decision produced" for those labelled a completely successful run as
    though something had gone wrong — which is exactly the kind of misleading
    trace that makes an operator distrust the trace store. A graph that never
    decides gets no reason, because there is nothing to explain.
    """
    ctx.trace.finished_at = time.time()
    ctx.trace.outcome = outcome
    ctx.trace.llm_budget = ctx.budget.summary()

    if final_state is not None:
        ctx.trace.unavailable = list(final_state.get("unavailable") or [])
        errs = final_state.get("errors") or []
        ctx.trace.errors.extend(
            f"{e.node}: {e.error}" for e in errs
            if f"{e.node}: {e.error}" not in ctx.trace.errors
        )

        decided = final_state.get("decision") is not None
        if produces_decision and not decided and no_decision_reason is None:
            unavailable = ctx.trace.unavailable
            no_decision_reason = (
                f"no decision produced; unevaluated inputs: {', '.join(unavailable)}"
                if unavailable
                else "no decision produced and no input was reported unavailable"
            )

    ctx.trace.no_decision_reason = no_decision_reason
    record_run(ctx.trace)
    return ctx.trace


# ---------------------------------------------------------------------------
# Streaming — spec Section 39.5
#
#     "LangGraph supports streaming state updates, node transitions, and LLM
#      tokens as they happen. For a trading dashboard this matters more than in
#      most agent applications — 'the AI is currently in multi_agent_analysis,
#      4 of 6 specialists reporting' is exactly the kind of live visibility that
#      makes a 24/7 autonomous system trustworthy to watch, versus a black box
#      that occasionally reports a trade after the fact."
#
# The only item of Section 39 that was missing. `run_*_graph` uses `ainvoke`, which
# returns once at the end — so a 19-node run with network I/O and a model call is
# opaque for its whole duration.
#
# STREAMING IS A SEPARATE FUNCTION, NOT A FLAG ON THE EXISTING RUNNERS.
# `ainvoke` and `astream` return different things (a final state versus a sequence of
# updates), so one function doing both would return a union type that every caller
# has to branch on. The trace and the final state are identical either way — this
# changes observability, not behaviour.
# ---------------------------------------------------------------------------

async def stream_run(
    graph: Any,
    state: "TradingState",
    config: Optional[Dict[str, Any]] = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Yield one progress event per node as a compiled graph executes.

    Each event is `{node, progress, total, state_keys, unavailable_count}` — enough
    for a dashboard to say which stage is running and how far along it is, without
    shipping the whole state on every superstep. The state is large (candles, findings,
    a portfolio snapshot) and streaming it per node would push megabytes over a
    WebSocket for a 19-node run.

    Never raises on a node failure. `wrap_node` already converts a node exception into
    an `errors` entry and lets the run continue, so a stream that aborted on the first
    failure would be less informative than the run it is watching.
    """
    total: Optional[int] = None
    try:
        total = len(getattr(graph, "nodes", {}) or {}) or None
    except Exception:  # noqa: BLE001
        total = None

    seen = 0
    try:
        async for update in graph.astream(state, config=config):
            # `astream` in updates mode yields {node_name: state_delta} per superstep.
            # A parallel superstep yields several keys at once, which is why `progress`
            # counts nodes rather than supersteps.
            if not isinstance(update, dict):
                continue
            for node, delta in update.items():
                seen += 1
                payload: Dict[str, Any] = {
                    "node": node,
                    "progress": seen,
                    "total": total,
                    "wroteKeys": sorted(delta.keys()) if isinstance(delta, dict) else [],
                }
                if isinstance(delta, dict):
                    # Counts, not contents: an operator watching wants to know a node
                    # reported something unavailable, and the detail is in the trace.
                    payload["unavailableCount"] = len(delta.get("unavailable") or [])
                    payload["errorCount"] = len(delta.get("errors") or [])
                yield payload
    except Exception as e:  # noqa: BLE001
        # The run itself may still have completed; only the stream broke. Yielded as a
        # final event rather than raised, so a dashboard shows "streaming stopped"
        # instead of the connection simply dying.
        logger.error("Graph stream interrupted: %s", e)
        yield {"node": None, "progress": seen, "total": total, "streamError": str(e)}
