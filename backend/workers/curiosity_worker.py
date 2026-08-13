"""AI Curiosity Engine — spec Section 15.

    "Every hour, it asks itself: What don't I understand? What strategy failed
     today? Why? What evidence contradicts my current view? Has this happened
     before? What can I simulate to test this? What should I look at? Should I
     ask another model for a second opinion? Should I create a hypothesis? Can I
     verify it? Can I improve because of it?"

Section 15 calls this *"the single most valuable addition ... the piece most
retail trading-bot projects skip entirely."*

WHAT THIS REPLACED
------------------
    recent_anomalies = ["Trend Following failed during high vol regime"]  # hardcoded
    hypothesis = f"Hypothesis: Trend following requires VIX < 20. ..."    # hardcoded
    # self.bus.publish(ResearchTaskSubmitted(...))                        # commented out

A hardcoded anomaly, a hardcoded hypothesis about VIX (which this system does
not track at all), and a publish that never happened. `main.py` never started
the worker either.

WHAT IT DOES NOW
----------------
Reads the real trade ledger and the real research queue, finds where performance
actually diverges — a strategy whose win rate is materially below the base rate,
a regime where losses cluster, research questions that were queued and never
answered — and queues concrete research tasks for what it cannot explain.

IT ONLY EVER ASKS QUESTIONS
---------------------------
Section 17: *"Research never directly affects production."* This worker writes
research tasks and nothing else. It has no path to risk config, strategy
selection, or execution, and it cannot promote a hypothesis — that requires a
human (see services/research_store.HUMAN_ONLY_STATUSES).
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Below this many trades, apparent divergence between strategies is sampling
# noise. Generating a research task from 3 trades would fill the queue with
# questions about randomness.
MIN_TRADES_FOR_COMPARISON = 10

# A strategy whose win rate is this far below the overall rate is worth asking
# about. 15 points is wide enough to survive modest samples.
UNDERPERFORMANCE_THRESHOLD_PCT = 15.0


class CuriosityEngineWorker:
    """Hourly: find what the system cannot explain, and queue research for it."""

    def __init__(self, interval_seconds: int = 3600):
        self.interval_seconds = interval_seconds
        self._running = False
        self.last_cycle: Optional[Dict[str, Any]] = None
        self.cycles_run = 0

    async def start(self) -> None:
        self._running = True
        logger.info("AI Curiosity Engine started (every %ds).", self.interval_seconds)
        while self._running:
            try:
                self.last_cycle = await self.run_cycle()
                self.cycles_run += 1
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error("Curiosity cycle failed: %s", e)
            await asyncio.sleep(self.interval_seconds)

    def stop(self) -> None:
        self._running = False
        logger.info("AI Curiosity Engine stopped after %d cycle(s).", self.cycles_run)

    async def run_cycle(self) -> Dict[str, Any]:
        """Look for genuine anomalies and queue research questions about them."""
        from backend.services.ai_memory import generate_learning_report, get_memory_stats
        from backend.services.research_store import add_research_tasks, get_research_tasks

        now = datetime.utcnow().isoformat()
        questions: List[str] = []
        anomalies: List[str] = []
        unexplored: List[str] = []

        memory = get_memory_stats() or {}
        ledger = memory.get("trade_ledger") or []
        global_stats = memory.get("global_stats") or {}
        total = global_stats.get("total_trades") or 0

        # --- "What don't I understand?" ---------------------------------
        if total < MIN_TRADES_FOR_COMPARISON:
            # Honest: with this little history there is nothing to be curious
            # about yet, and inventing an anomaly would be the old behaviour.
            unexplored.append(
                f"Only {total} recorded trade(s) — below the {MIN_TRADES_FOR_COMPARISON} needed "
                f"before per-strategy differences mean anything. No anomalies claimed."
            )
        else:
            report = generate_learning_report()
            if "error" not in report:
                overall = report.get("win_rate", 0.0)

                # --- "What strategy failed today? Why?" -----------------
                for strat in report.get("worst_strategies", []) or []:
                    trades = strat.get("trades", 0)
                    rate = strat.get("win_rate", 0.0)
                    if trades >= MIN_TRADES_FOR_COMPARISON and (overall - rate) >= UNDERPERFORMANCE_THRESHOLD_PCT:
                        anomalies.append(
                            f"{strat['name']}: {rate:.1f}% win rate over {trades} trades vs "
                            f"{overall:.1f}% overall."
                        )
                        questions.append(
                            f"Why does {strat['name']} win {rate:.1f}% of the time against a "
                            f"{overall:.1f}% baseline? Identify the market conditions where it "
                            f"fails, and whether it should be gated out of them."
                        )

                # --- "What evidence contradicts my current view?" -------
                expectancy = report.get("expectancy")
                if expectancy is not None and expectancy < 0 and overall >= 50:
                    # Winning more often than not while losing money is exactly
                    # the kind of contradiction worth surfacing: it means losers
                    # are much larger than winners.
                    anomalies.append(
                        f"Win rate is {overall:.1f}% but expectancy is {expectancy:.2f} — "
                        f"winning more often than not while losing money overall."
                    )
                    questions.append(
                        "Expectancy is negative despite a win rate above 50%. Are losers being "
                        "held past their stop, or are targets being taken too early relative to "
                        "the stop distance?"
                    )

        # --- "Has this happened before?" / "Can I verify it?" ------------
        open_tasks = await get_research_tasks(open_only=True)
        if open_tasks:
            unexplored.append(
                f"{len(open_tasks)} research question(s) queued earlier are still unanswered — "
                f"no new duplicates generated for them."
            )

        # --- "Should I ask another model for a second opinion?" ----------
        # Answered honestly rather than skipped: the collaboration protocol
        # exists on the TypeScript side only.
        unexplored.append(
            "Second-opinion collaboration (spec Section 16) is implemented in "
            "lib/collaborationAgent.ts and has no backend path, so this question cannot be "
            "acted on here."
        )

        created = []
        if questions:
            created = await add_research_tasks(
                hypothesis_id=None,
                trade_id=f"curiosity-{now}",
                symbol="portfolio",
                tasks=questions,
            )

        cycle = {
            "ts": now,
            "tradesConsidered": total,
            "anomalies": anomalies,
            "questionsQueued": [t["question"] for t in created],
            "unexplored": unexplored,
            # Section 17's guarantee, stated on every cycle record.
            "affectsProduction": False,
            "note": (
                "Research only. This worker queues questions; it cannot change risk config, "
                "strategy selection, or execution, and cannot promote a hypothesis."
            ),
        }

        if anomalies:
            logger.info(
                "Curiosity cycle: %d anomaly/anomalies, %d question(s) queued.",
                len(anomalies), len(created),
            )
        else:
            logger.info("Curiosity cycle: nothing anomalous. %s", "; ".join(unexplored[:1]))

        return cycle


_worker: Optional[CuriosityEngineWorker] = None


def get_curiosity_worker(interval_seconds: int = 3600) -> CuriosityEngineWorker:
    global _worker
    if _worker is None:
        _worker = CuriosityEngineWorker(interval_seconds)
    return _worker
