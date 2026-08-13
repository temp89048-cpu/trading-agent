# TradingOS AI
Version 3.0

## Mission
Build the world's most advanced autonomous AI trading platform capable of
continuously analyzing cryptocurrency futures markets, making explainable
decisions, preserving capital through rigorous risk management, learning
from validated experience, and operating safely 24/7 under human-defined
governance.

## Core Principles
1. Capital Preservation
2. Explainability
3. Reliability
4. Continuous Learning
5. Safety
6. Modularity
7. Scalability
8. Research Driven
9. Risk First
10. Evidence Based

---

## 11. Trading Styles Library

### 11.1 Primary styles, by holding timeframe (your original four)

| Style | Holding Period | Description |
|---|---|---|
| **Scalping** | Seconds to minutes | The fastest style — profits from tiny price changes, often dozens to hundreds of trades daily. Requires intense focus, low latency, and high liquidity. |
| **Day Trading** | Minutes to hours, closed same day | No overnight risk — capitalizes on intraday volatility and momentum. |
| **Swing Trading** | Days to weeks | Medium-term — captures "swings" or trends within a larger move; balances monitoring needs with flexibility to hold overnight. |
| **Position Trading** | Weeks to months (or years) | The longest active style — focused on long-term trends and fundamentals, ignoring short-term noise. |

### 11.2 Full strategy library the system must know, compare, and select among

Trend Following · Momentum Trading · Breakout Trading · Mean Reversion · Grid Trading · ICT (Inner Circle Trader concepts) · Smart Money Concepts (SMC) · Wyckoff Method · Volume Profile · VWAP-based trading · Market Making · Statistical Arbitrage · Pairs Trading · Event-Driven Trading · Volatility Trading · Funding-Rate Arbitrage · Basis Trading · Gamma Squeeze Detection · Liquidation Trading · News Trading · Macro Trading

### 11.3 Required template — every style above must define all of these before it's eligible for selection

```markdown
### Strategy: <name>

**Best market conditions:**       when this strategy should be active
**Worst market conditions:**      when it must be deactivated
**Expected holding time:**        typical trade duration
**Risk profile:**                 typical R:R, max drawdown tolerance
**Indicators used:**              what it reads
**Entry logic:**                  precise entry conditions
**Exit logic:**                   precise exit conditions (stop/target/time)
**Position sizing rule:**         how size is computed for this style
**Market regime fit:**            which Phase-34 regime(s) it's valid in
**Historical success rate:**      from backtest/paper/live data
**Confidence rules:**             minimum confidence to activate
**Portfolio rules:**              max concurrent positions, correlation caps
**Failure modes:**                documented ways this strategy has failed
**Self-evaluation:**              how the strategy scores its own trades
```

### 11.4 Fully Implemented Example Strategy (Enhancement)

```markdown
### Strategy: Institutional Trend Following (Medium-Term)

**Best market conditions:** High liquidity, low funding rate anomalies, directional volume expansion.
**Worst market conditions:** Choppy, range-bound consolidation; immediately preceding macro news drops.
**Expected holding time:** 2 days to 3 weeks (Swing to Position).
**Risk profile:** Minimum 1:3 Risk-to-Reward. Max drawdown tolerance 5%.
**Indicators used:** 200 EMA (Daily), 50 EMA (4H), Volume Profile (POC).
**Entry logic:** Price closes above 50 EMA on 4H chart WITH daily trend alignment (above 200 EMA) AND volume > 1.5x 20-day average.
**Exit logic:** Trailing stop via 2x ATR. Hard exit if 4H price closes below 50 EMA.
**Position sizing rule:** Volatility-adjusted (ATR based), maximum 2% risk of total portfolio equity.
**Market regime fit:** Trending Bull / Trending Bear.
**Historical success rate:** Must be validated via Walk-Forward testing > 45% win rate (due to high R:R).
**Confidence rules:** Base signal confidence must be > 0.8; penalize if high correlation to existing open trades.
**Portfolio rules:** Max 3 concurrent trend positions across the portfolio.
**Failure modes:** Late entries near exhaustion points; getting whipsawed by false breakouts.
**Self-evaluation:** Expected EV calculated post-trade; compares actual slippage against modeled slippage.
```
