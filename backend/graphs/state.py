"""TradingState — spec Section 4, the shared state of the reasoning graph.

    "Don't let every agent maintain its own ad-hoc state. Create one strongly
     typed TradingState that every node reads from and writes back to ...
     every node's job is to read some fields and write others, nothing more."

This is the single largest architectural gap the audit found. Today each agent
holds its own state and the only thing they share is the event payload passing
between them, so no component can see the whole picture of a decision.

THREE DELIBERATE DEVIATIONS FROM THE SPEC'S SCHEMA
-------------------------------------------------
1. `confidence: float | None`, not `float`.

   A missing confidence and a zero confidence are different facts. This
   codebase has been bitten by that exact class repeatedly — slippage hardcoded
   to 0.0 gave every trade a perfect execution score; `prob_of_ruin: 0.0` with
   no data claimed zero risk of ruin; `fng: 50` on a failed fetch was
   indistinguishable from a genuinely neutral market. `0.0` reads as "measured
   no confidence". `None` reads as "not measured". Only one of those is true
   when a node could not run.

2. `unavailable: list[str]` is added, and it matters as much as the analysis
   fields.

   Every component in this system now distinguishes "evaluated and found
   nothing" from "could not evaluate". If the state carries only the analysis
   fields, that distinction is destroyed at the first node and a downstream
   node cannot tell a quiet market from a broken feed.

3. Analysis fields are `| None` rather than required.

   The spec types `market_data`, `technical_analysis` etc. as always present.
   In a real run a node can fail, and LangGraph will still route to the next
   node. Typing them as required would mean either fabricating a value on
   failure or crashing the run — the first is forbidden, the second loses the
   partial reasoning that had already been done.

SECTION 39.4 — REPLAY SAFETY IS THE REASON MARKET DATA LIVES HERE
-----------------------------------------------------------------
    "fetch market data once per graph run into TradingState, and have every
     downstream node read from state rather than calling the market API again."

A resumed thread can re-execute later graph work. If a node re-fetches candles
on replay it reasons over a DIFFERENT market than the one the original decision
was based on, and the resumed run silently diverges from the run it is meant to
be continuing. `market_data` is written exactly once, by the first node, and is
read-only thereafter — `contracts.py` enforces which nodes may write it.
"""

from __future__ import annotations

import operator
from dataclasses import dataclass, field
from typing import Annotated, Any, Dict, List, Literal, Optional, TypedDict

# ---------------------------------------------------------------------------
# Trigger — why this run happened at all (Phase 31 / spec Section 14)
# ---------------------------------------------------------------------------

TriggerKind = Literal[
    "price_move",
    "oi_spike",
    "funding_change",
    "liquidation_spike",
    "volatility_regime_change",
    "news_event",
    # Phase 36. NOT folded into "news_event", deliberately: a prediction-market
    # reprice is not a headline, and reusing that kind would make
    # `UNAVAILABLE_TRIGGERS["news_event"]`'s stated blocker a lie while leaving the
    # actual news gap invisible. Two different missing feeds must stay two facts.
    "prediction_market_shift",
    "position_risk_change",
    "exchange_event",
    "manual",
    "scheduled",
]


@dataclass(frozen=True)
class TriggerReason:
    """What caused this graph run.

    Recorded on the state because "why did the system think about this now?" is
    a question the decision log must be able to answer. Spec Section 14 requires
    event triggers rather than polling; without this field a triggered run and a
    scheduled sweep are indistinguishable after the fact.
    """

    kind: TriggerKind
    symbol: str
    detail: str
    # The measurement that crossed a threshold, when there was one. None for
    # `manual` and `scheduled`.
    observed_value: Optional[float] = None
    threshold: Optional[float] = None


# ---------------------------------------------------------------------------
# Errors — a failed node degrades the run, it does not abort it
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class NodeError:
    node: str
    error: str
    # True when the node could not run at all (missing input, dead feed) as
    # opposed to raising unexpectedly. The first is a data problem; the second
    # is a bug, and they need different responses.
    was_unavailable: bool = False


