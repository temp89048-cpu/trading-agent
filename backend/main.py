from fastapi import FastAPI
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from backend.api import (
    market, exchange, ai, knowledge, memory, research, execution, monitoring,
    dashboard, admin, agents as agents_api, missions, graphs as graphs_api,
    polymarket as polymarket_api, catalog as catalog_api,
)
from backend.core.agent_os import get_agent_os
from backend.agents.trading_agent import register_trading_agent
from backend.agents.research_agent import register_research_agent
from backend.agents.event_agent import register_event_agent
from backend.services.live_market_data import start_live_data_feed

from backend.agents.market_intelligence import get_market_intelligence_agent
from backend.agents.portfolio_agent import get_portfolio_agent
from backend.agents.reflection_agent import get_reflection_agent
from backend.agents.execution_agent import get_execution_agent
from backend.agents.ceo_agent import get_ceo_agent
from backend.agents.cio_agent import get_cio_agent
from backend.agents.cro_agent import get_cro_agent
from backend.agents.supervisor_agent import get_supervisor
from backend.agents.debate_agent import get_debate_agent
from backend.agents.hypothesis_agent import get_hypothesis_agent
from backend.agents.position_monitor import get_position_monitor
from backend.agents.confidence_agent import get_confidence_agent
from backend.agents.simulation_agent import get_simulation_agent
from backend.core.db import init_db, close_db
from backend.graphs.runtime import build_checkpointer
from backend.graphs.analysis import subscribe_to_triggers as subscribe_analysis_to_triggers
from backend.services.execution_service import (
    execution_enabled,
    subscribe_to_plans as subscribe_execution_to_plans,
)
from backend.workers.curiosity_worker import get_curiosity_worker
from backend.workers.position_worker import (
    get_position_worker,
    monitoring_enabled as position_monitoring_enabled,
)
from backend.workers.monitor_worker import get_monitor_worker
from backend.workers.trigger_worker import get_trigger_worker

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

