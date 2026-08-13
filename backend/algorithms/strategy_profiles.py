"""Spec Section 11 — the strategy library and its eligibility template.

Section 11.3: *"No strategy goes live without every field above filled in and
validated."* That rule needs somewhere to live and something to check it, or it
is a paragraph. This module is the template as code, plus the gate that uses it.

THE GAP THIS FILLS
------------------
`agents/strategy_ensemble.py` runs nine strategies and counts their votes with
NO regime awareness at all. So Mean Reversion votes during a strong trend and
Grid votes in a trending market — the exact conditions where each loses money.
A strategy library without an "when is this strategy wrong" field is a list of
names.

`activeRegimes` is the field that makes the rest of the template load-bearing:
it is what lets the ensemble mute a strategy instead of averaging its bad
signal into the consensus.

REGIME LABELS MATCH THE EXISTING CLASSIFIER
-------------------------------------------
The labels here are exactly what `agents/regime_agent.detect_market_regime`
returns, not the TypeScript side's richer set (`strong-bull`, `compression`,
...). Inventing a second vocabulary would mean a translation layer, and a
mistranslation would silently gate the wrong strategies. When the Python
classifier gains finer labels, this list should follow it.

HISTORICAL SUCCESS RATE IS `None`, NOT ZERO
-------------------------------------------
Section 11.3 requires a historical success rate. None of these has been
validated on this system's own data, so the field is `None` — meaning "not
established". Zero would claim a measured 0% win rate, which is a much stronger
and false statement, and `profile_completeness()` reports it as the outstanding
field rather than letting the profile look finished.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

# Exactly the labels agents/regime_agent.detect_market_regime returns.
REGIME_TRENDING_BULL = "Trending Bullish"
REGIME_TRENDING_BEAR = "Trending Bearish"
REGIME_RANGING = "Ranging / Low Volatility"
REGIME_HIGH_VOL = "High Volatility"
REGIME_UNKNOWN = "Unknown"

ALL_REGIMES = (REGIME_TRENDING_BULL, REGIME_TRENDING_BEAR, REGIME_RANGING, REGIME_HIGH_VOL)
TRENDING = (REGIME_TRENDING_BULL, REGIME_TRENDING_BEAR)


@dataclass(frozen=True)
class StrategyProfile:
    """Section 11.3's template, field for field."""

    # Identity — must match the key the ensemble votes under, or gating
    # silently does nothing. `test_every_voting_strategy_has_a_profile` checks it.
    agent: str
    name: str

    best_conditions: str            # when this strategy should be active
    worst_conditions: str           # when it must be deactivated
    expected_holding_time: str
    risk_profile: str
    indicators_used: List[str]
    entry_logic: str
    exit_logic: str
    position_sizing_rule: str
    active_regimes: Tuple[str, ...]  # market regime fit
    historical_success_rate: Optional[float]  # None = not established
    confidence_rules: str
    portfolio_rules: str
    failure_modes: List[str]
    self_evaluation: str

    def is_active_in(self, regime: str) -> bool:
        """Is this strategy eligible in `regime`?

        An UNKNOWN regime returns True. The alternative — muting every strategy
        whenever the classifier has too little history — would silently stop the
        system trading at exactly the moments a new symbol starts up, and
        "unknown" is not evidence that a strategy is unsuitable. The Supervisor's
        own gates still apply.
        """
        if regime == REGIME_UNKNOWN or not regime:
            return True
        return regime in self.active_regimes


# ---------------------------------------------------------------------------
# Profiles for the strategies the backend ensemble actually votes with.
# ---------------------------------------------------------------------------

