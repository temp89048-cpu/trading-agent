from fastapi import APIRouter
from backend.core.agent_os import get_agent_os

router = APIRouter()

@router.get("")
async def get_system_health():
    """
    Returns the health of the Agent OS and its running agents.
    Replaces app/api/health/route.ts
    """
    os_kernel = get_agent_os()
    
    agents_health = []
    for agent in os_kernel.agents.values():
        agents_health.append(agent.health.model_dump())
        
    return {
        "overall": "healthy" if os_kernel.is_running else "degraded",
        "status": "ok",
        "scheduler_running": os_kernel.is_running,
        "agents": agents_health,
        "checks": [{"label": "FastAPI Core", "ok": True}]
    }
