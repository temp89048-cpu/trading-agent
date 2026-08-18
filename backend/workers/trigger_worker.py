"""Trigger worker — connects Section 14's triggers to the event bus.

Two paths, deliberately different:

  * **Push (TICK_RECEIVED).** Price and volatility ride the existing websocket
    feed, so these are genuinely event-driven with no polling at all. Subscribed
    to the bus, evaluated per tick.

  * **Poll (slow cadence).** Funding rate, open interest and exchange
    reachability have no push feed. Polled on a slow loop and compared against a
    baseline, so a REASONING RUN still only happens on change.

WHY IT PUBLISHES INSTEAD OF STARTING RUNS
-----------------------------------------
This worker publishes `TRIGGER_FIRED` and nothing else. It does not build or
invoke a graph.

That is not indirection for its own sake. Phase 24 onward will subscribe the
trade-decision graph to `TRIGGER_FIRED`, and keeping the two separate means:

  * the trigger layer is complete and testable now, before any graph exists;
  * the dashboard WebSocket already streams every bus event, so triggers and
    suppressions are visible in the UI for free (spec Section 39.5);
  * multiple graphs can react to the same trigger without the trigger layer
    knowing about any of them.

SUPPRESSIONS ARE PUBLISHED TOO
------------------------------
A suppressed trigger is published with `acted=False` and its reason. An operator
asking "why didn't the system react to that move?" must be able to tell a missed
detection from a deliberate debounce, and silence cannot distinguish them.

THE PRICE-TICK PATH MUST STAY CHEAP
-----------------------------------
`TICK_RECEIVED` arrives per symbol per websocket message. Trigger evaluation on
that path is arithmetic against a stored baseline — no I/O, no awaits that can
block. Regime classification needs candles, so it is NOT done per tick; the
polling loop supplies it on a slow cadence instead.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

from backend.graphs.triggers import (
    BTC_SYMBOL,
    TriggerDecision,
    get_trigger_evaluator,
)
from backend.core.message_bus import get_message_bus
from backend.models.events import BaseEvent, TickReceivedEvent, TriggerFiredEvent

logger = logging.getLogger(__name__)

# Slow loop cadence. Funding is published every 8 hours by the venue and open
# interest moves on minutes, so polling faster than this costs API quota to learn
# nothing. 120s is well inside the cooldowns in TriggerConfig, so the poll rate is
# never what limits firing — the thresholds are.
POLL_INTERVAL_SECONDS = 120.0

# Symbols whose regime is classified on the slow loop. Kept small: each entry is
# a klines fetch per cycle, and regime is a slow-moving property that does not
# need breadth to be useful.
REGIME_WATCH: tuple = ("BTC/USDT", "ETH/USDT")


class TriggerWorker:
    def __init__(self, poll_interval: float = POLL_INTERVAL_SECONDS):
        self.poll_interval = poll_interval
        self._running = False
        self._subscribed = False
        self.cycles_run = 0
        self.triggers_published = 0
        self.suppressions_published = 0

    # -- push path ----------------------------------------------------

    def subscribe(self) -> None:
        """Subscribe to TICK_RECEIVED. Idempotent.

        Guarded because subscribing twice would evaluate every tick twice, and
        the second evaluation would see the baseline the first one just reset —
        so half the triggers would silently vanish rather than duplicate, which is
        the harder bug to notice.
        """
        if self._subscribed:
            return
        get_message_bus().subscribe("TICK_RECEIVED", self._on_tick)
        self._subscribed = True
        logger.info("Trigger worker subscribed to TICK_RECEIVED (push path)")

    async def _on_tick(self, event: BaseEvent) -> None:
        if not isinstance(event, TickReceivedEvent):
            return
        try:
            evaluator = get_trigger_evaluator()
            # No regime here — that needs candles, and this path must stay
            # allocation-and-arithmetic only. The poll loop supplies regime.
            decisions = evaluator.evaluate_tick(event.symbol, event.price)
            await self._publish(decisions)
        except Exception as e:
            # A trigger-evaluation failure must never propagate into the bus and
            # disturb the agents handling live positions.
            logger.error("Trigger evaluation failed for tick on %s: %s", event.symbol, e)

    # -- poll path ----------------------------------------------------

    async def start(self) -> None:
        self._running = True
        self.subscribe()
        logger.info(
            "Trigger worker started (poll every %.0fs; price/volatility are push-driven)",
            self.poll_interval,
        )
        while self._running:
            try:
                await self.run_cycle()
                self.cycles_run += 1
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error("Trigger poll cycle failed: %s", e)
            await asyncio.sleep(self.poll_interval)

    def stop(self) -> None:
        self._running = False
        logger.info(
            "Trigger worker stopped after %d cycle(s); published %d trigger(s), %d suppression(s)",
            self.cycles_run, self.triggers_published, self.suppressions_published,
        )

    async def run_cycle(self) -> List[TriggerDecision]:
        """One slow-loop pass: macro, regime, exchange health, position risk."""
        evaluator = get_trigger_evaluator()
        decisions: List[TriggerDecision] = []

        # --- funding + open interest (BTC only; see BTC_ONLY_TRIGGERS) ---
        try:
            from backend.agents.sentiment_agent import fetch_macro_data

            macro = await fetch_macro_data()
            decisions.extend(evaluator.evaluate_macro(macro))
        except Exception as e:
            logger.debug("Macro trigger evaluation skipped: %s", e)

        # --- volatility regime -------------------------------------------
        for symbol in REGIME_WATCH:
            try:
                from backend.agents.regime_agent import detect_market_regime
                from backend.services.market_data import fetch_klines, get_price

                price = get_price(symbol)
                if price <= 0:
                    continue
                klines = await fetch_klines(symbol, "15m", limit=50)
                regime = detect_market_regime(klines)
                # Passing the price here re-checks the price trigger too, which
                # is harmless: the baseline was already advanced by the push path,
                # so an unchanged price produces nothing.
                decisions.extend(evaluator.evaluate_tick(symbol, price, regime=regime))
            except Exception as e:
                logger.debug("Regime trigger evaluation skipped for %s: %s", symbol, e)

        # --- exchange reachability ---------------------------------------
        try:
            from backend.services.exchange_client import get_exchange_client

            client = get_exchange_client()
            if client.has_credentials():
                balance = await client.fetch_balance()
                decisions.extend(
                    evaluator.evaluate_exchange(
                        reachable=balance is not None,
                        detail="balance fetch " + ("succeeded" if balance else "failed"),
                    )
                )
            # No credentials means reachability is unknown, not false. Reporting
            # it as unreachable would fire an exchange_event on every startup of
            # an unconfigured system.
        except Exception as e:
            decisions.extend(
                evaluator.evaluate_exchange(reachable=False, detail=f"error: {e}")
            )

        # --- open-position risk ------------------------------------------
        try:
            from backend.core.config import settings
            from backend.services.market_data import get_price
            from backend.services.portfolio_store import get_portfolio

            portfolio = await get_portfolio()
            book = (portfolio.get(settings.execution_tab) or {}).get("positions", [])
            for pos in book:
                symbol = pos.get("symbol")
                cost = float(pos.get("avgCost") or 0)
                if not symbol or cost <= 0:
                    continue
                live = get_price(symbol)
                if live <= 0:
                    continue
                pnl_pct = (live - cost) / cost * 100.0
                decisions.extend(evaluator.evaluate_position(symbol, pnl_pct))
        except Exception as e:
            logger.debug("Position-risk trigger evaluation skipped: %s", e)

        # --- liquidation spikes (stubbed) --------------------------------
        # Liquidation triggers are not yet supported because no backend
        # websocket is subscribed to liquidation streams.
        decisions.extend(
            evaluator.evaluate_liquidation(
                reachable=False,
                detail="unavailable: no liquidation feed subscribed"
            )
        )
        
        # --- news events (stubbed) ---------------------------------------
        # News triggers are not yet supported in the backend (TS only).
        decisions.extend(
            evaluator.evaluate_news(
                reachable=False,
                detail="unavailable: no backend news feed"
            )
        )

        await self._publish(decisions)
        return decisions

    # -- publishing ---------------------------------------------------

    async def _publish(self, decisions: List[TriggerDecision]) -> None:
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
                logger.info("TRIGGER %s on %s: %s", d.reason.kind, d.reason.symbol, d.reason.detail)
            else:
                self.suppressions_published += 1
                # Debug, not info: suppressions are expected and common, and
                # logging each at info would drown the ones that fired. They are
                # still published on the bus, so nothing is hidden.
                logger.debug(
                    "trigger suppressed (%s on %s): %s",
                    d.reason.kind, d.reason.symbol, d.suppressed_reason,
                )
            await bus.publish("TRIGGER_FIRED", event)


_worker: Optional[TriggerWorker] = None


def get_trigger_worker(poll_interval: float = POLL_INTERVAL_SECONDS) -> TriggerWorker:
    global _worker
    if _worker is None:
        _worker = TriggerWorker(poll_interval)
    return _worker
