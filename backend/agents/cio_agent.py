"""CIO AI — capital allocation, second in spec Section 4's chain.

    CEO AI -> CIO AI -> CRO AI -> Research -> Supervisor -> ...

Like the CEO, the CIO exists here to own a specific authority that was
genuinely missing, not to add a layer of commentary. Its job is the
portfolio-level constraint the CRO could not enforce:

    Spec Section 18, Max Correlated Exposure:
    "If Pearson correlation between Asset A and Asset B > 0.75 over 30 days,
     their combined directional exposure cannot exceed 1.5x the max limit of a
     single asset."

`agents/cro_agent.py` said so in a comment — its rationale string used to claim
it had "Passed all VaR and correlation constraints" while running no
correlation check at all. That claim is now accurate because the CRO admits the
gap, and this agent closes it.

WHY THIS IS SEPARATE FROM THE CRO
---------------------------------
The CRO answers "is this one trade acceptable?". Correlation is a property of a
trade *relative to the book*: the same 2% position is fine alone and
unacceptable as the fourth correlated long. That requires reading every open
position and a price history per symbol, which is a different job with
different data needs.

WHY IT ADVISES RATHER THAN VETOES
---------------------------------
`check_exposure` returns a verdict the Supervisor consults before sizing, so a
correlated trade is *sized down or declined at submission* rather than rejected
after a TAR exists. The CRO keeps the final veto — there is deliberately no
second approval authority, because two agents that can both approve means
neither is accountable.

HONEST LIMITATION
-----------------
Correlation is computed from whatever candle history the market-data service
can supply, on the timeframe requested. If a symbol has too little history the
pair is reported as UNKNOWN and treated as correlated (the conservative
reading), never as uncorrelated. Assuming independence you have not measured is
how a "diversified" book turns out to be one position in five instruments.
"""

import logging
from typing import Any, Dict, List, Optional, Sequence

import numpy as np

from backend.algorithms.portfolio import (
    build_asset_graph,
    calculate_correlation_matrix,
    pearson_correlation,
)
from backend.core.agent_base import BaseAgent
from backend.core.config import settings
from backend.models.events import BaseEvent, EventType
from backend.services.market_data import fetch_klines
from backend.services.portfolio_store import get_portfolio

logger = logging.getLogger(__name__)

# Spec Section 18's thresholds.
CORRELATION_THRESHOLD = 0.75
CORRELATED_EXPOSURE_MULTIPLIER = 1.5

# Max exposure to a single asset, as a fraction of equity. The "max limit of a
# single asset" the spec's 1.5x multiplier is relative to.
MAX_SINGLE_ASSET_EXPOSURE = 0.20

# 30 days of 1h candles = 720. Requested at 4h (180 candles) instead: 720
# candles is a large fetch per pair per check, and correlation of daily-ish
# co-movement is not meaningfully different at 4h resolution. Stated because
# it IS a deviation from the spec's literal "over 30 days" of tick data.
CORRELATION_TIMEFRAME = "4h"
CORRELATION_CANDLES = 180
MIN_CANDLES_FOR_CORRELATION = 60


# Re-exported so existing imports of `cio_agent.pearson` keep working. The
# implementation moved to algorithms/portfolio.py: this module had its own copy
# while `calculate_correlation_matrix` already existed in the algorithm library,
# which is exactly the duplication spec Section 20 forbids. Two correlation
# implementations will eventually disagree about whether two assets are related.
pearson = pearson_correlation


def returns_of(klines: List[Dict[str, Any]]) -> List[float]:
    closes = [float(k["close"]) for k in klines]
    return [
        (closes[i] - closes[i - 1]) / closes[i - 1]
        for i in range(1, len(closes))
        if closes[i - 1]
    ]


