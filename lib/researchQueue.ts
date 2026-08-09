import type { TradeLogEntry } from './types';
import { reconstructClosedTrades } from './learningDashboard';
import type { CuriosityFinding } from './curiosityEngine';

// ---------------------------------------------------------------------
// Research Queue — the missing middle of the spec's Section 12 pipeline.
//
// The required pipeline is:
//   Trade -> Reflection -> RESEARCH QUEUE -> Hypothesis -> Backtest
//         -> Walk-Forward -> Paper -> Evaluation -> Human Approval
//
// Reflection and Hypothesis both existed; the queue between them did
// not, so a lesson jumped straight to a single hypothesis with nothing
// tracking what *should* be investigated or whether anything was. Section
// 12 also requires each closed trade to produce a Validation Plan,
// Research Tasks, and Future Recommendations — this module is where those
// three come from.
//
// DERIVED, not persisted. Every input (trade log, reflections,
// hypotheses, curiosity findings) is already stored in its own place;
// a persisted queue would be a second source of truth needing
// invalidation on every write. Same reasoning as lib/knowledgeGraph.ts.
//
// CANNOT DEPLOY ANYTHING. This produces a prioritized list of things a
// human might investigate. It has no write path to risk config or
// strategy selection, which is the Section 12 rule that must not bend.
// ---------------------------------------------------------------------

export type ResearchPriority = 'high' | 'medium' | 'low';

export type ResearchTask = {
  id: string;
  /** What to investigate, phrased as an answerable question. */
  question: string;
  /** Why this surfaced — always traceable to real recorded data. */
  evidence: string[];
  /** How a human would actually settle it, using tools this app has. */
  validationPlan: string;
  priority: ResearchPriority;
  /** Where it came from, so the queue is auditable. */
  origin: 'repeated-loss' | 'losing-origin' | 'signal-conflict' | 'contradicted-position' | 'unreflected-trade' | 'untested-hypothesis';
};

const MIN_SAMPLE = 3; // same floor the Learning Dashboard and Curiosity Engine use

export type ResearchQueueInputs = {
  tradeLog: TradeLogEntry[];
  /** Trade ids that already have a reflection. */
  reflectedTradeIds?: Set<string>;
  /** Hypotheses still sitting at 'proposed' — generated but never tested. */
  untestedHypotheses?: { id: string; claim: string; symbol: string }[];
  /** Findings from lib/curiosityEngine.ts that implied follow-up. */
  curiosityFindings?: CuriosityFinding[];
};