# Keep references so event-driven agents aren't garbage collected
_active_base_agents = {}

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize database pool
    await init_db()
    
    # Register agents
    register_trading_agent()
    register_research_agent()
    register_event_agent()
    
    # Instantiate BaseAgents.
    # CEO and CIO were the only two links in spec Section 4's chain of command
    # (CEO -> CIO -> CRO -> Research -> Supervisor -> ...) with no
    # implementation. They own the two portfolio-level controls the CRO could
    # not: the drawdown killswitch and the correlated-exposure cap.
    _active_base_agents['ceo'] = get_ceo_agent()
    _active_base_agents['cio'] = get_cio_agent()
    _active_base_agents['market_intelligence'] = get_market_intelligence_agent()
    _active_base_agents['portfolio'] = get_portfolio_agent()
    _active_base_agents['reflection'] = get_reflection_agent()
    _active_base_agents['execution'] = get_execution_agent()
    _active_base_agents['cro'] = get_cro_agent()
    _active_base_agents['supervisor'] = get_supervisor()
    _active_base_agents['debate'] = get_debate_agent()
    _active_base_agents['confidence'] = get_confidence_agent()
    _active_base_agents['simulation'] = get_simulation_agent()

    # The "Monitor" stage of spec Section 6's chain. Without it the pipeline
    # could open a position and nothing ever closed one: the approved
    # stop-loss reached the Execution Engine, got logged, and no component
    # compared price against it. It also produces POSITION_CLOSED, which the
    # CEO (equity tracking) and Reflection (learning) both consume and which
    # previously had no publisher at all.
    monitor = get_position_monitor()
    # Wired to the Execution Engine rather than the exchange, so closes still
    # pass through the single gateway (spec Section 8) while remaining ungated
    # by pause/emergency-stop (CLAUDE.md invariant 4).
    monitor.attach_execution(_active_base_agents['execution'])
    _active_base_agents['position_monitor'] = monitor

    # Closes spec Section 12's pipeline. REFLECTION_COMPLETED was published and
    # consumed by nobody, so learning ended at "a lesson was written to a file".
    # This agent turns each reflection into a proposed hypothesis, a validation
    # plan and queued research tasks — none of which affect live trading.
    _active_base_agents['hypothesis'] = get_hypothesis_agent()

    # Register every event-driven agent with the AgentOS kernel.
    #
    # There were two disjoint registries: these nine BaseAgents lived only in
    # the dict above, while just the three tick-based agents called
    # get_agent_os().register(). So /api/monitoring, /api/ai/agents and the
    # frontend's AgentOSPanel all reported 3 agents out of 12 — the CRO and
    # the Supervisor among the nine that were invisible to health monitoring.
    # If one of them had died, no dashboard would have shown it.
    for agent in _active_base_agents.values():
        agent.register_with_kernel()
    logger.info("Registered %d event-driven agents with the AgentOS kernel", len(_active_base_agents))

    # Bridge every bus event to the dashboard WebSocket. Started here rather
    # than via @router.on_event("startup"), which does not fire on an
    # APIRouter — the previous placement meant the bridge never ran.
    dashboard.start_event_bridge()

    # Start the live market data feed
    live_data_task = asyncio.create_task(start_live_data_feed())

    # Spec Sections 14 and 15. Both workers existed with fully mocked cycle
    # bodies AND were never started from here, so neither loop ran at all.
    monitor_worker = get_monitor_worker()
    curiosity_worker = get_curiosity_worker()

    # Phase 31 / LangGraph spec Section 14 — event triggers.
    #
    # Started BEFORE any reasoning graph exists, deliberately. The AgentOS
    # scheduler ticks every 3s; wiring graph runs to that tick without a trigger
    # layer would mean ~28,800 model calls a day per symbol. The cheap gate has
    # to exist before the expensive thing it gates.
    #
    # This worker publishes TRIGGER_FIRED and starts no graph runs itself, so it
    # is inert until Phase 24 subscribes a graph to that event.
    trigger_worker = get_trigger_worker()

    # Phases 24 + 25 + 26 / LangGraph spec Sections 7, 8 and 9 — Graph 2, the
    # Trade Analysis graph. It CONTAINS the five market-state nodes and the four
    # opportunity nodes, then fans out to seven specialists and a debate.
    #
    # Only this one is subscribed. Neither `market_state.subscribe_to_triggers()`
    # nor `opportunity.subscribe_to_triggers()` is called: this graph already runs
    # all nine of their stages, so subscribing more than one would execute them
    # several times per trigger for one usable result.
    #
    # Subscribed to TRIGGER_FIRED, NOT to the 3s AgentOS tick. A run happens when
    # a market condition actually changed — the whole point of Section 14 being
    # built before this.
    #
    # No checkpointer is passed. These runs are short and have nothing to resume;
    # checkpointing would write a row per trigger for state no one reads. The
    # monitoring graph (Phase 30) is where durability earns its cost, because a
    # position's reasoning genuinely must survive a restart.
    subscribe_analysis_to_triggers()

    # Phase 29 / LangGraph spec Section 12 — the Execution Service.
    #
    #   LangGraph -> ExecutionRequest -> Risk Gateway -> Execution Service
    #             -> Exchange -> Order Confirmation -> Event Bus -> Monitoring
    #
    # Lives in services/, NOT graphs/, because it is the one component in this
    # chain permitted to reach the execution chokepoint — and `FORBIDDEN_IMPORTS`
    # means no module under graphs/ can.
    #
    # The ExecutionAgent is INJECTED rather than imported by the service, so the
    # service stays testable with a double and has no import-time dependency on
    # the agent singleton.
    #
    # TWO INDEPENDENT GATES sit below this subscription and both default to off:
    #   GRAPH_EXECUTION_ENABLED  — off, the service validates, quantises and
    #                              records a receipt but publishes no TAR, so the
    #                              whole chain is observable without a graph run
    #                              being able to submit anything.
    #   LIVE_TRADING             — off, the ExecutionAgent is in simulation mode
    #                              and makes no exchange calls at all.
    #
    # Closes deliberately ignore the first flag: a flag that gated exits would
    # trap the operator in positions while it was off (invariant 4).
    subscribe_execution_to_plans(_active_base_agents['execution'])
    logger.info(
        "Execution service wired. GRAPH_EXECUTION_ENABLED=%s — graph runs %s submit "
        "TARs; closes are always routed regardless.",
        execution_enabled(),
        "CAN" if execution_enabled() else "CANNOT",
    )

    # Phase 30 / LangGraph spec Section 13 — Position Monitoring (Graph 4).
    #
    # THE FIRST GRAPH THAT CHECKPOINTS. Graphs 1-3 pass checkpointer=None on
    # purpose: their runs are seconds long and have nothing to resume. A POSITION
    # exists across restarts, and the reasoning about it is the record of why it is
    # still open — so the thread is keyed on the position and a restart resumes it
    # rather than forming a fresh opinion.
    #
    # The context manager is entered ONCE here and held for the app's lifetime, so
    # one SQLite connection serves every monitoring run instead of one per run.
    # `build_checkpointer` returns None rather than falling back to MemorySaver — an
    # in-memory checkpointer for durability across restarts is a contradiction — so
    # a None here means monitoring runs without persistence and says so.
    checkpointer_cm = build_checkpointer()
    checkpointer = None
    if checkpointer_cm is not None:
        checkpointer = await checkpointer_cm.__aenter__()
        await checkpointer.setup()
        logger.info("Monitoring checkpointer ready (%s).", type(checkpointer).__name__)
    else:
        logger.warning(
            "No durable checkpointer available — position monitoring will run "
            "WITHOUT persistence, so a restart loses each position's reasoning "
            "history. Stop-loss enforcement is unaffected."
        )

    # A SEPARATE worker from monitor_worker, which documents itself as reporting
    # only: "two loops that can both act on the same position will eventually act
    # twice on it." This is the single driver of Graph 4.
    #
    # POSITION_MONITORING_ENABLED defaults to false. Off, the graph still runs and
    # every decision is logged in full; only the action is withheld. Stop-loss
    # enforcement is never gated by it — that lives in PositionMonitorAgent and runs
    # on every tick.
    position_worker = get_position_worker()
    position_worker.attach(monitor_agent=monitor, checkpointer=checkpointer)
    logger.info(
        "Position monitoring wired. POSITION_MONITORING_ENABLED=%s — decisions %s "
        "be applied.",
        position_monitoring_enabled(),
        "WILL" if position_monitoring_enabled() else "will NOT",
    )

    worker_tasks = [
        asyncio.create_task(monitor_worker.start()),
        asyncio.create_task(curiosity_worker.start()),
        asyncio.create_task(trigger_worker.start()),
        asyncio.create_task(position_worker.start()),
    ]

    # Phase 36 — Polymarket poller. Started ONLY when the feature is enabled.
    #
    # Gated rather than started-and-idle for a concrete reason: an always-running
    # worker that no-ops still holds a task, still logs a cycle, and still appears in
    # whatever an operator reads to see what the process is doing. A feature that is
    # off should be ABSENT, not quietly present. `run_cycle` re-checks the flag
    # itself, so a change while running is honoured either way.
    polymarket_worker = None
    polymarket_stream = None
    from backend.core.config import settings as _settings

    if _settings.POLYMARKET_ENABLED:
        from backend.workers.polymarket_worker import (
            get_polymarket_stream,
            get_polymarket_worker,
        )

        polymarket_worker = get_polymarket_worker()
        worker_tasks.append(asyncio.create_task(polymarket_worker.start()))

        # Phase 32b. The stream is STARTED, not appended to `worker_tasks`: it owns
        # one task per followed outcome internally, and `start()` returns once they
        # are launched. Cancelling a single wrapper task would leave those children
        # running.
        polymarket_stream = get_polymarket_stream()
        await polymarket_stream.start()
        logger.info(
            "Polymarket poller started — READ-ONLY market data. It cannot place an "
            "order on any venue and decides nothing: it stores signals that two "
            "SUPPLEMENTARY specialists read, at weight 1.0 of 8.0 panel weight."
        )
    else:
        logger.info(
            "Polymarket integration OFF (POLYMARKET_ENABLED=false). No poller, no "
            "specialists registered, and every confidence number is unchanged."
        )

    # Start the AgentOS loop when the server starts
    agent_os = get_agent_os()
    agent_os.start_scheduler(tick_ms=3000)
    yield
    # Clean up when the server stops
    agent_os.stop_scheduler()
    monitor_worker.stop()
    curiosity_worker.stop()
    trigger_worker.stop()
    position_worker.stop()
    if polymarket_worker is not None:
        polymarket_worker.stop()
    if polymarket_stream is not None:
        # Awaited, unlike the other workers' synchronous `stop()`: it cancels its own
        # child tasks and gathers them, so an un-awaited stop would let them log
        # "Task exception was never retrieved" at interpreter shutdown — which reads as
        # a crash during an otherwise clean stop.
        await polymarket_stream.stop()
    for task in worker_tasks:
        task.cancel()
    live_data_task.cancel()

    # Release the Polymarket HTTP session. Unconditional: the client is a lazily
    # built singleton, so closing when it was never opened is a no-op, and skipping
    # it on the disabled path would leak a session if anything else had touched it.
    try:
        from backend.services.polymarket_client import close_polymarket_client

        await close_polymarket_client()
    except Exception as e:
        logger.warning("Polymarket client did not close cleanly: %s", e)

    # Close the checkpointer connection LAST, after the workers that use it have
    # been told to stop. Closing it first would have an in-flight monitoring run
    # write to a closed SQLite connection.
    if checkpointer_cm is not None:
        try:
            await checkpointer_cm.__aexit__(None, None, None)
        except Exception as e:
            logger.warning("Checkpointer did not close cleanly: %s", e)

    # Close database pool
    await close_db()

