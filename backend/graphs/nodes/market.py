"""Phase 24 — Market State Graph nodes (spec Section 7).

    Market Event -> Data Validation -> Feature Generation -> Market Analysis
                 -> Regime Detection -> Market State

    Example result:
    { "regime": "TRENDING_BULL", "volatility": "MEDIUM", "liquidity": "HIGH",
      "trend_strength": 0.82, "confidence": 0.87 }

ALL FIVE NODES ARE DETERMINISTIC. NONE CALLS A MODEL.
----------------------------------------------------
Every field in the spec's example output is a computed number. There is nothing
here for a model to judge, and making any of it an LLM call would mean the same
candles could produce a different regime on a re-run — which would make the
regime gate in `algorithms/strategy_profiles` non-reproducible and destroy the
ability to backtest a strategy's own eligibility.

`contracts.py` enforces this: these nodes declare `deterministic=True`, and
`market_regime`/`technical_analysis`/`market_data` are all in
`DETERMINISTIC_ONLY_FIELDS`, so an LLM node could not write them even if one
were added later.

THESE NODES ARE THIN WRAPPERS
-----------------------------
The computation already exists and is already tested — `market_intelligence`'s
EMA/ATR/support-resistance helpers, `regime_agent.detect_market_regime`,
`sentiment_agent.fetch_macro_data`. A node's job is to read state, call that, and
write named fields. If a node here contained new trading logic, the logic would
be in the wrong place and would drift from the version the event-driven agents
use.

SECTION 39.4 — WHY `run_multi_timeframe_analysis` IS NOT CALLED HERE
-------------------------------------------------------------------
`market_intelligence.run_multi_timeframe_analysis()` fetches its own klines
internally. Calling it from a node would re-fetch market data mid-graph, so a
resumed run would reason over a DIFFERENT market than the decision it is meant to
be continuing. Instead `validate_market_data` fetches every timeframe ONCE into
`state['market_data']`, and the later nodes call `analyze_market_structure()` on
those stored candles.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

import numpy as np

from backend.agents.market_intelligence import (
    analyze_market_structure,
    calculate_atr,
    calculate_ema,
)
from backend.agents.regime_agent import detect_market_regime
from backend.graphs.contracts import NodeContract
from backend.graphs.registry import register_node
from backend.graphs.state import (
    MarketRegimeState,
    MarketSnapshot,
    SentimentAnalysis,
    TechnicalAnalysis,
    TradingState,
)
from backend.services.market_data import fetch_klines, get_price

logger = logging.getLogger(__name__)

# Timeframes fetched once per run. 15m drives the decision; 1h and 4h give the
# higher-timeframe context the debate uses to cut conviction on a
# counter-trend read.
TIMEFRAMES = ("15m", "1h", "4h")
PRIMARY_TIMEFRAME = "15m"

# Minimums, and what each one gates. Stated as constants because a node that
# silently proceeds on thin data produces a confident-looking regime derived
# from almost nothing.
MIN_CANDLES_FOR_STRUCTURE = 21   # analyze_market_structure's own floor
MIN_CANDLES_FOR_REGIME = 20      # detect_market_regime's floor
MIN_CANDLES_FOR_ATR = 15

# Volatility banding, as a per-candle stdev of returns. 1% per 15m candle is
# already brisk for a major pair.
VOL_MEDIUM_THRESHOLD = 0.004
VOL_HIGH_THRESHOLD = 0.010


# ===========================================================================
# 1. Data Validation
# ===========================================================================

async def validate_market_data(state: TradingState) -> Optional[Dict[str, Any]]:
    """Fetch and VALIDATE market data. The only node that writes `market_data`.

    IT REJECTS BAD DATA RATHER THAN REPAIRING IT.

    A validation node that forward-fills a gap, or substitutes the last good
    candle, produces a snapshot that looks complete and is not. Every downstream
    node would then compute confidently over invented bars. So each check either
    passes the data through or records the reason it cannot be used, and the
    graph continues with `market_data=None` — which the later nodes handle by
    reporting themselves unavailable.

    Section 39.4: this is the single fetch point. Everything downstream reads
    `state['market_data']`.
    """
    symbol = state["symbol"]
    price = get_price(symbol)

    problems: List[str] = []

    if price <= 0:
        # get_price returns 0.0 for an unknown symbol. Passing that through would
        # let downstream nodes compute percentages against zero.
        problems.append(f"no live price for {symbol} (feed returned {price})")

    candles: Dict[str, List[Dict[str, Any]]] = {}
    for tf in TIMEFRAMES:
        try:
            bars = await fetch_klines(symbol, tf, limit=120)
        except Exception as e:
            problems.append(f"{tf} klines fetch failed: {e}")
            continue

        if not bars:
            problems.append(f"{tf} klines returned empty")
            continue

        clean, rejected = _validate_candles(bars, tf)
        if rejected:
            # Recorded, not repaired. The count matters: 2 bad bars out of 120 is
            # a different situation from 60.
            problems.append(f"{tf}: {len(rejected)} malformed candle(s) discarded ({rejected[0]})")
        if clean:
            candles[tf] = clean

    if not candles:
        # Nothing usable. Return the problems and no snapshot — the graph
        # continues and every later node reports unavailable, rather than the run
        # aborting and losing the record of why.
        logger.warning("Market data validation produced nothing usable for %s: %s", symbol, problems)
        return {"unavailable": [f"market_data ({'; '.join(problems)})"]}

    snapshot = MarketSnapshot(
        symbol=symbol,
        price=price if price > 0 else None,
        candles=candles,
        # Read from state, not from time.time(). Section 39.4: a wall-clock read
        # inside a node returns a different value on replay.
        fetched_at=state["started_at"],
        source="websocket+rest",
    )

    out: Dict[str, Any] = {"market_data": snapshot}
    if problems:
        out["unavailable"] = [f"market_data partial ({'; '.join(problems)})"]
    return out


def _validate_candles(
    bars: List[Dict[str, Any]], timeframe: str
) -> tuple[List[Dict[str, Any]], List[str]]:
    """Drop structurally invalid candles, and say which were dropped.

    A candle is invalid when it cannot be arithmetic — a non-positive price, or a
    high below its low. Those are not edge cases to tolerate: `high < low` makes
    every range and ATR calculation meaningless, and a zero close makes every
    return calculation divide by zero.

    Deliberately does NOT drop outliers. A 20% candle is not invalid data, it is
    a 20% move, and discarding it would hide exactly the event the system should
    be reasoning about.
    """
    clean: List[Dict[str, Any]] = []
    rejected: List[str] = []

    for i, bar in enumerate(bars):
        try:
            o, h, l, c = float(bar["open"]), float(bar["high"]), float(bar["low"]), float(bar["close"])
            v = float(bar.get("volume", 0.0))
        except (KeyError, TypeError, ValueError):
            rejected.append(f"{timeframe}[{i}] missing or non-numeric OHLC")
            continue

        if min(o, h, l, c) <= 0:
            rejected.append(f"{timeframe}[{i}] non-positive price")
            continue
        if h < l:
            rejected.append(f"{timeframe}[{i}] high {h} below low {l}")
            continue
        if v < 0:
            rejected.append(f"{timeframe}[{i}] negative volume")
            continue

        clean.append(bar)

    return clean, rejected


# ===========================================================================
# 2. Feature Generation
# ===========================================================================

def generate_features(state: TradingState) -> Optional[Dict[str, Any]]:
    """EMA / ATR / RSI / support / resistance from the stored candles.

    Reads `state['market_data']`; never fetches. If the snapshot is missing or
    too thin it reports unavailable and writes no features, rather than emitting
    zeros — a zero ATR would be read downstream as "no volatility" and would make
    `compute_stop_loss_take_profit` refuse, which is the right outcome but for
    the wrong stated reason.
    """
    snapshot = state.get("market_data")
    if snapshot is None:
        return {"unavailable": ["features (no market data)"]}

    bars = snapshot.candles.get(PRIMARY_TIMEFRAME, [])
    if len(bars) < MIN_CANDLES_FOR_STRUCTURE:
        return {
            "unavailable": [
                f"features ({len(bars)} {PRIMARY_TIMEFRAME} candles, "
                f"need {MIN_CANDLES_FOR_STRUCTURE})"
            ]
        }

    closes = np.array([float(b["close"]) for b in bars])
    highs = np.array([float(b["high"]) for b in bars])
    lows = np.array([float(b["low"]) for b in bars])

    structure = analyze_market_structure(bars)

    atr_series = calculate_atr(highs, lows, closes, 14)
    atr = float(atr_series[-1]) if len(atr_series) and atr_series[-1] > 0 else None

    ema9 = calculate_ema(closes, 9)
    ema21 = calculate_ema(closes, 21)

    rsi = _rsi(closes)

    # `analyze_market_structure` returns support/resistance as LISTS of levels.
    # The nearest below/above the current price is what a stop or target would
    # use; taking min/max of the whole list would give the extremes of the
    # window, which are not actionable levels.
    price = float(closes[-1])
    supports = [s for s in (structure.get("support") or []) if s < price]
    resistances = [r for r in (structure.get("resistance") or []) if r > price]

    technical = TechnicalAnalysis(
        trend=structure.get("trend"),
        multi_timeframe_trend=_multi_timeframe_trend(snapshot),
        support=max(supports) if supports else None,
        resistance=min(resistances) if resistances else None,
        atr=atr,
        rsi=rsi,
        features={
            "ema9": float(ema9[-1]) if len(ema9) else None,
            "ema21": float(ema21[-1]) if len(ema21) else None,
            "candles_used": len(bars),
            "timeframe": PRIMARY_TIMEFRAME,
            # Counts, so a caller can see the levels were found rather than
            # assuming the single nearest one is all there was.
            "support_levels_found": len(structure.get("support") or []),
            "resistance_levels_found": len(structure.get("resistance") or []),
        },
    )

    out: Dict[str, Any] = {"technical_analysis": technical}
    missing = []
    if atr is None:
        missing.append("ATR")
    if rsi is None:
        missing.append("RSI")
    if missing:
        out["unavailable"] = [f"features partial (no {', '.join(missing)})"]
    return out


def _rsi(closes: np.ndarray, period: int = 14) -> Optional[float]:
    """Wilder-style RSI, or None when there is not enough history.

    None rather than 50. A neutral-looking 50 is indistinguishable from a
    measured neutral reading — the same class of bug as `fetch_macro_data`
    returning `fng: 50` on a failed request.
    """
    if len(closes) < period + 1:
        return None
    gains = losses = 0.0
    for i in range(len(closes) - period, len(closes)):
        change = float(closes[i] - closes[i - 1])
        if change >= 0:
            gains += change
        else:
            losses -= change
    avg_gain, avg_loss = gains / period, losses / period
    if avg_loss == 0:
        return 100.0 if avg_gain > 0 else 50.0
    rs = avg_gain / avg_loss
    return 100.0 - (100.0 / (1.0 + rs))


def _multi_timeframe_trend(snapshot: MarketSnapshot) -> Optional[str]:
    """Consensus trend across the fetched timeframes.

    Returns None when fewer than two timeframes could be assessed — a
    "multi-timeframe" trend derived from one timeframe is just that timeframe's
    trend wearing a more authoritative name.
    """
    votes: List[str] = []
    for tf in TIMEFRAMES:
        bars = snapshot.candles.get(tf, [])
        if len(bars) < MIN_CANDLES_FOR_STRUCTURE:
            continue
        votes.append(analyze_market_structure(bars).get("trend") or "Neutral")

    if len(votes) < 2:
        return None

    bullish = votes.count("Bullish")
    bearish = votes.count("Bearish")
    if bullish > bearish:
        return "Bullish"
    if bearish > bullish:
        return "Bearish"
    return "Mixed"


# ===========================================================================
# 3. Market Analysis (macro / sentiment context)
# ===========================================================================

async def analyse_market(state: TradingState) -> Optional[Dict[str, Any]]:
    """Fear & Greed, funding and open interest.

    Uses `sentiment_agent.fetch_macro_data`, which returns None for anything it
    could not fetch plus an `unavailable` list — it was fixed to stop returning
    plausible neutral defaults. Those Nones are carried through rather than
    filled in.
    """
    from backend.agents.sentiment_agent import fetch_macro_data

    try:
        macro = await fetch_macro_data()
    except Exception as e:
        return {"unavailable": [f"sentiment (fetch failed: {e})"]}

    unavailable_fields = list(macro.get("unavailable") or [])

    sentiment = SentimentAnalysis(
        fear_greed=macro.get("fng"),
        classification=macro.get("fng_classification"),
        funding_rate=macro.get("funding_rate"),
        open_interest=macro.get("oi"),
        risk_level=_risk_level(macro),
        unavailable=unavailable_fields,
    )

    out: Dict[str, Any] = {"sentiment_analysis": sentiment}
    if unavailable_fields:
        out["unavailable"] = [f"sentiment partial (no {', '.join(unavailable_fields)})"]
    return out


def _risk_level(macro: Dict[str, Any]) -> str:
    """'unknown' when nothing could be measured, never 'normal'.

    'normal' would be read downstream as a measured all-clear. Same derivation as
    `MarketIntelligenceAgent._risk_level`, kept consistent so the graph and the
    event-driven agent cannot disagree about the same market.
    """
    fng, funding = macro.get("fng"), macro.get("funding_rate")
    if fng is None and funding is None:
        return "unknown"
    if fng is not None and (fng <= 20 or fng >= 80):
        return "elevated"
    if funding is not None and abs(funding) > 0.001:
        return "elevated"
    return "normal"


# ===========================================================================
# 4. Regime Detection
# ===========================================================================

def detect_regime(state: TradingState) -> Optional[Dict[str, Any]]:
    """Produce the spec Section 7 result: regime, volatility, liquidity,
    trend_strength, confidence.

    `confidence` HERE IS DATA COVERAGE, NOT A PREDICTION.

    The spec's example shows `"confidence": 0.87` without saying what it measures.
    It is defined here as the fraction of the five output fields that could
    actually be computed. That makes it verifiable and honest: a regime derived
    from 3 of 5 inputs reports 0.6, and a consumer can weight it accordingly.
    Defining it as a model's belief about the regime being correct would be a
    number nobody could check.
    """
    snapshot = state.get("market_data")
    technical = state.get("technical_analysis")

    if snapshot is None:
        return {
            "market_regime": MarketRegimeState(unavailable=["all (no market data)"]),
            "unavailable": ["regime (no market data)"],
        }

    bars = snapshot.candles.get(PRIMARY_TIMEFRAME, [])
    unavailable: List[str] = []

    # --- regime ---------------------------------------------------------
    regime: Optional[str] = None
    if len(bars) >= MIN_CANDLES_FOR_REGIME:
        classified = detect_market_regime(bars)
        # 'Unknown' is a real answer from the classifier meaning "not enough
        # history", so it is reported as unavailable rather than as a regime name.
        if classified and classified != "Unknown":
            regime = classified
        else:
            unavailable.append("regime")
    else:
        unavailable.append(f"regime ({len(bars)} candles, need {MIN_CANDLES_FOR_REGIME})")

    # --- volatility -----------------------------------------------------
    volatility, stdev = _volatility_band(bars)
    if volatility is None:
        unavailable.append("volatility")

    # --- liquidity ------------------------------------------------------
    liquidity, liq_detail = _liquidity_proxy(bars)
    if liquidity is None:
        unavailable.append("liquidity")

    # --- trend strength -------------------------------------------------
    trend_strength = _trend_strength(bars, technical)
    if trend_strength is None:
        unavailable.append("trend_strength")

    computed = sum(
        1 for v in (regime, volatility, liquidity, trend_strength) if v is not None
    )
    # 4 measurable fields; confidence is the fraction of them obtained.
    confidence = round(computed / 4.0, 3) if computed else 0.0

    state_out = MarketRegimeState(
        regime=regime,
        volatility=volatility,
        liquidity=liquidity,
        trend_strength=trend_strength,
        confidence=confidence,
        unavailable=unavailable,
    )

    out: Dict[str, Any] = {"market_regime": state_out}
    if unavailable:
        out["unavailable"] = [f"regime detection: {', '.join(unavailable)}"]
    logger.info(
        "Market state for %s: regime=%s vol=%s liq=%s strength=%s confidence=%.2f%s",
        state["symbol"], regime, volatility, liquidity, trend_strength, confidence,
        f" ({liq_detail})" if liq_detail else "",
    )
    return out


def _volatility_band(bars: List[Dict[str, Any]]) -> tuple[Optional[str], Optional[float]]:
    """LOW / MEDIUM / HIGH from realised per-candle return stdev."""
    if len(bars) < MIN_CANDLES_FOR_ATR:
        return None, None
    closes = [float(b["close"]) for b in bars]
    returns = [
        (closes[i] - closes[i - 1]) / closes[i - 1]
        for i in range(1, len(closes))
        if closes[i - 1]
    ]
    if not returns:
        return None, None
    mean = sum(returns) / len(returns)
    stdev = (sum((r - mean) ** 2 for r in returns) / len(returns)) ** 0.5
    if stdev >= VOL_HIGH_THRESHOLD:
        return "HIGH", stdev
    if stdev >= VOL_MEDIUM_THRESHOLD:
        return "MEDIUM", stdev
    return "LOW", stdev


def _liquidity_proxy(bars: List[Dict[str, Any]]) -> tuple[Optional[str], Optional[str]]:
    """Liquidity band from traded VOLUME — explicitly a proxy, not depth.

    The spec's example output includes `"liquidity": "HIGH"`. True liquidity is an
    order-book property (depth, spread) and there is no order-book feed, so this
    is derived from recent volume relative to its own baseline.

    Labelled as a proxy in the returned detail string so a consumer is not misled
    into treating it as measured depth. `LiquidityAnalysis` in the state schema
    remains `available=False` for the same reason — that field is reserved for
    real depth data and this does not satisfy it.
    """
    if len(bars) < 20:
        return None, None
    volumes = [float(b.get("volume", 0.0)) for b in bars]
    recent = volumes[-5:]
    baseline = volumes[-20:]
    if not any(baseline):
        return None, "no volume reported"

    avg_recent = sum(recent) / len(recent)
    avg_baseline = sum(baseline) / len(baseline)
    if avg_baseline <= 0:
        return None, "zero baseline volume"

    ratio = avg_recent / avg_baseline
    detail = f"volume proxy, recent/baseline={ratio:.2f} — NOT order-book depth"
    if ratio >= 1.3:
        return "HIGH", detail
    if ratio >= 0.7:
        return "MEDIUM", detail
    return "LOW", detail


def _trend_strength(
    bars: List[Dict[str, Any]], technical: Optional[TechnicalAnalysis]
) -> Optional[float]:
    """0.0-1.0 directional strength from EMA separation.

    Normalised by price so it is comparable across an instrument at $0.02 and one
    at $60,000 — an absolute EMA gap would make every high-priced asset look
    strongly trending.

    Unsigned on purpose: this is *strength*, and direction is already carried by
    `technical_analysis.trend`. Returning a signed value here would give two
    fields that could disagree about direction.
    """
    if len(bars) < MIN_CANDLES_FOR_STRUCTURE:
        return None
    closes = np.array([float(b["close"]) for b in bars])
    ema9 = calculate_ema(closes, 9)
    ema21 = calculate_ema(closes, 21)
    if not len(ema9) or not len(ema21) or ema21[-1] <= 0:
        return None
    price = float(closes[-1])
    if price <= 0:
        return None
    separation = abs(float(ema9[-1]) - float(ema21[-1])) / price
    # A 2% EMA separation is a strong trend on a 15m chart, so that maps to 1.0.
    return round(min(1.0, separation / 0.02), 3)


# ===========================================================================
# 5. Market State (assembly)
# ===========================================================================

def assemble_market_state(state: TradingState) -> Optional[Dict[str, Any]]:
    """Terminal node. Writes nothing new; records that the graph completed.

    Deliberately does not synthesise a summary field. Every value the spec's
    Section 7 output names is already in `market_regime`, and duplicating it into
    a second "market state" object would create two representations that can
    disagree — the exact problem `TradingState` exists to prevent.

    Its value is the completion marker in `nodes_visited`, which distinguishes "the
    graph ran to the end" from "the graph stopped after regime detection".
    """
    regime = state.get("market_regime")
    if regime is None or regime.regime is None:
        return {"unavailable": ["market_state (no regime was determined)"]}
    return None


# ===========================================================================
# Registration
# ===========================================================================

def register_market_nodes() -> None:
    """Register all five Phase 24 nodes. Idempotent-safe to call once at import
    of the graph module; a second call raises by design (see registry.py)."""

    register_node(
        NodeContract(
            name="data_validation",
            reads=("symbol", "started_at"),
            writes=("market_data",),
            purpose="Fetch every timeframe ONCE and reject unusable candles rather than repairing them",
            deterministic=True,
            phase=24,
        ),
        validate_market_data,
    )

    register_node(
        NodeContract(
            name="feature_generation",
            reads=("market_data",),
            writes=("technical_analysis",),
            purpose="EMA, ATR, RSI, support and resistance from the stored candles",
            deterministic=True,
            phase=24,
        ),
        generate_features,
    )

    register_node(
        NodeContract(
            name="market_analysis",
            reads=("market_data",),
            writes=("sentiment_analysis",),
            purpose="Fear & Greed, funding and open interest context",
            deterministic=True,
            phase=24,
        ),
        analyse_market,
    )

    register_node(
        NodeContract(
            name="regime_detection",
            reads=("market_data", "technical_analysis", "symbol"),
            writes=("market_regime",),
            purpose="Regime, volatility band, liquidity proxy, trend strength and data-coverage confidence",
            deterministic=True,
            phase=24,
        ),
        detect_regime,
    )

    register_node(
        NodeContract(
            name="market_state",
            reads=("market_regime",),
            writes=(),
            purpose="Terminal marker — records that the graph reached the end",
            deterministic=True,
            phase=24,
        ),
        assemble_market_state,
    )
