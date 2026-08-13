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

## 0. Context & One Objective Reframing (read this first)

Your original ask was: *"if I trade $2, I want it to return $2, compounding through multiple trades up to $20, with the agent analyzing every market movement and self-learning from every failure and success."*

That's kept fully intact below as the **behavioral goal** — continuous analysis, self-reflection, learning from every trade, never stopping. One piece is deliberately **not** encoded as a hard requirement:

> **"Turn $2 into $20" is a desired financial outcome, not a software requirement.** No AI agent can honestly promise or optimize for a guaranteed 10× return — markets are uncertain, especially with leveraged futures. If this is encoded as a hard target, it will push the system toward overfitting and excessive risk-taking to hit the number.

**The engineering objective used throughout this document instead:**
> *Maximize long-term, risk-adjusted capital growth while preserving capital and continuously improving through validated learning.*

You can still paper-test or small-stake-test toward a 10x target — that's a legitimate way to evaluate the system. The architecture itself just never assumes or optimizes for a guaranteed outcome. Every other point from your request — self-learning from every failure, asking for help via API when uncertain, full trading-style knowledge, "as advanced as possible" — is fully captured below.
