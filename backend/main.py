from fastapi import FastAPI
from contextlib import asynccontextmanager
from fastapi.middleware.cors import CORSMiddleware
from backend.api import (
    market, exchange, ai, knowledge, memory, research, execution, monitoring,
    dashboard, admin, agents as agents_api, missions,
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
from backend.workers.curiosity_worker import get_curiosity_worker
from backend.workers.monitor_worker import get_monitor_worker

import asyncio
import logging

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
    worker_tasks = [
        asyncio.create_task(monitor_worker.start()),
        asyncio.create_task(curiosity_worker.start()),
    ]

    # Start the AgentOS loop when the server starts
    agent_os = get_agent_os()
    agent_os.start_scheduler(tick_ms=3000)
    yield
    # Clean up when the server stops
    agent_os.stop_scheduler()
    monitor_worker.stop()
    curiosity_worker.stop()
    for task in worker_tasks:
        task.cancel()
    live_data_task.cancel()
    
    # Close database pool
    await close_db()

app = FastAPI(title="Trading Agent API", lifespan=lifespan)

# Configure CORS to allow the Next.js frontend to talk to this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
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

# Original fallback health check removed, using dedicated router above
