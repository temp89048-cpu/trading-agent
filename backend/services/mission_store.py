import json
import os
import asyncio
from typing import List, Dict, Any
from backend.models.types import Mission

DATA_DIR = os.path.join(os.getcwd(), ".data")
DATA_FILE = os.path.join(DATA_DIR, "missions.json")

# A lock to ensure serialized writes like the TS memoryStore
_lock = asyncio.Lock()

async def ensure_file():
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(DATA_FILE):
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            f.write("[]")

async def read_all() -> List[Dict[str, Any]]:
    await ensure_file()
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            content = f.read()
            if not content:
                return []
            return json.loads(content)
    except Exception:
        return []

async def write_all(missions: List[Dict[str, Any]]):
    await ensure_file()
    tmp_file = DATA_FILE + ".tmp"
    with open(tmp_file, "w", encoding="utf-8") as f:
        json.dump(missions, f, indent=2)
    os.replace(tmp_file, DATA_FILE)

async def get_missions() -> List[Dict[str, Any]]:
    return await read_all()

async def save_mission(mission: Mission) -> List[Dict[str, Any]]:
    async with _lock:
        missions_raw = await read_all()
        idx = next((i for i, m in enumerate(missions_raw) if m.get("id") == mission.id), -1)
        mission_dict = mission.model_dump()
        
        if idx >= 0:
            missions_raw[idx] = mission_dict
        else:
            missions_raw.append(mission_dict)
            
        await write_all(missions_raw)
        return missions_raw

async def update_mission_partial(mission_id: str, updates: Dict[str, Any]) -> List[Dict[str, Any]]:
    async with _lock:
        missions_raw = await read_all()
        idx = next((i for i, m in enumerate(missions_raw) if m.get("id") == mission_id), -1)
        if idx >= 0:
            for k, v in updates.items():
                missions_raw[idx][k] = v
            await write_all(missions_raw)
        return missions_raw

async def delete_mission(mission_id: str) -> List[Dict[str, Any]]:
    async with _lock:
        missions_raw = await read_all()
        filtered = [m for m in missions_raw if m.get("id") != mission_id]
        await write_all(filtered)
        return filtered
