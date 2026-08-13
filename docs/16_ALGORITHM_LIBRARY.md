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

## 10. Algorithm Library

The system must implement (or wrap a validated library for) each of these — every algorithm gets its own entry in `16_ALGORITHM_LIBRARY.md` documenting inputs, outputs, and when it's used:

- Risk sizing (fixed-fractional, volatility-adjusted)
- Kelly Criterion (fractional/half-Kelly, not full Kelly — full Kelly is too aggressive for uncertain probability estimates)
- ATR (Average True Range) for volatility-based stops
- Monte Carlo simulation (drawdown/ruin probability)
- Bayesian probability updating
- Graph intelligence (asset relationship modeling)
- Market structure analysis (BOS/CHoCH/order blocks)
- Correlation analysis (cross-asset, cross-exchange)
- Confidence scoring/calibration
- Portfolio optimization
- Execution optimization (slippage/latency minimization)

### 10.1 Algorithm Contracts (Enhancement)

#### A. Half-Kelly Sizing
**Purpose:** Calculates optimal bet size while preventing over-leverage due to confidence miscalibration.
**Inputs:**
- `win_probability` (Float, 0.0 to 1.0)
- `win_loss_ratio` (Float, Avg Win / Avg Loss)
**Outputs:**
- `optimal_fraction` (Float, percentage of total bankroll)
**Formula Constraint:** `Kelly_Fraction = W - ((1 - W) / R)`. Return `Kelly_Fraction / 2` (Half-Kelly).

#### B. ATR Volatility-Adjusted Sizing
**Purpose:** Normalizes risk so highly volatile assets do not disproportionately impact portfolio variance.
**Inputs:**
- `account_balance` (Float)
- `risk_per_trade_pct` (Float, e.g., 0.01 for 1%)
- `asset_atr` (Float, 14-period Average True Range)
- `atr_multiplier` (Float, e.g., 1.5 for stop placement)
**Outputs:**
- `position_size_contracts` (Float)
- `stop_loss_distance` (Float)
