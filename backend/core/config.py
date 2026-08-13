import os
import logging

# Ensure fallback values if .env is missing or dotenv is not installed
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

class Settings:
    # ---------------------------------------------------------------
    # Execution mode. Both of these default to the SAFE value, so an
    # absent or malformed .env produces paper trading on a testnet
    # endpoint rather than live orders. `LIVE_TRADING` was already
    # defined here but nothing read it — the ExecutionAgent defaulted
    # to `simulation_mode=False` and routed real orders regardless, so
    # setting LIVE_TRADING=false had no effect at all. It is now the
    # single switch that decides.
    # ---------------------------------------------------------------
    LIVE_TRADING: bool = os.getenv("LIVE_TRADING", "false").lower() == "true"
    USE_TESTNET: bool = os.getenv("USE_TESTNET", "true").lower() == "true"

    # API Keys
    BINANCE_API_KEY: str = os.getenv("BINANCE_API_KEY", "")
    BINANCE_SECRET: str = os.getenv("BINANCE_SECRET", "")

    OPENAI_API_KEY: str = os.getenv("OPENAI_API_KEY", "")

    # Operational
    LOG_LEVEL: str = os.getenv("LOG_LEVEL", "INFO")
    MAX_RETRIES: int = int(os.getenv("MAX_RETRIES", "3"))

    # Risk. Fraction of equity risked per trade, used for volatility-based
    # sizing. Note this is the risk BUDGET, not the position size — a 0.02
    # value means a trade whose stop is hit loses 2% of equity.
    RISK_PER_TRADE: float = float(os.getenv("RISK_PER_TRADE", "0.02"))

    # Database
    DATABASE_URL: str = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/tradingos")

    @property
    def execution_tab(self) -> str:
        """'real' only when live trading is explicitly enabled, else 'paper'.

        Every trade record and every leverage-ceiling lookup derives its tab
        from here, so a single flag governs both what gets executed and how
        it is labelled. Previously `execution_agent._persist_trade`
        hardcoded `tab="real"`, which meant simulated fills were written into
        the trade log as real ones — permanently mixing fake and real history
        in the same table with no way to separate them afterwards.
        """
        return "real" if self.LIVE_TRADING else "paper"


settings = Settings()

def configure_logging():
    level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)
    logging.basicConfig(
        level=level,
        format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