class CIOAgent(BaseAgent):
    version = "1.0.0"
    priority = 2  # just below the CEO

    def __init__(self) -> None:
        # symbol -> returns series, cached per process run. Correlation over 30
        # days does not change materially between two trades minutes apart, and
        # re-fetching 180 candles per symbol per check would dominate the
        # decision latency.
        self._returns_cache: Dict[str, List[float]] = {}
        super().__init__()

    @property
    def name(self) -> str:
        return "CIO AI"

    @property
    def purpose(self) -> str:
        return "Enforces portfolio-level allocation limits, including the correlated-exposure cap that a per-trade risk check cannot see."

    @property
    def permissions(self) -> List[str]:
        # Advises on allocation. Deliberately cannot approve a TAR — the CRO
        # holds the only veto, and a second approval authority would mean
        # neither is accountable.
        return ["READ_PORTFOLIO", "READ_MARKET_DATA", "SET_ALLOCATION_LIMITS"]

    @property
    def inputs(self) -> List[str]:
        return [
            "Open positions via services/portfolio_store.get_portfolio",
            f"{CORRELATION_TIMEFRAME} klines per held symbol via services/market_data.fetch_klines",
            "The proposed symbol, side and notional from the caller",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "An exposure verdict: allowed / reduced / declined, with the correlated group named",
            "A maximum permitted notional the Supervisor can size down to",
            "UNKNOWN correlations reported explicitly and treated as correlated",
        ]

    @property
    def category(self) -> str:
        return "risk"

    @property
    def events_consumed(self) -> List[EventType]:
        # Queried directly by the Supervisor before sizing rather than reacting
        # to an event. An event-driven check would arrive after the TAR was
        # already built, which is too late to size down.
        return []

    @property
    def events_published(self) -> List[EventType]:
        return []

    @property
    def responsibilities(self) -> List[str]:
        return [
            "Measure pairwise correlation between a proposed symbol and the existing book.",
            f"Cap combined exposure of a correlated group at {CORRELATED_EXPOSURE_MULTIPLIER}x the single-asset limit.",
            "Treat unmeasurable correlation as correlated, never as independent.",
        ]

    @property
    def dependencies(self) -> List[str]:
        return ["PortfolioStore", "MarketData"]

    @property
    def memory_ttl(self) -> str:
        return "Returns series cached in-process for the lifetime of the run; no persistence."

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Open positions", "Historical candles per symbol"]

    @property
    def prompt_reference(self) -> str:
        return "CIO_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["Exchange OHLCV via services/market_data"]

    @property
    def database_tables(self) -> List[str]:
        return []

    @property
    def metrics_reported(self) -> List[str]:
        return ["Correlated groups detected", "Exposure reductions applied", "Unmeasurable pairs"]

    @property
    def failure_recovery_strategy(self) -> str:
        return (
            "Degrades conservatively. A symbol with insufficient history is treated as correlated "
            "with everything held, which reduces the permitted size rather than allowing it. A "
            "failed fetch never widens a limit."
        )

    @property
    def health_status(self) -> str:
        return "Active"

    async def handle_event(self, event: BaseEvent) -> None:
        """No event subscriptions — see `events_consumed`."""
        return None

    # -----------------------------------------------------------------

    async def _returns_for(self, symbol: str) -> Optional[List[float]]:
        if symbol in self._returns_cache:
            return self._returns_cache[symbol]
        klines = await fetch_klines(symbol, CORRELATION_TIMEFRAME, limit=CORRELATION_CANDLES)
        if len(klines) < MIN_CANDLES_FOR_CORRELATION:
            return None
        series = returns_of(klines)
        self._returns_cache[symbol] = series
        return series

    async def correlation_clusters(self) -> Dict[str, Any]:
        """Group the open book into clusters of mutually correlated assets.

        Uses `algorithms/portfolio.build_asset_graph` (graph intelligence, spec
        Section 10) over `calculate_correlation_matrix`. Both existed with zero
        callers.

        Why this is worth having beyond the pairwise check in
        `check_exposure()`: pairwise correlation misses transitive clustering. A
        book holding A, B and C where A~B and B~C but A~C measures as
        uncorrelated pairwise, yet all three move together. A connected
        component in the graph exposes that; comparing pairs one at a time
        cannot.

        Symbols with too little history are reported in `unmeasurable` rather
        than silently omitted — an asset excluded from the graph looks
        diversified.
        """
        import networkx as nx

        tab = settings.execution_tab
        portfolio = await get_portfolio()
        positions = (portfolio.get(tab) or {}).get("positions", [])
        symbols = [p["symbol"] for p in positions if p.get("symbol")]

        if len(symbols) < 2:
            return {
                "clusters": [[s] for s in symbols],
                "unmeasurable": [],
                "detail": f"{len(symbols)} position(s) — no clustering to compute.",
            }

        series: Dict[str, List[float]] = {}
        unmeasurable: List[str] = []
        for symbol in symbols:
            returns = await self._returns_for(symbol)
            if returns is None:
                unmeasurable.append(symbol)
            else:
                series[symbol] = returns

        measurable = sorted(series)
        if len(measurable) < 2:
            return {
                "clusters": [[s] for s in symbols],
                "unmeasurable": unmeasurable,
                "detail": (
                    f"Only {len(measurable)} symbol(s) had enough history to correlate; "
                    f"clustering not computed."
                ),
            }

        # Align every series to the shortest so the matrix is rectangular.
        length = min(len(series[s]) for s in measurable)
        matrix = np.array([series[s][-length:] for s in measurable], dtype=float)
        corr = calculate_correlation_matrix(matrix)

        graph = build_asset_graph(measurable, corr, threshold=CORRELATION_THRESHOLD)
        clusters = [sorted(c) for c in nx.connected_components(graph)]
        # Unmeasurable symbols are their own singleton clusters, but flagged.
        clusters.extend([[s] for s in unmeasurable])

        multi = [c for c in clusters if len(c) > 1]
        return {
            "clusters": sorted(clusters, key=len, reverse=True),
            "correlatedClusters": multi,
            "unmeasurable": unmeasurable,
            "threshold": CORRELATION_THRESHOLD,
            "detail": (
                f"{len(multi)} correlated cluster(s) among {len(measurable)} measurable "
                f"position(s)"
                + (f"; {len(unmeasurable)} could not be measured." if unmeasurable else ".")
            ),
        }

    async def check_exposure(
        self, symbol: str, side: str, proposed_notional: float, equity: float
    ) -> Dict[str, Any]:
        """Is this trade acceptable given what the book already holds?

        Returns a dict with `allowed`, `max_notional`, and a `detail` string
        explaining any reduction. Sizing down is preferred over refusing where
        a smaller position is genuinely acceptable — a flat refusal on a
        correlated trade would stop the system trading its best setup just
        because it already holds something similar.
        """
        if equity <= 0:
            return {
                "allowed": False,
                "max_notional": 0.0,
                "correlated_group": [],
                "detail": "Equity unknown, so no exposure limit can be computed.",
            }

        single_limit = equity * MAX_SINGLE_ASSET_EXPOSURE
        group_limit = single_limit * CORRELATED_EXPOSURE_MULTIPLIER

        tab = settings.execution_tab
        portfolio = await get_portfolio()
        book = (portfolio.get(tab) or {}).get("positions", [])

        # Same-symbol exposure always counts, correlation or not.
        correlated: List[Dict[str, Any]] = []
        unknown_pairs: List[str] = []
        group_notional = 0.0

        proposed_returns = await self._returns_for(symbol)

        for pos in book:
            held = pos.get("symbol")
            if not held:
                continue
            qty = float(pos.get("qty") or 0.0)
            cost = float(pos.get("avgCost") or 0.0)
            held_notional = qty * cost
            if held_notional <= 0:
                continue

            if held == symbol:
                correlated.append({"symbol": held, "notional": held_notional, "correlation": 1.0})
                group_notional += held_notional
                continue

            held_returns = await self._returns_for(held)
            corr = None
            if proposed_returns is not None and held_returns is not None:
                corr = pearson(proposed_returns, held_returns)

            if corr is None:
                # Unmeasurable: treat as correlated. Assuming independence you
                # have not measured is how a book that looks diversified turns
                # out to be one position in five instruments.
                unknown_pairs.append(held)
                correlated.append({"symbol": held, "notional": held_notional, "correlation": None})
                group_notional += held_notional
            elif abs(corr) > CORRELATION_THRESHOLD:
                # Only same-direction exposure compounds. A long in one and a
                # short in a highly correlated other is a partial hedge, not
                # doubled risk.
                same_direction = (corr > 0) == (side == "buy" or side == "long")
                if same_direction:
                    correlated.append({"symbol": held, "notional": held_notional, "correlation": round(corr, 3)})
                    group_notional += held_notional

        combined = group_notional + proposed_notional

        if combined <= group_limit:
            detail = (
                f"Combined correlated exposure ${combined:.2f} is within the "
                f"${group_limit:.2f} group limit "
                f"({CORRELATED_EXPOSURE_MULTIPLIER}x the ${single_limit:.2f} single-asset limit)."
            )
            if unknown_pairs:
                detail += (
                    f" Correlation with {', '.join(unknown_pairs)} could not be measured and was "
                    f"counted as correlated."
                )
            result = {
                "allowed": True,
                "max_notional": proposed_notional,
                "correlated_group": correlated,
                "detail": detail,
            }
        else:
            headroom = max(0.0, group_limit - group_notional)
            detail = (
                f"Correlated group {[c['symbol'] for c in correlated]} already holds "
                f"${group_notional:.2f}; adding ${proposed_notional:.2f} would reach "
                f"${combined:.2f}, above the ${group_limit:.2f} group limit. "
                f"Permitted notional reduced to ${headroom:.2f}."
            )
            if unknown_pairs:
                detail += f" ({', '.join(unknown_pairs)} counted as correlated — correlation unmeasurable.)"
            result = {
                "allowed": headroom > 0,
                "max_notional": headroom,
                "correlated_group": correlated,
                "detail": detail,
            }

        self.record_decision(
            "exposure-allowed" if result["allowed"] else "exposure-declined",
            result["detail"],
            {
                "symbol": symbol,
                "side": side,
                "proposedNotional": round(proposed_notional, 2),
                "groupNotional": round(group_notional, 2),
                "groupLimit": round(group_limit, 2),
                "unmeasurablePairs": unknown_pairs,
            },
            acted=True,
        )
        return result


_cio: Optional[CIOAgent] = None


def get_cio_agent() -> CIOAgent:
    """Singleton, so the returns cache is shared rather than rebuilt per call."""
    global _cio
    if _cio is None:
        _cio = CIOAgent()
    return _cio
