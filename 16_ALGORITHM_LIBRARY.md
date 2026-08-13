# 16. Algorithm Library

This library defines the specific mathematical and computational algorithms that must be implemented (or wrapped via a validated library like `scipy`, `numpy`, or `pandas-ta`) by the TradingOS backend.

---

## 1. Risk Sizing
**Type:** Fixed-Fractional & Volatility-Adjusted
- **Inputs:** Total Portfolio Equity, Current Asset Volatility (ATR), Win Rate, Average Risk/Reward ratio.
- **Outputs:** Recommended position size (in base currency or USD).
- **When it's used:** Used by the **Chief Risk Officer (CRO)** agent during the Risk Evaluation phase to determine the absolute size of a Trade Authorization Request (TAR).

## 2. Kelly Criterion
**Type:** Fractional / Half-Kelly
- **Inputs:** Estimated Probability of Success ($p$), Expected Payoff Ratio ($b$).
- **Outputs:** Optimal fraction of the portfolio to wager ($f^*$).
- **When it's used:** Used by the **Portfolio Agent** to size high-conviction trades.
- *Constraint:* The system MUST cap this at Half-Kelly (or lower). Full Kelly is strictly forbidden due to its aggressiveness when faced with uncertain probability estimates in crypto markets.

## 3. Average True Range (ATR)
**Type:** Volatility Measurement
- **Inputs:** OHLC data (Open, High, Low, Close) over $N$ periods (default $N=14$).
- **Outputs:** ATR value (absolute price range).
- **When it's used:** Used by the **Market Intelligence Agent** and **CRO** to set dynamic, volatility-adjusted Stop-Loss and Take-Profit levels (e.g., Stop Loss = Entry - 1.5 * ATR).

## 4. Monte Carlo Simulation
**Type:** Probabilistic Risk Modeling
- **Inputs:** Historical returns distribution, current portfolio allocations, number of simulations ($N=10,000$).
- **Outputs:** Probability of Ruin (PoR), Maximum Expected Drawdown.
- **When it's used:** Used by the **Simulation Agent** during the Stress Test phase. If the PoR exceeds a hardcoded threshold, the TAR is rejected.

## 5. Bayesian Probability Updating
**Type:** Statistical Inference
- **Inputs:** Prior probability of a market regime (e.g., Bull Market = 60%), New Evidence (e.g., Federal Reserve rate hike), Likelihood of evidence given the regime.
- **Outputs:** Posterior probability of the market regime.
- **When it's used:** Used by the **Market Intelligence Agent** to continuously adjust its confidence in the current market regime as new macroeconomic or tick data arrives.

## 6. Graph Intelligence
**Type:** Asset Relationship Modeling
- **Inputs:** Correlation matrices, fundamental links (e.g., "Solana ecosystem" or "AI coins"), historical lead-lag relationships.
- **Outputs:** Directed graph of asset dependencies.
- **When it's used:** Used by the **Knowledge Graph** and **Portfolio Agent** to detect hidden clustering risks (e.g., realizing that 3 different coins are all dependent on the same underlying protocol, thus violating diversification rules).

## 7. Market Structure Analysis (BOS / CHoCH)
**Type:** Price Action Logic
- **Inputs:** Time-series OHLC data, swing highs, swing lows.
- **Outputs:** Break of Structure (BOS), Change of Character (CHoCH), Order Block zones.
- **When it's used:** Used by the **Feature Engine** to feed the Debate Parliament. Bull and Bear agents heavily rely on these structural pivots to argue for trend continuations or reversals.

## 8. Correlation Analysis
**Type:** Cross-Asset / Cross-Exchange Statistical Modeling
- **Inputs:** Rolling return vectors of Asset A and Asset B over $N$ periods.
- **Outputs:** Pearson or Spearman correlation coefficients (-1.0 to 1.0).
- **When it's used:** Used continuously by the **Portfolio Agent**. The CRO will reject any TAR that pushes the portfolio's net correlation above the `0.75` threshold.

## 9. Confidence Scoring / Calibration
**Type:** Weighted Ensemble Scoring
- **Inputs:** Debate Judge verdict, historical accuracy of the winning persona, market volatility, liquidity depth.
- **Outputs:** A calibrated confidence score ($0.0 - 1.0$).
- **When it's used:** Used by the **Confidence Agent** to scale the Kelly Criterion inputs. A $0.9$ confidence results in a larger allocation than a $0.5$ confidence, even if the structural setup is identical.

## 10. Portfolio Optimization
**Type:** Mean-Variance / Black-Litterman
- **Inputs:** Asset expected returns, covariance matrix, risk tolerance parameter.
- **Outputs:** Optimal portfolio weights.
- **When it's used:** Used by the **Daily Planner Agent** to rebalance the overall portfolio across active strategies, shifting capital to the best-performing sectors.

## 11. Execution Optimization
**Type:** Slippage & Latency Minimization (TWAP/VWAP)
- **Inputs:** Target order size, current orderbook depth, volume profile.
- **Outputs:** Sliced order chunks, optimal routing path.
- **When it's used:** Used by the **Execution Agent** via the `execution.py` API chokepoint to ensure large trades do not incur massive slippage.
