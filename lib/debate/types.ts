export type AgentName = 'trend' | 'momentum' | 'meanReversion' | 'breakout' | 'news' | 'volatility' | 'orderFlow';

export const AGENT_LABELS: Record<AgentName, string> = {
  trend: 'Trend Agent',
  momentum: 'Momentum Agent',
  meanReversion: 'Mean Reversion Agent',
  breakout: 'Breakout Agent',
  news: 'News Agent',
  volatility: 'Volatility Agent',
  orderFlow: 'Order Flow Agent',
};

export type Recommendation = 'BUY' | 'SELL' | 'HOLD';

// Every agent produces this exact shape: a recommendation, a confidence
// it's willing to put a number on, and a list of EVIDENCE bullets that
// must each trace back to a real computed value already flowing through
// this app (an indicator reading, a structure event, an order-book
// number) — never a fabricated justification. If an agent has nothing
// real to point to, its evidence says so plainly instead of inventing
// something.
export type AgentOpinion = {
  agent: AgentName;
  label: string;
  recommendation: Recommendation;
  confidence: number; // 0-1
  evidence: string[];
};

// Canonical DebateRecord definition lives here (pure, no fs dependency)
// so client-side calibration/reputation/regime modules never need even
// a type-only import from the fs-backed debateStore.server.ts.
export type DebateRegimeTag = { trend: 'bull' | 'bear' | 'sideways'; vol: 'high-vol' | 'low-vol' } | null;

export type ModeratorDecisionSummary = {
  recommendation: Recommendation;
  rawConfidence: number;
  agreementSummary: string;
  supportingEvidence: string[];
  opposingViews: string[];
  agentBreakdown: { agent: AgentName; label: string; recommendation: Recommendation; confidence: number; weight: number }[];
};

export type DebateRecord = {
  id: string;
  ts: number;
  symbol: string;
  opinions: AgentOpinion[];
  moderator: ModeratorDecisionSummary;
  regime: DebateRegimeTag;
  calibratedConfidence: number | null;
  riskLevel: 'Low' | 'Medium' | 'High';
  suggestedPositionPct: number | null;
  tradeId: string | null;
  outcome: 'win' | 'loss' | null;
  outcomePnlUsd: number | null;
};