STRATEGY_PROFILES: List[StrategyProfile] = [
    StrategyProfile(
        agent="Trend",
        name="Trend Following (EMA crossover)",
        best_conditions="A sustained directional move with the fast EMA clear of the slow EMA.",
        worst_conditions="Choppy, range-bound price action — crossovers whipsaw and every one is a loss.",
        expected_holding_time="Hours to days",
        risk_profile="~1:2 R:R, tolerates a wider stop because the entry is mid-trend",
        indicators_used=["EMA(12)", "EMA(26)"],
        entry_logic="Fast EMA crosses and holds above/below the slow EMA.",
        exit_logic="ATR stop at 1.5x, target 3.0x, or the crossover reverses.",
        position_sizing_rule="Volatility-adjusted from the ATR stop distance (core/risk_manager).",
        active_regimes=TRENDING,
        historical_success_rate=None,
        confidence_rules="Requires the multi-timeframe trend to agree; conviction is cut 30% when it does not.",
        portfolio_rules="Subject to the CIO's correlated-exposure cap — trend signals cluster across correlated pairs.",
        failure_modes=[
            "Whipsaw in a range: repeated crossover entries each stopped out.",
            "Late entry near trend exhaustion, where the stop is far and the remaining move is small.",
        ],
        self_evaluation="Compare realised R against the 1:2 target, and count how many exits were crossover reversals rather than target hits.",
    ),
    StrategyProfile(
        agent="MeanReversion",
        name="Mean Reversion (RSI extremes)",
        best_conditions="Range-bound price with RSI reaching an extreme and no directional trend.",
        worst_conditions="A strong trend. RSI can sit above 70 for the entire move, and every fade is a loss against a running market.",
        expected_holding_time="Minutes to hours",
        risk_profile="Tight stop, modest target; a high win rate with occasional large losers",
        indicators_used=["RSI(14)"],
        entry_logic="RSI below 30 (long) or above 70 (short), with no trending regime.",
        exit_logic="RSI returns to the 40-60 band, or the ATR stop is hit.",
        position_sizing_rule="Volatility-adjusted; the tight stop means a small position in absolute terms.",
        # The single most important gating decision in this file: mean reversion
        # is BARRED from trending regimes. Fading a strong trend is the classic
        # way this strategy produces one loss that erases many wins.
        active_regimes=(REGIME_RANGING,),
        historical_success_rate=None,
        confidence_rules="Muted entirely outside a ranging regime, regardless of how extreme RSI is.",
        portfolio_rules="Max one mean-reversion position per correlated cluster.",
        failure_modes=[
            "Fading a strong trend: RSI stays extreme and the position is stopped out at the worst point.",
            "A high win rate masking negative expectancy when the rare loser is many times the average win.",
        ],
        self_evaluation="Track the ratio of the largest loss to the average win; above ~5x means the edge is illusory.",
    ),
    StrategyProfile(
        agent="Momentum",
        name="Momentum (MACD)",
        best_conditions="Accelerating directional movement with MACD expanding away from its signal line.",
        worst_conditions="Low-volatility drift, where MACD crossovers are noise.",
        expected_holding_time="Hours",
        risk_profile="~1:2 R:R",
        indicators_used=["MACD(12,26,9)"],
        entry_logic="MACD crosses its signal line in the direction of the histogram's expansion.",
        exit_logic="ATR stop/target, or histogram contraction.",
        position_sizing_rule="Volatility-adjusted from the ATR stop distance.",
        active_regimes=TRENDING + (REGIME_HIGH_VOL,),
        historical_success_rate=None,
        confidence_rules="Requires volume confirmation of the recent move.",
        portfolio_rules="Correlated-exposure capped; momentum fires simultaneously across a sector.",
        failure_modes=[
            "MACD lags a sharp reversal, so the exit is late.",
            "Firing on a single-candle spike that immediately retraces.",
        ],
        self_evaluation="Measure how much of the captured move occurred after entry versus before it.",
    ),
    StrategyProfile(
        agent="Scalping",
        name="Scalping (short-term momentum)",
        best_conditions="High liquidity and enough short-term volatility to cover fees and spread.",
        worst_conditions="Thin books or wide spreads — fees and slippage exceed the edge.",
        expected_holding_time="Seconds to minutes",
        risk_profile="Very tight stop; needs a high win rate to survive costs",
        indicators_used=["Short-window price change"],
        entry_logic="A short-window directional impulse.",
        exit_logic="Immediate target or stop; no position held through a regime change.",
        position_sizing_rule="Volatility-adjusted, and the smallest of any strategy given the tight stop.",
        active_regimes=(REGIME_HIGH_VOL, REGIME_RANGING),
        historical_success_rate=None,
        confidence_rules="Requires measured slippage on recent fills to be within the circuit-breaker limit.",
        portfolio_rules="Never more than one scalp per symbol at a time.",
        failure_modes=[
            "Fees and slippage consuming the entire edge — the most common way this fails.",
            "The in-process stop being too slow for a genuinely fast market.",
        ],
        self_evaluation="Net P&L AFTER fees and measured slippage; gross P&L is meaningless here.",
    ),
    StrategyProfile(
        agent="Swing",
        name="Swing Trading",
        best_conditions="A clear multi-day swing within a larger trend.",
        worst_conditions="Tight consolidation with no swing amplitude.",
        expected_holding_time="Days to weeks",
        risk_profile="Wide stop, large target; low trade frequency",
        indicators_used=["Swing highs/lows", "EMA"],
        entry_logic="Pullback to a swing level in the direction of the higher-timeframe trend.",
        exit_logic="Next swing extreme, or the ATR stop.",
        position_sizing_rule="Volatility-adjusted; the wide stop means a smaller position than the timeframe suggests.",
        active_regimes=TRENDING,
        historical_success_rate=None,
        confidence_rules="Requires higher-timeframe trend agreement.",
        portfolio_rules="Held overnight, so counts fully against correlated exposure.",
        failure_modes=[
            "Overnight gap through the stop — the in-process stop cannot fire while the market is closed or the process is down.",
            "Funding costs accumulating over a multi-day hold.",
        ],
        self_evaluation="Compare realised hold time against the expected range; much shorter means the stop was too tight for the timeframe.",
    ),
    StrategyProfile(
        agent="Breakout",
        name="Breakout Trading",
        best_conditions="Price compressing into a range, then breaking out on expanding volume.",
        worst_conditions="A market already extended in the breakout direction — the move is over.",
        expected_holding_time="Hours to days",
        risk_profile="~1:2 R:R; a meaningful fraction of breakouts fail",
        indicators_used=["Range high/low", "Volume"],
        entry_logic="Close beyond the recent range boundary with volume above baseline.",
        exit_logic="ATR target, or back inside the range (a failed breakout).",
        position_sizing_rule="Volatility-adjusted from the range boundary as the stop.",
        active_regimes=(REGIME_RANGING, REGIME_HIGH_VOL) + TRENDING,
        historical_success_rate=None,
        confidence_rules="Requires volume confirmation; a breakout on falling volume is muted.",
        portfolio_rules="Correlated-exposure capped.",
        failure_modes=[
            "False breakout: price closes beyond the range and immediately reverses through the stop.",
            "Entering after the move has already run, so the stop is far and the target close.",
        ],
        self_evaluation="Track the false-breakout rate: closes that re-entered the range within a few candles.",
    ),
    StrategyProfile(
        agent="Range",
        name="Range Trading",
        best_conditions="Well-defined support and resistance holding repeatedly.",
        worst_conditions="A breakout. Buying support that is about to fail is the failure mode.",
        expected_holding_time="Hours",
        risk_profile="Tight stop just beyond the boundary; modest target",
        indicators_used=["Support/resistance levels"],
        entry_logic="Reject from a range boundary back toward the middle.",
        exit_logic="Opposite boundary, or stop beyond the entry boundary.",
        position_sizing_rule="Volatility-adjusted.",
        active_regimes=(REGIME_RANGING,),
        historical_success_rate=None,
        confidence_rules="Muted outside a ranging regime.",
        portfolio_rules="Max one range position per symbol.",
        failure_modes=[
            "The range breaking while positioned against the break.",
            "Repeated small wins followed by one large loss when the range ends.",
        ],
        self_evaluation="Count how many range trades were profitable versus the size of the loss when the range finally broke.",
    ),
    StrategyProfile(
        agent="Grid",
        name="Grid Trading",
        best_conditions="Sideways oscillation with no net direction.",
        worst_conditions="A sustained trend. A grid accumulates against a trending market and the losses compound.",
        expected_holding_time="Hours to days (multiple simultaneous levels)",
        risk_profile="Many small wins; unbounded loss if the trend runs and levels keep filling",
        indicators_used=["Price levels", "Range width"],
        entry_logic="Ladder of orders across the range.",
        exit_logic="Each level exits at the next level; a hard stop outside the grid.",
        position_sizing_rule="Total grid exposure sized as one position, not per level.",
        # Barred from trending regimes for the same reason as Mean Reversion.
        active_regimes=(REGIME_RANGING,),
        historical_success_rate=None,
        confidence_rules="Muted outside a ranging regime.",
        portfolio_rules="A grid is one position for exposure purposes; its levels do not each get their own budget.",
        failure_modes=[
            "Trend runs through the grid and every level is underwater simultaneously.",
            "Total exposure being tracked per level rather than in aggregate, understating risk.",
        ],
        self_evaluation="Compare cumulative level profit against the worst aggregate drawdown of the whole grid.",
    ),
    StrategyProfile(
        agent="Arbitrage",
        name="Cross-Exchange Price Dislocation",
        best_conditions="A genuine, persistent price difference across venues that exceeds fees plus transfer cost.",
        worst_conditions="Any apparent spread that is actually a stale feed. Most are.",
        expected_holding_time="Seconds",
        risk_profile="Low directional risk in principle; execution and latency risk dominate in practice",
        indicators_used=["Multi-venue price comparison"],
        entry_logic="Spread beyond fees and estimated slippage on both legs.",
        exit_logic="Spread converges, or a time limit.",
        position_sizing_rule="Limited by the thinner of the two venues' liquidity.",
        active_regimes=ALL_REGIMES,
        historical_success_rate=None,
        confidence_rules="Requires both venue prices to be fresh. A stale quote is the most common cause of a phantom spread.",
        portfolio_rules="Requires simultaneous capital on both venues; not currently supported.",
        failure_modes=[
            "Acting on a stale feed and taking a directional position believing it is hedged.",
            "Only one leg filling, leaving unintended directional exposure.",
        ],
        self_evaluation="Measure how often both legs filled; a single-leg fill is a failure regardless of P&L.",
    ),
]

