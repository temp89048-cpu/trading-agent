"""Which Polymarket market is about which traded symbol — Phase 33.

The question this module answers, and the one most able to produce a confidently
wrong number:

    Given a Polymarket market, is it a DIRECTIONAL view on the symbol we trade, is
    it EVENT RISK around it, or is it neither?

`POLYMARKET_INTEGRATION_PLAN.md` §1 settles why that split matters. Restated,
because it is the whole design:

    a dated BTC price threshold is a view on BTC's direction.
    "Will the Fed cut in September?" is not.

Collapsing both into one "sentiment score" would produce a signed directional vote
derived from a market that says nothing about direction, and that number would then
drive real position sizing. CLAUDE.md invariant 6.

CLASSIFICATION READS TYPED FIELDS ONLY — IT NEVER PARSES A TITLE
----------------------------------------------------------------
ccxt's `PredictionMarket` carries `marketType` ('binary' | 'categorical' |
'scalar'), and for scalar markets `underlying`, `floorStrike`, `capStrike` and
`strikeType`. Those are the inputs.

A tempting alternative is to regex a threshold out of "Will Bitcoin close above
$130,000 on September 30?". It is rejected: a title is prose written by a market
creator, the format is not guaranteed, and the failure mode is silent. Reading
"$130,000" out of a title that turns out to say "below" inverts the signal, and
nothing downstream can detect an inverted probability — it looks exactly like a
market with a strong opposite view.

So a market whose direction cannot be established from typed fields is classified
`unusable` with the reason stated, not guessed at.

DISCOVERY IS AUTOMATED. ATTRIBUTION IS NOT.
-------------------------------------------
`discover_for_symbol` searches, classifies and records — all automatic. Every
record is written UNCONFIRMED, and `polymarket_store.confirm_mapping` refuses to
set `confirmed` without `set_by_human=True`.

The reason is that keyword search cannot decide attribution. "Will ETH flip BTC?"
matches a Bitcoin keyword search, is genuinely about BTC's price, and is not a
BTC-long signal. A human takes five seconds to see that; no available automation
does, and the cost of being wrong is a real stance with a real confidence
attributed to the wrong instrument.

WHAT IS UNVERIFIED HERE
-----------------------
This environment has no network route to Polymarket (CLAUDE.md), so the ccxt
adapter's SHAPE is verified by introspection but its VALUES are not. Specifically
unknown until the §8 probe runs:

  * whether crypto price markets come back as `marketType='scalar'` at all, or as
    `binary` with strikes, or as `binary` with neither;
  * what `underlying` actually contains — "BTC", "bitcoin", a token id, or empty;
  * what `tags` look like in practice.

Every branch below therefore **fails toward `unusable`**. If `underlying` comes
back empty, nothing is misclassified as directional — discovery simply reports
that it could not establish direction for any market, which is a visible,
actionable result rather than a wrong signal.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.services import polymarket_store
from backend.services.polymarket_client import PolymarketClient, get_polymarket_client

logger = logging.getLogger(__name__)

# Roles a market can play. Deliberately three, not two: "neither" has to be
# representable, because most Polymarket markets are about elections and sport.
ROLE_DIRECTIONAL = "directional"
ROLE_EVENT_RISK = "event_risk"
ROLE_UNUSABLE = "unusable"

ROLES = (ROLE_DIRECTIONAL, ROLE_EVENT_RISK, ROLE_UNUSABLE)


# ---------------------------------------------------------------------------
# Symbol -> discovery keywords
# ---------------------------------------------------------------------------
#
# Search terms and `underlying` aliases per traded base asset. Hand-written
# because it is short, stable, and the alternative — deriving keywords from the
# ticker — produces searches like "SOL" that match "solar" and "solution".
#
# `aliases` is what `underlying` is matched against, case-insensitively. Both the
# ticker and the full name are listed because it is not yet known which ccxt
# returns (see the module docstring).
@dataclass(frozen=True)
class SymbolKeywords:
    base: str
    queries: Tuple[str, ...]
    aliases: Tuple[str, ...]


SYMBOL_KEYWORDS: Dict[str, SymbolKeywords] = {
    "BTC": SymbolKeywords("BTC", ("Bitcoin",), ("btc", "bitcoin", "xbt")),
    "ETH": SymbolKeywords("ETH", ("Ethereum",), ("eth", "ethereum", "ether")),
    "SOL": SymbolKeywords("SOL", ("Solana",), ("sol", "solana")),
    "XRP": SymbolKeywords("XRP", ("XRP", "Ripple"), ("xrp", "ripple")),
    "DOGE": SymbolKeywords("DOGE", ("Dogecoin",), ("doge", "dogecoin")),
}


def base_asset(symbol: str) -> Optional[str]:
    """"BTC/USDT" -> "BTC". None when the format is not recognised.

    None rather than a best guess: a symbol this module does not understand must
    produce "no market resolves to this symbol", which is true, rather than a
    search for a malformed term that returns unrelated markets.
    """
    if not symbol:
        return None
    head = symbol.split(":")[0].split("/")[0].strip().upper()
    return head or None


def keywords_for(symbol: str) -> Optional[SymbolKeywords]:
    base = base_asset(symbol)
    return SYMBOL_KEYWORDS.get(base) if base else None


# ---------------------------------------------------------------------------
# Event risk
# ---------------------------------------------------------------------------
#
# Which non-directional markets are worth treating as event risk, and how much
# concern each may contribute at most.
#
# THE CEILING IS THE IMPORTANT PART. `run_debate` combines constraint specialists
# with `max()`, not a product — so a fourth constraint cannot compound the other
# three, but it CAN only ever RAISE the binding concern. A miscalibrated event
# score would therefore quietly suppress trading system-wide, and nothing would
# look broken: every run would just come back a little less confident.
#
# MAX_EVENT_RISK_CONCERN = 0.35 is chosen so event risk can dampen but never veto.
# Arithmetic, stated so it can be checked rather than trusted: the best achievable
# confidence with the prediction specialist available is coverage 5.0/8.0 = 0.625,
# and 0.625 * (1 - 0.35) = 0.406 — still far above MIN_CONFIDENCE_TO_TRADE (0.18).
# A trade blocked while event risk is elevated is therefore blocked by something
# else too, which is the intended division of labour: this is an analyst's
# concern, and hard blocks belong to the Risk Gateway.
MAX_EVENT_RISK_CONCERN = 0.35


@dataclass(frozen=True)
class EventRiskProfile:
    """One class of event whose resolution would invalidate a technical thesis."""

    key: str
    # Matched case-insensitively against the event's `tags` and `title`. Title
    # matching is acceptable HERE and not for direction, because the cost of a
    # false positive is a small dampening rather than an inverted stance.
    terms: Tuple[str, ...]
    # Symbols this plausibly moves. "*" for market-wide.
    affects: Tuple[str, ...]
    # Concern at 100% certainty of the adverse outcome, before the global ceiling.
    weight: float
    why: str


EVENT_RISK_PROFILES: Tuple[EventRiskProfile, ...] = (
    EventRiskProfile(
        key="monetary_policy",
        terms=("fed", "fomc", "interest rate", "rate cut", "rate hike", "cpi", "inflation"),
        affects=("*",),
        weight=0.30,
        why=(
            "crypto trades as a long-duration risk asset, so a policy surprise "
            "repriced everything at once and a technical thesis on one symbol "
            "does not survive it"
        ),
    ),
    EventRiskProfile(
        key="regulation",
        terms=("sec", "cftc", "lawsuit", "regulat", "ban ", "etf approval", "etf decision"),
        affects=("*",),
        weight=0.30,
        why=(
            "a regulatory decision is a step change, not a trend — it gaps price "
            "through stops rather than moving it through them"
        ),
    ),
    EventRiskProfile(
        key="venue_risk",
        terms=("hack", "exploit", "insolvency", "bankrupt", "depeg", "delist"),
        affects=("*",),
        weight=0.35,
        why=(
            "the highest weight, because this is the only class that can make an "
            "exchange position unexitable — the one risk a stop-loss does not cover"
        ),
    ),
    EventRiskProfile(
        key="protocol_event",
        terms=("upgrade", "fork", "halving", "unlock", "merge"),
        affects=("*",),
        weight=0.20,
        why=(
            "scheduled and widely known, so mostly priced in — the residual risk is "
            "in the execution of the event, not the fact of it"
        ),
    ),
)


def event_risk_profile_for(
    title: Optional[str], tags: Optional[Sequence[str]], symbol: str
) -> Optional[EventRiskProfile]:
    """The first profile this event matches, or None.

    First match rather than strongest: the profiles are ordered by how distinct
    their terms are, and returning several would need a combination rule that
    `max()` downstream already provides.
    """
    haystack = " ".join(
        [(title or "").lower(), *[str(t).lower() for t in (tags or [])]]
    )
    if not haystack.strip():
        return None

    base = base_asset(symbol) or ""
    for profile in EVENT_RISK_PROFILES:
        if not any(term in haystack for term in profile.terms):
            continue
        if "*" in profile.affects or base in profile.affects:
            return profile
    return None


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

@dataclass
class Classification:
    """What one market is, and why. `reason` is always populated.

    The reason is not decoration: `unusable` is the expected outcome for most
    markets, and an operator looking at a discovery run needs to distinguish "this
    is about the Super Bowl" from "this is about Bitcoin but has no strike price",
    because only the second one indicates something worth fixing.
    """

    role: str
    reason: str
    outcome: Optional[str] = None
    market: Optional[str] = None
    market_type: Optional[str] = None
    underlying: Optional[str] = None
    floor_strike: Optional[float] = None
    cap_strike: Optional[float] = None
    end_ts: Optional[float] = None
    title: Optional[str] = None
    event_risk_key: Optional[str] = None
    # Capped concern this market may contribute. None for directional markets.
    max_concern: Optional[float] = None
    # WHICH computation a directional market can actually feed. None for every
    # non-directional role.
    #
    # This field exists because Phase 33 and Phase 34 disagreed without it. The
    # registry called a market "directional" whenever `underlying` matched and any
    # strike was present — but `algorithms.prediction_market` has exactly two honest
    # paths, and a lone market with one strike feeds NEITHER:
    #
    #   expected_price  needs a mutually-exclusive event whose markets PARTITION the
    #                   price range, so a single bucket is not enough
    #   delta_stance    needs to know whether the outcome pays out above or below the
    #                   strike, and refuses to guess
    #
    # A mapping stored as directional that no computation can consume would have
    # produced a specialist reporting `available=False` on a market an operator had
    # explicitly confirmed — which reads as a bug in the specialist rather than an
    # honest limit of the data.
    directional_basis: Optional[str] = None


BASIS_EXPECTED_PRICE = "expected_price"


def _num(value: Any) -> Optional[float]:
    """Coerce to float, or None. Never 0.0 for a missing value.

    ccxt returns `Num = Union[None, str, float, int]` on these fields, and `0.0`
    is a legitimate strike, a legitimate probability and a legitimate volume — so
    the usual `float(x or 0)` idiom would erase the difference between "no strike"
    and "a strike at zero".
    """
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _matches_underlying(underlying: Optional[str], kw: SymbolKeywords) -> bool:
    if not underlying:
        return False
    text = str(underlying).strip().lower()
    return any(alias == text or alias in text.split() for alias in kw.aliases)


def classify_market(
    market: Dict[str, Any],
    outcome: Dict[str, Any],
    symbol: str,
    *,
    event_title: Optional[str] = None,
    event_tags: Optional[Sequence[str]] = None,
    event_mutually_exclusive: Optional[bool] = None,
    now: Optional[float] = None,
) -> Classification:
    """Classify one (market, outcome) pair for one traded symbol.

    Pure — no I/O — so it is unit-testable against recorded ccxt payloads without
    a network, which matters because no network is available here.

    Branch order is the design. Liveness first, because a resolved market's
    probability has converged to 0 or 1 and would read as an overwhelming
    directional signal (see the `end` check and §5 risk 7 in the plan).
    """
    now = time.time() if now is None else now

    handle = outcome.get("outcome") or outcome.get("outcomeId")
    market_handle = market.get("market") or market.get("id")
    title = market.get("title") or event_title
    market_type = market.get("marketType")
    underlying = market.get("underlying")
    floor_strike = _num(market.get("floorStrike"))
    cap_strike = _num(market.get("capStrike"))
    end_ms = _num(market.get("end"))
    end_ts = end_ms / 1000.0 if end_ms else None

    common = dict(
        outcome=handle if isinstance(handle, str) else None,
        market=market_handle if isinstance(market_handle, str) else None,
        market_type=market_type if isinstance(market_type, str) else None,
        underlying=underlying if isinstance(underlying, str) else None,
        floor_strike=floor_strike,
        cap_strike=cap_strike,
        end_ts=end_ts,
        title=title if isinstance(title, str) else None,
    )

    if not common["outcome"]:
        return Classification(
            role=ROLE_UNUSABLE,
            reason="the outcome has no handle or token id, so it cannot be fetched again",
            **{k: v for k, v in common.items() if k != "outcome"},
        )

    # --- 1. liveness ------------------------------------------------------
    #
    # A resolved market prices at 0 or 1 by definition. Admitting one would hand
    # the directional specialist a probability of ~1.0 and a huge ΔP on the day it
    # settled — a maximal signal derived from an event that has already happened.
    # `winner is True` rather than a truthiness test: ccxt types it `Bool`, so False
    # means "resolved and this side lost" and None means "not resolved". A truthy
    # check would treat all three the same, and the losing side of a settled market
    # prices at ~0.0 — which is the most extreme directional reading available.
    # (The `resolved` flag catches the losing side too; both are checked because
    # either alone would depend on the venue populating that particular field.)
    if market.get("resolved") is True or outcome.get("winner") is True:
        return Classification(
            role=ROLE_UNUSABLE,
            reason=(
                "market is RESOLVED — its probability has converged to 0 or 1, which "
                "would read as an overwhelming directional signal about an event that "
                "has already settled"
            ),
            **common,
        )
    if market.get("closed") is True or market.get("active") is False or outcome.get("active") is False:
        return Classification(
            role=ROLE_UNUSABLE,
            reason="market is closed or inactive — no live probability to read",
            **common,
        )
    if end_ts is not None and end_ts <= now:
        return Classification(
            role=ROLE_UNUSABLE,
            reason=(
                f"market ended at {end_ts:.0f} (now {now:.0f}) but is not flagged "
                f"resolved — treated as unusable rather than trusted"
            ),
            **common,
        )

    kw = keywords_for(symbol)

    # --- 2. directional ---------------------------------------------------
    if kw is not None and _matches_underlying(underlying, kw):
        bounded = floor_strike is not None and cap_strike is not None
        if bounded and event_mutually_exclusive is True:
            # The one classification that yields a usable signal today: a bounded
            # bucket inside a mutually-exclusive event, which
            # `prediction_market.buckets_from_event` can turn into a partition and
            # `expected_price` can average over — with no volatility assumption.
            return Classification(
                role=ROLE_DIRECTIONAL,
                reason=(
                    f"marketType={market_type!r} on underlying {underlying!r} is a "
                    f"BOUNDED bucket ({floor_strike} to {cap_strike}) inside a "
                    f"mutually-exclusive event, so the event's markets partition the "
                    f"price range and a probability-weighted expected price is "
                    f"computable without assuming a volatility model"
                ),
                directional_basis=BASIS_EXPECTED_PRICE,
                **common,
            )

        if bounded:
            # Both strikes but no partition. `expected_price` over one bucket would
            # be that bucket's midpoint with probability < 1 — an "expectation"
            # conditioned on an event that may not happen, reported as if
            # unconditional.
            return Classification(
                role=ROLE_UNUSABLE,
                reason=(
                    f"underlying {underlying!r} matches {kw.base} and the bucket is "
                    f"bounded, but the parent event is not flagged mutuallyExclusive "
                    f"(got {event_mutually_exclusive!r}), so its markets are not a "
                    f"partition. Averaging over a non-partition yields an expectation "
                    f"conditioned on an event that may not occur, reported as if "
                    f"unconditional"
                ),
                **common,
            )

        if floor_strike is not None or cap_strike is not None:
            # One strike only — the binary threshold case. `expected_price` cannot
            # run (unbounded), and `delta_stance` needs to know whether the outcome
            # pays out above or below, which no typed field reliably supplies.
            return Classification(
                role=ROLE_UNUSABLE,
                reason=(
                    f"underlying {underlying!r} matches {kw.base} but only one strike "
                    f"is present (floor={floor_strike}, cap={cap_strike}), so the "
                    f"bucket is unbounded. expected_price has no midpoint to use, and "
                    f"delta_stance needs an explicit above/below sense that no typed "
                    f"field supplies — guessing it would invert the signal on every "
                    f"'below' market"
                ),
                **common,
            )
        # Underlying matches but there is no threshold. This is the branch that
        # exists because the probe has not run: it is entirely possible that
        # crypto markets come back with `underlying` set and no strikes.
        #
        # `implied_drift` needs a threshold to convert a probability into a
        # direction. Without one, the honest answer is that direction cannot be
        # established — NOT that the market is about something else, and NOT a
        # threshold read out of the title.
        return Classification(
            role=ROLE_UNUSABLE,
            reason=(
                f"underlying {underlying!r} matches {kw.base} but the market carries "
                f"no floorStrike or capStrike, so there is no threshold to convert a "
                f"probability into a direction. Refusing to parse one out of the title: "
                f"misreading 'above' as 'below' would invert the signal undetectably"
            ),
            **common,
        )

    # --- 3. event risk ----------------------------------------------------
    profile = event_risk_profile_for(title, event_tags, symbol)
    if profile is not None:
        return Classification(
            role=ROLE_EVENT_RISK,
            reason=(
                f"matched event-risk profile {profile.key!r}: {profile.why}. Contributes "
                f"a CONCERN only — it says nothing about direction"
            ),
            event_risk_key=profile.key,
            max_concern=min(profile.weight, MAX_EVENT_RISK_CONCERN),
            **common,
        )

    # --- 4. neither -------------------------------------------------------
    return Classification(
        role=ROLE_UNUSABLE,
        reason=(
            f"no underlying match for {symbol} and no event-risk profile matched — "
            f"most Polymarket markets are about elections and sport, so this is the "
            f"expected outcome"
        ),
        **common,
    )


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

@dataclass
class DiscoveryResult:
    """What one discovery run found. Reports refusals, not just successes."""

    symbol: str
    available: bool
    reason_unavailable: Optional[str] = None
    events_seen: int = 0
    markets_seen: int = 0
    directional: List[Classification] = field(default_factory=list)
    event_risk: List[Classification] = field(default_factory=list)
    unusable: List[Classification] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "symbol": self.symbol,
            "available": self.available,
            "reasonUnavailable": self.reason_unavailable,
            "eventsSeen": self.events_seen,
            "marketsSeen": self.markets_seen,
            "directional": [c.__dict__ for c in self.directional],
            "eventRisk": [c.__dict__ for c in self.event_risk],
            # Counted and summarised rather than listed in full: a discovery run
            # over a Bitcoin keyword search returns mostly unusable markets, and
            # dumping all of them would bury the two that matter.
            "unusableCount": len(self.unusable),
            "unusableReasons": sorted({c.reason.split(" — ")[0] for c in self.unusable}),
            "confirmationRequired": (
                "directional mappings are stored UNCONFIRMED and cannot feed the "
                "prediction specialist until an operator confirms each one"
            ),
        }


async def discover_for_symbol(
    symbol: str,
    client: Optional[PolymarketClient] = None,
    limit: int = 25,
) -> DiscoveryResult:
    """Search Polymarket for markets relevant to `symbol` and record what is found.

    Never raises. Writes every classified mapping to the store as UNCONFIRMED.
    """
    client = client or get_polymarket_client()

    if not client.is_available():
        return DiscoveryResult(
            symbol=symbol,
            available=False,
            reason_unavailable=client.unavailable_reason(),
        )

    kw = keywords_for(symbol)
    if kw is None:
        return DiscoveryResult(
            symbol=symbol,
            available=False,
            reason_unavailable=(
                f"no Polymarket search keywords are defined for {symbol}. Add an entry "
                f"to SYMBOL_KEYWORDS — deriving a search term from the ticker returns "
                f"unrelated markets (a 'SOL' search matches 'solar' and 'solution')"
            ),
        )

    result = DiscoveryResult(symbol=symbol, available=True)

    for query in kw.queries:
        events = await client.fetch_events(query=query, limit=limit, status="active")
        if not events:
            continue
        result.events_seen += len(events)

        for event in events:
            if not isinstance(event, dict):
                continue
            tags = event.get("tags") or []
            event_title = event.get("title")

            for market in event.get("markets") or []:
                if not isinstance(market, dict):
                    continue
                result.markets_seen += 1

                for outcome in market.get("outcomes") or []:
                    if not isinstance(outcome, dict):
                        continue
                    c = classify_market(
                        market, outcome, symbol,
                        event_title=event_title, event_tags=tags,
                        event_mutually_exclusive=event.get("mutuallyExclusive"),
                    )
                    if c.role == ROLE_DIRECTIONAL:
                        result.directional.append(c)
                    elif c.role == ROLE_EVENT_RISK:
                        result.event_risk.append(c)
                    else:
                        # Not persisted. Storing every Super Bowl outcome would fill
                        # MAX_TRACKED_OUTCOMES with markets nothing reads.
                        result.unusable.append(c)
                        continue

                    await polymarket_store.save_mapping(
                        symbol,
                        c.outcome or "",
                        market=c.market,
                        role=c.role,
                        classification_reason=c.reason,
                        market_type=c.market_type,
                        underlying=c.underlying,
                        floor_strike=c.floor_strike,
                        cap_strike=c.cap_strike,
                        end_ts=c.end_ts,
                        title=c.title,
                        directional_basis=c.directional_basis,
                        event_risk_key=c.event_risk_key,
                    )

    logger.info(
        "Polymarket discovery for %s: %d events, %d markets -> %d directional, "
        "%d event-risk, %d unusable. Directional mappings are UNCONFIRMED.",
        symbol, result.events_seen, result.markets_seen,
        len(result.directional), len(result.event_risk), len(result.unusable),
    )
    return result