# ---------------------------------------------------------------------------
# Domain payloads
#
# Deliberately plain dataclasses rather than Pydantic models. They are carried
# through a checkpointer, and the value here is a documented shape, not
# validation — the deterministic components that produce them already validate
# their own inputs. Pydantic would add a serialization round-trip per node for
# no correctness gain.
# ---------------------------------------------------------------------------

@dataclass
class MarketSnapshot:
    """Fetched ONCE per run. See the Section 39.4 note in the module docstring."""

    symbol: str
    price: Optional[float]
    # Candles by timeframe, e.g. {"15m": [...]}. Held here so no downstream node
    # re-fetches and reasons over different data on a replay.
    candles: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    fetched_at: Optional[float] = None
    source: Optional[str] = None  # "websocket" | "polled-http-cache"

    def candle_count(self, timeframe: str = "15m") -> int:
        return len(self.candles.get(timeframe, []))


@dataclass
class MarketRegimeState:
    """Spec Section 7's example result shape."""

    regime: Optional[str] = None            # e.g. "Trending Bullish"
    volatility: Optional[str] = None        # "LOW" | "MEDIUM" | "HIGH"
    liquidity: Optional[str] = None
    trend_strength: Optional[float] = None
    confidence: Optional[float] = None
    # Which of the above could not be computed, and why.
    unavailable: List[str] = field(default_factory=list)


@dataclass
class TechnicalAnalysis:
    trend: Optional[str] = None
    multi_timeframe_trend: Optional[str] = None
    support: Optional[float] = None
    resistance: Optional[float] = None
    atr: Optional[float] = None
    rsi: Optional[float] = None
    features: Dict[str, Any] = field(default_factory=dict)


@dataclass
class OrderflowAnalysis:
    """Spec Section 9 requires an Orderflow specialist.

    NOT IMPLEMENTED — there is no order-book feed. The `available` flag exists
    so a node can publish "I could not assess this" rather than the graph
    silently omitting a specialist the Supervisor believes it consulted.
    """

    available: bool = False
    reason: str = "no order-book feed is subscribed"
    imbalance: Optional[float] = None
    aggressor_side: Optional[str] = None


@dataclass
class LiquidityAnalysis:
    """Also a Section 9 specialist, also feed-blocked. Same reasoning."""

    available: bool = False
    reason: str = "no order-book depth feed is subscribed"
    depth_score: Optional[float] = None
    spread_bps: Optional[float] = None


@dataclass
class SentimentAnalysis:
    fear_greed: Optional[int] = None
    classification: Optional[str] = None
    funding_rate: Optional[float] = None
    open_interest: Optional[float] = None
    risk_level: Optional[str] = None       # "normal" | "elevated" | "unknown"
    unavailable: List[str] = field(default_factory=list)