_BY_AGENT: Dict[str, StrategyProfile] = {p.agent: p for p in STRATEGY_PROFILES}


# ---------------------------------------------------------------------------
# Strategies Section 11.2 names that this backend does NOT implement.
#
# Listed with a concrete blocker each. The point is that "not implemented" is a
# statement about a missing input or venue capability, not a vague TODO — an
# honest gap list is checkable, and `test_all_spec_strategies_are_accounted_for`
# asserts every one of Section 11.2's 21 strategies is either profiled here or
# in this list.
# ---------------------------------------------------------------------------

PLANNED_STRATEGIES: Dict[str, str] = {
    "ICT": (
        "Needs order-block and fair-value-gap detection over labelled swing structure. "
        "algorithms/structure.py detects BOS/CHoCH only. Approximating order blocks with "
        "a nearby-candle heuristic produces confident-looking levels that are not the concept."
    ),
    "Smart Money Concepts": (
        "Requires the sweep-then-break sequence (liquidity sweep followed by a structural "
        "break), which needs sweep-event detection the backend does not have. Implemented "
        "on the TypeScript side as lib/strategies/smartMoney.ts."
    ),
    "Wyckoff": (
        "Depends on phase classification (accumulation/distribution) across volume and "
        "range over long windows. No volume-profile primitive exists in the backend."
    ),
    "Volume Profile": (
        "Needs traded volume bucketed by PRICE level, not by time. The kline feed provides "
        "volume per time bucket only; deriving value areas from it would be a guess."
    ),
    "VWAP": (
        "Computable from klines, but a session-anchored VWAP needs a defined session "
        "boundary, which is ambiguous for 24/7 crypto. Implemented on the TypeScript side "
        "as lib/strategies/vwapReversion.ts."
    ),
    "Market Making": (
        "Requires resting two-sided limit orders and live order-book depth. The Execution "
        "Engine places market orders only and there is no order-book feed."
    ),
    "Statistical Arbitrage": (
        "Needs cointegration testing across a universe of pairs plus simultaneous "
        "multi-leg execution. Neither exists."
    ),
    "Pairs Trading": (
        "Requires simultaneous long/short execution on two instruments as one position. "
        "The TAR model authorises a single symbol and direction."
    ),
    "Event-Driven": (
        "agents/event_agent.py detects volume and volatility anomalies, but there is no "
        "scheduled economic-calendar feed, so genuine event-driven entries cannot be timed."
    ),
    "Volatility": (
        "True volatility trading needs options or variance instruments. Only linear "
        "futures are reachable through the exchange client."
    ),
    "Funding-Rate Arbitrage": (
        "The funding rate IS available (agents/sentiment_agent.fetch_macro_data), but "
        "capturing it requires holding an offsetting spot position, and only futures are "
        "wired."
    ),
    "Basis Trading": (
        "Needs simultaneous spot and futures legs on the same asset. Spot is not wired."
    ),
    "Gamma Squeeze Detection": (
        "Requires options open-interest and dealer-positioning data. No options data source."
    ),
    "Liquidation Trading": (
        "Needs a liquidation-event stream (forced-order feed). Not subscribed; open "
        "interest alone is not sufficient to locate liquidation clusters."
    ),
    "News Trading": (
        "A news source exists on the TypeScript side, but the backend has no news feed and "
        "no latency budget that would make news entries meaningful."
    ),
    "Macro Trading": (
        "Fear & Greed and funding are fetched, but macro trading needs rate, liquidity and "
        "cross-asset series that are not sourced."
    ),
}


