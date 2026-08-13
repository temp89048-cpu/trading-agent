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

## 12. Self-Learning Pipeline (the safe version)

This is the single most important correction to your original idea. What you asked for — *"my agent self-learns from every failure"* — is exactly right as a **behavior**. What it must never mean is an agent that edits its own live trading logic in response to a loss. Encode it this way:

**✅ Required pipeline:**
```
Trade → Reflection → Research Queue → Hypothesis → Backtest
      → Walk-Forward Test → Paper Trading → Evaluation
      → Human Approval → Production
```

**🚫 Never allowed:**
```
Loss → AI rewrites strategy → Live Trading
```
That second path is extremely dangerous — it lets a single unlucky trade (or a model's overconfident misread of *why* it lost) permanently change what happens to real capital, with no validation step at all.

**Every completed trade must generate:**
- Trade Journal entry
- Reflection (why it won/lost, was confidence correct, did execution hurt)
- Hypothesis (a specific, testable claim about what should change)
- Validation Plan (how the hypothesis will be tested before trusting it)
- Research Tasks (queued for the Research agents)
- Performance Review contribution (rolls into Weekly/Monthly Review)
- Confidence Calibration update
- Knowledge Graph update
- Future Recommendations (visible to the human operator)

Learning improves the system's **understanding** — it does not, by itself, deploy anything.

## 17. Research Scope

The system should continuously investigate: strategy improvements, risk improvements, execution improvements, market behavior, new indicators, academic research, exchange changes, new statistical techniques, machine-learning improvements. **Research never directly affects production** — it only ever feeds the pipeline in Section 12.

### Automated Validation Gates (Enhancement)
Before any hypothesis reaches "Human Approval," it must autonomously pass these strict mathematical gates:
1. **Backtest Gate:** Win Rate > 40%, Profit Factor > 1.5, Max Drawdown < 10% over 2 years of historical data.
2. **Walk-Forward Gate:** Out-of-sample data test. Sharpe Ratio > 1.2.
3. **Paper Trading Gate:** Must execute in real-time paper environment for a minimum of 30 days and 50 trades. Actual slippage must not exceed modeled slippage by >15%.