@dataclass
class SpecialistFinding:
    """One specialist's contribution — spec Section 9.

        "Each agent produces structured evidence, not a bare opinion."

    That sentence is the whole design constraint. A specialist returning
    "bullish" is a bare opinion: the Supervisor cannot weigh it, cannot explain
    it, and cannot tell a strong read from a guess. So every finding carries the
    evidence behind it, its own confidence, and — critically — whether it could
    run at all.

    `available=False` is a first-class result, not a failure. Three of the
    seven specialists Section 9 names have no data feed in this system. A
    specialist that silently returned `neutral` when it had no data would be
    indistinguishable from one that looked and found balance, and the Supervisor
    would count a missing input as a vote for doing nothing.
    """

    specialist: str
    # 'directional' | 'constraint'. Not cosmetic — it decides how the debate uses
    # the finding, and conflating the two is a real modelling error.
    #
    # Four of Section 9's seven specialists have evidence about WHICH WAY the
    # market is going (market, orderflow, news, funding). Three do not: liquidity,
    # portfolio and risk answer "is there room to act", which is a different
    # question with a different answer space. A portfolio specialist reporting
    # "you already hold three correlated longs" is not evidence for shorting — but
    # a directional model has nowhere to put that except as a short vote, which
    # would be a fabricated bearish signal derived from your own position book.
    #
    # So constraints cannot vote on direction at all. They cap conviction instead.
    role: str
    available: bool
    # DIRECTIONAL ONLY. 'supports_long' | 'supports_short' | 'neutral', or None.
    stance: Optional[str] = None
    # DIRECTIONAL ONLY. 0.0-1.0 conviction in `stance`. None when unavailable —
    # never 0.0, which would read as "measured and found no conviction".
    confidence: Optional[float] = None
    # CONSTRAINT ONLY. 0.0-1.0: how strongly this specialist argues against acting
    # at full size right now. 0.0 means measured and found no obstacle; None means
    # not measured.
    concern: Optional[float] = None
    evidence: List[str] = field(default_factory=list)
    # Required when available is False. Says WHY, so a missing specialist is
    # explainable rather than merely absent.
    reason_unavailable: Optional[str] = None
    # `available=False` because THE SOURCE DOES NOT APPLY HERE, not because reading
    # it failed. Only meaningful for the `supplementary` role.
    #
    # WHY THIS IS A SEPARATE FLAG AND NOT JUST A WORDING OF `reason_unavailable`:
    # the debate must treat the two causes differently in the ARITHMETIC, and only a
    # field can carry that.
    #
    #   available=False, not_applicable=False  tried and failed. Its weight stays in
    #                                          the coverage denominator, so
    #                                          confidence drops. Honest — this is an
    #                                          engineering gap and `specialists.py`'s
    #                                          refusal to renormalise applies.
    #   available=False, not_applicable=True   the source does not exist for this
    #                                          symbol. Its weight LEAVES the
    #                                          denominator, so confidence is
    #                                          unchanged from a run where the
    #                                          specialist did not exist.
    #
    # Polymarket has deep BTC/ETH markets and nothing for most alts. Counting that
    # absence against coverage would impose a permanent confidence penalty on every
    # uncovered symbol for the absence of a source that cannot apply to it — which
    # would make a supplementary input load-bearing in the wrong direction.
    #
    # `core/risk_manager.py` already draws exactly this line, splitting
    # `'unavailable'` (a caller omitted an input — rejects) from `'delegated'`
    # (structurally uncomputable — reports). A check that can never be computed must
    # not be scored as a check that failed.
    #
    # Defaults False so every existing specialist keeps today's behaviour: a
    # feed-blocked orderflow specialist IS an engineering gap and must keep counting
    # against coverage.
    not_applicable: bool = False

    def signed_weight(self) -> float:
        """Stance as a signed number: positive favours long, negative short.

        An unavailable, neutral or constraint-role specialist contributes exactly
        0.0, and the caller must exclude unavailable ones from the DENOMINATOR too
        — otherwise feed-blocked specialists would silently dilute every verdict
        toward neutral, which is the arithmetic form of counting absent votes.

        `supplementary` votes too, at the small weight `SUPPLEMENTARY_WEIGHTS` gives
        it. It was omitted here when the role was introduced, and the symptom was
        instructive: `run_debate` added the specialist's weight to the DENOMINATOR
        while this method returned 0.0 for its stance, so an agreeing prediction
        market made confidence go DOWN — it widened the panel and then abstained.
        Nothing raised, and the number was plausible. Caught by
        `test_an_agreeing_prediction_adds_conviction`.

        Only `constraint` is excluded, and that exclusion is the point of the role:
        a portfolio book is not a market signal, so it caps conviction instead of
        voting. See the `role` field.
        """
        if self.role not in ("directional", "supplementary"):
            return 0.0
        if not self.available or self.stance is None or self.confidence is None:
            return 0.0
        if self.stance == "supports_long":
            return self.confidence
        if self.stance == "supports_short":
            return -self.confidence
        return 0.0