# ---------------------------------------------------------------------------
# Lookup and gating
# ---------------------------------------------------------------------------

def get_profile(agent: str) -> Optional[StrategyProfile]:
    return _BY_AGENT.get(agent)


def is_strategy_active_in_regime(agent: str, regime: str) -> bool:
    """Is this strategy eligible to vote in this regime?

    An UNPROFILED strategy returns True and is NOT muted. That is deliberate:
    silently dropping a strategy nobody wrote a profile for would make the
    ensemble quietly weaker with no signal that anything was missing.
    `profile_completeness()` and `test_every_voting_strategy_has_a_profile`
    surface the gap loudly instead.
    """
    profile = _BY_AGENT.get(agent)
    if profile is None:
        return True
    return profile.is_active_in(regime)


def profile_completeness() -> Dict[str, Any]:
    """Makes Section 11.3's "every field filled in" rule checkable.

    Reports which fields are outstanding per strategy rather than a pass/fail,
    so the answer to "is this strategy eligible to go live?" is a list of what
    is missing.
    """
    REQUIRED = [
        "best_conditions", "worst_conditions", "expected_holding_time", "risk_profile",
        "indicators_used", "entry_logic", "exit_logic", "position_sizing_rule",
        "active_regimes", "historical_success_rate", "confidence_rules",
        "portfolio_rules", "failure_modes", "self_evaluation",
    ]

    rows = []
    for profile in STRATEGY_PROFILES:
        missing = []
        for f in REQUIRED:
            value = getattr(profile, f)
            if value is None:
                missing.append(f)
            elif isinstance(value, (list, tuple)) and not value:
                missing.append(f)
            elif isinstance(value, str) and not value.strip():
                missing.append(f)
        rows.append({
            "agent": profile.agent,
            "name": profile.name,
            "missingFields": missing,
            # Every profile is incomplete on exactly this field, by design —
            # none has been validated on this system's own data.
            "eligibleForLive": not missing,
        })

    return {
        "totalRequiredFields": len(REQUIRED),
        "profiled": len(STRATEGY_PROFILES),
        "planned": len(PLANNED_STRATEGIES),
        "strategies": rows,
        "eligibleForLive": [r["agent"] for r in rows if r["eligibleForLive"]],
        "note": (
            "Every profile is missing historical_success_rate because none has been validated "
            "on this system's own data. Per Section 11.3 that means none is formally eligible "
            "for live promotion; they remain eligible to VOTE, which is a different thing."
        ),
    }
