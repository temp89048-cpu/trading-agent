"""Simulation Agent — stress tests before authorization (spec Section 22.3).

Runs a Monte Carlo ruin simulation over the proposed risk and reports whether
it survives. This is the last gate before the Supervisor submits a TAR.

THE BUG THIS FIXES
------------------
The previous implementation was:

    await self.publish(StressTestedEvent(
        symbol=event.symbol,
        passed=True,
        results={"max_drawdown_simulation": 2.5}
    ))

`passed=True`, unconditionally, with a fabricated drawdown figure. It ignored
`event.risk_score` and `event.warnings` entirely. Because the Supervisor gates
on `StressTestedEvent.passed`, this was a gate that could not fail — and the
2.5 in `results` was a number no simulation produced, presented as one that a
simulation had.

WHAT IT CHECKS NOW
------------------
Monte Carlo over the risk-of-ruin path (`algorithms/risk.monte_carlo_ruin` if
available, otherwise a local simulation), plus the incoming risk score and
warnings. Fails closed: if the simulation cannot run, the trade does NOT pass.
"""

import logging
from typing import Any, Dict, List

from backend.algorithms.risk import monte_carlo_trade_sequence
from backend.core.agent_base import BaseAgent
from backend.core.config import settings
from backend.models.events import BaseEvent, EventType, RiskEvaluatedEvent, StressTestedEvent

logger = logging.getLogger(__name__)

# A proposed trade whose incoming risk score is at or above this fails without
# needing a simulation — the Risk agent has already said it is unacceptable.
RISK_SCORE_HARD_FAIL = 0.8

# Ruin probability above this fails the stress test. 5% is not "safe", it is
# the point past which a strategy is more likely than not to be ruined inside
# a few hundred trades.
MAX_RUIN_PROBABILITY = 0.05

# Simulated drawdown beyond this fraction of equity fails.
MAX_SIMULATED_DRAWDOWN = 0.25

SIMULATIONS = 2_000
TRADES_PER_SIMULATION = 200

# The seed lives with the simulation itself (algorithms/risk.DEFAULT_SEED), so
# every caller gets the same reproducible draw rather than each defining its own.


