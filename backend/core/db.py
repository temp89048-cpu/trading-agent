import os
import asyncpg
import logging
from backend.core.config import settings

logger = logging.getLogger(__name__)

# Global connection pool
_db_pool = None

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
        
        # Check if the schema is already initialized
        async with _db_pool.acquire() as conn:
            table_exists = await conn.fetchval(
                "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trades')"
            )
            
            if not table_exists:
                logger.info("Initializing database schema from db/schema.sql...")
                schema_path = os.path.join(os.path.dirname(__file__), '..', '..', 'db', 'schema.sql')
                if os.path.exists(schema_path):
                    with open(schema_path, 'r', encoding='utf-8') as f:
                        schema_sql = f.read()
                    
                    # Execute the schema (contains multiple statements)
                    await conn.execute(schema_sql)
                    logger.info("Database schema initialized successfully.")
                else:
                    logger.error(f"Schema file not found at {schema_path}")
            else:
                logger.info("Database schema already exists.")
                
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
