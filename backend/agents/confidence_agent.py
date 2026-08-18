"""Confidence Agent — calibration, not scoring (spec Section 10).

Takes the debate's raw confidence and adjusts it for two things the debate
cannot see: how accurate this system's past predictions have actually been,
and how hostile current conditions are to any prediction.

THE BUG THIS FIXES
------------------
The previous implementation was:

    breakdown = {"Trend": 15, "Momentum": 12, "Funding": 5,
                 "Market Structure": 18, "Risk": 10}
    total = sum(breakdown.values())          # always 60
    calibrated_confidence = total / 100.0    # always 0.60

A constant. It ignored `event.consensus_confidence` — the very number it
existed to calibrate — so a 20%-confidence debate and a 95%-confidence debate
both emerged as 0.60. A calibration stage that discards its input is worse
than no calibration stage, because downstream consumers believe the number has
been checked.

WHY CALIBRATION MATTERS HERE
----------------------------
`algorithms/probability.calibrate_confidence` scales raw confidence by
historical accuracy and a volatility penalty. Both existed and neither was
used. Overconfidence is the specific failure mode that hurts: position sizing
and approval thresholds both read this number, so a systematically inflated
confidence produces systematically oversized positions.
"""

import logging
from typing import Any, Dict, List

from backend.algorithms.probability import (
    MIN_TRADES_FOR_ACCURACY,
    bayesian_update,
    calibrate_confidence,
    measured_accuracy,
    volatility_penalty_from_closes,
)
from backend.core.agent_base import BaseAgent
from backend.models.events import (
    BaseEvent,
    ConfidenceCalibratedEvent,
    DebateConcludedEvent,
    EventType,
)
from backend.services.ai_memory import get_memory_stats
from backend.services.market_data import fetch_klines

logger = logging.getLogger(__name__)

# Used until enough real outcomes exist to measure accuracy from. Set BELOW 1.0
# deliberately: with no track record, the honest prior is that predictions are
# worse than they claim, not exactly as good. Assuming 1.0 would make the
# calibration stage a no-op for every new deployment — which is precisely when
# overconfidence is most likely.
ASSUMED_ACCURACY_WITHOUT_HISTORY = 0.55

# MIN_TRADES_FOR_ACCURACY is imported from `algorithms/probability`, not redefined
# here. It was defined in both places, and two copies of a threshold that decides
# whether a win rate counts as measured is one copy too many.


