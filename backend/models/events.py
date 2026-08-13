from typing import Literal, Dict, Any, List, Optional
from pydantic import BaseModel, Field
from datetime import datetime
from uuid import UUID, uuid4

EventType = Literal[
    'TICK_RECEIVED',
    'FEATURES_COMPUTED',
    'MARKET_STRUCTURE_ANALYZED',
    'LIQUIDITY_ANALYZED',
    'FUNDING_ANALYZED',
    'NEWS_ANALYZED',
    'MACRO_ANALYZED',
    'SIGNAL_GENERATED',
    'DEBATE_CONCLUDED',
    'CONFIDENCE_CALIBRATED',
    'RISK_EVALUATED',
    'STRESS_TESTED',
    'TAR_SUBMITTED',
    'TAR_APPROVED',
    'TAR_REJECTED',
    'ORDER_ROUTED',
    'ORDER_FILLED',
    'POSITION_CLOSED',
    'REFLECTION_COMPLETED'
]

class BaseEvent(BaseModel):
    event_id: UUID = Field(default_factory=uuid4)
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    event_type: EventType

# 1. TICK_RECEIVED
class TickReceivedEvent(BaseEvent):
    event_type: Literal['TICK_RECEIVED'] = 'TICK_RECEIVED'
    symbol: str
    price: float
    volume: float
    exchange: str

# 2. FEATURES_COMPUTED
class FeaturesComputedEvent(BaseEvent):
    event_type: Literal['FEATURES_COMPUTED'] = 'FEATURES_COMPUTED'
    symbol: str
    timeframe: str
    features: Dict[str, Any]

class MarketStructureAnalyzedEvent(BaseEvent):
    event_type: Literal['MARKET_STRUCTURE_ANALYZED'] = 'MARKET_STRUCTURE_ANALYZED'
    symbol: str
    structure_data: Dict[str, Any]

class LiquidityAnalyzedEvent(BaseEvent):
    event_type: Literal['LIQUIDITY_ANALYZED'] = 'LIQUIDITY_ANALYZED'
    symbol: str
    liquidity_data: Dict[str, Any]

class FundingAnalyzedEvent(BaseEvent):
    event_type: Literal['FUNDING_ANALYZED'] = 'FUNDING_ANALYZED'
    symbol: str
    funding_data: Dict[str, Any]

class NewsAnalyzedEvent(BaseEvent):
    event_type: Literal['NEWS_ANALYZED'] = 'NEWS_ANALYZED'
    symbol: str
    news_data: Dict[str, Any]

class MacroAnalyzedEvent(BaseEvent):
    event_type: Literal['MACRO_ANALYZED'] = 'MACRO_ANALYZED'
    symbol: str
    macro_data: Dict[str, Any]

# 3. SIGNAL_GENERATED
class SignalGeneratedEvent(BaseEvent):
    event_type: Literal['SIGNAL_GENERATED'] = 'SIGNAL_GENERATED'
    agent_id: str
    symbol: str
    strategy: str
    direction: Literal['LONG', 'SHORT', 'NEUTRAL']
    confidence: float
    rationale: str

# 4. DEBATE_CONCLUDED
class DebateConcludedEvent(BaseEvent):
    event_type: Literal['DEBATE_CONCLUDED'] = 'DEBATE_CONCLUDED'
    symbol: str
    winning_direction: Literal['LONG', 'SHORT', 'NEUTRAL']
    consensus_confidence: float
    participants: List[str]
    supervisor_rationale: str

class ConfidenceCalibratedEvent(BaseEvent):
    event_type: Literal['CONFIDENCE_CALIBRATED'] = 'CONFIDENCE_CALIBRATED'
    symbol: str
    calibrated_confidence: float
    breakdown: Dict[str, float]

class RiskEvaluatedEvent(BaseEvent):
    event_type: Literal['RISK_EVALUATED'] = 'RISK_EVALUATED'
    symbol: str
    risk_score: float
    warnings: List[str]

class StressTestedEvent(BaseEvent):
    event_type: Literal['STRESS_TESTED'] = 'STRESS_TESTED'
    symbol: str
    passed: bool
    results: Dict[str, Any]

