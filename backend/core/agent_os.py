import time
from typing import Dict, List, Any, Optional, Set, Callable
# pyrefly: ignore [missing-import]
from pydantic import BaseModel, field_validator
import asyncio
import logging

logger = logging.getLogger(__name__)

# The only valid agent categories. These MUST match `AgentCategory` in
# lib/agentOS.ts, because the frontend's AgentOSPanel groups agents with
# `grouped.get(agent.descriptor.category)` and then does `if (group) push(...)`
# — so an agent whose category isn't in the union is silently dropped from the
# dashboard rather than shown under an "other" heading.
#
# That had already happened: event_agent used category="security" and
# research_agent used category="research", neither of which exists in the TS
# union, so both agents were invisible in the UI while reporting as healthy in
# the API. Validating here turns a silent disappearance into a loud error.
VALID_CATEGORIES = (
    "market-intelligence",
    "strategy",
    "risk",
    "execution",
    "learning",
    "orchestration",
)


class AgentDescriptor(BaseModel):
    id: str
    name: str
    version: str
    description: str
    capabilities: List[str]
    dependencies: List[str]
    category: str
    priority: int
    tickIntervalMs: int

    @field_validator("category")
    @classmethod
    def _category_must_be_known(cls, v: str) -> str:
        if v not in VALID_CATEGORIES:
            raise ValueError(
                f"category {v!r} is not one of {VALID_CATEGORIES}. An unknown category is "
                f"silently dropped by the frontend's AgentOSPanel, so the agent would run "
                f"but never appear on the dashboard."
            )
        return v

class AgentHealthRecord(BaseModel):
    agentId: str
    lastHeartbeat: float = 0.0
    lastError: Optional[str] = None
    lastErrorAt: Optional[float] = None
    consecutiveErrors: int = 0
    totalTicks: int = 0
    totalErrors: int = 0
    status: str = "init"

class RegisteredAgent:
    def __init__(self, descriptor: AgentDescriptor, tick_fn: Optional[Callable]):
        self.descriptor = descriptor
        self.tick_fn = tick_fn
        self.health = AgentHealthRecord(agentId=descriptor.id)
        self.last_scheduled_at = 0.0

class AgentOS:
    """
    Central runtime kernel for the Multi-Agent OS.
    Handles lifecycle, scheduling, and health of Python-based agents.
    """
    def __init__(self):
        self.agents: Dict[str, RegisteredAgent] = {}
        self.is_running = False
        self._scheduler_task = None
        self._listeners: Set[Callable] = set()

    def register(self, descriptor: AgentDescriptor, tick_fn: Optional[Callable] = None):
        self.agents[descriptor.id] = RegisteredAgent(descriptor, tick_fn)
        self._try_ready(descriptor.id)

    def _try_ready(self, agent_id: str):
        agent = self.agents.get(agent_id)
        if not agent or agent.health.status != 'init':
            return
        
        deps_ok = all(
            dep_id in self.agents and self.agents[dep_id].health.status in ['ready', 'running']
            for dep_id in agent.descriptor.dependencies
        )
        if deps_ok:
            agent.health.status = 'ready'

    def get_execution_order(self) -> List[str]:
        # Simple topological sort by priority (stubbed for brevity)
        return sorted(self.agents.keys(), key=lambda aid: self.agents[aid].descriptor.priority)

    async def _tick_loop(self, tick_ms: int):
        while self.is_running:
            now = time.time() * 1000
            for agent_id in self.get_execution_order():
                agent = self.agents[agent_id]
                
                if agent.health.status != 'running' or not agent.tick_fn or agent.descriptor.tickIntervalMs == 0:
                    continue
                
                elapsed = now - agent.last_scheduled_at
                if elapsed < agent.descriptor.tickIntervalMs:
                    continue
                
                # Check dependencies
                deps_healthy = all(
                    self.agents.get(dep_id) and self.agents[dep_id].health.status in ['running', 'ready']
                    for dep_id in agent.descriptor.dependencies
                )
                if not deps_healthy:
                    continue
                
                agent.last_scheduled_at = now
                try:
                    # Sync or Async execution
                    if asyncio.iscoroutinefunction(agent.tick_fn):
                        await agent.tick_fn(agent_id)
                    else:
                        agent.tick_fn(agent_id)
                    agent.health.lastHeartbeat = now
                    agent.health.totalTicks += 1
                    agent.health.consecutiveErrors = 0
                except Exception as e:
                    agent.health.lastError = str(e)
                    agent.health.lastErrorAt = now
                    agent.health.totalErrors += 1
                    agent.health.consecutiveErrors += 1
                    logger.error(f"Agent {agent_id} failed: {e}")
                    if agent.health.consecutiveErrors >= 5:
                        agent.health.status = 'error'
                        
            await asyncio.sleep(tick_ms / 1000.0)

    def start_scheduler(self, tick_ms: int = 1000):
        if self.is_running:
            return
        self.is_running = True
        
        # Transition ready agents to running
        for agent in self.agents.values():
            if agent.health.status == 'ready':
                agent.health.status = 'running'
                
        # In a real async app this should be scheduled in the running event loop
        self._scheduler_task = asyncio.create_task(self._tick_loop(tick_ms))

    def stop_scheduler(self):
        self.is_running = False
        if self._scheduler_task:
            self._scheduler_task.cancel()
            self._scheduler_task = None
        for agent in self.agents.values():
            if agent.health.status == 'running':
                agent.health.status = 'stopped'

# Singleton Instance
agent_os_instance = AgentOS()
def get_agent_os() -> AgentOS:
    return agent_os_instance
