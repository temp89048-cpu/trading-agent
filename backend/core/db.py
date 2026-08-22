import os
import asyncpg
import logging
from backend.core.config import settings

logger = logging.getLogger(__name__)

# Global connection pool
_db_pool = None

async def _table_names(conn) -> set:
    """Table names in the public schema, for reporting what a schema apply created."""
    rows = await conn.fetch(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    )
    return {r["table_name"] for r in rows}


async def init_db() -> asyncpg.Pool:
    """Initialize the database connection pool and run schema migrations if necessary."""
    global _db_pool
    logger.info(f"Connecting to database at {settings.DATABASE_URL}")
    
    try:
        _db_pool = await asyncpg.create_pool(
            dsn=settings.DATABASE_URL,
            min_size=2,
            max_size=20,
            command_timeout=60,
        )
        
        # APPLY THE SCHEMA EVERY STARTUP.
        #
        # This used to run only `if not table_exists` for the `trades` table. That
        # is not a migration: once `trades` existed, `db/schema.sql` was never read
        # again, so `execution_quality` — added to the schema later — was never
        # created. 26 tables were declared and 25 existed, and the missing one was
        # only reachable through `_persist_execution_quality()`, which logs its
        # failure AFTER the order is already on the exchange. So a table that had
        # been "added" months earlier had never once been written to, and the only
        # symptom was a line in a log nobody greps.
        #
        # Every statement in schema.sql is now idempotent (`CREATE ... IF NOT
        # EXISTS`, seed `INSERT ... ON CONFLICT DO NOTHING`), which is what makes
        # re-running it safe and what makes a newly-added table actually land.
        async with _db_pool.acquire() as conn:
            schema_path = os.path.join(os.path.dirname(__file__), '..', '..', 'db', 'schema.sql')
            if not os.path.exists(schema_path):
                logger.error(
                    "Schema file not found at %s — the database is whatever it already was. "
                    "Tables added since the last run will be MISSING, and the code that "
                    "writes them will fail at write time.",
                    schema_path,
                )
                return _db_pool

            with open(schema_path, 'r', encoding='utf-8') as f:
                schema_sql = f.read()

            before = await _table_names(conn)
            try:
                await conn.execute(schema_sql)
            except Exception as e:
                # Loud and specific. A half-applied schema means some writer will
                # fail later against a missing table, far from this line.
                logger.error(
                    "Applying db/schema.sql FAILED: %s. The database may be missing tables; "
                    "writes to them will fail at call time rather than here.",
                    e,
                )
                return _db_pool

            after = await _table_names(conn)
            created = sorted(after - before)
            if created:
                logger.warning(
                    "Database schema applied — CREATED %d table(s) that did not exist: %s. "
                    "Any code writing to these was failing before this run.",
                    len(created),
                    ", ".join(created),
                )
            else:
                logger.info("Database schema applied; all %d table(s) already present.", len(after))

        return _db_pool
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}")
        # Not throwing an exception to allow the app to boot even if DB is down (graceful degradation)
        # But we log it as an error.
        return None

def get_db_pool() -> asyncpg.Pool:
    """Retrieve the global connection pool."""
    return _db_pool

async def close_db():
    """Close the database connection pool."""
    global _db_pool
    if _db_pool:
        await _db_pool.close()
        _db_pool = None
        logger.info("Database pool closed.")