# 5. TAR_SUBMITTED (Trade Authorization Request)
#
# `stop_loss` and `tab` are REQUIRED fields, deliberately with no defaults.
#
# CLAUDE.md invariant 3 says every position requires a computed stop-loss.
# Previously the TAR events carried no stop at all, so the Execution Engine
# routed a bare market order and nothing downstream could enforce the
# invariant even in principle — the information simply wasn't in the message.
# Making it a required Pydantic field means a TAR that cannot state its stop
# fails construction, at the Supervisor, before the CRO ever sees it. An
# Optional field with a None default would have let the old behaviour back in
# silently.
#
# `tab` is required for the same reason: the leverage ceiling and the trade's
# persisted destination both depend on whether this is paper or real money,
# and defaulting that is how a paper trade ends up recorded as a real one.
class TarSubmittedEvent(BaseEvent):
    event_type: Literal['TAR_SUBMITTED'] = 'TAR_SUBMITTED'
    tar_id: UUID = Field(default_factory=uuid4)
    symbol: str
    direction: Literal['LONG', 'SHORT']
    requested_size: float
    requested_leverage: int
    strategy: str
    supervisor_rationale: str
    stop_loss: float
    tab: Literal['paper', 'real']
    take_profit: Optional[float] = None
    entry_price: Optional[float] = None

# 6. TAR_APPROVED / TAR_REJECTED
class TarApprovedEvent(BaseEvent):
    event_type: Literal['TAR_APPROVED'] = 'TAR_APPROVED'
    tar_id: UUID
    symbol: str
    direction: str
    approved_size: float
    approved_leverage: int
    cro_rationale: str
    # Carried through from the TAR so the Execution Engine can attach the
    # protective stop to the position it just opened. If this did not travel
    # with the approval, Execution would have to re-derive it and could
    # legitimately arrive at a different number than the one Risk approved.
    stop_loss: float
    tab: Literal['paper', 'real']
    take_profit: Optional[float] = None

class TarRejectedEvent(BaseEvent):
    event_type: Literal['TAR_REJECTED'] = 'TAR_REJECTED'
    tar_id: UUID
    rule_breached: str
    cro_rationale: str

# 7. ORDER_ROUTED
class OrderRoutedEvent(BaseEvent):
    event_type: Literal['ORDER_ROUTED'] = 'ORDER_ROUTED'
    tar_id: UUID
    exchange: str
    order_id: str
    order_type: str
    price: Optional[float]
    quantity: float

# 8. ORDER_FILLED
#
# `symbol`, `side` and `tab` are required. They were absent, and
# `agents/reflection_agent.py` worked around that by hardcoding
# `"symbol": "BTC/USDT"` with the comment "Mocking symbol since
# OrderFilledEvent doesn't carry it (only tar_id)". Every reflection in the
# system was therefore attributed to BTC/USDT regardless of what actually
# traded — and those reflections feed the accuracy figure the Confidence
# Agent calibrates against, so fabricated attribution propagated into
# position sizing. Carrying the fields removes the reason to invent them.
class OrderFilledEvent(BaseEvent):
    event_type: Literal['ORDER_FILLED'] = 'ORDER_FILLED'
    tar_id: UUID
    exchange: str
    order_id: str
    symbol: str
    side: Literal['buy', 'sell']
    tab: Literal['paper', 'real']
    fill_price: float
    fill_quantity: float
    slippage_bps: float
    fee: float


# 8b. POSITION_CLOSED — the event the learning pipeline actually needs.
#
# Spec Section 12 requires that "every COMPLETED trade" generates a
# reflection. There was no completion event: the Reflection agent listened to
# ORDER_FILLED, which fires when a position OPENS, and supplied a hardcoded
# `pnl: -50.0` ("Mock negative PNL to trigger reflection") because an opening
# fill has no P&L to report. So the learning system was reflecting on entries
# using an invented loss.
#
# `realized_pnl` is required and has no default, so a close cannot be
# announced without stating its actual outcome.
class PositionClosedEvent(BaseEvent):
    event_type: Literal['POSITION_CLOSED'] = 'POSITION_CLOSED'
    trade_id: str
    symbol: str
    side: Literal['buy', 'sell']
    tab: Literal['paper', 'real']
    entry_price: float
    exit_price: float
    quantity: float
    realized_pnl: float
    # Why it closed: 'take-profit' | 'stop-loss' | 'thesis-invalidated' |
    # 'manual' | 'liquidation'. Labelling a thesis-driven exit as a stop
    # misreports WHY the position closed, which is exactly the information
    # the reflection then learns from.
    exit_reason: str
    strategies: List[str] = Field(default_factory=list)
    held_seconds: Optional[float] = None

# 9. REFLECTION_COMPLETED
class ReflectionCompletedEvent(BaseEvent):
    event_type: Literal['REFLECTION_COMPLETED'] = 'REFLECTION_COMPLETED'
    trade_id: str
    pnl: float
    lesson_learned: str
    confidence_calibration_delta: float
