import sqlite3
import json
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

class AuditTrail:
    """
    Level 9: Complete Audit Trail
    Store everything. Every decision should record: Timestamp, Indicators, Market State,
    Prompt Version, AI Reasoning, Confidence, Risk Checks, Execution Result.
    """
    def __init__(self, db_path="audit.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    CREATE TABLE IF NOT EXISTS audit_logs (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        symbol TEXT,
                        decision TEXT,
                        confidence INTEGER,
                        context JSON,
                        reasoning TEXT
                    )
                ''')
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to initialize Audit Trail DB: {e}")

    def log_decision(self, symbol: str, decision: str, confidence: int, context: Dict[str, Any], reasoning: str):
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT INTO audit_logs (symbol, decision, confidence, context, reasoning)
                    VALUES (?, ?, ?, ?, ?)
                ''', (symbol, decision, confidence, json.dumps(context), reasoning))
                conn.commit()
        except Exception as e:
            logger.error(f"Failed to log to Audit Trail: {e}")

_audit = AuditTrail()

def get_audit_trail() -> AuditTrail:
    return _audit