@dataclass
class DebateVerdict:
    """The debate's structured conclusion (spec Section 9's Debate Agent)."""

    direction: Optional[str] = None          # LONG | SHORT | NEUTRAL
    confidence: Optional[float] = None
    participants: List[str] = field(default_factory=list)
    # Specialists that could not run, named. The Supervisor needs to know the
    # verdict rests on four of seven inputs rather than seven.
    absent: List[str] = field(default_factory=list)
    supporting: List[str] = field(default_factory=list)
    contradicting: List[str] = field(default_factory=list)
    rationale: Optional[str] = None
    # Fraction of the possible DIRECTIONAL weight that was actually available.
    # Confidence is scaled by this, so a verdict from half the panel cannot claim
    # the conviction of a full one.
    coverage: Optional[float] = None
    # The binding constraint's concern level and name, after coverage scaling was
    # applied. Kept separate from `coverage` because "we could not see enough" and
    # "we saw plenty and it says don't" are different reasons for low confidence
    # and lead to different operator actions.
    constraint_applied: Optional[float] = None
    binding_constraint: Optional[str] = None
    # Coverage-scaled agreement BEFORE constraint dampening — "how strongly does
    # the evidence point this way", independent of whether acting is permitted.
    #
    # This exists because of a real invariant-4 violation found by an end-to-end
    # run. The risk specialist reports concern 1.0 when the system is
    # emergency-stopped, which drove `confidence` to exactly 0.0 — and the
    # Supervisor's exit check gated on `confidence`. So at the precise moment a kill
    # switch fired, the system became structurally incapable of recommending that an
    # open position be closed.
    #
    # Both halves were individually correct: a constraint SHOULD stop new risk, and
    # an exit SHOULD need evidence behind it. The bug was using one number for both
    # questions. A constraint has no business suppressing a signal to REDUCE risk —
    # using it that way inverts its meaning.
    #
    # Anything deciding whether to CLOSE must read this field. Anything deciding
    # whether to OPEN must read `confidence`.
    directional_confidence: Optional[float] = None


@dataclass
class MonitoredPosition:
    """One open position, as the monitoring graph sees it (spec Section 13).

    Read from `PositionMonitorAgent`, which is the single source of truth on what
    is open. The graph does not maintain its own position book — two books would
    disagree on a restart, and the one enforcing the stop must be the one that is
    right.
    """

    tar_id: str
    symbol: str
    side: str                                # 'buy' | 'sell' (the ENTRY side)
    tab: str = "paper"
    qty: Optional[float] = None
    entry_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    opened_at_ts: Optional[float] = None
    # Best price reached since entry, in the position's favour. Tracked by the
    # monitor agent, used here to trail a stop.
    peak_price: Optional[float] = None
    current_price: Optional[float] = None
    unrealised_pnl: Optional[float] = None
    unrealised_pct: Optional[float] = None
    # Profit measured in units of the INITIAL risk (entry-to-stop distance). The
    # natural unit for a trailing rule: "1R" means the position has made as much
    # as it was prepared to lose, which is the standard point to protect it.
    r_multiple: Optional[float] = None
    held_seconds: Optional[float] = None


@dataclass
class PositionDecision:
    """Spec Section 13's four outcomes: HOLD | REDUCE | MODIFY | EXIT.

    Deterministic — "Risk rules remain deterministic here too."

    Like `ExecutionPlan`, this object is INERT. Deciding to exit is not exiting:
    the runner turns an EXIT into an `EXECUTION_PLAN_READY` with `intent='close'`,
    which goes down the same ungated close path Phase 29 built, and turns a MODIFY
    into a `tighten_stop` call the monitor agent can refuse.
    """

    action: Optional[str] = None
    reason: Optional[str] = None
    # REDUCE only. A partial close, so it travels the close path too.
    reduce_qty: Optional[float] = None
    # MODIFY only. Enforced tighter-only by `PositionMonitorAgent.tighten_stop`,
    # which is the authority — this field is a request, not an instruction.
    new_stop_loss: Optional[float] = None
    evidence: List[str] = field(default_factory=list)
    # Which of Section 13's nine monitor dimensions could not be evaluated.
    unavailable: List[str] = field(default_factory=list)


@dataclass
class StrategyCandidate:
    """One strategy considered, with why it was or wasn't eligible."""

    name: str
    score: Optional[float] = None
    eligible: bool = True
    # Populated when regime gating muted this strategy, carrying the profile's
    # own `worst_conditions` so the exclusion is explainable.
    gated_out_reason: Optional[str] = None


