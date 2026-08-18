"""Graph builder — spec Section 6's "Graph Builder" and "Graph Configuration".

Assembles a LangGraph `StateGraph` from a declarative `GraphConfig`, wiring every
node through `runtime.wrap_node` so contract validation, error capture, tracing
and budget accounting are applied uniformly.

WHY DECLARATIVE, AND WHY IT MATTERS FOR SECTION 35
--------------------------------------------------
    Section 35: "don't create one gigantic LangGraph — that's a mistake. Use
    multiple, purpose-built graphs instead."

Section 35 names seven graphs. Hand-assembling seven graphs means seven places
where a node could be added without a contract, or where the wrapper could be
forgotten. A `GraphConfig` makes each graph a data structure, so all seven are
built by the same code path and the wrapper cannot be skipped for one of them.

It also makes the graph shape testable without running it: a test can assert
that the trade-decision graph routes REJECT to END without executing a single
node.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

from langgraph.graph import END, START, StateGraph

from backend.graphs.registry import get_node
from backend.graphs.runtime import RunContext, wrap_node
from backend.graphs.state import TradingState

logger = logging.getLogger(__name__)


@dataclass
class ConditionalEdge:
    """A branch. Spec Section 3's graph has one: risk_review -> REJECT | APPROVE.

    A label may map to a TUPLE of node names, which fans out to all of them in
    one superstep — the shape Section 9 draws, where seven specialists analyse in
    parallel. `_fan_out_router` explains why that case is wired differently.
    """

    source: str
    # Returns one of the keys of `destinations`.
    router: Callable[[TradingState], str]
    # Every possible return value mapped to a destination: a single node name, END,
    # or a tuple of node names to run in parallel. Declared explicitly so an
    # unmapped router return is a build-time error rather than a runtime KeyError
    # mid-decision.
    destinations: Dict[str, Any]

    def has_fan_out(self) -> bool:
        return any(isinstance(dst, (tuple, list)) for dst in self.destinations.values())


@dataclass
class GraphConfig:
    """One purpose-built graph (Section 35)."""

    name: str
    # Node names, in the order they should be wired. Must be registered.
    nodes: List[str]
    entry: str
    # Linear edges: (from, to). Use END as a destination to terminate.
    edges: List[Tuple[str, str]] = field(default_factory=list)
    conditional_edges: List[ConditionalEdge] = field(default_factory=list)
    # Nodes to pause BEFORE, for the Section 39.2 human-approval path.
    interrupt_before: List[str] = field(default_factory=list)

    def validate(self) -> None:
        """Structural checks before anything is built.

        Every one of these catches a mistake that would otherwise surface as a
        confusing runtime failure part-way through a decision.
        """
        if not self.nodes:
            raise ValueError(f"graph '{self.name}' declares no nodes")

        if self.entry not in self.nodes:
            raise ValueError(
                f"graph '{self.name}' entry '{self.entry}' is not among its nodes: {self.nodes}"
            )

        known = set(self.nodes)

        for src, dst in self.edges:
            if src not in known:
                raise ValueError(f"graph '{self.name}' edge source '{src}' is not a node of this graph")
            if dst not in known and dst != END:
                raise ValueError(f"graph '{self.name}' edge destination '{dst}' is not a node of this graph")

        # Two conditional edges on one node. LangGraph rejects this at compile time
        # ("Branch with name `X` already exists"), but by then it is inside
        # build_graph and surfaces to an operator as a failed run rather than a
        # misconfigured graph. It is an easy mistake to make when one config is
        # derived from another — `analysis_config()` extends `opportunity_config()`
        # and restated an edge it had already inherited.
        sources = [ce.source for ce in self.conditional_edges]
        duplicates = sorted({s for s in sources if sources.count(s) > 1})
        if duplicates:
            raise ValueError(
                f"graph '{self.name}' declares more than one conditional edge on "
                f"node(s) {duplicates}. A node has exactly one router; two would mean "
                f"its routing depends on which was registered last."
            )

        for ce in self.conditional_edges:
            if ce.source not in known:
                raise ValueError(
                    f"graph '{self.name}' conditional edge source '{ce.source}' is not a node"
                )
            for label, dst in ce.destinations.items():
                targets = dst if isinstance(dst, (tuple, list)) else [dst]
                if not targets:
                    raise ValueError(
                        f"graph '{self.name}' conditional edge '{ce.source}' maps '{label}' to "
                        f"an empty fan-out. A branch that goes nowhere stalls the run; route it "
                        f"to END if that is what is meant."
                    )
                for target in targets:
                    if target not in known and target != END:
                        raise ValueError(
                            f"graph '{self.name}' conditional edge '{ce.source}' maps '{label}' to "
                            f"'{target}', which is not a node of this graph"
                        )

        for node in self.interrupt_before:
            if node not in known:
                raise ValueError(
                    f"graph '{self.name}' declares interrupt_before '{node}', which is not a node"
                )

        # A node with no outgoing edge is a silent dead end: the run would stop
        # there and the operator would see an incomplete decision with no reason.
        with_outgoing = {s for s, _ in self.edges} | {ce.source for ce in self.conditional_edges}
        dead_ends = known - with_outgoing
        if dead_ends:
            raise ValueError(
                f"graph '{self.name}' has node(s) with no outgoing edge: {sorted(dead_ends)}. "
                f"Route them to another node or explicitly to END — a node that just stops "
                f"leaves a run looking incomplete with no stated reason."
            )


def _fan_out_router(
    graph_name: str, ce: ConditionalEdge
) -> Callable[[TradingState], List[str]]:
    """Adapt a label-returning router into the list-returning form LangGraph needs.

    Kept as an adapter rather than making every router return a list, because the
    label form is what makes `destinations` declarable and therefore checkable. A
    router returning raw node names would put the graph's shape inside a function
    body, where `GraphConfig.validate()` cannot see it and a typo becomes a
    runtime failure part-way through a decision.
    """

    def route(state: TradingState) -> List[str]:
        label = ce.router(state)
        if label not in ce.destinations:
            # Would otherwise be a bare KeyError from inside LangGraph with no
            # indication of which edge or graph produced it.
            raise ValueError(
                f"graph '{graph_name}' router for '{ce.source}' returned label "
                f"'{label}', which is not among its declared destinations "
                f"{sorted(ce.destinations)}"
            )
        dst = ce.destinations[label]
        return list(dst) if isinstance(dst, (tuple, list)) else [dst]

    return route


def build_graph(config: GraphConfig, ctx: RunContext, checkpointer: Any = None):
    """Compile a `GraphConfig` into a runnable LangGraph graph.

    Every node is wrapped. There is no path through this function that adds an
    unwrapped node, which is what guarantees contract enforcement applies to the
    whole graph rather than to the nodes someone remembered.
    """
    config.validate()

    graph = StateGraph(TradingState)

    for name in config.nodes:
        fn, contract = get_node(name)  # raises KeyError if unregistered
        graph.add_node(name, wrap_node(contract, fn, ctx))

    graph.add_edge(START, config.entry)

    for src, dst in config.edges:
        graph.add_edge(src, dst)

    for ce in config.conditional_edges:
        if ce.has_fan_out():
            # LangGraph's `path_map` values must be single hashable node names — a
            # list raises `TypeError: unhashable type: 'list'` at compile time. The
            # supported way to fan out is a router that RETURNS the list of nodes,
            # with no path_map at all.
            #
            # Dropping the path_map would also drop LangGraph's own check that every
            # destination exists, so `_fan_out_router` re-adds an equivalent check
            # itself and `GraphConfig.validate()` verifies the targets up front.
            graph.add_conditional_edges(ce.source, _fan_out_router(config.name, ce))
        else:
            graph.add_conditional_edges(ce.source, ce.router, ce.destinations)

    compile_kwargs: Dict[str, Any] = {}
    if checkpointer is not None:
        compile_kwargs["checkpointer"] = checkpointer
    if config.interrupt_before:
        # Section 39.2: LangGraph's native interrupt path, rather than a bespoke
        # polling loop, for human approval.
        compile_kwargs["interrupt_before"] = config.interrupt_before

    compiled = graph.compile(**compile_kwargs)
    logger.info(
        "Built graph '%s' with %d node(s), %d conditional edge(s), checkpointer=%s",
        config.name, len(config.nodes), len(config.conditional_edges),
        type(checkpointer).__name__ if checkpointer else "none",
    )
    return compiled
