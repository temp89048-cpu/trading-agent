"""Debate Agent — the Multi-Agent Parliament (spec Section 22.7).

Weighs bull evidence against bear evidence and publishes a verdict the
Supervisor can act on. The arithmetic lives in `algorithms/debate.py`; this
agent supplies real market data to it and reports the result.

THE BUG THIS FIXES
------------------
The previous implementation was:

    memory = get_memory_stats()      # fetched, then never referenced
    bull_score = 3
    bear_score = 1
    winning_dir = "LONG"
    confidence = 0.85
    rationale = "Bull arguments outweighed Bear arguments."

Every debate, on every symbol, in every market condition, concluded LONG at
85% confidence. It also never looked at `event.macro_data`, which was the
whole input it was triggered by. Downstream this mattered more than it looks:
the Supervisor takes trade direction from DEBATE_CONCLUDED, so the entire
pipeline was hard-wired to go long — and because a fixed 0.85 sits above every
confidence threshold in the system, no gate could ever filter it out.
"""

import logging
from typing import Any, Dict, List

from backend.algorithms.debate import MIN_CANDLES, score_debate
from backend.core.agent_base import BaseAgent
from backend.models.events import (
    BaseEvent,
    DebateConcludedEvent,
    EventType,
    FeaturesComputedEvent,
    MacroAnalyzedEvent,
    MarketStructureAnalyzedEvent,
)
from backend.services.market_data import fetch_klines

logger = logging.getLogger(__name__)

# More than algorithms/debate.MIN_CANDLES so a short feed gap doesn't silently
# drop checks out of the verdict.
KLINE_LIMIT = 120