@dataclass
class TradeThesis:
    """The reasoning for a proposed trade. Section 25's output.

    `narrative` is the one field an LLM writes. Everything else is computed, and
    `contracts.py` prevents an LLM node from writing the computed fields —
    otherwise a model could restate the score it was asked to describe.
    """

    direction: Optional[str] = None         # LONG | SHORT | NEUTRAL
    strategy: Optional[str] = None
    entry_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    supporting_evidence: List[str] = field(default_factory=list)
    contradicting_evidence: List[str] = field(default_factory=list)
    narrative: Optional[str] = None


@dataclass
class TradeDecision:
    """Spec Section 10 — the Supervisor must answer all ten questions."""

    action: Optional[str] = None            # TRADE | WAIT | EXIT | DO_NOT_TRADE
    direction: Optional[str] = None
    size: Optional[float] = None
    leverage: Optional[int] = None
    rationale: Optional[str] = None
    # The ten questions of Section 10, answered. A decision that cannot fill
    # these is not explainable and Section 10 makes that non-negotiable.
    what_happened: Optional[str] = None
    what_is_happening: Optional[str] = None
    why: Optional[str] = None
    what_could_happen_next: Optional[str] = None
    evidence_for: List[str] = field(default_factory=list)
    evidence_against: List[str] = field(default_factory=list)
    probability: Optional[float] = None
    downside: Optional[str] = None
    portfolio_impact: Optional[str] = None
    trade_wait_or_exit: Optional[str] = None


@dataclass
class PortfolioStateSnapshot:
    tab: str = "paper"
    equity: Optional[float] = None
    cash: Optional[float] = None
    open_positions: List[Dict[str, Any]] = field(default_factory=list)
    correlated_clusters: List[List[str]] = field(default_factory=list)
    drawdown_from_hwm: Optional[float] = None


@dataclass
class RiskAssessment:
    """Written ONLY by the deterministic Risk Gateway node.

    `approved` is intentionally not defaulted to True. A risk assessment that
    has not run must not read as an approval — the field starts None, and a
    consumer treating None as approved is a bug the contract test catches.
    """

    approved: Optional[bool] = None
    rejection_reasons: List[str] = field(default_factory=list)
    caution_notes: List[str] = field(default_factory=list)
    checks: Dict[str, Dict[str, str]] = field(default_factory=dict)
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None


@dataclass
class ExecutionPlan:
    """The INERT boundary object (spec Section 12 / Rule 0).

    This is what the graph produces instead of an order. It is a dataclass, not
    an event and not a call: a separate deterministic service converts an
    approved plan into a TAR. The cognitive plane can be entirely wrong and
    still cannot move money.
    """

    symbol: Optional[str] = None
    side: Optional[str] = None
    size: Optional[float] = None
    leverage: Optional[int] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    tab: str = "paper"
    # Derived from decision identity, never from thread_id — see Section 39.3
    # and the note in runtime.py.
    idempotency_basis: Optional[str] = None


@dataclass
class ExecutionResult:
    filled: bool = False
    order_id: Optional[str] = None
    fill_price: Optional[float] = None
    filled_qty: Optional[float] = None
    slippage_bps: Optional[float] = None
    latency_ms: Optional[float] = None
    error: Optional[str] = None


@dataclass
class TradeReflection:
    trade_id: Optional[str] = None
    realized_pnl: Optional[float] = None
    prediction_correct: Optional[bool] = None
    entry_quality: Optional[str] = None
    execution_quality: Optional[str] = None
    lesson: Optional[str] = None
    confidence_calibration_delta: Optional[float] = None


@dataclass
class MemoryContext:
    """Spec Section 15's memory stores, as read into a run."""

    working: Dict[str, Any] = field(default_factory=dict)
    episodic: List[Dict[str, Any]] = field(default_factory=list)
    semantic: List[str] = field(default_factory=list)
    # Section 15's SEVENTH store, added in the Section 14-41 audit. It was missing
    # from both this dataclass and `memory_manager`, which is why
    # `services/procedural_memory.py` had zero callers: there was nowhere for its
    # output to go, so the store existed and was never read.
    procedural: List[Dict[str, Any]] = field(default_factory=list)
    strategy_performance: Dict[str, Any] = field(default_factory=dict)
    risk_events: List[Dict[str, Any]] = field(default_factory=list)
    research_findings: List[Dict[str, Any]] = field(default_factory=list)
    # WHICH stores could not be read, and why. Not decoration: a store that failed
    # and a store that is genuinely empty both return `[]`, and the difference
    # matters most for `risk_events` — "no past risk events" reads as "this system
    # has never been blocked", which is the most reassuring possible wrong answer.
    unavailable: List[str] = field(default_factory=list)