app = FastAPI(title="Trading Agent API", lifespan=lifespan)

# ---------------------------------------------------------------------------
# CORS for the Next.js frontend.
#
# THIS WAS `["http://localhost:3000"]` AND THAT SINGLE ENTRY IS NOT ENOUGH.
#
# `http://localhost:3000` and `http://127.0.0.1:3000` are DIFFERENT ORIGINS to a
# browser. So an operator who opened the dashboard on 127.0.0.1 — which is what
# this project's own docs recommend for the backend, and what the Next dev server
# prints as an alternative — got a failed preflight on every call. Every page that
# reads the backend then rendered "backend unreachable" while the backend was
# running perfectly.
#
# That is the worst shape of bug for this app: the UI reports a data-source
# failure, so the natural response is to debug the backend, which is fine.
#
# Found by serving a production build on port 3100 and watching an OPTIONS
# preflight return 400 with no `access-control-allow-origin` header.
#
# `ALLOWED_ORIGINS` overrides the list entirely (comma-separated) for a real
# deployment. The defaults cover both hostnames on the two ports Next actually
# uses, and nothing wider — `allow_credentials=True` means `allow_origins=["*"]`
# is rejected by the CORS spec anyway, so a wildcard here would silently break
# every request rather than loosen anything.
# ---------------------------------------------------------------------------
_DEFAULT_ORIGINS = [
    f"http://{host}:{port}"
    for host in ("localhost", "127.0.0.1")
    for port in (3000, 3001, 3100)
]

