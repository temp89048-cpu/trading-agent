"""Polymarket probability series + resolved-market store — Phase 33.

Two JSON files under `.data/`:

    polymarket_series.json    a BOUNDED rolling window of probabilities per outcome
    polymarket_markets.json   resolved symbol -> market mappings, with confirmation

Copies `services/research_store.py`'s pattern exactly — module-level `asyncio.Lock`,
`_read` that degrades to empty and logs loudly, `_write` via temp file + `os.replace`
(atomic on Windows and POSIX). CLAUDE.md: "Stores follow one pattern ... Copy an
existing one."

WHY NOT A TIME-SERIES DATABASE
------------------------------
`polymarket.md` §3 recommends InfluxDB or TimescaleDB, and for the volume of data
that document imagines (per-tick level-2 book depth) it would be right. This
integration does not ingest that. It stores one probability per outcome per
5-minute bucket, which is ~2,000 floats per outcome per week.

A TSDB would be the only infrastructure dependency in this project and the only
store not following the pattern above — two costs paid for a query load a JSON
file handles. If per-tick depth is ever ingested, revisit; the interface here
(`record_probability` / `get_series`) is small enough to reimplement behind.

WHY BOUNDED IS NOT OPTIONAL
---------------------------
`graphs/state.py` grew an `_append_bounded` reducer because `nodes_visited`
accumulated across every sweep on a checkpointed position thread and reached ~33
entries after 3 sweeps — roughly 8,000 a week — with the whole state re-serialised
on every superstep.

The same shape of bug is available here and would be worse, because this file is
rewritten in full on every write. An unbounded series across a few dozen outcomes
polled every 5 minutes becomes a multi-megabyte JSON document that is read,
parsed, appended to and rewritten every poll. The retention cap is load-bearing,
not tidiness.

WHAT THIS MODULE DOES NOT DO
----------------------------
No ΔP, no z-scores, no direction, no thresholds. It stores and retrieves numbers.
Every computation lives in `algorithms/prediction_market.py`, pure and unit-tested.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
import time
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(_ROOT, ".data")
SERIES_FILE = os.path.join(DATA_DIR, "polymarket_series.json")
MARKETS_FILE = os.path.join(DATA_DIR, "polymarket_markets.json")

# ---------------------------------------------------------------------------
# Retention
# ---------------------------------------------------------------------------
#
# 7 days at 5-minute resolution. The window is set by what the CONSUMER needs, not
# by what is available: `algorithms/prediction_market.probability_zscore` normalises
# a move against the outcome's own realised volatility, and a few hours of history
# cannot establish that. A week spans enough regimes to be a baseline while staying
# small enough to rewrite cheaply.
RETENTION_SECONDS = 7 * 24 * 60 * 60
SERIES_RESOLUTION_SECONDS = 5 * 60
MAX_POINTS_PER_OUTCOME = RETENTION_SECONDS // SERIES_RESOLUTION_SECONDS  # 2016

# A hard ceiling on tracked outcomes, independent of retention.
#
# Retention alone bounds each series but not their number, and `fetch_events`
# returning a surprising number of matches would otherwise silently grow the file
# without limit. When the cap is hit, new outcomes are REFUSED and the refusal is
# logged rather than an existing series being evicted: evicting would drop the
# history the z-score baseline depends on, so a full store should be visible and
# fixed rather than quietly churning.
MAX_TRACKED_OUTCOMES = 200

# Serialises read-modify-write. The poller and an operator-driven API call can
# both write, and without this one of the two updates is lost.
_lock = asyncio.Lock()


def _read(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        # Loud, and degrades to empty rather than raising. Losing the probability
        # history means the prediction specialist reports unavailable — which is
        # the correct, honest outcome — whereas raising would fail the trading run
        # that happened to trigger the read.
        logger.error("Could not read %s (%s). Treating as empty.", path, e)
        return default
    return data if isinstance(data, type(default)) else default


def _write(path: str, payload: Any, prefix: str) -> None:
    """Atomic write — temp file then `os.replace`. A crash mid-write leaves the
    previous good file rather than a truncated one."""
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=prefix, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=2, default=str)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise


# ===========================================================================
# Probability series
# ===========================================================================

def _prune(points: List[Dict[str, Any]], now: float) -> List[Dict[str, Any]]:
    """Drop points outside the retention window, then cap the count.

    Both, in that order: the time window is the meaningful rule and the count cap
    is the backstop for a caller polling faster than the declared resolution.
    """
    cutoff = now - RETENTION_SECONDS
    kept = [p for p in points if isinstance(p.get("ts"), (int, float)) and p["ts"] >= cutoff]
    if len(kept) > MAX_POINTS_PER_OUTCOME:
        kept = kept[-MAX_POINTS_PER_OUTCOME:]
    return kept


async def record_probability(
    outcome: str,
    price: Optional[float],
    *,
    market: Optional[str] = None,
    volume: Optional[float] = None,
    open_interest: Optional[float] = None,
    bid: Optional[float] = None,
    ask: Optional[float] = None,
    ts: Optional[float] = None,
) -> bool:
    """Append one observation. Returns False when nothing was stored.

    REFUSES A MISSING OR OUT-OF-RANGE PROBABILITY.
    ---------------------------------------------
    `price` is documented by ccxt as a probability in 0..1. `None` means the fetch
    failed, and storing it as a point — or coercing it to 0.0 — would put a
    fabricated certainty ("this event will definitely not happen") into the series
    that ΔP is computed from. CLAUDE.md invariant 6.

    A value outside [0, 1] is also refused rather than clamped: clamping would
    turn a units bug or an API change into a plausible number, and 0.0/1.0 are
    exactly the values that produce the largest ΔP.

    `volume`/`open_interest`/`bid`/`ask` may legitimately be None — they are
    stored as None and the confidence calculation treats them as unmeasured.
    """
    if price is None:
        logger.debug("Not recording %s: price is None (fetch failed, not zero).", outcome)
        return False
    if isinstance(price, bool):
        # `bool` is an `int` subclass, so `float(True)` is 1.0 and the range check
        # below would pass it as a 100% probability — the most extreme value the
        # series can hold, from a value that is not a measurement at all. Rejected
        # here at the boundary rather than only in the reader, so the bad value
        # never enters the store: `algorithms.prediction_market._series_prices`
        # also skips bools, and two layers disagreeing about what is storable is
        # how a value ends up persisted but permanently invisible.
        logger.error("Not recording %s: price %r is a bool, not a probability.", outcome, price)
        return False
    try:
        # A str is accepted deliberately: ccxt types these fields `Num = Union[None,
        # str, float, int]` and genuinely returns strings for some venues, so
        # refusing one would drop real observations.
        price = float(price)
    except (TypeError, ValueError):
        logger.error("Not recording %s: price %r is not a number.", outcome, price)
        return False
    if not (0.0 <= price <= 1.0):
        logger.error(
            "Not recording %s: price %s is outside the 0..1 probability range. "
            "Refusing rather than clamping — a clamp would turn a units change in "
            "the upstream API into a confident 0%% or 100%%.",
            outcome, price,
        )
        return False

    now = time.time() if ts is None else float(ts)

    async with _lock:
        series: Dict[str, Any] = _read(SERIES_FILE, {})
        entry = series.get(outcome)

        if entry is None:
            if len(series) >= MAX_TRACKED_OUTCOMES:
                logger.error(
                    "Refusing to track %s: already at MAX_TRACKED_OUTCOMES (%d). "
                    "Not evicting an existing series — eviction would drop the "
                    "history the volatility baseline needs. Narrow the polled "
                    "market set instead.",
                    outcome, MAX_TRACKED_OUTCOMES,
                )
                return False
            entry = {"market": market, "points": []}
            series[outcome] = entry
        elif market and not entry.get("market"):
            entry["market"] = market

        points: List[Dict[str, Any]] = entry.get("points") or []
        points.append({
            "ts": now,
            "p": price,
            "volume": volume,
            "openInterest": open_interest,
            "bid": bid,
            "ask": ask,
        })
        entry["points"] = _prune(points, now)
        entry["updatedAt"] = now

        _write(SERIES_FILE, series, ".polymarket-series.")
        return True


async def get_series(outcome: str, since: Optional[float] = None) -> List[Dict[str, Any]]:
    """Observations for one outcome, oldest first. `[]` when nothing is stored.

    `[]` is honest here and callers must treat it as "no history", never as "the
    probability has not moved" — a caller inferring ΔP = 0 from an empty series
    would report a measured non-event where nothing was measured at all.
    """
    series: Dict[str, Any] = _read(SERIES_FILE, {})
    entry = series.get(outcome)
    if not entry:
        return []
    points = entry.get("points") or []
    if since is not None:
        points = [p for p in points if p.get("ts", 0) >= since]
    return sorted(points, key=lambda p: p.get("ts", 0))


async def tracked_outcomes() -> List[str]:
    return sorted(_read(SERIES_FILE, {}).keys())


async def series_summary() -> Dict[str, Any]:
    """For the monitoring API. Reports the cap so a full store is visible."""
    series: Dict[str, Any] = _read(SERIES_FILE, {})
    return {
        "trackedOutcomes": len(series),
        "maxTrackedOutcomes": MAX_TRACKED_OUTCOMES,
        "totalPoints": sum(len(e.get("points") or []) for e in series.values()),
        "retentionSeconds": RETENTION_SECONDS,
        "resolutionSeconds": SERIES_RESOLUTION_SECONDS,
        "maxPointsPerOutcome": MAX_POINTS_PER_OUTCOME,
        "outcomes": {
            name: {
                "market": entry.get("market"),
                "points": len(entry.get("points") or []),
                "updatedAt": entry.get("updatedAt"),
            }
            for name, entry in sorted(series.items())
        },
    }


# ===========================================================================
# Resolved market mappings
# ===========================================================================
#
# A mapping says "this Polymarket outcome is a directional view on BTC/USDT".
# `confirmed` is the gate that keeps an automated guess out of the decision path —
# see `polymarket_registry.py` for why attribution is not automated.

async def save_mapping(
    symbol: str,
    outcome: str,
    *,
    market: Optional[str],
    role: str,
    classification_reason: str,
    market_type: Optional[str] = None,
    underlying: Optional[str] = None,
    floor_strike: Optional[float] = None,
    cap_strike: Optional[float] = None,
    end_ts: Optional[float] = None,
    title: Optional[str] = None,
    directional_basis: Optional[str] = None,
    event_risk_key: Optional[str] = None,
) -> Dict[str, Any]:
    """Record a discovered mapping as UNCONFIRMED, or refresh an existing one.

    An existing mapping's `confirmed` flag is PRESERVED across a refresh. Market
    metadata (strikes, end date, title) is re-read from the venue and updated;
    the human's decision about whether this market is really about this symbol is
    not re-derived, because rediscovery would otherwise silently revoke a
    confirmation every time the poller ran.
    """
    now = time.time()
    async with _lock:
        rows: List[Dict[str, Any]] = _read(MARKETS_FILE, [])
        for i, row in enumerate(rows):
            if row.get("symbol") == symbol and row.get("outcome") == outcome:
                rows[i] = {
                    **row,
                    "market": market,
                    "role": role,
                    "classificationReason": classification_reason,
                    "marketType": market_type,
                    "underlying": underlying,
                    "floorStrike": floor_strike,
                    "capStrike": cap_strike,
                    "endTs": end_ts,
                    "title": title,
                    "directionalBasis": directional_basis,
                    "eventRiskKey": event_risk_key,
                    "updatedAt": now,
                }
                _write(MARKETS_FILE, rows, ".polymarket-markets.")
                return rows[i]

        record = {
            "symbol": symbol,
            "outcome": outcome,
            "market": market,
            "role": role,
            "classificationReason": classification_reason,
            "marketType": market_type,
            "underlying": underlying,
            "floorStrike": floor_strike,
            "capStrike": cap_strike,
            "endTs": end_ts,
            "title": title,
            # WHICH computation this can feed. A directional mapping with no basis
            # cannot produce a signal at all — see polymarket_registry.Classification.
            "directionalBasis": directional_basis,
            # WHICH event-risk profile applies, so the weight the worker uses is the one
            # classification chose rather than one re-derived later from a title that
            # may have been edited at the venue.
            "eventRiskKey": event_risk_key,
            # FALSE on discovery, always. Only an operator sets this.
            "confirmed": False,
            "confirmedBy": None,
            "confirmedAt": None,
            "discoveredAt": now,
            "updatedAt": now,
        }
        rows.append(record)
        _write(MARKETS_FILE, rows, ".polymarket-markets.")
        logger.info(
            "Discovered Polymarket mapping %s -> %s (role=%s, UNCONFIRMED — it "
            "cannot feed the directional specialist until a human confirms it)",
            symbol, outcome, role,
        )
        return record


async def confirm_mapping(
    symbol: str,
    outcome: str,
    confirmed: bool,
    *,
    set_by_human: bool = False,
    note: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Confirm or un-confirm a mapping. HUMANS ONLY.

    Mirrors `research_store.update_hypothesis_status`'s `set_by_human` gate, and
    for the same class of reason. There the risk is a module validating its own
    hypothesis; here it is the discovery code confirming its own guess, which
    would make the confirmation step decorative.

    What a wrong confirmation costs: the directional specialist would report a
    probability about one asset as evidence about another, with a real stance and
    a real confidence, and no downstream check could catch it — `run_debate` has
    no way to know that "Will ETH flip BTC?" is not a BTC signal.
    """
    if confirmed and not set_by_human:
        raise PermissionError(
            "a Polymarket market mapping may only be confirmed by a human operator. "
            "Automated discovery cannot confirm its own attribution: a keyword match "
            "deciding that 'Will ETH flip BTC?' is a BTC-long signal would attribute "
            "a probability to the wrong instrument, and nothing downstream could "
            "detect it."
        )

    now = time.time()
    async with _lock:
        rows: List[Dict[str, Any]] = _read(MARKETS_FILE, [])
        for i, row in enumerate(rows):
            if row.get("symbol") == symbol and row.get("outcome") == outcome:
                rows[i] = {
                    **row,
                    "confirmed": bool(confirmed),
                    "confirmedBy": "operator" if confirmed else None,
                    "confirmedAt": now if confirmed else None,
                    "reviewNote": note,
                    "updatedAt": now,
                }
                _write(MARKETS_FILE, rows, ".polymarket-markets.")
                logger.info(
                    "Mapping %s -> %s %s by operator",
                    symbol, outcome, "CONFIRMED" if confirmed else "un-confirmed",
                )
                return rows[i]
    logger.warning("No mapping %s -> %s to confirm.", symbol, outcome)
    return None