ApprovalStatusValue = Literal[
    "not_required",
    "pending_human",
    "approved",
    "rejected",
]


@dataclass
class ApprovalStatus:
    """Governance. Backs the Section 39.2 `interrupt()` path.

    Defaults to `not_required` rather than `approved`: an un-evaluated approval
    must not read as a granted one.
    """

    status: ApprovalStatusValue = "not_required"
    reason: Optional[str] = None
    decided_by: Optional[str] = None
    decided_at: Optional[float] = None


# ---------------------------------------------------------------------------
# The state itself
# ---------------------------------------------------------------------------

def _merge_unique(left: List[str], right: List[str]) -> List[str]:
    """Reducer for list fields written by concurrent nodes.

    Spec Section 9 fans out several specialists in parallel. Without a reducer,
    LangGraph raises on concurrent writes to the same key; with plain
    `operator.add`, two specialists reporting the same unavailable check would
    duplicate it. Order is preserved so the reason a node ran first is still
    legible.
    """
    seen = list(left)
    for item in right:
        if item not in seen:
            seen.append(item)
    return seen


def _merge_findings(
    left: List["SpecialistFinding"], right: List["SpecialistFinding"]
) -> List["SpecialistFinding"]:
    """Reducer for `specialist_findings` — spec Section 9's parallel fan-out.

    This is the one field in the whole state that genuinely IS accumulated by
    several concurrent writers: seven specialist nodes each append exactly one
    finding. `operator.add` would nearly work, and the `candidate_strategies`
    bug documented below is why "nearly" is not good enough to assume.

    Dedupes on `specialist`, last write winning. Two reasons:

    1. Idempotence. A retried node re-emits its finding; with `operator.add` the
       panel would contain that specialist twice and `coverage` — a fraction of
       available specialists — would exceed the truth.
    2. It makes the reducer safe to reason about without knowing the graph's
       retry policy, which is exactly the kind of coupling that produced the
       18-candidate bug.
    """
    merged = {f.specialist: f for f in left}
    for finding in right:
        merged[finding.specialist] = finding
    return list(merged.values())


# Longest history kept in a bounded accumulator. Generous enough that a single
# run's whole node list survives many times over, small enough that a long-lived
# thread cannot grow without limit.
MAX_ACCUMULATED_HISTORY = 200


def _append_bounded(left: List[Any], right: List[Any]) -> List[Any]:
    """Accumulating reducer that keeps only the most recent entries.

    `operator.add` was correct while every thread lived for one short run. Phase 30
    broke that assumption: the monitoring graph keys its thread on the POSITION, so
    one thread accumulates every sweep for as long as the position is open.

    Observed on the first live run — three sweeps left 33 entries in
    `nodes_visited`, and at a five-minute interval that is roughly 8,000 per week
    per position. Since LangGraph serialises the WHOLE state into the checkpoint on
    every superstep, an unbounded list is not just a large row: it makes every
    write progressively slower for the entire life of the position.

    The recent tail is what has debugging value anyway. The full history lives in
    the trace store, which is append-only files rather than a re-serialised blob.
    """
    combined = list(left) + list(right)
    if len(combined) <= MAX_ACCUMULATED_HISTORY:
        return combined
    return combined[-MAX_ACCUMULATED_HISTORY:]