_configured = os.getenv("ALLOWED_ORIGINS", "").strip()
_allowed_origins = (
    [o.strip() for o in _configured.split(",") if o.strip()]
    if _configured
    else _DEFAULT_ORIGINS
)

logger.info("CORS allowed origins: %s", ", ".join(_allowed_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(market.router, prefix="/api/market", tags=["Market API"])
app.include_router(exchange.router, prefix="/api/exchange", tags=["Exchange API"])
app.include_router(ai.router, prefix="/api/ai", tags=["AI API"])
app.include_router(knowledge.router, prefix="/api/knowledge", tags=["Knowledge API"])
app.include_router(memory.router, prefix="/api/memory", tags=["Memory API"])
app.include_router(research.router, prefix="/api/research", tags=["Research API"])
app.include_router(execution.router, prefix="/api/execution", tags=["Execution API"])
app.include_router(monitoring.router, prefix="/api/monitoring", tags=["Monitoring API"])
app.include_router(dashboard.router, prefix="/api/dashboard", tags=["Dashboard API"])
# Agent task store — the frontend's components/Agent.tsx targets
# /api/agents/tasks, which previously had no router mounted at all.
app.include_router(agents_api.router, prefix="/api/agents", tags=["Agents API"])
# Human-in-the-loop kill switch (pause / resume / emergency-stop).
app.include_router(admin.router, prefix="/api/admin", tags=["Admin API"])
app.include_router(missions.router, prefix="/api/missions", tags=["Missions API"])
# The LangGraph reasoning layer, exposed to the UI.
#
# Recommended_Technology_Stack.md layers 1-4 are Next.js / FastAPI / Python agents /
# LangGraph. The first three were connected; the fourth had NO API surface at all, so
# every decision the seven graphs produced was computed, traced to disk, and
# unreachable from the dashboard.
#
# Spec Section 39.5 asks for exactly this ("the AI is currently in
# multi_agent_analysis, 4 of 6 specialists reporting"), and Section 1 puts the UI at
# the top of the Agent OS rather than beside it.
#
# Read-only except POST /run/{symbol}, which is auth-gated and still cannot trade:
# it produces an inert ExecutionPlan that GRAPH_EXECUTION_ENABLED gates separately.
app.include_router(graphs_api.router, prefix="/api/graphs", tags=["LangGraph API"])

# Phase 37. Mounted unconditionally even though the FEATURE is flag-gated, and
# that is deliberate: the endpoints answer "is this feed contributing anything,
# and if not, why not?", and the most useful time to ask is when the answer is
# no. `POST /mappings/confirm` is also the only route in the codebase that passes
# `set_by_human=True` — without it, `confirm_mapping`'s refusal would be
# unreachable rather than enforced, and no mapping could ever be confirmed.
app.include_router(polymarket_api.router, prefix="/api/polymarket", tags=["Polymarket API"])

# The three read-only views the frontend brief listed as BLOCKED: orders,
# strategies and replay. The data was already in the process with no route to it.
# Nothing here decides anything and no endpoint accepts a write.
app.include_router(catalog_api.router, prefix="/api/catalog", tags=["Catalog API"])

# Original fallback health check removed, using dedicated router above