class SimulationAgent(BaseAgent):
    version = "2.0.0"
    priority = 40

    @property
    def name(self) -> str:
        return "Simulation Agent"

    @property
    def purpose(self) -> str:
        return "Runs a Monte Carlo ruin and drawdown simulation over the proposed risk and passes or fails the trade."

    @property
    def permissions(self) -> List[str]:
        return ["READ_RISK_EVALUATION"]

    @property
    def inputs(self) -> List[str]:
        return [
            "RISK_EVALUATED events (risk score and warnings)",
            "settings.RISK_PER_TRADE as the per-trade risk fraction",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "STRESS_TESTED events with passed=True/False and the simulation's real figures",
            "An explicit failure when the simulation cannot be run (fails closed)",
        ]

    @property
    def category(self) -> str:
        return "risk"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["RISK_EVALUATED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["STRESS_TESTED"]

    @property
    def responsibilities(self) -> List[str]:
        return [
            "Estimate probability of ruin over a realistic trade sequence.",
            "Estimate worst-case drawdown.",
            "Fail the trade when the incoming risk score is already unacceptable.",
        ]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus", "algorithms/risk"]

    @property
    def memory_ttl(self) -> str:
        return "Stateless; last 50 verdicts retained in-process for explain_decision()."

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Risk evaluation from the event payload", "Configured risk-per-trade"]

    @property
    def prompt_reference(self) -> str:
        return "SIMULATION_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return []

    @property
    def database_tables(self) -> List[str]:
        return []

    @property
    def metrics_reported(self) -> List[str]:
        return ["Ruin probability", "Simulated max drawdown", "Pass/fail rate"]

    @property
    def failure_recovery_strategy(self) -> str:
        return (
            "Fails CLOSED. If the simulation raises or its inputs are unusable, the trade does not "
            "pass — the previous version returned passed=True unconditionally."
        )

    @property
    def health_status(self) -> str:
        return "Active"

    async def handle_event(self, event: BaseEvent) -> None:
        if not isinstance(event, RiskEvaluatedEvent):
            return

        # The Risk agent has already judged this unacceptable; no simulation
        # can overturn that.
        if event.risk_score >= RISK_SCORE_HARD_FAIL:
            results = {
                "reason": f"incoming risk score {event.risk_score:.2f} >= hard-fail {RISK_SCORE_HARD_FAIL}",
                "warnings": event.warnings,
            }
            self.record_decision("FAIL", results["reason"], results, acted=True)
            await self._publish(event.symbol, False, results)
            return

        try:
            # Uses the shared library simulation rather than a private copy —
            # two independent ruin simulations will eventually disagree about
            # whether the same strategy is survivable (spec Section 20: never
            # duplicate logic).
            sim = monte_carlo_trade_sequence(
                risk_fraction=settings.RISK_PER_TRADE,
                num_simulations=SIMULATIONS,
                trades_per_simulation=TRADES_PER_SIMULATION,
            )
            if not sim.get("available"):
                results = {**sim, "note": "simulation inputs unusable; failing closed"}
                self.record_decision("FAIL", sim.get("reason", "simulation unavailable"), results, acted=True)
                await self._publish(event.symbol, False, results)
                return
        except Exception as e:
            # Fails closed — see failure_recovery_strategy.
            logger.error("Stress simulation failed for %s: %s", event.symbol, e)
            results = {"error": str(e), "note": "simulation could not run; failing closed"}
            self.record_decision("FAIL", f"simulation error: {e}", results, acted=True)
            await self._publish(event.symbol, False, results)
            return

        ruin = sim["prob_of_ruin"]
        drawdown = sim["expected_max_drawdown"]
        ruin_ok = ruin <= MAX_RUIN_PROBABILITY
        dd_ok = drawdown <= MAX_SIMULATED_DRAWDOWN
        passed = ruin_ok and dd_ok

        failures = []
        if not ruin_ok:
            failures.append(
                f"ruin probability {ruin * 100:.2f}% exceeds {MAX_RUIN_PROBABILITY * 100:.0f}%"
            )
        if not dd_ok:
            failures.append(
                f"expected max drawdown {drawdown * 100:.1f}% exceeds "
                f"{MAX_SIMULATED_DRAWDOWN * 100:.0f}%"
            )

        results: Dict[str, Any] = {
            **sim,
            # Reported as a percentage of equity, and named so it cannot be
            # confused with the previous fabricated "2.5" whose units were
            # never stated.
            "max_drawdown_simulation_pct": round(drawdown * 100, 2),
            "incoming_risk_score": event.risk_score,
            "incoming_warnings": event.warnings,
            "thresholds": {
                "maxRuinProbability": MAX_RUIN_PROBABILITY,
                "maxDrawdownFraction": MAX_SIMULATED_DRAWDOWN,
            },
            "failures": failures,
        }

        rationale = (
            f"{'PASS' if passed else 'FAIL'}: ruin {ruin * 100:.2f}%, "
            f"expected max drawdown {drawdown * 100:.1f}% over {SIMULATIONS} simulations "
            f"of {TRADES_PER_SIMULATION} trades at {settings.RISK_PER_TRADE * 100:.1f}% risk each."
        )
        if failures:
            rationale += " Failures: " + "; ".join(failures)

        self.record_decision("PASS" if passed else "FAIL", rationale, results, acted=True)
        logger.info("Stress test %s for %s: %s", "PASSED" if passed else "FAILED", event.symbol, rationale)
        await self._publish(event.symbol, passed, results)

    async def _publish(self, symbol: str, passed: bool, results: Dict[str, Any]) -> None:
        await self.publish(StressTestedEvent(symbol=symbol, passed=passed, results=results))

def get_simulation_agent() -> SimulationAgent:
    return SimulationAgent()
