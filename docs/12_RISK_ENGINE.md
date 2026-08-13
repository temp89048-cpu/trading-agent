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

## 18. Portfolio-Level Thinking

No agent reasons about a single trade in isolation. Every decision must be evaluated against: the entire portfolio, correlation, exposure, capital, drawdown, recovery, expected value.

### Mathematical Constraints (Enhancement)
The CRO AI enforces these hard portfolio-level constraints mathematically:
1. **Max Correlated Exposure:** If Pearson correlation between Asset A and Asset B > 0.75 over 30 days, their combined directional exposure cannot exceed 1.5x the max limit of a single asset.
2. **Global VaR (Value at Risk):** The 99% 24-hour VaR of the entire portfolio must never exceed 5% of total equity.
3. **Drawdown Killswitch:** If portfolio equity drops 10% from the monthly high-water mark, the CRO automatically transitions the system to `Observation Mode` (close all trades, halt new entries).
