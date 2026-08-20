"""Polymarket poller — Phase 36. The only component that fetches from Polymarket.

    fetch_events -> record probabilities -> compute signals -> write snapshot
                 -> evaluate trigger -> publish TRIGGER_FIRED

WHY EVERYTHING FUNNELS THROUGH ONE WORKER
-----------------------------------------
`graphs/nodes/specialists.py` establishes that a specialist READS state and never
fetches. Two reasons, both of which apply here with force:

  * two nodes fetching the same number in one run can disagree about it, and a
    panel that contradicts itself within a single decision is unexplainable;
  * a network call inside a nine-way fan-out makes the panel's latency the sum of
    nine timeouts.

So this worker is the single fetcher. It writes a snapshot; the two Phase 35
specialists read it. `tests/test_polymarket.py` asserts by AST that nothing under
`graphs/` can even import the client.

ONE API CALL PER SYMBOL PER CYCLE
--------------------------------
`fetch_events` returns whole events with their markets and each market's outcomes
and probabilities nested. So a single call supplies everything needed for one
symbol: the probabilities to record, the buckets for the expected-price
computation, and the event-risk markets. Fetching per outcome would multiply the
call count by the number of buckets for no extra information.

WHAT THIS WORKER WILL NOT DO
----------------------------
It does not decide anything. It computes the signals in
`algorithms/prediction_market.py` — pure, deterministic, unit-tested — and stores
the result. Direction, sizing and approval belong to the panel, the Supervisor and
the Risk Gateway respectively, and a poller that shortcut any of them would be
outside the single execution gate (CLAUDE.md invariant 1).

It also never writes a probability it did not read. Every failure path either
writes an honest "not applicable" snapshot or writes nothing at all, so a stale
snapshot expires (`MAX_SNAPSHOT_AGE_SECONDS`) rather than being refreshed with a
carried-forward value.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.algorithms import prediction_market as pm
from backend.graphs.triggers import TriggerDecision, get_trigger_evaluator
from backend.services import polymarket_store as store
from backend.services import polymarket_registry as registry

logger = logging.getLogger(__name__)

# 5 minutes, matching `polymarket_store.SERIES_RESOLUTION_SECONDS`. Polling faster
# would write several points per retention bucket and burn the count cap without
# adding resolution; slower would let snapshots expire between cycles
# (`MAX_SNAPSHOT_AGE_SECONDS` is 30 minutes, so there is room for five missed
# cycles before the panel goes dark).
POLL_INTERVAL_SECONDS = 300.0

# Symbols to poll. Deliberately short: each entry is one API call per cycle, and
# Polymarket only has meaningful depth on the majors anyway. Intersected with
# `SYMBOL_KEYWORDS` at call time so a symbol added here without keywords is
# reported rather than silently skipped.
WATCH_SYMBOLS: Tuple[str, ...] = ("BTC/USDT", "ETH/USDT")

# The ΔP window the trigger and the snapshot's z-score are measured over. 1 hour:
# long enough that a single poll's noise cannot dominate, short enough to still be
# about now.
SIGNAL_WINDOW_SECONDS = 3600.0

NOT_APPLICABLE_NO_CONFIRMED = (
    "no CONFIRMED Polymarket mapping exists for this symbol. Discovery may have "
    "found candidates, but an operator has to confirm that a market is really about "
    "this instrument before it can feed the panel — see "
    "polymarket_store.confirm_mapping"
)


class PolymarketWorker:
    def __init__(self, poll_interval: float = POLL_INTERVAL_SECONDS):
        self.poll_interval = poll_interval
        self._running = False
        self.cycles_run = 0
        self.snapshots_written = 0
        self.triggers_published = 0
        self.suppressions_published = 0
        self._logged_disabled = False

    # -- lifecycle --------------------------------------------------------

    async def start(self) -> None:
        self._running = True
        logger.info(
            "Polymarket worker started (poll every %.0fs, symbols %s)",
            self.poll_interval, ", ".join(WATCH_SYMBOLS),
        )
        while self._running:
            try:
                await self.run_cycle()
                self.cycles_run += 1
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                # Never propagate: this worker shares an event loop with the
                # components managing live positions.
                logger.error("Polymarket poll cycle failed: %s", exc)
            await asyncio.sleep(self.poll_interval)

    def stop(self) -> None:
        self._running = False
        logger.info(
            "Polymarket worker stopped after %d cycle(s); %d snapshot(s), %d "
            "trigger(s), %d suppression(s)",
            self.cycles_run, self.snapshots_written,
            self.triggers_published, self.suppressions_published,
        )

    # -- one cycle --------------------------------------------------------

    async def run_cycle(self, client: Optional[Any] = None) -> List[Dict[str, Any]]:
        """Poll every watched symbol. Returns the snapshots written.

        A no-op when the feature is disabled, logged exactly once so a disabled
        worker is visible in the log without repeating every five minutes forever.
        """
        from backend.core.config import settings

        if not settings.POLYMARKET_ENABLED:
            if not self._logged_disabled:
                logger.info(
                    "Polymarket worker idle: POLYMARKET_ENABLED is false. No polling, "
                    "no snapshots, and the two Phase 35 specialists are not registered."
                )
                self._logged_disabled = True
            return []
        self._logged_disabled = False

        if client is None:
            from backend.services.polymarket_client import get_polymarket_client

            client = get_polymarket_client()

        if not client.is_available():
            logger.warning(
                "Polymarket worker cannot poll: %s", client.unavailable_reason()
            )
            return []

        written: List[Dict[str, Any]] = []
        for symbol in WATCH_SYMBOLS:
            try:
                snapshot = await self.poll_symbol(symbol, client)
                if snapshot is not None:
                    written.append(snapshot)
                    self.snapshots_written += 1
            except Exception as exc:  # noqa: BLE001
                # One symbol failing must not stop the others. NOT written as a
                # snapshot: an existing snapshot expiring is the correct outcome,
                # whereas writing a failure record would refresh `computedAt` and
                # make stale data look current.
                logger.error("Polymarket poll failed for %s: %s", symbol, exc)
        return written

    async def poll_symbol(self, symbol: str, client: Any) -> Optional[Dict[str, Any]]:
        """Fetch, record, compute and store one symbol's snapshot."""
        keywords = registry.keywords_for(symbol)
        if keywords is None:
            logger.warning(
                "Polymarket worker is watching %s but SYMBOL_KEYWORDS has no entry for "
                "it, so nothing can be searched. Add one or remove the symbol from "
                "WATCH_SYMBOLS.", symbol,
            )
            return None

        confirmed = await store.get_mappings(symbol, confirmed_only=True)
        directional = [r for r in confirmed if r.get("role") == registry.ROLE_DIRECTIONAL]
        event_risk_rows = [r for r in confirmed if r.get("role") == registry.ROLE_EVENT_RISK]

        if not confirmed:
            # An explicit not-applicable snapshot rather than no snapshot. Both make
            # the specialist report `not_applicable`, but this one records WHEN the
            # check was last made, which is the difference between "we looked and
            # there is nothing" and "nothing has ever run".
            return await store.save_signal_snapshot(
                symbol, applicable=False,
                reason_not_applicable=NOT_APPLICABLE_NO_CONFIRMED,
            )

        events: List[Dict[str, Any]] = []
        for query in keywords.queries:
            events.extend(await client.fetch_events(query=query, status="active"))

        confirmed_markets = {r.get("market") for r in directional if r.get("market")}
        confirmed_outcomes = {r.get("outcome") for r in directional if r.get("outcome")}

        directional_signal = await self._directional_signal(
            symbol, events, confirmed_markets, confirmed_outcomes
        )
        event_signal = self._event_risk_signal(events, event_risk_rows)

        return await store.save_signal_snapshot(
            symbol,
            applicable=True,
            directional=directional_signal,
            event_risk=event_signal,
        )

    # -- directional ------------------------------------------------------

    async def _directional_signal(
        self,
        symbol: str,
        events: List[Dict[str, Any]],
        confirmed_markets: set,
        confirmed_outcomes: set,
    ) -> Optional[Dict[str, Any]]:
        """Record probabilities, compute drift, fire a trigger. None when uncomputable.

        Returns None rather than a partial dict: `specialist_prediction` treats a
        missing `directional` as "a market is mapped but the signal is uncomputable",
        which counts against coverage. That is the correct reading — the mapping
        exists, so this is an engineering gap.
        """
        from backend.services.market_data import get_price

        spot = get_price(symbol)
        if not spot or spot <= 0:
            logger.debug("No Polymarket drift for %s: no spot price available.", symbol)
            return None

        # The event that owns a confirmed market. `mutuallyExclusive` and bounded
        # buckets are checked by `buckets_from_event`, which refuses a partial
        # partition — so this only has to find the right event.
        chosen: Optional[Dict[str, Any]] = None
        for event in events:
            if not isinstance(event, dict):
                continue
            markets = {m.get("market") for m in (event.get("markets") or [])
                       if isinstance(m, dict)}
            if markets & confirmed_markets:
                chosen = event
                break

        if chosen is None:
            logger.debug(
                "No Polymarket drift for %s: none of the fetched events contains a "
                "confirmed market. The mapping may name a market that has since "
                "resolved.", symbol,
            )
            return None

        # Record every outcome of the partition, not only the confirmed ones. The
        # z-score baseline needs each bucket's own history, and `expected_price` reads
        # the whole partition — recording a subset would leave the other buckets with
        # no volatility baseline and their triggers permanently suppressed.
        await self._record_event(chosen)

        buckets = pm.buckets_from_event(chosen)
        if buckets is None:
            logger.debug(
                "No Polymarket drift for %s: event %r is not a bounded, "
                "mutually-exclusive partition.", symbol, chosen.get("event"),
            )
            return None

        horizon = self._horizon_seconds(chosen)
        estimate = pm.expected_price(buckets, spot, horizon_seconds=horizon)
        if estimate is None:
            return None

        # Confidence comes from the DRIVING outcome's own move and liquidity, not
        # from the partition as a whole: "how much should this drift be trusted" is a
        # question about the quality of the quotes it was computed from.
        driver, zscore, quote_volume, spread = await self._driver_stats(
            chosen, confirmed_outcomes
        )
        conviction = pm.confidence_from_liquidity(zscore, quote_volume, spread)
        if conviction is None:
            # A computable drift with no way to say how much to trust it. Reported as
            # uncomputable rather than shipped at an assumed confidence — the
            # specialist requires a real number and would otherwise be handed a
            # default that looks measured.
            logger.debug(
                "No Polymarket drift for %s: drift computed but its trustworthiness "
                "could not be measured (z=%r, volume=%r).", symbol, zscore, quote_volume,
            )
            return None

        if driver is not None:
            await self._fire_trigger(symbol, driver, zscore)

        return {
            "direction": estimate.direction,
            "confidence": conviction,
            "driftPct": estimate.drift_pct,
            "expectedPrice": estimate.expected_price,
            "spot": estimate.spot,
            "bucketsUsed": estimate.buckets_used,
            "probabilitySum": estimate.probability_sum,
            "horizonSeconds": horizon,
            "event": chosen.get("event"),
            "drivingOutcome": driver,
            "zscore": zscore,
            "observation": (
                f"market-implied expected price {estimate.expected_price:.2f} vs spot "
                f"{estimate.spot:.2f} ({estimate.drift_pct:+.2f}%) across "
                f"{estimate.buckets_used} buckets"
            ),
        }

    async def _record_event(self, event: Dict[str, Any]) -> None:
        """Store every YES probability in the event. Skips what it cannot read."""
        for market in event.get("markets") or []:
            if not isinstance(market, dict):
                continue
            for outcome in market.get("outcomes") or []:
                if not isinstance(outcome, dict):
                    continue
                handle = outcome.get("outcome")
                if not isinstance(handle, str):
                    continue
                # `record_probability` refuses None, bools and out-of-range values
                # itself, so nothing is filtered here — one place decides what is
                # storable.
                await store.record_probability(
                    handle,
                    outcome.get("price"),
                    market=market.get("market"),
                    bid=outcome.get("bid"),
                    ask=outcome.get("ask"),
                    volume=market.get("volume"),
                )

    async def _driver_stats(
        self, event: Dict[str, Any], confirmed_outcomes: set,
    ) -> Tuple[Optional[str], Optional[float], Optional[float], Optional[float]]:
        """(outcome, zscore, quote_volume, spread) for the outcome to judge the move by.

        Prefers a confirmed outcome; falls back to the partition's highest-probability
        bucket, which is the one carrying most of the expectation's weight and
        therefore the one whose quote quality matters most.
        """
        best: Optional[Dict[str, Any]] = None
        best_market: Optional[Dict[str, Any]] = None
        best_p = -1.0

        for market in event.get("markets") or []:
            if not isinstance(market, dict):
                continue
            for outcome in market.get("outcomes") or []:
                if not isinstance(outcome, dict):
                    continue
                handle = outcome.get("outcome")
                p = outcome.get("price")
                if not isinstance(handle, str) or not isinstance(p, (int, float)):
                    continue
                if isinstance(p, bool):
                    continue
                if handle in confirmed_outcomes:
                    best, best_market, best_p = outcome, market, 2.0  # unbeatable
                elif float(p) > best_p:
                    best, best_market, best_p = outcome, market, float(p)

        if best is None:
            return None, None, None, None

        handle = best["outcome"]
        series = await store.get_series(handle)
        zscore = pm.probability_zscore(series, SIGNAL_WINDOW_SECONDS)

        bid, ask = best.get("bid"), best.get("ask")
        spread = None
        if isinstance(bid, (int, float)) and isinstance(ask, (int, float)):
            spread = abs(float(ask) - float(bid))

        volume = (best_market or {}).get("volume")
        quote_volume = float(volume) if isinstance(volume, (int, float)) else None

        return handle, zscore, quote_volume, spread

    # -- event risk -------------------------------------------------------

    def _event_risk_signal(
        self, events: List[Dict[str, Any]], rows: List[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        """The single highest concern across confirmed event-risk markets.

        HIGHEST, not summed: `run_debate` combines constraints with `max()` for the
        stated reason that the binding constraint binds, and summing several mild
        event risks into one large concern would misreport three small doubts as a
        big one. Aggregating here the same way keeps the two consistent.

        Concern comes from uncertainty and proximity only — never from which outcome
        is adverse. See `algorithms.prediction_market.event_uncertainty`.
        """
        if not rows:
            return None

        confirmed = {r.get("market") for r in rows if r.get("market")}
        profiles = {p.key: p for p in registry.EVENT_RISK_PROFILES}
        now = time.time()

        best: Optional[Dict[str, Any]] = None
        for event in events:
            if not isinstance(event, dict):
                continue
            for market in event.get("markets") or []:
                if not isinstance(market, dict) or market.get("market") not in confirmed:
                    continue

                row = next(
                    (r for r in rows if r.get("market") == market.get("market")), None
                )
                profile = profiles.get((row or {}).get("eventRiskKey") or "")
                # Fall back to re-classifying by title/tags when the stored row has no
                # key: a mapping written by an older version must degrade to a
                # recomputed profile rather than to no concern at all.
                if profile is None:
                    profile = registry.event_risk_profile_for(
                        market.get("title") or event.get("title"),
                        event.get("tags"),
                        (row or {}).get("symbol") or "",
                    )
                if profile is None:
                    continue

                probability = self._yes_probability(market)
                end_ms = market.get("end") or event.get("end")
                seconds = None
                if isinstance(end_ms, (int, float)) and not isinstance(end_ms, bool):
                    seconds = float(end_ms) / 1000.0 - now

                concern = pm.event_concern(
                    probability, seconds, profile.weight,
                    ceiling=registry.MAX_EVENT_RISK_CONCERN,
                )
                if concern is None:
                    continue

                if best is None or concern > best["concern"]:
                    best = {
                        "concern": concern,
                        "key": profile.key,
                        "market": market.get("market"),
                        "title": market.get("title") or event.get("title"),
                        "probability": probability,
                        "secondsToResolution": seconds,
                        "uncertainty": pm.event_uncertainty(probability),
                        "proximity": pm.event_proximity(seconds),
                        "observation": (
                            f"{profile.key}: market at {probability:.2f} resolving in "
                            f"{max(0.0, (seconds or 0.0)) / 86400.0:.1f} days"
                        ),
                    }

        return best

    @staticmethod
    def _yes_probability(market: Dict[str, Any]) -> Optional[float]:
        for outcome in market.get("outcomes") or []:
            if not isinstance(outcome, dict):
                continue
            label = str(outcome.get("label") or "").strip().lower()
            handle = str(outcome.get("outcome") or "")
            if label in pm.YES_LABELS or handle.upper().endswith(":YES"):
                p = outcome.get("price")
                if isinstance(p, (int, float)) and not isinstance(p, bool):
                    return float(p)
        return None

    @staticmethod
    def _horizon_seconds(event: Dict[str, Any]) -> Optional[float]:
        end_ms = event.get("end")
        if not isinstance(end_ms, (int, float)) or isinstance(end_ms, bool):
            # Try the markets — a range event may date its buckets rather than itself.
            for market in event.get("markets") or []:
                if isinstance(market, dict) and isinstance(market.get("end"), (int, float)):
                    end_ms = market["end"]
                    break
        if not isinstance(end_ms, (int, float)) or isinstance(end_ms, bool):
            return None
        return float(end_ms) / 1000.0 - time.time()

    # -- triggers ---------------------------------------------------------

    async def _fire_trigger(
        self, symbol: str, outcome: str, zscore: Optional[float],
    ) -> None:
        """Evaluate and publish. Never raises."""
        try:
            series = await store.get_series(outcome)
            if not series:
                return
            probability = series[-1].get("p")

            decisions = get_trigger_evaluator().evaluate_prediction_market(
                symbol, outcome, probability, zscore,
            )
            await self._publish(decisions)
        except Exception as exc:  # noqa: BLE001
            logger.error("Polymarket trigger evaluation failed for %s: %s", symbol, exc)

    async def _publish(self, decisions: List[TriggerDecision]) -> None:
        if not decisions:
            return

        from backend.core.message_bus import get_message_bus
        from backend.models.events import TriggerFiredEvent

        bus = get_message_bus()
        for d in decisions:
            event = TriggerFiredEvent(
                symbol=d.reason.symbol,
                kind=d.reason.kind,
                detail=d.reason.detail,
                acted=d.acted,
                observed_value=d.reason.observed_value,
                threshold=d.reason.threshold,
                suppressed_reason=d.suppressed_reason,
            )
            if d.acted:
                self.triggers_published += 1
                logger.info(
                    "TRIGGER prediction_market_shift on %s: %s",
                    d.reason.symbol, d.reason.detail,
                )
            else:
                self.suppressions_published += 1
                logger.debug(
                    "prediction trigger suppressed (%s): %s",
                    d.reason.symbol, d.suppressed_reason,
                )
            # TWO arguments. `MessageBus.publish` takes (topic, payload), and a
            # one-argument call once passed 43 tests because every test double also
            # took one argument — so the real call raised a TypeError that the
            # publisher's own exception handling swallowed. There is a real-bus test.
            await bus.publish("TRIGGER_FIRED", event)

    # -- introspection ----------------------------------------------------

    def stats(self) -> Dict[str, Any]:
        return {
            "cyclesRun": self.cycles_run,
            "snapshotsWritten": self.snapshots_written,
            "triggersPublished": self.triggers_published,
            "suppressionsPublished": self.suppressions_published,
            "pollIntervalSeconds": self.poll_interval,
            "watchSymbols": list(WATCH_SYMBOLS),
            "signalWindowSeconds": SIGNAL_WINDOW_SECONDS,
        }


_worker: Optional[PolymarketWorker] = None


def get_polymarket_worker(
    poll_interval: float = POLL_INTERVAL_SECONDS,
) -> PolymarketWorker:
    global _worker
    if _worker is None:
        _worker = PolymarketWorker(poll_interval)
    return _worker


def reset_polymarket_worker() -> None:
    """For tests."""
    global _worker
    _worker = None


# ===========================================================================
# Phase 32b — streaming feed
# ===========================================================================
#
# WHAT THIS BUYS, STATED HONESTLY BEFORE THE CODE
# -----------------------------------------------
# One thing: TRIGGER LATENCY. The REST poller notices a reprice up to
# POLL_INTERVAL_SECONDS (5 minutes) after it happens; the stream notices it in
# seconds. Against a 900s trigger cooldown that is a real but modest improvement —
# reasoning starts 0-300 seconds sooner.
#
# WHAT IT DOES NOT BUY, and each of these would be easy to claim falsely:
#
#   * It does NOT replace the poller. `expected_price` needs every bucket of a
#     mutually-exclusive event at once, and `watch_ticker` is per-outcome — a stream
#     of one bucket's midpoint cannot produce a partition. The poller still computes
#     every snapshot the panel and the specialists read.
#
#   * It does NOT improve the volatility baseline. Persisting every tick would blow
#     through MAX_POINTS_PER_OUTCOME (2016 — a week at 5-minute resolution) in hours,
#     and the z-score's baseline would then cover the last few hours instead of the
#     last week: worse, not better. So persistence stays THROTTLED to the store's
#     declared resolution. The stream evaluates triggers on every update and writes
#     at the same cadence the poller does.
#
#   * It does NOT need a new dependency. ccxt implements the Polymarket CLOB market
#     channel including the venue's text-PING-every-10-seconds keepalive, declared in
#     `describe()['streaming']`. polymarket.md section 3's hand-written reconnect
#     logic, 30-second watchdog and `websockets` requirement are all unnecessary — an
#     earlier draft of the integration plan claimed `websockets` had to be declared,
#     and that was wrong.
#
# THE TICKER IS A QUOTE MIDPOINT, NOT A TRADE
# -------------------------------------------
# ccxt derives mid = (bid + ask) / 2 from book snapshots and deltas, so an update can
# move on a one-sided quote change with no trade behind it. That is why the spread is
# recorded alongside and `confidence_from_liquidity` discounts a wide one: a midpoint
# between two thin quotes is a guess, not a price.

# Minimum gap between PERSISTED points per outcome. Matches the store's declared
# resolution, so the stream and the poller produce the same series density and the
# retention window keeps meaning a week.
STREAM_PERSIST_INTERVAL_SECONDS = store.SERIES_RESOLUTION_SECONDS

# Backoff bounds for a failing subscription. ccxt reconnects internally, so this
# handles the case where it cannot — a resolved market, a renamed outcome, a venue
# outage. Capped so a permanently dead outcome retries once a minute rather than
# spinning.
STREAM_BACKOFF_INITIAL_SECONDS = 2.0
STREAM_BACKOFF_MAX_SECONDS = 60.0


class PolymarketStreamFeed:
    """Follows confirmed outcomes over the ccxt websocket. Trigger latency only.

    One task per outcome. `watch_ticker` is a next-update-await API, so each task is a
    loop rather than a callback registration.
    """

    def __init__(self) -> None:
        self._running = False
        self._tasks: Dict[str, Any] = {}
        self._last_persisted: Dict[str, float] = {}
        self.updates_received = 0
        self.points_persisted = 0
        self.triggers_evaluated = 0
        self.reconnects = 0

    async def start(self, client: Optional[Any] = None) -> None:
        """Subscribe to every confirmed outcome. Returns once the tasks are launched."""
        from backend.core.config import settings

        if not settings.POLYMARKET_ENABLED:
            logger.info("Polymarket stream idle: POLYMARKET_ENABLED is false.")
            return

        if client is None:
            from backend.services.polymarket_client import get_polymarket_client

            client = get_polymarket_client()

        if not client.is_available():
            logger.warning(
                "Polymarket stream cannot start: %s", client.unavailable_reason()
            )
            return

        outcomes = await self._confirmed_outcomes()
        if not outcomes:
            # Not an error. Until a human confirms a mapping there is nothing to
            # follow, and that is the expected state.
            logger.info(
                "Polymarket stream has nothing to follow: no confirmed mapping exists. "
                "The REST poller is unaffected."
            )
            return

        self._running = True
        for outcome in outcomes:
            self._tasks[outcome] = asyncio.create_task(self._follow(outcome, client))
        logger.info(
            "Polymarket stream following %d outcome(s): %s. Trigger latency only — "
            "snapshots still come from the REST poller.",
            len(outcomes), ", ".join(sorted(outcomes)),
        )

    async def _confirmed_outcomes(self) -> List[str]:
        """Every human-confirmed outcome across the watched symbols.

        Confirmed only, for the same reason the poller uses confirmed mappings: an
        unconfirmed candidate is discovery's guess, and following it would spend a
        subscription and fire triggers on a market nobody has attested is about this
        instrument.
        """
        out: List[str] = []
        for symbol in WATCH_SYMBOLS:
            for row in await store.get_mappings(symbol, confirmed_only=True):
                outcome = row.get("outcome")
                if isinstance(outcome, str) and outcome and outcome not in out:
                    out.append(outcome)
        return out

    async def _follow(self, outcome: str, client: Any) -> None:
        """Loop on one outcome's ticker until stopped. Never raises out."""
        backoff = STREAM_BACKOFF_INITIAL_SECONDS

        while self._running:
            try:
                ticker = await client.watch_ticker(outcome)
                if ticker is None:
                    # The adapter cannot stream at all. Stop this task rather than
                    # retrying forever against a method that does not exist.
                    logger.error(
                        "Polymarket stream for %s stopped: the client returned no "
                        "ticker, so streaming is unavailable in this ccxt build. The "
                        "REST poller is unaffected.",
                        outcome,
                    )
                    return

                backoff = STREAM_BACKOFF_INITIAL_SECONDS
                self.updates_received += 1
                await self._on_ticker(outcome, ticker)

            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                self.reconnects += 1
                logger.warning(
                    "Polymarket stream for %s failed (%s). Retrying in %.0fs.",
                    outcome, exc, backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(STREAM_BACKOFF_MAX_SECONDS, backoff * 2)

    async def _on_ticker(self, outcome: str, ticker: Dict[str, Any]) -> None:
        """Evaluate the trigger on every update; persist only on the throttle."""
        if not isinstance(ticker, dict):
            return

        probability = ticker.get("last")
        if not isinstance(probability, (int, float)) or isinstance(probability, bool):
            # `PredictionTicker.last` is the midpoint. Without one there is no
            # probability to record or evaluate.
            return

        bid, ask = ticker.get("bid"), ticker.get("ask")

        now = time.time()
        last = self._last_persisted.get(outcome)
        if last is None or (now - last) >= STREAM_PERSIST_INTERVAL_SECONDS:
            stored = await store.record_probability(
                outcome, probability,
                bid=bid if isinstance(bid, (int, float)) else None,
                ask=ask if isinstance(ask, (int, float)) else None,
                volume=ticker.get("quoteVolume"),
                open_interest=ticker.get("openInterest"),
                ts=now,
            )
            if stored:
                self._last_persisted[outcome] = now
                self.points_persisted += 1

        symbol = await self._symbol_for(outcome)
        if symbol is None:
            # The mapping was un-confirmed while the stream was running. Stop
            # attributing this outcome to a symbol rather than using a cached one.
            return

        # The trigger is evaluated on EVERY update, throttled or not — that is the
        # entire point of the stream. `_admit`'s 900s cooldown bounds how often a
        # fired trigger can actually start a reasoning run, so evaluating often is
        # cheap.
        #
        # The z-score comes from the PERSISTED series, which the throttle keeps at the
        # poller's density. So the stream improves WHEN a move is noticed, not how well
        # it is characterised — see the section header.
        series = await store.get_series(outcome)
        zscore = pm.probability_zscore(series, SIGNAL_WINDOW_SECONDS)

        self.triggers_evaluated += 1
        decisions = get_trigger_evaluator().evaluate_prediction_market(
            symbol, outcome, float(probability), zscore, now=now,
        )
        await get_polymarket_worker()._publish(decisions)

    @staticmethod
    async def _symbol_for(outcome: str) -> Optional[str]:
        """Which traded symbol this outcome is confirmed against. None if unmapped.

        Read from the store rather than cached at subscribe time: an operator can
        un-confirm a mapping while the stream is running, and a cached symbol would
        keep firing triggers for a market whose attribution had been withdrawn.
        """
        for row in await store.get_mappings(confirmed_only=True):
            if row.get("outcome") == outcome:
                symbol = row.get("symbol")
                return symbol if isinstance(symbol, str) else None
        return None

    async def stop(self) -> None:
        """Cancel every subscription and await the cancellations."""
        self._running = False
        tasks = list(self._tasks.values())
        self._tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            # Awaited rather than fire-and-forget: an un-awaited cancelled task logs
            # "Task exception was never retrieved" at interpreter shutdown, which reads
            # as a crash during an otherwise clean stop.
            await asyncio.gather(*tasks, return_exceptions=True)
        logger.info(
            "Polymarket stream stopped: %d update(s), %d persisted, %d trigger "
            "evaluation(s), %d reconnect(s)",
            self.updates_received, self.points_persisted,
            self.triggers_evaluated, self.reconnects,
        )

    def stats(self) -> Dict[str, Any]:
        return {
            "following": sorted(self._tasks),
            "updatesReceived": self.updates_received,
            "pointsPersisted": self.points_persisted,
            "triggersEvaluated": self.triggers_evaluated,
            "reconnects": self.reconnects,
            "persistIntervalSeconds": STREAM_PERSIST_INTERVAL_SECONDS,
            "meaning": (
                "the stream improves trigger LATENCY only. Snapshots come from the "
                "REST poller, because expected_price needs a whole event partition and "
                "watch_ticker is per-outcome. Persistence is throttled to the store's "
                "resolution so the retention window keeps meaning a week"
            ),
        }


_stream: Optional[PolymarketStreamFeed] = None


def get_polymarket_stream() -> PolymarketStreamFeed:
    global _stream
    if _stream is None:
        _stream = PolymarketStreamFeed()
    return _stream


def reset_polymarket_stream() -> None:
    """For tests."""
    global _stream
    _stream = None