export function buildResearchQueue(inputs: ResearchQueueInputs): ResearchTask[] {
  const tasks: ResearchTask[] = [];
  const reflected = inputs.reflectedTradeIds ?? new Set<string>();
  const closed = reconstructClosedTrades(inputs.tradeLog, reflected);

  // --- 1. Symbols losing on a majority of a meaningful sample.
  const bySymbol = new Map<string, { losses: number; total: number; pnl: number }>();
  for (const t of closed) {
    const b = bySymbol.get(t.symbol) ?? { losses: 0, total: 0, pnl: 0 };
    b.total++;
    if (t.pnl < 0) b.losses++;
    b.pnl += t.pnl;
    bySymbol.set(t.symbol, b);
  }
  for (const [symbol, b] of bySymbol) {
    if (b.total < MIN_SAMPLE || b.losses / b.total <= 0.5) continue;
    tasks.push({
      id: `repeated-loss:${symbol}`,
      question: `Why does ${symbol} lose on a majority of trades, and should it be removed from the watchlist or traded differently?`,
      evidence: [`${b.losses} losses out of ${b.total} closed trades on ${symbol}, ${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2)} net`],
      validationPlan: `Backtest the current ensemble on ${symbol} over a longer history in the Backtest Lab, and compare its per-regime breakdown against a symbol that performs well. If the edge is absent across regimes, the honest conclusion is to stop trading it.`,
      priority: 'high',
      origin: 'repeated-loss',
    });
  }

  // --- 2. Decision paths that lose money.
  const byOrigin = new Map<string, { losses: number; total: number; pnl: number }>();
  for (const t of closed) {
    const key = t.originTag ?? 'unknown';
    const b = byOrigin.get(key) ?? { losses: 0, total: 0, pnl: 0 };
    b.total++;
    if (t.pnl < 0) b.losses++;
    b.pnl += t.pnl;
    byOrigin.set(key, b);
  }
  for (const [origin, b] of byOrigin) {
    if (b.total < MIN_SAMPLE || b.pnl >= 0) continue;
    tasks.push({
      id: `losing-origin:${origin}`,
      question: `Why is the "${origin}" decision path net negative, and what distinguishes its losing trades from its winning ones?`,
      evidence: [`${origin}: ${b.losses}/${b.total} losses, $${b.pnl.toFixed(2)} net across closed trades`],
      validationPlan: `Query the Knowledge Graph for this origin split by market condition and volatility regime. If losses concentrate in one regime, the fix is a regime gate (lib/strategyProfiles.ts), not a strategy change.`,
      priority: 'high',
      origin: 'losing-origin',
    });
  }

  // --- 3. Closed trades with no reflection — the pipeline's own gaps.
  const unreflected = closed.filter((t) => !reflected.has(t.exitTradeId));
  if (unreflected.length > 0) {
    tasks.push({
      id: 'unreflected-trades',
      question: `${unreflected.length} closed trade(s) have no reflection — why is the reflection step failing?`,
      evidence: [`Unreflected: ${unreflected.slice(0, 5).map((t) => `${t.symbol} ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}`).join(', ')}${unreflected.length > 5 ? ` +${unreflected.length - 5} more` : ''}`],
      validationPlan: 'Check that an LLM provider and API key are configured in Settings — reflection generation skips silently without one. Then use Regenerate on a trade detail page to confirm the path works.',
      // Not "high": this is a plumbing gap, not a loss of money. But it
      // does mean the learning pipeline is running blind.
      priority: 'medium',
      origin: 'unreflected-trade',
    });
  }

  // --- 4. Hypotheses generated but never tested. A queue of untested
  // claims is the learning pipeline stalling, which is worth surfacing.
  for (const h of inputs.untestedHypotheses ?? []) {
    tasks.push({
      id: `untested-hypothesis:${h.id}`,
      question: `Is this hypothesis true? "${h.claim}"`,
      evidence: [`Generated from a ${h.symbol} trade reflection and still at status 'proposed' — never validated or rejected.`],
      validationPlan: 'Test it in the Backtest Lab against the parameter it names, then mark it Validated or Rejected on the trade detail page. Applying it is a separate, explicit step.',
      priority: 'medium',
      origin: 'untested-hypothesis',
    });
  }

  // --- 5. Curiosity findings that implied follow-up.
  for (const f of inputs.curiosityFindings ?? []) {
    if (f.suggestedAction === 'none' || !f.answer) continue;
    const priority: ResearchPriority = f.suggestedAction === 'reduce-exposure' ? 'high' : 'medium';
    tasks.push({
      id: `curiosity:${f.question.slice(0, 40)}`,
      question: f.question,
      evidence: f.evidence,
      validationPlan:
        f.suggestedAction === 'ask-second-opinion'
          ? 'Configure a second-opinion model in Settings; the Supervisor will then request an independent read automatically when internal signals conflict.'
          : f.suggestedAction === 'run-backtest'
            ? 'Run the Backtest Lab over the affected symbol/strategy and compare per-regime results.'
            : f.suggestedAction === 'reduce-exposure'
              ? 'Review the open position against the opposing signal and decide deliberately whether to hold or reduce. Holding through an opposing read should be a choice, not an oversight.'
              : 'Turn this into a hypothesis on the relevant trade, then test it before acting.',
      priority,
      origin: f.suggestedAction === 'reduce-exposure' ? 'contradicted-position' : 'signal-conflict',
    });
  }

  // High first, then medium, then low — stable within each band so the
  // order doesn't churn between rebuilds of identical data.
  const rank: Record<ResearchPriority, number> = { high: 0, medium: 1, low: 2 };
  return tasks.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/**
 * Section 12's "Future Recommendations (visible to the human operator)".
 * Deliberately phrased as recommendations to a person — this module has
 * no authority to enact any of them.
 */
export function buildFutureRecommendations(tasks: ResearchTask[]): string[] {
  if (tasks.length === 0) {
    return ['No research tasks outstanding — nothing in the recorded data currently suggests a specific investigation.'];
  }
  const high = tasks.filter((t) => t.priority === 'high');
  const out: string[] = [];
  if (high.length > 0) {
    out.push(`${high.length} high-priority item(s) involve real losses and are worth looking at before increasing size or enabling more autonomy.`);
    for (const t of high.slice(0, 3)) out.push(`• ${t.question}`);
  }
  const medium = tasks.filter((t) => t.priority === 'medium');
  if (medium.length > 0) {
    out.push(`${medium.length} medium-priority item(s) are pipeline or understanding gaps rather than losses.`);
  }
  out.push('None of these are applied automatically. Each requires you to test it and decide — that boundary is deliberate.');
  return out;
}

// ---------------------------------------------------------------------
// Chat context injection — same pattern as every other build*Context.
// ---------------------------------------------------------------------
export function buildResearchQueueContext(tasks: ResearchTask[]): string {
  if (tasks.length === 0) {
    return 'RESEARCH QUEUE: empty — no closed-trade pattern, unreflected trade, or untested hypothesis currently warrants a specific investigation.';
  }
  const lines = tasks.slice(0, 8).map((t) => `  [${t.priority.toUpperCase()}] ${t.question}\n     Evidence: ${t.evidence.join(' | ')}\n     How to settle it: ${t.validationPlan}`);
  return `RESEARCH QUEUE (derived from real recorded outcomes — the middle stage of the self-learning pipeline, between a trade's reflection and a testable hypothesis):\n${lines.join(
    '\n',
  )}${tasks.length > 8 ? `\n  ...and ${tasks.length - 8} more.` : ''}\n\nThese are investigations for the operator, not actions. Nothing here can change risk config or strategy selection — learning improves understanding, it does not deploy.`;
}