class TradingState(TypedDict, total=False):
    """Spec Section 4's schema. `total=False` so a node may write a subset.

    Every field is Optional or has a reducer. A node writes only what it
    computed; it never has to invent a value to satisfy the type.
    """

    # --- run identity -------------------------------------------------
    run_id: str
    symbol: str
    trigger: TriggerReason
    started_at: float

    # --- Market (spec Section 4) --------------------------------------
    market_data: Optional[MarketSnapshot]
    market_regime: Optional[MarketRegimeState]

    # --- Analysis ----------------------------------------------------
    technical_analysis: Optional[TechnicalAnalysis]
    orderflow_analysis: Optional[OrderflowAnalysis]
    liquidity_analysis: Optional[LiquidityAnalysis]
    sentiment_analysis: Optional[SentimentAnalysis]

    # --- Strategy ----------------------------------------------------
    # NO REDUCER — this field is REPLACED, not accumulated.
    #
    # It originally carried `Annotated[..., operator.add]`, on the assumption that
    # parallel nodes would each contribute candidates. In practice
    # `strategy_candidates` produces the full list of nine and
    # `strategy_scoring` rewrites the same nine with scores attached — so the
    # reducer appended instead of replacing and the state ended up with 18
    # entries: nine unscored and nine scored, with the unscored ones first.
    #
    # That is worse than a wrong count. Any consumer doing
    # `next(c for c in candidates if c.name == "Trend")` would find the UNSCORED
    # copy and read `score=None`, concluding the strategy was never evaluated.
    # Caught by `test_the_result_reports_the_losing_candidates_with_their_scores`.
    #
    # Accumulating reducers belong on fields that genuinely collect from several
    # writers (`errors`, `unavailable`, `nodes_visited`), not on a field one node
    # refines.
    candidate_strategies: List[StrategyCandidate]
    selected_strategy: Optional[StrategyCandidate]

    # --- Multi-agent analysis (spec Section 9) -------------------------
    # THE one accumulating field with several concurrent writers. See
    # `_merge_findings` for why it is not `operator.add`.
    specialist_findings: Annotated[List[SpecialistFinding], _merge_findings]
    # Written by the single fan-in node, so no reducer.
    debate_verdict: Optional[DebateVerdict]

    # --- Position monitoring (spec Section 13) -------------------------
    monitored_position: Optional[MonitoredPosition]
    # Section 13's nine monitor dimensions, written in parallel by three nodes.
    # Same reducer as `specialist_findings` and for the same reason; a SEPARATE key
    # because conflating an entry panel with a monitoring panel would mean a
    # summary could not tell which question a finding was answering.
    monitor_findings: Annotated[List[SpecialistFinding], _merge_findings]
    position_decision: Optional[PositionDecision]

    # --- Decision ----------------------------------------------------
    trade_thesis: Optional[TradeThesis]
    # The ONLY field the thesis LLM node may write.
    #
    # Kept separate from `trade_thesis` rather than living inside it, because a
    # node writing `trade_thesis` writes the WHOLE object — including
    # `direction`, `entry_price`, `stop_loss` and `take_profit`. A model asked to
    # narrate a thesis would then be structurally able to change the numbers it
    # was describing, and `NodeContract` could not prevent it: the granularity of
    # enforcement is the state key.
    #
    # Splitting the field is what makes "a model may narrate a computed value; it
    # may not replace it" enforceable rather than aspirational. `summarise()`
    # recombines them for output.
    thesis_narrative: Optional[str]
    # `| None` — see deviation 1 in the module docstring.
    confidence: Optional[float]
    decision: Optional[TradeDecision]

    # --- Portfolio ---------------------------------------------------
    portfolio_state: Optional[PortfolioStateSnapshot]

    # --- Risk (deterministic node only) ------------------------------
    risk_assessment: Optional[RiskAssessment]

    # --- Execution (inert request; execution happens outside) ---------
    execution_plan: Optional[ExecutionPlan]
    execution_result: Optional[ExecutionResult]

    # --- Reflection --------------------------------------------------
    reflection: Optional[TradeReflection]

    # --- Memory ------------------------------------------------------
    memory_context: Optional[MemoryContext]

    # --- Governance --------------------------------------------------
    approval_status: ApprovalStatus

    # --- Run bookkeeping (additions to the spec) ----------------------
    # BOUNDED, not `operator.add` — see `_append_bounded`. A checkpointed thread
    # keyed on a long-lived position accumulates these across every sweep, and the
    # whole state is re-serialised on every superstep.
    errors: Annotated[List[NodeError], _append_bounded]
    # Checks that could NOT be evaluated. See deviation 2. Naturally bounded by the
    # number of DISTINCT messages, since `_merge_unique` dedupes.
    unavailable: Annotated[List[str], _merge_unique]
    nodes_visited: Annotated[List[str], _append_bounded]
    llm_calls_made: int
    llm_tokens_used: int


