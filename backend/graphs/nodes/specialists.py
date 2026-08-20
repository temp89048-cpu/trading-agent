"""Phase 26 — Multi-Agent Analysis (spec Section 9).

                       Market Agent
                            |
        Liquidity ----------+
                            |
        Orderflow ----------+
                            |
        News --------------+---->  Debate Agent  ---->  Supervisor
                            |
        Funding ------------+
                            |
        Portfolio ----------+
                            |
        Risk ---------------+

    "Each agent produces structured evidence, not a bare opinion."

THE FIRST FAN-OUT, AND WHAT THAT ACTUALLY COSTS
-----------------------------------------------
Every node before this one ran in sequence, so "what writes this key" had a
single answer. Seven nodes now execute in one superstep, and LangGraph raises
`InvalidUpdateError` on two concurrent writes to a key with no reducer. That is
the good failure. The bad one is a reducer that was assumed rather than chosen —
`candidate_strategies` carried `operator.add` on an assumption and silently
produced 18 entries where 9 were expected, half of them stale.

So every key written in this superstep was decided explicitly:

  specialist_findings   dedupe-by-name reducer (`_merge_findings`) — SEVEN writers
  unavailable           `_merge_unique` — several writers, duplicates collapse
  orderflow_analysis    ONE writer (orderflow specialist)      — no reducer
  liquidity_analysis    ONE writer (liquidity specialist)      — no reducer
  portfolio_state       ONE writer (portfolio specialist)      — no reducer
  errors/nodes_visited  `operator.add`, already correct for many writers

`sentiment_analysis` is deliberately NOT written here. The funding specialist
READS what Phase 24's `market_analysis` node already fetched. Re-fetching in
parallel would mean two HTTP calls per run for one number, and — worse — the
funding specialist could then disagree with the market state about the funding
rate within a single run.

NO LLM NODE IN THE FAN-OUT, AND THAT IS DELIBERATE
--------------------------------------------------
`llm_calls_made` and `llm_tokens_used` are plain ints with no reducer, because
until now only one node ever incremented them. Two concurrent LLM nodes would
both write them and LangGraph would raise — and the naive fix (an `operator.add`
reducer) is wrong, because these nodes compute `(state.get(...) or 0) + 1`, so
adding the two deltas would double-count the base.

That is a real constraint worth stating rather than discovering later. It does
not bite here: all seven specialists are deterministic. Which they should be
anyway — six of them read numbers already in state, and asking a model to
re-read numbers it was handed adds hallucination risk to a financial decision
for no benefit and destroys reproducibility.

THREE OF SEVEN CANNOT RUN, AND SAY SO
-------------------------------------
Orderflow, Liquidity and News have no data feed in this system. Not "a weak
feed" — none. They ship with `available=False` and a named blocker.

The alternative was approximating them, and it is worth being concrete about why
that is worse than absence. An orderflow specialist that derived "buy pressure"
from candle body direction would be reporting a fact about the last close under
a name that means order-book aggressor flow. It would look like independent
confirmation of the market specialist while being a restatement of it — the same
evidence counted twice, which raises confidence precisely when it should not.
`DebateVisualizer`'s hardcoded "EMA 9 crossed above EMA 21" was this bug in its
most visible form; this would be the same bug where nobody could see it.

DIRECTIONAL vs CONSTRAINT
-------------------------
See `SpecialistFinding.role`. Four specialists vote on direction; three cap
conviction and cannot vote. A portfolio book is not a market signal.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.algorithms.debate import (
    NEUTRAL_BAND,
    score_debate,
)
from backend.core import system_state
from backend.core.risk_manager import max_leverage_ceiling
from backend.graphs.contracts import NodeContract
from backend.graphs.registry import register_node
from backend.graphs.state import (
    DebateVerdict,
    LiquidityAnalysis,
    OrderflowAnalysis,
    PortfolioStateSnapshot,
    SpecialistFinding,
    TradingState,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Panel weights
# ---------------------------------------------------------------------------
#
# Only DIRECTIONAL specialists have a weight, because only they vote. The
# numbers express how directly a specialist observes price, which is the only
# defensible basis available — none of these has a validated track record on this
# system's own data, exactly as with the strategy profiles.
#
# The Market specialist dominates on purpose: it is the only leg looking at
# actual candles. Funding is a real but weak and often contrarian signal. News
# and Orderflow carry the weight they WOULD have, so `coverage` reports the true
# fraction of the panel that is missing rather than flattering itself by
# renormalising over what happens to be wired up.
DIRECTIONAL_WEIGHTS: Dict[str, float] = {
    "market": 3.0,
    "orderflow": 1.5,
    "news": 1.5,
    "funding": 1.0,
}

TOTAL_DIRECTIONAL_WEIGHT = sum(DIRECTIONAL_WEIGHTS.values())

# ---------------------------------------------------------------------------
# Supplementary weights — Phase 35, a THIRD tier
# ---------------------------------------------------------------------------
#
# A supplementary specialist is one extra layer of information: it may add or
# subtract conviction when it has something to say, and must cost nothing when it
# does not apply.
#
# THIS TIER EXISTS BECAUSE THE TWO EXISTING ONES BOTH GET IT WRONG.
#
# As a plain directional specialist, `prediction`'s weight would join
# TOTAL_DIRECTIONAL_WEIGHT permanently — imposing a ~12.5% confidence penalty on
# every symbol Polymarket does not cover (which is most of them; it has deep BTC and
# ETH markets and little else). An input that makes the agent less willing to trade
# SOL because a Bitcoin prediction market exists is not supplementary.
#
# As a constraint it could only ever reduce conviction (constraints combine with
# `max()`), so a prediction market agreeing with the thesis could never add anything
# — which throws away the half of the signal that is actually useful.
#
# So: weight counted in the denominator only when the specialist is either available
# or genuinely FAILED. See `SpecialistFinding.not_applicable` for why "the source
# does not exist for this symbol" is arithmetically different from "we could not
# read it", and `core/risk_manager.py`'s 'unavailable' vs 'delegated' split for the
# same distinction already drawn elsewhere in this codebase.
#
# Populated ONLY when `settings.POLYMARKET_ENABLED` — see `supplementary_weights()`.
# With the flag off this is empty, no node is registered, and every confidence number
# is byte-identical to Phase 34.
SUPPLEMENTARY_WEIGHTS: Dict[str, float] = {
    # 1.0 — equal to funding, one third of market. A prediction market on a dated
    # threshold is a real but indirect observation of spot: it prices a TERMINAL
    # distribution, not the next 15-minute candle. Claiming more would assert a
    # track record this system has never measured, exactly as the core weights note.
    "prediction": 1.0,
}


def supplementary_weights() -> Dict[str, float]:
    """Active supplementary weights. Empty unless the feature is enabled.

    Read at call time rather than captured at import so a test can flip the flag,
    and so enabling it does not require a restart to take effect consistently across
    the two places that need it (`run_debate` and node registration).
    """
    from backend.core.config import settings

    if not settings.POLYMARKET_ENABLED:
        return {}
    return dict(SUPPLEMENTARY_WEIGHTS)


CONSTRAINT_SPECIALISTS = ("liquidity", "portfolio", "risk")

# Constraints added by Phase 35, active only with POLYMARKET_ENABLED. Kept separate
# from the tuple above so the base panel's composition is unchanged when the feature
# is off, and so `constraint_specialists()` is the single place that combines them.
OPTIONAL_CONSTRAINT_SPECIALISTS = ("event_risk",)


def constraint_specialists() -> Tuple[str, ...]:
    """Active constraint specialists, base plus any enabled optional ones."""
    from backend.core.config import settings

    if not settings.POLYMARKET_ENABLED:
        return CONSTRAINT_SPECIALISTS
    return CONSTRAINT_SPECIALISTS + OPTIONAL_CONSTRAINT_SPECIALISTS

# Funding this far from zero is a crowded-positioning signal. Same threshold the
# thesis evidence gatherer already uses, referenced rather than re-picked so the
# two cannot drift apart and contradict each other in one run.
FUNDING_CROWDED_ABS = 0.001

# A book this concentrated in one symbol is a reason to reduce conviction. Not a
# hard cap — the Risk Gateway (Phase 28) owns hard caps; this is an analyst's
# concern, and the two must not be confused.
CONCENTRATION_WARN_PCT = 20.0


def _no_feed(
    specialist: str, role: str, reason: str, evidence: List[str]
) -> SpecialistFinding:
    """A specialist that could not run. Never a neutral vote."""
    return SpecialistFinding(
        specialist=specialist,
        role=role,
        available=False,
        stance=None,
        confidence=None,
        concern=None,
        evidence=evidence,
        reason_unavailable=reason,
    )


# ===========================================================================
# 1. Market specialist (directional)
# ===========================================================================

def specialist_market(state: TradingState) -> Optional[Dict[str, Any]]:
    """Directional evidence from price itself.

    Delegates to `algorithms/debate.score_debate` rather than re-deriving trend,
    structure, momentum, volume and volatility. That function is already the
    deterministic, unit-tested scorer this system uses, and it already scales its
    own confidence by how many of its checks it could evaluate.

    Reusing it also removes a double-counting trap. The obvious alternative was
    for the debate NODE to call `score_debate` as a separate leg alongside the
    panel — but the Market specialist reads the same candles, so the same evidence
    would have entered the verdict twice under two names. Making `score_debate`
    BE the market specialist means it is counted exactly once.
    """
    snapshot = state.get("market_data")
    if snapshot is None:
        return {
            "specialist_findings": [
                _no_feed("market", "directional", "no market data in state", [])
            ],
            "unavailable": ["market specialist (no market data)"],
        }

    bars = snapshot.candles.get("15m") or []
    result = score_debate(bars)

    # `score_debate` returns NEUTRAL/0.0 with `unavailable=['all checks']` when it
    # has too few candles. That is its refusal, and it must not be recorded as a
    # measured neutral — otherwise "not enough history" becomes a vote for
    # balance, which is the exact confusion this whole module is built to avoid.
    if result.unavailable and "all checks" in result.unavailable:
        return {
            "specialist_findings": [
                _no_feed(
                    "market",
                    "directional",
                    result.rationale,
                    [f"{len(bars)} candle(s) on 15m"],
                )
            ],
            "unavailable": [f"market specialist ({result.rationale})"],
        }

    stance = {
        "LONG": "supports_long",
        "SHORT": "supports_short",
        "NEUTRAL": "neutral",
    }[result.direction]

    evidence = [f"{a.name} ({a.score:+.2f}) {a.detail}" for a in result.bull_arguments]
    evidence += [f"{a.name} ({a.score:+.2f}) {a.detail}" for a in result.bear_arguments]
    if result.unavailable:
        evidence.append(f"checks not evaluated: {', '.join(result.unavailable)}")

    finding = SpecialistFinding(
        specialist="market",
        role="directional",
        available=True,
        stance=stance,
        confidence=result.confidence,
        evidence=evidence,
    )
    logger.debug(
        "Market specialist on %s: %s @ %.2f from %d argument(s)",
        state["symbol"], stance, result.confidence,
        len(result.bull_arguments) + len(result.bear_arguments),
    )
    return {"specialist_findings": [finding]}


# ===========================================================================
# 2. Orderflow specialist (directional) — NO FEED
# ===========================================================================

ORDERFLOW_BLOCKER = (
    "no order-book or trade-tape feed is subscribed: aggressor side and bid/ask "
    "imbalance require level-2 depth and per-trade taker flags, and this system "
    "consumes only OHLCV candles and mark price"
)


def specialist_orderflow(state: TradingState) -> Optional[Dict[str, Any]]:
    """Order-book aggressor flow. Cannot run — and does not pretend to.

    Also writes `orderflow_analysis` so the state's own schema carries the same
    refusal, rather than leaving a None that a later reader might interpret as
    "not yet computed" and try to fill in.
    """
    return {
        "orderflow_analysis": OrderflowAnalysis(
            available=False,
            reason=ORDERFLOW_BLOCKER,
        ),
        "specialist_findings": [
            _no_feed(
                "orderflow",
                "directional",
                ORDERFLOW_BLOCKER,
                [
                    "would need: level-2 depth snapshots + trade tape with taker side",
                    "candle body direction is NOT a substitute — it restates the "
                    "market specialist's evidence under a different name",
                ],
            )
        ],
        "unavailable": [f"orderflow specialist ({ORDERFLOW_BLOCKER})"],
    }


# ===========================================================================
# 3. Liquidity specialist (constraint) — NO DEPTH FEED
# ===========================================================================

LIQUIDITY_BLOCKER = (
    "no order-book depth feed is subscribed: executable depth and spread require "
    "level-2 quotes, and traded volume is not a substitute for them"
)


def specialist_liquidity(state: TradingState) -> Optional[Dict[str, Any]]:
    """Executable depth and spread. Cannot run.

    A constraint, not a voter: thin depth is a reason to size down or skip, never
    a reason to pick a side.

    It reports the volume proxy Phase 24 already computed as a POINTER, clearly
    labelled as not being depth. Naming what exists and what it is not is more
    useful to an operator than silence, and it is not the same as substituting one
    for the other — the finding stays `available=False` and contributes no
    concern value at all.
    """
    regime = state.get("market_regime")
    evidence = [
        "would need: level-2 bid/ask depth for spread (bps) and executable size",
    ]
    if regime is not None and regime.liquidity:
        evidence.append(
            f"a traded-VOLUME proxy exists in market_regime.liquidity "
            f"('{regime.liquidity}'); it is NOT order-book depth and cannot bound "
            f"slippage or fillable size"
        )

    return {
        "liquidity_analysis": LiquidityAnalysis(
            available=False,
            reason=LIQUIDITY_BLOCKER,
        ),
        "specialist_findings": [
            _no_feed("liquidity", "constraint", LIQUIDITY_BLOCKER, evidence)
        ],
        "unavailable": [f"liquidity specialist ({LIQUIDITY_BLOCKER})"],
    }


# ===========================================================================
# 4. News specialist (directional) — NO FEED
# ===========================================================================

NEWS_BLOCKER = (
    "no news, filing or social feed is ingested anywhere in this backend: there "
    "is no headline source to score, so event risk around this symbol is unknown "
    "rather than absent"
)


def specialist_news(state: TradingState) -> Optional[Dict[str, Any]]:
    """Headline and event risk. Cannot run.

    The distinction the `reason` is careful about: "no news feed" must not be read
    downstream as "no news". An unmeasured event risk is the most dangerous kind
    of missing input, because a scheduled listing, unlock or regulatory
    announcement invalidates a technical thesis entirely and leaves every other
    specialist looking healthy.
    """
    return {
        "specialist_findings": [
            _no_feed(
                "news",
                "directional",
                NEWS_BLOCKER,
                [
                    "would need: a headline feed with symbol tagging and timestamps",
                    "unknown event risk is not the same as no event risk — a "
                    "scheduled unlock or listing would invalidate a technical "
                    "thesis without any other specialist noticing",
                ],
            )
        ],
        "unavailable": [f"news specialist ({NEWS_BLOCKER})"],
    }


# ===========================================================================
# 5. Funding specialist (directional) — REAL DATA
# ===========================================================================

def specialist_funding(state: TradingState) -> Optional[Dict[str, Any]]:
    """Perpetual funding and Fear & Greed as crowding evidence.

    Reads `sentiment_analysis`, already fetched once by Phase 24. Does not fetch.

    CONTRARIAN BY CONSTRUCTION, and that needs justifying rather than asserting:
    funding is paid by the crowded side. Positive funding means longs are paying
    to hold, which is evidence that long positioning is crowded — so it counts as
    weak evidence for the SHORT side, not the long one. It carries the panel's
    lowest weight because crowding can persist for a long time in a real trend,
    and being early on a crowding signal is indistinguishable from being wrong.
    """
    sentiment = state.get("sentiment_analysis")
    if sentiment is None:
        return {
            "specialist_findings": [
                _no_feed("funding", "directional", "no sentiment data in state", [])
            ],
            "unavailable": ["funding specialist (no sentiment data in state)"],
        }

    funding = sentiment.funding_rate
    fng = sentiment.fear_greed

    if funding is None and fng is None:
        return {
            "specialist_findings": [
                _no_feed(
                    "funding",
                    "directional",
                    "neither funding rate nor Fear & Greed could be fetched",
                    list(sentiment.unavailable),
                )
            ],
            "unavailable": ["funding specialist (no funding rate and no Fear & Greed)"],
        }

    # Signed conviction, accumulated from whichever inputs exist. Positive means
    # crowding favours a SHORT.
    short_bias = 0.0
    measured = 0.0
    evidence: List[str] = []

    if funding is not None:
        measured += 1.0
        if abs(funding) > FUNDING_CROWDED_ABS:
            # Scaled so 3x the threshold saturates. A funding rate ten times
            # normal is not ten times the evidence.
            magnitude = min(1.0, abs(funding) / (FUNDING_CROWDED_ABS * 3.0))
            short_bias += magnitude if funding > 0 else -magnitude
            crowded = "longs are" if funding > 0 else "shorts are"
            evidence.append(
                f"funding rate {funding:+.5f} — {crowded} paying to hold, so that "
                f"side is crowded (crowded threshold {FUNDING_CROWDED_ABS})"
            )
        else:
            evidence.append(
                f"funding rate {funding:+.5f} is within the neutral band "
                f"(+/-{FUNDING_CROWDED_ABS}) — no crowding evidence either way"
            )
    else:
        evidence.append("funding rate unavailable")

    if fng is not None:
        measured += 1.0
        # Extremes only. 40-60 carries no information and pretending otherwise
        # would manufacture a signal out of the middle of the range.
        if fng >= 75:
            short_bias += min(1.0, (fng - 75) / 25.0 + 0.3)
            evidence.append(f"Fear & Greed {fng} ({sentiment.classification}) — greed extreme")
        elif fng <= 25:
            short_bias -= min(1.0, (25 - fng) / 25.0 + 0.3)
            evidence.append(f"Fear & Greed {fng} ({sentiment.classification}) — fear extreme")
        else:
            evidence.append(
                f"Fear & Greed {fng} ({sentiment.classification}) is mid-range — "
                f"no positioning signal"
            )
    else:
        evidence.append("Fear & Greed unavailable")

    net = short_bias / measured if measured else 0.0

    if abs(net) < NEUTRAL_BAND:
        stance, conviction = "neutral", 0.0
    elif net > 0:
        stance, conviction = "supports_short", min(1.0, abs(net))
    else:
        stance, conviction = "supports_long", min(1.0, abs(net))

    # Scaled by how many of the two inputs were actually measured, matching the
    # coverage discipline `score_debate` already applies.
    conviction *= measured / 2.0
    if measured < 2.0:
        evidence.append(
            f"conviction scaled to {measured / 2.0 * 100:.0f}% — only "
            f"{int(measured)} of 2 inputs measured"
        )

    return {
        "specialist_findings": [
            SpecialistFinding(
                specialist="funding",
                role="directional",
                available=True,
                stance=stance,
                confidence=conviction,
                evidence=evidence,
            )
        ]
    }


# ===========================================================================
# 6. Portfolio specialist (constraint) — REAL DATA
# ===========================================================================

async def specialist_portfolio(state: TradingState) -> Optional[Dict[str, Any]]:
    """What is already held, and whether there is room for more.

    A constraint. Existing exposure is a fact about the book, not about the
    market, and turning "I already hold this" into a directional vote would let
    the portfolio manufacture a market signal out of itself.

    Also the only writer of `portfolio_state`, which the Risk Gateway (Phase 28)
    and the Supervisor (Phase 27) both read.
    """
    from backend.services.portfolio_store import get_portfolio

    tab = "paper"
    try:
        book = await get_portfolio()
    except Exception as exc:  # noqa: BLE001 - degrade honestly, never guess a book
        return {
            "specialist_findings": [
                _no_feed("portfolio", "constraint", f"portfolio read failed: {exc}", [])
            ],
            "unavailable": [f"portfolio specialist (read failed: {exc})"],
        }

    side = book.get(tab) or {}
    positions: List[Dict[str, Any]] = list(side.get("positions") or [])
    cash = side.get("cash")

    # Notional of open positions at ENTRY cost. Deliberately not marked to market:
    # this node is not given per-symbol prices for every held symbol, and fetching
    # them here would be a second market-data path that could disagree with
    # `market_data` within one run. The evidence string says which it is, so a
    # reader is not left guessing.
    held_notional = 0.0
    for pos in positions:
        try:
            held_notional += abs(float(pos["qty"])) * float(pos["avgCost"])
        except (KeyError, TypeError, ValueError):
            continue

    equity: Optional[float] = None
    if cash is not None:
        try:
            equity = float(cash) + held_notional
        except (TypeError, ValueError):
            equity = None

    snapshot = PortfolioStateSnapshot(
        tab=tab,
        equity=equity,
        cash=float(cash) if cash is not None else None,
        open_positions=positions,
        # Correlation clustering belongs to the CIO agent, which fetches 180 4h
        # candles per held symbol. Doing that inside a parallel analysis node
        # would add seconds of network I/O to every run and duplicate a
        # computation that already has an owner. Left empty, and named as absent
        # in the evidence rather than implied to be "no correlations found".
        correlated_clusters=[],
        # Owned by the CEO agent, which tracks the high-water mark across runs.
        # A per-run node has no memory of a previous peak and cannot compute it.
        drawdown_from_hwm=None,
    )

    symbol = state["symbol"]
    base = symbol.split("/")[0]
    same_symbol = [
        p for p in positions
        if str(p.get("symbol", "")).split("/")[0].upper() == base.upper()
    ]

    evidence: List[str] = [
        f"{len(positions)} open position(s) on the {tab} book",
        "position notional is measured at ENTRY cost, not marked to market",
        "correlated-cluster analysis not run here — owned by the CIO agent",
        "drawdown from high-water mark not available here — owned by the CEO agent",
    ]
    concern = 0.0

    if same_symbol:
        existing = sum(
            abs(float(p["qty"])) * float(p["avgCost"])
            for p in same_symbol
            if p.get("qty") is not None and p.get("avgCost") is not None
        )
        evidence.append(
            f"already holding {base}: {len(same_symbol)} position(s), "
            f"${existing:,.2f} at entry cost — adding here concentrates rather "
            f"than diversifies"
        )
        concern = max(concern, 0.4)
        if equity and equity > 0:
            pct = existing / equity * 100.0
            evidence.append(f"{base} is {pct:.1f}% of ${equity:,.2f} equity")
            if pct > CONCENTRATION_WARN_PCT:
                concern = max(concern, min(0.8, pct / 100.0 + 0.3))

    if equity is None:
        evidence.append(
            "equity could not be computed (no cash figure on this book), so "
            "concentration is expressed in dollars only, not as a percentage"
        )

    return {
        "portfolio_state": snapshot,
        "specialist_findings": [
            SpecialistFinding(
                specialist="portfolio",
                role="constraint",
                available=True,
                concern=concern,
                evidence=evidence,
            )
        ],
    }


# ===========================================================================
# 7. Risk specialist (constraint) — REAL DATA
# ===========================================================================

def specialist_risk(state: TradingState) -> Optional[Dict[str, Any]]:
    """Whether governance and measurability permit acting at all.

    A constraint, and specifically NOT the Risk Gateway. It writes no
    `risk_assessment`: that field belongs to Phase 28, which validates a SIZED
    request against hard limits and can reject. This node runs before any size
    exists and can only reduce conviction. Keeping the two apart matters — a
    system with two things that both look like the risk gate is a system where
    nobody can say which one actually blocked a trade.

    Reads the live kill-switch rather than recomputing drawdown, because
    observation mode IS the CEO's drawdown verdict already surfaced. Recomputing
    it here would create a second, differently-timed answer to one question.
    """
    # The PREDICATE functions, not `snapshot()` dict keys.
    #
    # This was written against guessed key names first, and `dict.get()` returned
    # None for every one of them — so the node reported "no governance block
    # active" while the system was paused, which is the most dangerous possible
    # direction for that mistake to fail in. A misspelled predicate is an
    # ImportError; a misspelled dict key is a confident wrong answer.
    emergency_stopped = system_state.is_emergency_stopped()
    paused = system_state.is_system_paused()
    observing = system_state.is_in_observation_mode()

    regime = state.get("market_regime")
    technical = state.get("technical_analysis")

    evidence: List[str] = []
    concern = 0.0

    if emergency_stopped:
        concern = 1.0
        evidence.append(
            "EMERGENCY STOP is active — no new position may be opened "
            "(exits remain permitted)"
        )
    elif paused:
        concern = 1.0
        evidence.append(
            "system is PAUSED — no new position may be opened "
            "(exits remain permitted)"
        )
    elif observing:
        concern = max(concern, 0.9)
        evidence.append(
            f"system is in OBSERVATION MODE: {system_state.observation_reason()} "
            f"— the CEO's drawdown mandate has already fired"
        )
    else:
        evidence.append("no governance block active (not paused, stopped or observing)")

    # Invariant 3 lives in the Risk Gateway and in `detect_opportunity`, both of
    # which hard-reject. Here it is only reported, because a specialist's job is
    # to hand the Supervisor evidence — an analyst that could veto would be a
    # second gate, which is what this node exists not to be.
    if technical is None or technical.atr is None:
        concern = max(concern, 0.7)
        evidence.append(
            "ATR unavailable, so no stop-loss can be computed — every position "
            "requires one, so this alone will block execution downstream"
        )
    else:
        evidence.append(f"ATR {technical.atr:.8g} is available, so a stop can be computed")

    if regime is not None:
        if regime.volatility == "HIGH":
            concern = max(concern, 0.5)
            evidence.append(
                "HIGH volatility regime — a wider stop is required, which means "
                "smaller size for the same dollar risk"
            )
        if regime.confidence is not None and regime.confidence < 0.75:
            concern = max(concern, 0.5)
            evidence.append(
                f"market-state coverage {regime.confidence:.2f} — a material share "
                f"of inputs could not be measured (this is coverage, not a probability)"
            )
    else:
        concern = max(concern, 0.6)
        evidence.append("no market regime determined — conditions are unclassified")

    # Both ceilings are reported rather than the one for "this book", because this
    # node CANNOT know which book it is. `portfolio_state` is written by
    # `specialist_portfolio` in the SAME superstep, and parallel nodes all see the
    # state as it was when the superstep began — so reading it here would reliably
    # find None and silently default to "paper", which would be a confident claim
    # about the leverage limit on an account this node never looked at.
    #
    # This is the fan-out's sharpest edge: in a sequential graph reading a sibling
    # node's output is ordinary, and here it is always stale.
    evidence.append(
        f"leverage ceiling is {max_leverage_ceiling('real')}x on real money and "
        f"{max_leverage_ceiling('paper')}x on paper, and is not overridable by any "
        f"setting, agent or confidence level"
    )

    return {
        "specialist_findings": [
            SpecialistFinding(
                specialist="risk",
                role="constraint",
                available=True,
                concern=concern,
                evidence=evidence,
            )
        ]
    }


# ===========================================================================
# 7b/7c. Polymarket specialists (Phase 35) — SUPPLEMENTARY and CONSTRAINT
# ===========================================================================
#
# One extra layer of information. Neither node fetches anything: both read the
# snapshot that the Polymarket worker computed, for the same reason the funding
# specialist reads `sentiment_analysis` rather than re-fetching it — two nodes
# fetching the same number in one run can disagree about it, and a network call
# inside a seven-way fan-out makes the panel's latency the sum of seven timeouts.
#
# Both are registered ONLY when `settings.POLYMARKET_ENABLED`, so with the flag off
# they do not exist and no confidence number changes.

PREDICTION_NOT_APPLICABLE = (
    "no confirmed Polymarket market resolves to this symbol. Polymarket has deep "
    "BTC and ETH markets and little else, so this is the expected result for most "
    "symbols — it means the source does not apply here, NOT that the crowd has no "
    "view, and it is deliberately not counted against panel coverage"
)

PREDICTION_STALE = (
    "no fresh Polymarket snapshot: a mapping exists but the last computed signal is "
    "older than the staleness limit or was never written. A stale probability "
    "presented as current evidence would be weighted as a live reading, so it is "
    "reported as missing — and this DOES count against coverage, because unlike the "
    "not-applicable case it is an engineering gap"
)


def _read_snapshot(symbol: str) -> Optional[Dict[str, Any]]:
    """Read the latest snapshot for `symbol`. None when absent, stale or unreadable.

    Synchronous, because `run_debate` and every specialist are synchronous by design
    (deterministic pure arithmetic). The store's public getter is async only because
    WRITES serialise behind a lock; reading just parses the file, so the read path is
    used directly rather than making the whole panel async for one file read.

    Never raises. A missing or corrupt snapshot must produce `available=False` with a
    reason, not a failed graph run.
    """
    try:
        from backend.services import polymarket_store

        snapshots = polymarket_store._read(polymarket_store.SNAPSHOT_FILE, {})
        record = snapshots.get(symbol)
        if not isinstance(record, dict):
            return None

        computed_at = record.get("computedAt")
        if not isinstance(computed_at, (int, float)):
            return None
        # `abs()` so a snapshot timestamped in the future is refused too — a clock
        # change must not make stale data look permanently fresh.
        if abs(time.time() - float(computed_at)) > polymarket_store.MAX_SNAPSHOT_AGE_SECONDS:
            return None
        return record
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not read the Polymarket snapshot for %s: %s", symbol, exc)
        return None


def specialist_prediction(state: TradingState) -> Optional[Dict[str, Any]]:
    """Prediction-market evidence. SUPPLEMENTARY — one extra layer, never the basis.

    Reports three distinct states, and the difference between the last two is the
    whole design:

      available        a fresh, computable signal. Joins the vote at weight 1.0 of
                       8.0, so it can shade conviction and cannot carry a decision
                       (see `SUPPLEMENTARY_WEIGHTS` and Guard A in `run_debate`).
      not_applicable   no confirmed market resolves to this symbol. Costs nothing —
                       coverage is exactly what it would be without this node.
      unavailable      a market IS mapped but the snapshot is stale or the signal was
                       uncomputable. Counts against coverage, because that is a real
                       engineering gap rather than an inapplicable source.
    """
    symbol = state["symbol"]
    snapshot = _read_snapshot(symbol)

    if snapshot is None or snapshot.get("applicable") is not True:
        reason = PREDICTION_NOT_APPLICABLE
        if snapshot is not None:
            reason = snapshot.get("reasonNotApplicable") or PREDICTION_NOT_APPLICABLE
        return {
            "specialist_findings": [
                SpecialistFinding(
                    specialist="prediction",
                    role="supplementary",
                    available=False,
                    not_applicable=True,
                    evidence=[
                        "supplementary source: its absence is not scored against the panel",
                    ],
                    reason_unavailable=reason,
                )
            ],
            # Deliberately NOT added to `unavailable`. That list answers "why did
            # nothing trade?", and a source that does not apply to this symbol is not
            # a reason a trade did not happen — listing it there would put a
            # permanent, misleading line in every alt-coin run's explanation.
        }

    directional = snapshot.get("directional")
    if not isinstance(directional, dict):
        return {
            "specialist_findings": [
                SpecialistFinding(
                    specialist="prediction",
                    role="supplementary",
                    available=False,
                    not_applicable=False,
                    evidence=["a market IS mapped to this symbol, so this gap is counted"],
                    reason_unavailable=PREDICTION_STALE,
                )
            ],
            "unavailable": ["prediction specialist (stale or uncomputable snapshot)"],
        }

    direction = directional.get("direction")
    conviction = directional.get("confidence")
    if direction not in ("LONG", "SHORT", "NEUTRAL") or not isinstance(
        conviction, (int, float)
    ) or isinstance(conviction, bool):
        return {
            "specialist_findings": [
                SpecialistFinding(
                    specialist="prediction",
                    role="supplementary",
                    available=False,
                    not_applicable=False,
                    reason_unavailable=(
                        f"malformed snapshot: direction={direction!r}, "
                        f"confidence={conviction!r}"
                    ),
                )
            ],
            "unavailable": ["prediction specialist (malformed snapshot)"],
        }

    stance = {
        "LONG": "supports_long",
        "SHORT": "supports_short",
        "NEUTRAL": "neutral",
    }[direction]

    total_with_supplementary = (
        TOTAL_DIRECTIONAL_WEIGHT + SUPPLEMENTARY_WEIGHTS["prediction"]
    )
    evidence: List[str] = []
    if directional.get("observation"):
        evidence.append(str(directional["observation"]))
    evidence.append(
        "a market-implied TERMINAL expectation, not a forecast for the next candle"
    )
    evidence.append(
        f"supplementary weight {SUPPLEMENTARY_WEIGHTS['prediction']} of "
        f"{total_with_supplementary} panel weight — it shades conviction, it does not "
        f"decide"
    )

    return {
        "specialist_findings": [
            SpecialistFinding(
                specialist="prediction",
                role="supplementary",
                available=True,
                stance=stance,
                confidence=max(0.0, min(1.0, float(conviction))),
                evidence=evidence,
            )
        ],
    }


def specialist_event_risk(state: TradingState) -> Optional[Dict[str, Any]]:
    """Event risk from prediction markets. CONSTRAINT — concern only, never direction.

    Concern comes from how UNDECIDED the market is and how SOON it resolves, never
    from which way it leans. "Will exchange X be hacked?" has an obviously adverse
    side; "Will the ETH ETF be approved?" does not, and deciding whether approval is
    good for a long BTC position would be guesswork multiplied into a real confidence
    number. See `algorithms.prediction_market.event_uncertainty`.

    Reports `concern=None` rather than 0.0 when nothing could be measured. A
    constraint reporting 0.0 says "measured, and found no obstacle" — reassurance
    this node has not earned when its feed is absent.
    """
    symbol = state["symbol"]
    snapshot = _read_snapshot(symbol)

    if snapshot is None:
        return {
            "specialist_findings": [
                SpecialistFinding(
                    specialist="event_risk",
                    role="constraint",
                    available=False,
                    evidence=["unknown event risk is not the same as no event risk"],
                    reason_unavailable=(
                        "no fresh Polymarket snapshot, so scheduled event risk around "
                        "this symbol is unmeasured. Reporting 0.0 concern here would be "
                        "reassurance derived from an absent feed"
                    ),
                )
            ],
            "unavailable": ["event risk specialist (no Polymarket snapshot)"],
        }

    event_risk = snapshot.get("eventRisk")
    concern_raw = event_risk.get("concern") if isinstance(event_risk, dict) else None
    if not isinstance(concern_raw, (int, float)) or isinstance(concern_raw, bool):
        return {
            "specialist_findings": [
                SpecialistFinding(
                    specialist="event_risk",
                    role="constraint",
                    available=False,
                    reason_unavailable=(
                        "no event-risk market is mapped to this symbol, or its "
                        "uncertainty and resolution time could not be measured"
                    ),
                )
            ],
        }

    from backend.services.polymarket_registry import MAX_EVENT_RISK_CONCERN

    concern = max(0.0, min(MAX_EVENT_RISK_CONCERN, float(concern_raw)))

    evidence = [
        str(event_risk.get("observation") or "event-risk market measured"),
        "concern from UNCERTAINTY and PROXIMITY, not from which outcome is adverse — "
        "deciding which resolution is bad for this position would be guesswork",
        f"capped at {MAX_EVENT_RISK_CONCERN}, so event risk can dampen conviction but "
        f"never veto a trade on its own",
    ]

    return {
        "specialist_findings": [
            SpecialistFinding(
                specialist="event_risk",
                role="constraint",
                available=True,
                concern=concern,
                evidence=evidence,
            )
        ],
    }


# ===========================================================================
# 8. Debate Agent — the fan-in
# ===========================================================================

def run_debate(state: TradingState) -> Optional[Dict[str, Any]]:
    """Weigh the panel into one verdict. Deterministic.

    NOT AN LLM CALL, and this is the deliberate choice the spec's "genuinely
    agentic" framing invites second-guessing on. Everything the debate weighs is
    already a number in state, put there by the specialists. A model asked to
    combine those numbers would give a different answer on a re-run of identical
    inputs, which would make a past decision unauditable and this graph
    unbacktestable — both of which the spec requires. The agentic property comes
    from seven independent specialists forming views in parallel, not from the
    arithmetic that adds them up. `DEBATE_DETERMINISTIC_V1` in the prompt library
    records the same reasoning.

    Confidence is reduced twice, for two separate reasons that are reported
    separately:

      * `coverage`  — the fraction of directional panel weight that could be
                      measured. Three of seven specialists have no feed, so this
                      caps confidence at roughly 0.57 today. Deliberate: a verdict
                      from half the panel must not read like a verdict from all
                      of it.
      * constraint  — the BINDING constraint's concern, via `max()` not a
                      product. The binding constraint binds; multiplying several
                      mild concerns together would collapse confidence toward zero
                      and misreport three small doubts as one large one.
    """
    findings = list(state.get("specialist_findings") or [])
    if not findings:
        return {
            "debate_verdict": DebateVerdict(
                rationale="No specialist produced a finding — nothing to debate.",
            ),
            "unavailable": ["debate (no specialist findings)"],
        }

    by_name = {f.specialist: f for f in findings}
    absent = sorted(f.specialist for f in findings if not f.available)
    present = sorted(f.specialist for f in findings if f.available)

    # --- core directional tally --------------------------------------------
    weighted_sum = 0.0
    available_weight = 0.0
    for name, weight in DIRECTIONAL_WEIGHTS.items():
        finding = by_name.get(name)
        if finding is None or not finding.available:
            continue
        available_weight += weight
        weighted_sum += weight * finding.signed_weight()

    core_available_weight = available_weight

    # --- supplementary tier (Phase 35) -------------------------------------
    #
    # Three outcomes per supplementary specialist, and they differ in the ARITHMETIC
    # rather than only in the reporting:
    #
    #   available            joins numerator AND denominator — can add or subtract
    #                        conviction
    #   failed               joins the DENOMINATOR only — coverage drops, which is
    #                        honest: a mapped market we could not read is an
    #                        engineering gap, and `specialists.py`'s refusal to
    #                        renormalise applies to it
    #   not_applicable       joins NEITHER — the source does not exist for this
    #                        symbol, so confidence is identical to a run where the
    #                        specialist did not exist at all
    #
    # Without the third case, every symbol Polymarket does not cover would carry a
    # permanent ~12.5% confidence penalty for the absence of a source that cannot
    # apply to it. See `SpecialistFinding.not_applicable`.
    supplementary_denominator = 0.0
    supplementary_excluded: List[str] = []

    for name, weight in supplementary_weights().items():
        finding = by_name.get(name)
        if finding is None:
            # The node did not run at all (feature enabled mid-run, or a graph that
            # does not include it). Treated as not-applicable: charging coverage for
            # a node that never executed would penalise a configuration change.
            continue

        if finding.available:
            # GUARD A: A SUPPLEMENTARY SOURCE MAY NOT SPEAK ALONE.
            #
            # Without this, `prediction` + `funding` reach coverage 2.0/8.0 = 0.25 —
            # above MIN_CONFIDENCE_TO_TRADE (0.18) — so two weak indirect signals
            # could authorise a trade with NO price-based evidence at all. Today
            # funding alone reaches 1.0/7.0 = 0.14 and cannot, and this feature has
            # no business creating that capability.
            if core_available_weight <= 0.0:
                supplementary_excluded.append(
                    f"{name} (available, but excluded: no core directional specialist "
                    f"ran, and a supplementary source may not be the sole basis for a "
                    f"direction)"
                )
                continue
            available_weight += weight
            weighted_sum += weight * finding.signed_weight()
            supplementary_denominator += weight
        elif not finding.not_applicable:
            supplementary_denominator += weight

    total_weight = TOTAL_DIRECTIONAL_WEIGHT + supplementary_denominator

    supporting: List[str] = []
    contradicting: List[str] = []

    if available_weight <= 0.0:
        # Not a neutral verdict. Nothing directional could be measured at all, so
        # direction and confidence stay None — a measured NEUTRAL/0.0 would claim
        # the panel looked and found balance.
        verdict = DebateVerdict(
            direction=None,
            confidence=None,
            participants=present,
            absent=absent,
            coverage=0.0,
            rationale=(
                "No directional specialist could run ("
                + ", ".join(f"{n}: {by_name[n].reason_unavailable}" for n in absent
                            if n in DIRECTIONAL_WEIGHTS)
                + "). No directional view — this is a refusal, not a neutral call."
            ),
        )
        logger.info(
            "Debate on %s: no directional coverage (%d absent)", state["symbol"], len(absent)
        )
        return {
            "debate_verdict": verdict,
            "unavailable": ["debate direction (no directional specialist available)"],
        }

    net = weighted_sum / available_weight
    # `total_weight`, not TOTAL_DIRECTIONAL_WEIGHT: an enabled supplementary
    # specialist that HAS something to say (or failed trying) widens the panel, and
    # one that does not apply leaves it exactly as it was.
    coverage = available_weight / total_weight

    if net > NEUTRAL_BAND:
        direction = "LONG"
    elif net < -NEUTRAL_BAND:
        direction = "SHORT"
    else:
        direction = "NEUTRAL"

    # Coverage-scaled agreement, BEFORE any constraint reduction. Kept because a
    # decision to CLOSE a position must not be gated on a constraint whose whole
    # purpose is to discourage OPENING one — see `DebateVerdict.directional_confidence`
    # for the invariant-4 violation that produced this split.
    directional_confidence = min(1.0, abs(net)) * coverage
    confidence = directional_confidence

    # --- constraint dampening ---------------------------------------------
    binding_name: Optional[str] = None
    binding_concern = 0.0
    for name in constraint_specialists():
        finding = by_name.get(name)
        if finding is None or not finding.available or finding.concern is None:
            continue
        if finding.concern > binding_concern:
            binding_concern, binding_name = finding.concern, name

    confidence *= 1.0 - binding_concern

    # --- who said what ----------------------------------------------------
    # Supplementary names included so a prediction-market vote is visible in the
    # For/Against lists. A leg that moved the number must be nameable, or an operator
    # cannot reconcile the rationale with the confidence.
    for name in (*DIRECTIONAL_WEIGHTS, *supplementary_weights()):
        finding = by_name.get(name)
        if finding is None or not finding.available:
            continue
        signed = finding.signed_weight()
        label = f"{name} ({finding.stance}, {finding.confidence:.2f})"
        if direction == "NEUTRAL" or signed == 0.0:
            continue
        agrees = (signed > 0) if direction == "LONG" else (signed < 0)
        (supporting if agrees else contradicting).append(label)

    for name in constraint_specialists():
        finding = by_name.get(name)
        if finding is None or not finding.available or not finding.concern:
            continue
        contradicting.append(f"{name} (constraint, concern {finding.concern:.2f})")

    # An excluded-by-Guard-A leg is reported rather than dropped: "we had a view and
    # deliberately did not count it" is a different fact from "we had no view".
    contradicting.extend(supplementary_excluded)

    parts = [
        f"{direction} at {confidence:.2f} confidence from a net directional score of "
        f"{net:+.2f} (neutral band +/-{NEUTRAL_BAND})."
    ]
    if supporting:
        parts.append("For: " + "; ".join(supporting) + ".")
    if contradicting:
        parts.append("Against: " + "; ".join(contradicting) + ".")
    parts.append(
        f"Confidence scaled to {coverage * 100:.0f}% directional coverage "
        f"({available_weight:.1f} of {TOTAL_DIRECTIONAL_WEIGHT:.1f} panel weight)."
    )
    if absent:
        parts.append(
            "Absent: "
            + "; ".join(f"{n} — {by_name[n].reason_unavailable}" for n in absent)
            + "."
        )
    if binding_name:
        parts.append(
            f"Then reduced a further {binding_concern * 100:.0f}% by the binding "
            f"constraint ({binding_name})."
        )

    verdict = DebateVerdict(
        direction=direction,
        confidence=confidence,
        participants=present,
        absent=absent,
        supporting=supporting,
        contradicting=contradicting,
        rationale=" ".join(parts),
        coverage=coverage,
        constraint_applied=binding_concern if binding_name else None,
        binding_constraint=binding_name,
        directional_confidence=directional_confidence,
    )

    logger.info(
        "Debate on %s: %s @ %.2f (net %+.2f, coverage %.2f, binding constraint %s) "
        "from %d/%d specialists",
        state["symbol"], direction, confidence, net, coverage,
        binding_name or "none", len(present), len(findings),
    )

    # `confidence` is written here as the run's composite confidence. It is a
    # deterministic-only field, so no LLM node can ever overwrite it.
    return {"debate_verdict": verdict, "confidence": confidence}


# ===========================================================================
# Registration
# ===========================================================================

SPECIALIST_NODES: Tuple[str, ...] = (
    "specialist_market",
    "specialist_orderflow",
    "specialist_liquidity",
    "specialist_news",
    "specialist_funding",
    "specialist_portfolio",
    "specialist_risk",
)


def register_specialist_nodes() -> None:
    register_node(
        NodeContract(
            name="specialist_market",
            reads=("market_data", "symbol"),
            writes=("specialist_findings",),
            purpose="Directional evidence from price via the deterministic debate scorer",
            deterministic=True,
            phase=26,
        ),
        specialist_market,
    )

    register_node(
        NodeContract(
            name="specialist_orderflow",
            reads=("symbol",),
            writes=("specialist_findings", "orderflow_analysis"),
            purpose="Order-book aggressor flow — reports unavailable, no feed is subscribed",
            deterministic=True,
            phase=26,
        ),
        specialist_orderflow,
    )

    register_node(
        NodeContract(
            name="specialist_liquidity",
            reads=("market_regime", "symbol"),
            writes=("specialist_findings", "liquidity_analysis"),
            purpose="Executable depth and spread — reports unavailable, no depth feed is subscribed",
            deterministic=True,
            phase=26,
        ),
        specialist_liquidity,
    )

    register_node(
        NodeContract(
            name="specialist_news",
            reads=("symbol",),
            writes=("specialist_findings",),
            purpose="Headline and event risk — reports unavailable, no news feed is ingested",
            deterministic=True,
            phase=26,
        ),
        specialist_news,
    )

    register_node(
        NodeContract(
            name="specialist_funding",
            reads=("sentiment_analysis", "symbol"),
            writes=("specialist_findings",),
            purpose="Funding and Fear & Greed as contrarian crowding evidence",
            deterministic=True,
            phase=26,
        ),
        specialist_funding,
    )

    register_node(
        NodeContract(
            name="specialist_portfolio",
            reads=("symbol",),
            writes=("specialist_findings", "portfolio_state"),
            purpose="Existing exposure and room to act — a constraint, never a directional vote",
            deterministic=True,
            phase=26,
        ),
        specialist_portfolio,
    )

    register_node(
        NodeContract(
            name="specialist_risk",
            # Deliberately does NOT read portfolio_state: written by a sibling in
            # the same superstep, so it would always be stale. See the node body.
            reads=("market_regime", "technical_analysis", "symbol"),
            writes=("specialist_findings",),
            purpose="Governance and measurability constraints — reports, never vetoes; the gateway is Phase 28",
            deterministic=True,
            phase=26,
        ),
        specialist_risk,
    )

    register_node(
        NodeContract(
            name="debate",
            reads=("specialist_findings", "symbol"),
            writes=("debate_verdict", "confidence"),
            purpose="Weigh the specialist panel into one verdict, scaled by coverage and the binding constraint",
            deterministic=True,
            phase=26,
        ),
        run_debate,
    )


# ---------------------------------------------------------------------------
# Phase 35 — optional Polymarket nodes
# ---------------------------------------------------------------------------
#
# A SEPARATE tuple and a SEPARATE register function, not additions to the ones
# above, so that with `POLYMARKET_ENABLED` off the panel's composition is literally
# unchanged rather than conditionally unchanged. `SPECIALIST_NODES` stays exactly the
# seven names it has always had, and the tests asserting that keep working.
OPTIONAL_SPECIALIST_NODES: Tuple[str, ...] = (
    "specialist_prediction",
    "specialist_event_risk",
)


def specialist_nodes() -> Tuple[str, ...]:
    """The specialist nodes this run should fan out to.

    `analysis.py` builds its fan-out edges from this, so a disabled feature produces
    no node, no edge and no finding — rather than a node that runs and reports
    unavailable. That distinction matters: a registered node still costs a superstep
    slot and still appears in `panelSize`, which would make the panel look like it
    grew even with the feature off.
    """
    from backend.core.config import settings

    if not settings.POLYMARKET_ENABLED:
        return SPECIALIST_NODES
    return SPECIALIST_NODES + OPTIONAL_SPECIALIST_NODES


def register_optional_specialist_nodes() -> None:
    """Register the Polymarket specialists. Caller checks POLYMARKET_ENABLED.

    Both are `deterministic=True` and neither may call a model: they read a snapshot
    another component computed and translate it into a finding. That is arithmetic and
    dictionary access, and `registry.coverage()`'s deterministic/LLM ratio is the
    number this project watches — a supplementary feed is not a reason to move it.
    """
    register_node(
        NodeContract(
            name="specialist_prediction",
            reads=("symbol",),
            writes=("specialist_findings", "unavailable"),
            purpose=(
                "Supplementary prediction-market evidence — weight 1.0 of 8.0, and "
                "not counted against coverage when no market resolves to the symbol"
            ),
            deterministic=True,
            phase=35,
        ),
        specialist_prediction,
    )

    register_node(
        NodeContract(
            name="specialist_event_risk",
            reads=("symbol",),
            writes=("specialist_findings", "unavailable"),
            purpose=(
                "Scheduled event risk as a CONSTRAINT — concern from uncertainty and "
                "proximity, never from which outcome is adverse"
            ),
            deterministic=True,
            phase=35,
        ),
        specialist_event_risk,
    )