class ConfidenceAgent(BaseAgent):
    version = "2.0.0"
    priority = 35

    @property
    def name(self) -> str:
        return "Confidence Agent"

    @property
    def purpose(self) -> str:
        return "Calibrates the debate's raw confidence against measured historical accuracy and current volatility."

    @property
    def permissions(self) -> List[str]:
        return ["READ_MEMORY", "READ_MARKET_DATA"]

    @property
    def inputs(self) -> List[str]:
        return [
            "DEBATE_CONCLUDED events (raw consensus confidence)",
            "Historical trade outcomes via services/ai_memory.get_memory_stats",
            "15m klines via services/market_data.fetch_klines (for the volatility penalty)",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "CONFIDENCE_CALIBRATED events with the adjusted confidence and a component breakdown",
            "A breakdown that names which factor reduced confidence and by how much",
        ]

    @property
    def category(self) -> str:
        return "learning"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["DEBATE_CONCLUDED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["CONFIDENCE_CALIBRATED"]

    @property
    def responsibilities(self) -> List[str]:
        return [
            "Scale raw confidence by measured win rate, not an assumed one.",
            "Apply a volatility penalty so conviction falls when conditions are hostile.",
            "Report the breakdown so a low number can be explained.",
        ]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus", "ai_memory", "MarketData", "algorithms/probability"]

    @property
    def memory_ttl(self) -> str:
        return "Reads the full trade history each time; retains last 50 calibrations in-process."

    @property
    def knowledge_sources(self) -> List[str]:
        return ["ai_memory trade ledger", "Recent klines"]

    @property
    def prompt_reference(self) -> str:
        return "CONFIDENCE_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["Exchange OHLCV via services/market_data"]

    @property
    def database_tables(self) -> List[str]:
        return []

    @property
    def metrics_reported(self) -> List[str]:
        return ["Raw vs calibrated confidence delta", "Measured accuracy", "Volatility penalty applied"]

    @property
    def failure_recovery_strategy(self) -> str:
        return (
            "Degrades pessimistically. Missing history uses an assumed accuracy BELOW 1.0, and "
            "unavailable volatility data applies the penalty for unknown conditions rather than "
            "assuming calm ones. Errors reduce confidence, never inflate it."
        )

    @property
    def health_status(self) -> str:
        return "Active"

    async def handle_event(self, event: BaseEvent) -> None:
        if not isinstance(event, DebateConcludedEvent):
            return

        raw = event.consensus_confidence

        # A NEUTRAL debate has nothing to calibrate. Passing it through as 0.0
        # keeps the chain intact without manufacturing conviction.
        if event.winning_direction == "NEUTRAL" or raw <= 0:
            self.record_decision(
                "no-calibration",
                f"Debate on {event.symbol} was {event.winning_direction} at {raw:.2f} — nothing to calibrate.",
                {"raw": raw},
                acted=False,
            )
            await self.publish(
                ConfidenceCalibratedEvent(
                    symbol=event.symbol,
                    calibrated_confidence=0.0,
                    breakdown={"raw": raw, "calibrated": 0.0},
                )
            )
            return

        accuracy, accuracy_note = self._measured_accuracy()
        penalty, penalty_note = await self._volatility_penalty(event.symbol)

        # Bayesian step (spec Section 10 requires Bayesian probability
        # updating; `algorithms/probability.bayesian_update` existed with zero
        # callers). The question it answers: given that this system has been
        # right `accuracy` of the time, and given a debate this confident, what
        # is the probability the direction is actually correct?
        #
        #   prior      = measured historical accuracy
        #   P(E|correct)   = raw confidence — a confident debate is more likely
        #                    when the read is genuinely right
        #   P(E|incorrect) = 1 - raw        — a confident debate still happens
        #                    when wrong, just less often
        #
        # This is what stops a 95%-confident debate from being treated as 95%
        # likely to be right when the system's measured hit rate is 55%.
        posterior = bayesian_update(
            prior=accuracy,
            likelihood_evidence_given_regime=max(0.01, min(0.99, raw)),
            likelihood_evidence_given_not_regime=max(0.01, min(0.99, 1.0 - raw)),
        )

        calibrated = calibrate_confidence(raw, accuracy, penalty)

        # The final figure is the lower of the two. They answer different
        # questions and disagreeing is normal; taking the smaller means neither
        # method can inflate the other, which matters because this number feeds
        # position sizing.
        final = min(calibrated, posterior)

        breakdown = {
            "raw": round(raw, 4),
            "historicalAccuracy": round(accuracy, 4),
            "volatilityPenalty": round(penalty, 4),
            "bayesianPosterior": round(posterior, 4),
            "multiplicativeCalibration": round(calibrated, 4),
            "calibrated": round(final, 4),
            # Signed so a consumer can see calibration reduced conviction
            # rather than having to recompute it.
            "delta": round(final - raw, 4),
        }
        calibrated = final

        rationale = (
            f"Raw {raw:.3f}; multiplicative calibration x accuracy {accuracy:.3f} "
            f"({accuracy_note}) x (1 - volatility penalty {penalty:.3f}) ({penalty_note}) "
            f"= {breakdown['multiplicativeCalibration']:.3f}; Bayesian posterior given a "
            f"{accuracy:.3f} prior = {posterior:.3f}. Taking the lower: {final:.3f}."
        )
        self.record_decision("calibrated", rationale, breakdown, acted=True)
        logger.info("Confidence for %s: %.3f -> %.3f (%s)", event.symbol, raw, calibrated, penalty_note)

        await self.publish(
            ConfidenceCalibratedEvent(
                symbol=event.symbol,
                calibrated_confidence=calibrated,
                breakdown=breakdown,
            )
        )

    def _measured_accuracy(self) -> tuple[float, str]:
        """Win rate from the real trade ledger, or a conservative assumption.

        The ledger read itself lives in `algorithms/probability.measured_accuracy`,
        shared with the Phase 27 Supervisor node. Two components computing a hit
        rate from one ledger is how they come to report different accuracies for
        the same history, and both numbers feed position sizing.

        The substitution stays HERE rather than in the shared helper, because it is
        this agent's requirement and not a property of the data: a calibration
        stage must always emit a calibrated number, so with no sample it uses a
        conservative prior. The Supervisor answering "what is the probability?"
        must return None instead, and the shared helper returning None is what
        lets both be correct.
        """
        try:
            stats = get_memory_stats() or {}
        except Exception as e:
            logger.warning("Could not read memory stats: %s", e)
            return ASSUMED_ACCURACY_WITHOUT_HISTORY, "history unreadable, assuming conservative accuracy"

        rate, note = measured_accuracy(stats)
        if rate is None:
            return ASSUMED_ACCURACY_WITHOUT_HISTORY, note
        return rate, note

    async def _volatility_penalty(self, symbol: str) -> tuple[float, str]:
        """Higher realised volatility means a larger penalty.

        Unavailable data returns the MAXIMUM penalty, not zero. Treating an
        unknown volatility regime as calm is the assumption most likely to
        produce an oversized position at the worst moment.

        This agent fetches its own candles because it is triggered by an event and
        holds no market snapshot. The Supervisor node passes the closes it already
        has, which is why the maths lives in a pure shared function.
        """
        klines = await fetch_klines(symbol, "15m", limit=50)
        return volatility_penalty_from_closes([float(k["close"]) for k in klines])


def get_confidence_agent() -> ConfidenceAgent:
    return ConfidenceAgent()
