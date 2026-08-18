"""Market Graph Intelligence — spec Section 26 (Phase 43).

    "Represent the ecosystem as a graph (BTC ↔ ETH, SOL, DOGE) so the AI learns
     relationships between assets, not just isolated charts."

WHAT THIS DOES AND DELIBERATELY DOES NOT DUPLICATE
--------------------------------------------------
`algorithms/portfolio` already has `pearson_correlation` and `build_asset_graph`,
and `agents/cio_agent` already uses them to enforce a correlated-exposure cap. This
module does NOT reimplement any of that. It:

  1. builds the asset graph from REAL return correlations, via those functions;
  2. persists the edges into `services/semantic_memory`, which is already an
     entity/relationship store, so the graph survives a restart and the Phase 32
     memory loader can read it;
  3. answers "what is this symbol related to, and how strongly".

A second correlation implementation would be worse than none: the CIO's exposure cap
and this graph disagreeing about whether BTC and ETH move together would mean the
cap is enforced against one number while the reasoning cites another.

EVERY EDGE IS MEASURED OR ABSENT
--------------------------------
No edge is ever created from an assumption. "BTC and ETH are obviously correlated"
is exactly the kind of prior that produces a graph which looks informative and
encodes nothing but the author's expectations. A pair with too little overlapping
history produces NO edge and an entry in `unavailable`, because a missing edge and a
measured-zero correlation are different facts — and the second is a real, useful
finding while the first is silence.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.algorithms.portfolio import pearson_correlation

logger = logging.getLogger(__name__)

# Minimum overlapping return observations before a correlation is reported.
#
# 60 matches `cio_agent.MIN_CANDLES_FOR_CORRELATION`, referenced by value rather than
# re-picked so the graph and the exposure cap cannot disagree about what counts as
# enough history.
MIN_OBSERVATIONS = 60

# |r| at or above this is recorded as a RELATED edge. Matches
# `cio_agent.CORRELATION_THRESHOLD` for the same reason.
RELATED_THRESHOLD = 0.75

# Below this, a pair is recorded as measured-and-INDEPENDENT. That is a positive
# finding — it is what makes two positions genuinely diversifying — so it gets an
# edge of its own rather than being dropped.
INDEPENDENT_THRESHOLD = 0.25

RELATION_CORRELATED = "correlated_with"
RELATION_INVERSE = "inversely_correlated_with"
RELATION_INDEPENDENT = "independent_of"


@dataclass
class AssetEdge:
    """One measured relationship between two assets."""

    source: str
    target: str
    correlation: float
    relation: str
    observations: int

    @property
    def weight(self) -> float:
        """Absolute strength, so an inverse relationship is as strong as a direct one.

        A -0.9 correlation is just as useful for reasoning about concentration as a
        +0.9 one — it is the magnitude that says "these two are not independent".
        """
        return abs(self.correlation)


@dataclass
class MarketGraph:
    """The measured ecosystem. Edges only where there was enough data."""

    edges: List[AssetEdge] = field(default_factory=list)
    # Pairs that could NOT be measured, with the reason. See the module docstring on
    # why a missing edge is not a zero correlation.
    unavailable: List[str] = field(default_factory=list)

    def related_to(self, symbol: str, minimum: float = RELATED_THRESHOLD) -> List[AssetEdge]:
        """Edges above `minimum` absolute strength touching `symbol`."""
        base = _base(symbol)
        return sorted(
            (e for e in self.edges
             if base in (e.source, e.target) and e.weight >= minimum),
            key=lambda e: e.weight,
            reverse=True,
        )

    def clusters(self, minimum: float = RELATED_THRESHOLD) -> List[List[str]]:
        """Connected groups of assets that move together.

        Union-find rather than a graph library: the only question asked of the graph
        is "which assets are transitively related", and pulling in networkx for that
        would add a dependency to a function that is six lines without one.
        """
        parent: Dict[str, str] = {}

        def find(x: str) -> str:
            parent.setdefault(x, x)
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for edge in self.edges:
            if edge.weight < minimum or edge.relation == RELATION_INDEPENDENT:
                continue
            a, b = find(edge.source), find(edge.target)
            if a != b:
                parent[a] = b

        groups: Dict[str, List[str]] = {}
        for node in list(parent):
            groups.setdefault(find(node), []).append(node)
        return [sorted(g) for g in groups.values() if len(g) > 1]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "edges": [
                {
                    "source": e.source,
                    "target": e.target,
                    "correlation": round(e.correlation, 4),
                    "relation": e.relation,
                    "observations": e.observations,
                }
                for e in self.edges
            ],
            "clusters": self.clusters(),
            "unavailable": self.unavailable,
            "thresholdMeaning": (
                f"|r| >= {RELATED_THRESHOLD} is recorded as related, "
                f"<= {INDEPENDENT_THRESHOLD} as measured-independent. The band between "
                f"them is measured but too weak to call either way, and is recorded "
                f"with its correlation so the number is visible"
            ),
        }


def _base(symbol: str) -> str:
    """'BTC/USDT' -> 'BTC'. Graph nodes are ASSETS, not trading pairs.

    BTC/USDT and BTC/USDC are the same asset for correlation purposes, and treating
    them as separate nodes would put an asset in a cluster with itself.
    """
    return str(symbol).split("/")[0].upper()


def returns_from_closes(closes: Sequence[float]) -> List[float]:
    """Simple returns. Skips any pair where the prior close is zero or missing."""
    out: List[float] = []
    for i in range(1, len(closes)):
        prior = closes[i - 1]
        if prior:
            out.append((closes[i] - prior) / prior)
    return out


def build_market_graph(
    returns_by_symbol: Dict[str, Sequence[float]],
    threshold: float = RELATED_THRESHOLD,
) -> MarketGraph:
    """Measure every pair. Pure — returns are passed in, never fetched.

    Fetching inside would make this a second market-data path (Section 39.4) and
    would mean a graph built during one decision could describe a different market
    than the decision did.
    """
    graph = MarketGraph()
    symbols = sorted({_base(s) for s in returns_by_symbol})

    # Collapse pairs of the same base asset. BTC/USDT and BTC/USDC contribute one
    # node, and the longer series wins.
    by_base: Dict[str, Sequence[float]] = {}
    for symbol, series in returns_by_symbol.items():
        base = _base(symbol)
        if len(series) > len(by_base.get(base, ())):
            by_base[base] = series

    for i, a in enumerate(symbols):
        for b in symbols[i + 1:]:
            series_a, series_b = by_base.get(a, ()), by_base.get(b, ())
            overlap = min(len(series_a), len(series_b))

            if overlap < MIN_OBSERVATIONS:
                graph.unavailable.append(
                    f"{a}<->{b}: only {overlap} overlapping observation(s), "
                    f"{MIN_OBSERVATIONS} needed. NO edge is recorded — an unmeasured "
                    f"pair is not an independent pair"
                )
                continue

            # Aligned from the END, so both series describe the same recent window.
            r = pearson_correlation(list(series_a)[-overlap:], list(series_b)[-overlap:])
            if r is None:
                graph.unavailable.append(
                    f"{a}<->{b}: correlation undefined (a series has zero variance — "
                    f"a flat price cannot be correlated with anything)"
                )
                continue

            if abs(r) >= threshold:
                relation = RELATION_CORRELATED if r > 0 else RELATION_INVERSE
            elif abs(r) <= INDEPENDENT_THRESHOLD:
                relation = RELATION_INDEPENDENT
            else:
                # Measured, real, and too weak to classify. Recorded anyway with its
                # number, because "we measured 0.5" is information and dropping it
                # would leave the pair looking unmeasured.
                relation = "weakly_related"

            graph.edges.append(AssetEdge(
                source=a, target=b, correlation=r,
                relation=relation, observations=overlap,
            ))

    logger.info(
        "Market graph: %d edge(s) across %d asset(s), %d pair(s) unmeasurable",
        len(graph.edges), len(symbols), len(graph.unavailable),
    )
    return graph


async def persist_market_graph(graph: MarketGraph) -> Tuple[int, Optional[str]]:
    """Write the graph into semantic memory. Returns (edges written, error).

    Persisted so the graph survives a restart and the Phase 32 memory loader can
    read it — a correlation matrix recomputed from scratch on every run is not a
    graph the system "learns", which is what Section 26 asks for.

    Returns the error rather than raising: failing to persist a market graph must not
    fail whatever decision was being made.
    """
    if not graph.edges:
        return 0, "no measured edges to persist"

    try:
        from backend.services.semantic_memory import add_relationship, upsert_entity

        assets = {e.source for e in graph.edges} | {e.target for e in graph.edges}
        for asset in sorted(assets):
            await upsert_entity(asset, "Asset", {"symbol": asset})

        for edge in graph.edges:
            await add_relationship(
                source_id=edge.source,
                target_id=edge.target,
                relation_type=edge.relation,
                weight=edge.weight,
                properties={
                    "correlation": edge.correlation,
                    "observations": edge.observations,
                },
            )
    except Exception as exc:  # noqa: BLE001
        logger.error("Could not persist the market graph: %s", exc)
        return 0, str(exc)

    return len(graph.edges), None


async def load_relationships(symbol: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Read what this asset is known to be related to. Returns (edges, error)."""
    try:
        from backend.services.semantic_memory import get_relationships

        return (await get_relationships(_base(symbol))) or [], None
    except Exception as exc:  # noqa: BLE001
        # None-vs-empty matters here as everywhere else: "this asset has no known
        # relationships" and "the store could not be read" are different, and only
        # the first is a finding.
        return [], str(exc)
