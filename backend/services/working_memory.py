import json
import os
import logging
from typing import Dict, Any, List

logger = logging.getLogger(__name__)

WORKING_MEMORY_FILE = os.path.join(os.path.dirname(__file__), "..", "data", "working_memory.json")

def _load_memory() -> Dict[str, Any]:
    if not os.path.exists(WORKING_MEMORY_FILE):
        return {
            "monitoring_cycles": [],
            "recent_triggers": [],
            "current_context": {}
        }
    try:
        with open(WORKING_MEMORY_FILE, 'r') as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load Working Memory: {e}")
        return {
            "monitoring_cycles": [],
            "recent_triggers": [],
            "current_context": {}
        }

def _save_memory(memory: Dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(WORKING_MEMORY_FILE), exist_ok=True)
        with open(WORKING_MEMORY_FILE, 'w') as f:
            json.dump(memory, f, indent=4)
    except Exception as e:
        logger.error(f"Failed to save Working Memory: {e}")

async def record_monitoring_cycle(cycle_data: Dict[str, Any]) -> None:
    """
    Saves a continuous monitoring cycle to working memory.
    Keeps only the most recent 60 cycles (approx 1 hour at 1 min intervals).
    """
    memory = _load_memory()
    memory["monitoring_cycles"].append(cycle_data)
    
    if len(memory["monitoring_cycles"]) > 60:
        memory["monitoring_cycles"] = memory["monitoring_cycles"][-60:]
        
    _save_memory(memory)
    logger.debug("Working Memory updated with new monitoring cycle.")

async def record_trigger(trigger_data: Dict[str, Any]) -> None:
    """
    Saves recent triggers to working memory.
    """
    memory = _load_memory()
    memory["recent_triggers"].append(trigger_data)
    
    if len(memory["recent_triggers"]) > 100:
        memory["recent_triggers"] = memory["recent_triggers"][-100:]
        
    _save_memory(memory)

async def get_latest_monitoring_cycles(limit: int = 5) -> List[Dict[str, Any]]:
    memory = _load_memory()
    return memory.get("monitoring_cycles", [])[-limit:]

async def update_current_context(key: str, value: Any) -> None:
    memory = _load_memory()
    memory["current_context"][key] = value
    _save_memory(memory)

async def get_current_context() -> Dict[str, Any]:
    memory = _load_memory()
    return memory.get("current_context", {})