async def get_mappings(
    symbol: Optional[str] = None,
    role: Optional[str] = None,
    confirmed_only: bool = False,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = _read(MARKETS_FILE, [])
    if symbol is not None:
        rows = [r for r in rows if r.get("symbol") == symbol]
    if role is not None:
        rows = [r for r in rows if r.get("role") == role]
    if confirmed_only:
        rows = [r for r in rows if r.get("confirmed") is True]
    return rows


async def clear_all() -> None:
    """For tests only. Not called in production."""
    async with _lock:
        _write(SERIES_FILE, {}, ".polymarket-series.")
        _write(MARKETS_FILE, [], ".polymarket-markets.")


# ===========================================================================
# Signal snapshots — the seam between the poller and the panel
# ===========================================================================
#
# WHY A SNAPSHOT EXISTS AT ALL, rather than the specialist computing from the series.
#
# `graphs/nodes/specialists.py` establishes the rule that a specialist READS state
# and never fetches: the funding specialist consumes `sentiment_analysis` that Phase
# 24 already fetched, because two nodes fetching the same number in one run can
# disagree about it, and because a network call inside a fan-out node makes the
# panel's latency the sum of seven timeouts.
#
# But `algorithms/prediction_market.expected_price` needs the LIVE event — every
# bucket of the partition at once — which no graph node may go and get. So the
# poller (Phase 36) fetches, computes, and writes a snapshot here; the specialist
# reads it. One fetcher, one reader, and the specialist stays deterministic and
# unit-testable without a network.
#
# The cost of that seam is staleness, which is why `get_signal_snapshot` takes
# `max_age_seconds` and returns None past it. A six-hour-old probability presented
# as current evidence is worse than no evidence: the panel would weight it as a live
# reading.

SNAPSHOT_FILE = os.path.join(DATA_DIR, "polymarket_snapshots.json")

# A snapshot older than this is not current evidence. 30 minutes: the poller's
# default cadence is 5 minutes, so this tolerates several missed cycles while still
# refusing anything from a materially different market.
MAX_SNAPSHOT_AGE_SECONDS = 30 * 60


async def save_signal_snapshot(
    symbol: str,
    *,
    applicable: bool,
    reason_not_applicable: Optional[str] = None,
    directional: Optional[Dict[str, Any]] = None,
    event_risk: Optional[Dict[str, Any]] = None,
    computed_at: Optional[float] = None,
) -> Dict[str, Any]:
    """Write the latest computed Polymarket signal for one symbol.

    `applicable=False` means no confirmed mapping exists for this symbol — a
    DIFFERENT fact from `directional=None` (a mapping exists but the signal could not
    be computed this cycle). The panel treats the two differently in the arithmetic,
    so they must be separately representable here. See
    `graphs/state.SpecialistFinding.not_applicable`.
    """
    now = time.time() if computed_at is None else float(computed_at)
    record = {
        "symbol": symbol,
        "computedAt": now,
        "applicable": bool(applicable),
        "reasonNotApplicable": reason_not_applicable,
        "directional": directional,
        "eventRisk": event_risk,
    }
    async with _lock:
        snapshots: Dict[str, Any] = _read(SNAPSHOT_FILE, {})
        snapshots[symbol] = record
        _write(SNAPSHOT_FILE, snapshots, ".polymarket-snapshots.")
    return record


async def get_signal_snapshot(
    symbol: str,
    max_age_seconds: Optional[float] = MAX_SNAPSHOT_AGE_SECONDS,
    now: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """The latest snapshot for `symbol`, or None if absent or stale.

    Returns None for a stale snapshot rather than returning it with an age attached
    and trusting the caller to check. A caller that forgot would present a
    half-hour-old probability as a live reading, and the panel has no way to tell.
    """
    snapshots: Dict[str, Any] = _read(SNAPSHOT_FILE, {})
    record = snapshots.get(symbol)
    if not isinstance(record, dict):
        return None

    if max_age_seconds is None:
        return record

    computed_at = record.get("computedAt")
    if not isinstance(computed_at, (int, float)):
        return None

    reference = time.time() if now is None else float(now)
    age = reference - float(computed_at)
    if age > float(max_age_seconds):
        logger.debug(
            "Polymarket snapshot for %s is %.0fs old (limit %.0fs) — treating as "
            "absent rather than presenting it as current.",
            symbol, age, max_age_seconds,
        )
        return None
    # A snapshot from the future means a clock change; refused for the same reason.
    if age < -float(max_age_seconds):
        logger.error(
            "Polymarket snapshot for %s is timestamped %.0fs in the FUTURE — refusing.",
            symbol, -age,
        )
        return None
    return record


async def clear_snapshots() -> None:
    """For tests only."""
    async with _lock:
        _write(SNAPSHOT_FILE, {}, ".polymarket-snapshots.")