class DebateAgent(BaseAgent):
    version = "2.0.0"
    priority = 30

    def __init__(self) -> None:
        # Context cached from the upstream Market Intelligence stages, keyed by
        # symbol. Included in the published rationale so a verdict can be read
        # against the multi-timeframe view that preceded it.
        self._features: Dict[str, Dict[str, Any]] = {}
        self._structure: Dict[str, Dict[str, Any]] = {}
        super().__init__()

    @property
    def name(self) -> str:
        return "Debate Agent"

    @property
    def purpose(self) -> str:
        return "Weighs bull against bear evidence from real market data and publishes a directional verdict with calibrated confidence."

    @property
    def permissions(self) -> List[str]:
        return ["READ_MACRO", "READ_MEMORY", "READ_MARKET_DATA"]

    @property
    def inputs(self) -> List[str]:
        return [
            "MACRO_ANALYZED events (trigger + macro context)",
            "15m klines via services/market_data.fetch_klines",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "DEBATE_CONCLUDED events carrying direction, confidence and a full evidence breakdown",
            "A NEUTRAL verdict when evidence conflicts or data is insufficient (an explicit refusal, not a default direction)",
        ]

    @property
    def category(self) -> str:
        return "strategy"

    @property
    def events_consumed(self) -> List[EventType]:
        # FEATURES_COMPUTED and MARKET_STRUCTURE_ANALYZED were both published
        # by Market Intelligence and consumed by nobody — the Feature Engine
        # and Market Structure stages of spec Section 6's chain were computed
        # and discarded, while this agent separately re-fetched its own klines.
        # Consumed here so the work is used and the chain is continuous.
        # MACRO_ANALYZED remains the trigger; the other two are context.
        return ["FEATURES_COMPUTED", "MARKET_STRUCTURE_ANALYZED", "MACRO_ANALYZED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["DEBATE_CONCLUDED"]

    @property
    def responsibilities(self) -> List[str]:
        return [
            "Score trend, structure, momentum, volume and volatility as signed evidence.",
            "Publish NEUTRAL rather than a weak direction when the sides are balanced.",
            "Scale confidence by how many checks could actually be evaluated.",
        ]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus", "MarketData", "algorithms/debate", "algorithms/structure", "agents/regime_agent"]

    @property
    def memory_ttl(self) -> str:
        return "Stateless per debate; last 50 verdicts retained in-process for explain_decision()."

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Market klines", "Macro analysis from the event payload"]

    @property
    def prompt_reference(self) -> str:
        return "DEBATE_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["Exchange OHLCV via services/market_data"]

    @property
    def database_tables(self) -> List[str]:
        return []

    @property
    def metrics_reported(self) -> List[str]:
        return ["Verdicts by direction", "Mean confidence", "Checks unavailable per verdict"]

    @property
    def failure_recovery_strategy(self) -> str:
        return (
            "Fails to NEUTRAL. Insufficient candles, a stale feed, or a failed check produce a "
            "NEUTRAL verdict at 0.0 confidence, which the Supervisor treats as a refusal. It never "
            "falls back to a default direction."
        )

    @property
    def health_status(self) -> str:
        return "Active"

    async def handle_event(self, event: BaseEvent) -> None:
        # Context events: recorded, not acted on. MACRO_ANALYZED is the trigger
        # because it is published last in the Market Intelligence sequence, so
        # by the time it arrives the features and structure for this symbol are
        # already cached below.
        if isinstance(event, FeaturesComputedEvent):
            self._features[event.symbol] = event.features
            return
        if isinstance(event, MarketStructureAnalyzedEvent):
            self._structure[event.symbol] = event.structure_data
            return

        if not isinstance(event, MacroAnalyzedEvent):
            return

        symbol = event.symbol
        klines = await fetch_klines(symbol, "15m", limit=KLINE_LIMIT)

        if len(klines) < MIN_CANDLES:
            # Publish the NEUTRAL verdict rather than staying silent. Silence
            # is indistinguishable from a crashed agent; an explicit NEUTRAL
            # tells the Supervisor a debate happened and found no edge.
            rationale = (
                f"Only {len(klines)} candle(s) retrieved for {symbol}; {MIN_CANDLES} needed. "
                f"No directional view — this is a data gap, not a bearish signal."
            )
            self.record_decision("NEUTRAL", rationale, {"candles": len(klines)}, acted=False)
            await self.publish(
                DebateConcludedEvent(
                    symbol=symbol,
                    winning_direction="NEUTRAL",
                    consensus_confidence=0.0,
                    participants=["Bull", "Bear"],
                    supervisor_rationale=rationale,
                )
            )
            return

        result = score_debate(klines)

        # Macro context adjusts conviction but never flips direction — a macro
        # reading is not a signal about this instrument's price structure, and
        # letting it overturn the technical verdict would double-count it
        # (the Macro agent already ran to produce this event).
        macro_note = self._macro_note(event.macro_data)
        confidence = result.confidence
        if macro_note.get("penalty"):
            confidence = max(0.0, confidence * (1.0 - macro_note["penalty"]))

        rationale = result.rationale
        if macro_note.get("detail"):
            rationale = f"{rationale} Macro: {macro_note['detail']}"

        # Upstream multi-timeframe context, if Market Intelligence published it
        # for this symbol. Reported alongside the verdict so a LONG taken
        # against a bearish higher timeframe is visible rather than buried.
        upstream = self._features.get(symbol) or {}
        mtf = upstream.get("multi_tf_trend")
        if mtf:
            rationale = f"{rationale} Multi-timeframe trend: {mtf}."
            # A verdict fighting the higher-timeframe consensus is not blocked,
            # but it is not allowed to claim full conviction either.
            if (mtf == "Bearish" and result.direction == "LONG") or (
                mtf == "Bullish" and result.direction == "SHORT"
            ):
                confidence *= 0.7
                rationale += " Conviction reduced 30% — verdict opposes the multi-timeframe trend."

        participants = [a.name for a in result.bull_arguments] + [a.name for a in result.bear_arguments]

        self.record_decision(
            result.direction,
            rationale,
            {
                "confidence": confidence,
                "bull": [a.name for a in result.bull_arguments],
                "bear": [a.name for a in result.bear_arguments],
                "unavailable": result.unavailable,
            },
            acted=result.direction != "NEUTRAL",
        )

        logger.info(
            "Debate on %s: %s at %.1f%% confidence (%d bull, %d bear, %d unavailable)",
            symbol,
            result.direction,
            confidence * 100,
            len(result.bull_arguments),
            len(result.bear_arguments),
            len(result.unavailable),
        )

        await self.publish(
            DebateConcludedEvent(
                symbol=symbol,
                winning_direction=result.direction,
                consensus_confidence=confidence,
                participants=participants or ["Bull", "Bear"],
                supervisor_rationale=rationale,
            )
        )

    @staticmethod
    def _macro_note(macro_data: Dict[str, Any]) -> Dict[str, Any]:
        """Turn macro context into a conviction penalty, or nothing.

        Returns a penalty rather than a direction on purpose — see the caller.
        An empty payload yields no penalty and says so, instead of being
        treated as "macro is fine".
        """
        if not macro_data:
            return {"detail": "no macro data supplied — no adjustment applied", "penalty": 0.0}

        penalty = 0.0
        notes = []

        # Only keys we actually understand are used. An unrecognised payload
        # is reported as unused rather than parsed speculatively.
        risk = macro_data.get("risk_level") or macro_data.get("riskLevel")
        if isinstance(risk, str):
            if risk.lower() in ("high", "elevated", "extreme"):
                penalty = max(penalty, 0.25)
                notes.append(f"risk_level={risk} reduces conviction 25%")
            else:
                notes.append(f"risk_level={risk}")

        event_flag = macro_data.get("major_event") or macro_data.get("majorEvent")
        if event_flag:
            penalty = max(penalty, 0.30)
            notes.append(f"major macro event pending ({event_flag}) reduces conviction 30%")

        if not notes:
            notes.append(f"macro payload keys {sorted(macro_data)} not interpreted — no adjustment")

        return {"detail": "; ".join(notes), "penalty": penalty}


def get_debate_agent() -> DebateAgent:
    return DebateAgent()
