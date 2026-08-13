"""Knowledge API (`/api/knowledge`) — spec Section 8: *"Query/write access to the
Knowledge Graph."*

This module was `router = APIRouter()` with no routes.

WRITES ARE ALLOWED, BUT THEY CANNOT REACH TRADING CONFIG
--------------------------------------------------------
Spec Section 8 explicitly asks for write access, and spec Section 16 requires
that an external model's opinion is *"recorded (goes into the Knowledge Graph,
attributed to its source)"*. So `POST /relationship` exists.

What it cannot do is change how the system trades. The graph holds beliefs about
how market states relate ("High Funding" -> "High Liquidation Risk"); nothing in
`core/risk_manager` or the leverage ceiling reads it, and nothing here writes to
either. That separation is CLAUDE.md invariant 5 — learning improves
understanding, it does not deploy anything. An endpoint that let a caller assert
"High Leverage -> Safe" and have that alter sizing would be exactly the
`Loss -> AI rewrites strategy -> Live` path Section 12 forbids.

Every write carries a `source` so an assertion can be traced back to whoever
made it, and the base rules shipped with the graph are marked as such.
"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core.knowledge_graph import get_knowledge_graph

logger = logging.getLogger(__name__)

router = APIRouter()


class RelationshipInput(BaseModel):
    source_state: str = Field(..., min_length=1, description="e.g. 'High Funding'")
    implies: str = Field(..., min_length=1, description="e.g. 'High Liquidation Risk'")
    weight: float = Field(1.0, ge=0.0, le=1.0)
    # Required, not optional: an unattributed assertion in a knowledge base is
    # indistinguishable from a shipped rule, and spec Section 16 requires
    # external opinions to be attributed to their source.
    attributed_to: str = Field(..., min_length=1, description="Who or what asserted this")


@router.get("")
async def get_graph() -> Dict[str, Any]:
    """The whole graph — every node and weighted edge."""
    kg = get_knowledge_graph()
    return {
        "status": "success",
        "nodeCount": kg.graph.number_of_nodes(),
        "edgeCount": kg.graph.number_of_edges(),
        "nodes": sorted(kg.graph.nodes()),
        "edges": [
            {
                "from": u,
                "to": v,
                "weight": data.get("weight", 1.0),
                # Base rules have no attribution because they were defined in
                # code (KnowledgeGraph._initialize_base_rules), not asserted at
                # runtime. Saying so beats leaving the field blank.
                "attributedTo": data.get("attributed_to", "base rules (code)"),
            }
            for u, v, data in kg.graph.edges(data=True)
        ],
    }


@router.get("/implications/{state}")
async def get_implications(state: str) -> Dict[str, Any]:
    """What a market state implies, to two degrees of separation."""
    kg = get_knowledge_graph()
    if state not in kg.graph:
        # 404 with the known states listed, rather than an empty list. An empty
        # list reads as "this state implies nothing", which is a different and
        # much stronger claim than "we have never heard of this state".
        raise HTTPException(
            status_code=404,
            detail=(
                f"'{state}' is not a known state in the knowledge graph. Known states: "
                f"{sorted(kg.graph.nodes())}"
            ),
        )

    implications = kg.query_implications(state)
    return {
        "status": "success",
        "state": state,
        "implications": implications,
        "count": len(implications),
        "note": "Includes second-degree implications (A -> B -> C returns both B and C).",
    }


@router.post("/relationship")
async def add_relationship(payload: RelationshipInput) -> Dict[str, Any]:
    """Assert that one state implies another.

    Records the assertion. It does NOT change risk configuration, position
    sizing, strategy selection, or the leverage ceiling — nothing in those paths
    reads this graph. See the module docstring.
    """
    kg = get_knowledge_graph()

    # Self-loops make `query_implications` return the state as its own
    # implication, which is meaningless and pollutes every downstream traversal.
    if payload.source_state == payload.implies:
        raise HTTPException(
            status_code=422,
            detail="A state cannot imply itself.",
        )

    existed = kg.graph.has_edge(payload.source_state, payload.implies)
    kg.graph.add_edge(
        payload.source_state,
        payload.implies,
        weight=payload.weight,
        attributed_to=payload.attributed_to,
    )
    logger.info(
        "Knowledge graph: %s -> %s (weight %.2f) asserted by %s",
        payload.source_state, payload.implies, payload.weight, payload.attributed_to,
    )
    return {
        "status": "success",
        "action": "updated" if existed else "created",
        "from": payload.source_state,
        "to": payload.implies,
        "weight": payload.weight,
        "attributedTo": payload.attributed_to,
        "affectsTrading": False,
        "note": (
            "Recorded as understanding only. No risk config, sizing rule, or strategy "
            "selection reads the knowledge graph (CLAUDE.md invariant 5)."
        ),
    }


@router.get("/path")
async def find_path(source: str, target: str) -> Dict[str, Any]:
    """Shortest implication chain between two states, if one exists."""
    import networkx as nx

    kg = get_knowledge_graph()
    for name, node in (("source", source), ("target", target)):
        if node not in kg.graph:
            raise HTTPException(status_code=404, detail=f"{name} state '{node}' is not in the graph")

    try:
        path = nx.shortest_path(kg.graph, source, target)
    except nx.NetworkXNoPath:
        # An explicit "no path" result, distinct from an error. The absence of a
        # known chain is a real and useful answer.
        return {
            "status": "success",
            "source": source,
            "target": target,
            "pathExists": False,
            "path": [],
            "note": "No known implication chain connects these states.",
        }

    return {
        "status": "success",
        "source": source,
        "target": target,
        "pathExists": True,
        "path": path,
        "hops": len(path) - 1,
    }
