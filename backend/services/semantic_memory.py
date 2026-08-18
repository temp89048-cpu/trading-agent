import logging
import json
import sqlite3
import os
from typing import Dict, Any, List, Optional
import aiosqlite

logger = logging.getLogger(__name__)

# We use a dedicated sqlite DB for the knowledge graph to keep it simple and portable.
DB_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "db", "knowledge_graph.db")

async def init_db():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS entities (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                properties TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS relationships (
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                weight REAL DEFAULT 1.0,
                properties TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (source_id, target_id, relation_type),
                FOREIGN KEY (source_id) REFERENCES entities(id),
                FOREIGN KEY (target_id) REFERENCES entities(id)
            )
        """)
        await db.commit()

async def upsert_entity(entity_id: str, entity_type: str, properties: Dict[str, Any]) -> None:
    """Insert or update an entity in the knowledge graph."""
    await init_db()
    props_json = json.dumps(properties)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO entities (id, type, properties, updated_at) 
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO UPDATE SET 
                type = excluded.type,
                properties = excluded.properties,
                updated_at = CURRENT_TIMESTAMP
        """, (entity_id, entity_type, props_json))
        await db.commit()

async def add_relationship(source_id: str, target_id: str, relation_type: str, weight: float = 1.0, properties: Dict[str, Any] = None) -> None:
    """Add a relationship between two entities."""
    await init_db()
    props_json = json.dumps(properties or {})
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO relationships (source_id, target_id, relation_type, weight, properties) 
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_id, target_id, relation_type) DO UPDATE SET 
                weight = excluded.weight,
                properties = excluded.properties
        """, (source_id, target_id, relation_type, weight, props_json))
        await db.commit()

async def get_entity(entity_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve an entity by ID."""
    await init_db()
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT type, properties FROM entities WHERE id = ?", (entity_id,)) as cursor:
            row = await cursor.fetchone()
            if row:
                return {
                    "id": entity_id,
                    "type": row[0],
                    "properties": json.loads(row[1])
                }
    return None

async def get_relationships(entity_id: str) -> List[Dict[str, Any]]:
    """Retrieve all relationships for a given entity."""
    await init_db()
    results = []
    async with aiosqlite.connect(DB_PATH) as db:
        # Outgoing
        async with db.execute("SELECT target_id, relation_type, weight, properties FROM relationships WHERE source_id = ?", (entity_id,)) as cursor:
            async for row in cursor:
                results.append({
                    "direction": "outgoing",
                    "target_id": row[0],
                    "relation_type": row[1],
                    "weight": row[2],
                    "properties": json.loads(row[3]) if row[3] else {}
                })
        # Incoming
        async with db.execute("SELECT source_id, relation_type, weight, properties FROM relationships WHERE target_id = ?", (entity_id,)) as cursor:
            async for row in cursor:
                results.append({
                    "direction": "incoming",
                    "source_id": row[0],
                    "relation_type": row[1],
                    "weight": row[2],
                    "properties": json.loads(row[3]) if row[3] else {}
                })
    return results