def new_state(
    run_id: str,
    symbol: str,
    trigger: TriggerReason,
    started_at: float,
) -> TradingState:
    """A fresh state for one run.

    Collections are initialised empty and scalars to None. Nothing is
    pre-populated with a plausible default, because a default here is
    indistinguishable downstream from a measured value.
    """
    return TradingState(
        run_id=run_id,
        symbol=symbol,
        trigger=trigger,
        started_at=started_at,
        market_data=None,
        market_regime=None,
        technical_analysis=None,
        orderflow_analysis=None,
        liquidity_analysis=None,
        sentiment_analysis=None,
        candidate_strategies=[],
        selected_strategy=None,
        specialist_findings=[],
        monitored_position=None,
        monitor_findings=[],
        position_decision=None,
        debate_verdict=None,
        trade_thesis=None,
        thesis_narrative=None,
        confidence=None,
        decision=None,
        portfolio_state=None,
        risk_assessment=None,
        execution_plan=None,
        execution_result=None,
        reflection=None,
        memory_context=None,
        approval_status=ApprovalStatus(),
        errors=[],
        unavailable=[],
        nodes_visited=[],
        llm_calls_made=0,
        llm_tokens_used=0,
    )


# Every writable key. `contracts.py` validates a node's declared writes against
# this, so a typo in a contract is caught at registration instead of producing a
# silently-ignored state write.
STATE_FIELDS: frozenset = frozenset(TradingState.__annotations__.keys())

# Fields only a deterministic node may write. An LLM node writing these would
# let a model overwrite computed risk or measured market data with prose.
DETERMINISTIC_ONLY_FIELDS: frozenset = frozenset({
    "market_data",
    "market_regime",
    "technical_analysis",
    "risk_assessment",
    "execution_plan",
    "execution_result",
    "portfolio_state",
    "confidence",
    # `trade_thesis` holds the computed direction, entry, stop and target. Only a
    # deterministic node may write it; the LLM writes `thesis_narrative` instead.
    "trade_thesis",
    "selected_strategy",
    "candidate_strategies",
    # Spec Section 9. The debate verdict carries a direction and a confidence
    # that the Supervisor and risk sizing both read. It is produced by weighing
    # numbers already in state, so a model adds hallucination risk to a financial
    # decision for no gain — and, unlike a model, the weighting is reproducible,
    # which is what makes a past decision auditable and backtestable.
    "debate_verdict",
    # A specialist's finding IS its evidence. Letting a model write this key
    # would let it invent an order-book imbalance for a feed that is not
    # subscribed — invariant 6, in the one place it would be least visible.
    "specialist_findings",
    # Spec Section 10. `TradeDecision` is the audit record: the action, the ten
    # answers, and the probability. All ten answers are computable from state, so
    # there is no judgement here for a model to add — and a model writing this key
    # would write the whole object, including `action` and `probability`. Prose
    # about the decision belongs in `thesis_narrative`, which the narrative node
    # writes AFTER this one.
    "decision",
    # Spec Section 13: "Risk rules remain deterministic here too." A model writing
    # `position_decision` could produce EXIT on a healthy position or — worse — a
    # `new_stop_loss`. `tighten_stop` would refuse to WIDEN one, but a model
    # inventing a TIGHTER stop would close a position early on a number nobody
    # measured, and that refusal would not catch it.
    "position_decision",
    # The position book itself. A model writing this could invent a quantity or an
    # entry price, and every monitoring number downstream is computed from them.
    "monitored_position",
    "monitor_findings",
})

# Written exactly once, by the first node. Section 39.4: a re-fetch on replay
# would reason over a different market than the original decision.
WRITE_ONCE_FIELDS: frozenset = frozenset({"market_data"})
