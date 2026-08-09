import type { TradeLogEntry, WatchItem } from './types';
import { reconstructClosedTrades } from './learningDashboard';

// ---------------------------------------------------------------------
// Curiosity Engine (spec Section 15) — "the AI shouldn't only trade, it
// should want to understand markets."
//
// The spec lists ten self-questions the system should ask itself
// hourly. The trap with a feature like this is producing plausible-
// sounding filler — a wall of rhetorical questions with invented
// answers reads as insight while conveying nothing, and this codebase's
// whole discipline is the opposite of that.
//
// So: every finding below is answered ONLY from data this app actually
// has (the real trade log, real computed ensemble/structure reads), and
// a question with nothing real to say is returned with a null answer and
// stated as unanswerable rather than padded. A finding also carries a
// concrete suggestedAction, so curiosity terminates in something doable
// (a hypothesis to test, a second opinion to request) instead of just
// commentary.
//
// Pure and deterministic — no LLM call, no I/O. Same reasoning as
// lib/debate/moderator.ts and lib/opportunityScanner.ts.
// ---------------------------------------------------------------------

export type CuriosityAction = 'none' | 'create-hypothesis' | 'run-backtest' | 'ask-second-opinion' | 'reduce-exposure';

export type CuriosityFinding = {
  question: string;
  answer: string | null; // null = genuinely not answerable from available data yet
  evidence: string[]; // real data points behind the answer — never paraphrase
  suggestedAction: CuriosityAction;
};

// A symbol where two independent reads disagree. Genuine ambiguity is
// the most honest possible answer to "what don't I understand?" — much
// more so than an invented knowledge gap.
export type SignalConflict = {
  symbol: string;
  ensembleSays: 'BUY' | 'SELL' | 'HOLD';
  ensembleConfidencePct: number;
  structureSays: 'bullish' | 'bearish' | 'undefined';
};

// An open position whose justifying signal has since flipped against it.
export type ContradictedHolding = {
  symbol: string;
  side: 'long';
  ensembleNowSays: 'BUY' | 'SELL' | 'HOLD';
  ensembleConfidencePct: number;
};

const MIN_TRADES_FOR_PATTERN = 3; // below this, a "pattern" is just noise

// --- "What strategy failed today? Why?" -------------------------------
// Grouped by originTag (which decision path produced the trade), since
// that's the real, recorded attribution this app has — not a guess at
// which strategy was "responsible."
export function findTodaysFailures(tradeLog: TradeLogEntry[], nowMs: number = Date.now()): CuriosityFinding {
  const startOfDay = new Date(nowMs).setHours(0, 0, 0, 0);
  const closedToday = reconstructClosedTrades(tradeLog).filter((t) => t.exitTs >= startOfDay);
  const losses = closedToday.filter((t) => t.pnl < 0);

  if (closedToday.length === 0) {
    return {
      question: 'What strategy failed today, and why?',
      answer: null,
      evidence: ['No trades closed today — nothing to attribute a failure to.'],
      suggestedAction: 'none',
    };
  }
  if (losses.length === 0) {
    return {
      question: 'What strategy failed today, and why?',
      answer: `Nothing failed today: all ${closedToday.length} closed trade(s) were profitable.`,
      evidence: closedToday.map((t) => `${t.symbol} +$${t.pnl.toFixed(2)} (${t.originTag ?? 'untagged'})`),
      suggestedAction: 'none',
    };
  }

  const byOrigin = new Map<string, { count: number; totalPnl: number }>();
  for (const loss of losses) {
    const key = loss.originTag ?? 'untagged';
    const entry = byOrigin.get(key) ?? { count: 0, totalPnl: 0 };
    entry.count++;
    entry.totalPnl += loss.pnl;
    byOrigin.set(key, entry);
  }
  const worst = Array.from(byOrigin.entries()).sort((a, b) => a[1].totalPnl - b[1].totalPnl)[0];

  return {
    question: 'What strategy failed today, and why?',
    answer: `${losses.length} of ${closedToday.length} closed trade(s) lost money. The worst-performing decision path was "${worst[0]}" (${worst[1].count} loss(es), $${worst[1].totalPnl.toFixed(2)} total). The "why" is not inferable from the trade log alone — that requires the per-trade Reflection.`,
    evidence: Array.from(byOrigin.entries()).map(([origin, s]) => `${origin}: ${s.count} loss(es), $${s.totalPnl.toFixed(2)}`),
    // A repeated failure in one path is exactly what the Reflection ->
    // Hypothesis pipeline exists to turn into something testable.
    suggestedAction: worst[1].count >= 2 ? 'create-hypothesis' : 'none',
  };
}

// --- "What don't I understand?" ---------------------------------------
export function findSignalConflicts(conflicts: SignalConflict[]): CuriosityFinding {
  const real = conflicts.filter(
    (c) =>
      (c.ensembleSays === 'BUY' && c.structureSays === 'bearish') ||
      (c.ensembleSays === 'SELL' && c.structureSays === 'bullish'),
  );

  if (conflicts.length === 0) {
    return {
      question: "What don't I understand right now?",
      answer: null,
      evidence: ['No symbols have enough loaded data to compare signals against each other yet.'],
      suggestedAction: 'none',
    };
  }
  if (real.length === 0) {
    return {
      question: "What don't I understand right now?",
      answer: `Nothing is contradicting itself: across ${conflicts.length} evaluated symbol(s), the strategy ensemble and market structure do not disagree on direction anywhere.`,
      evidence: conflicts.map((c) => `${c.symbol}: ensemble ${c.ensembleSays}, structure ${c.structureSays}`),
      suggestedAction: 'none',
    };
  }

  return {
    question: "What don't I understand right now?",
    answer: `${real.length} symbol(s) where my own signals contradict each other — the indicator ensemble and market structure point opposite ways. That is a real gap in understanding, not noise to average away.`,
    evidence: real.map((c) => `${c.symbol}: ensemble says ${c.ensembleSays} (${c.ensembleConfidencePct.toFixed(0)}%) but market structure is ${c.structureSays}`),
    // Genuine internal disagreement is the exact trigger the
    // Collaboration Protocol (Section 16) was built for.
    suggestedAction: 'ask-second-opinion',
  };
}

// --- "What evidence contradicts my current view?" ---------------------
export function findContradictedHoldings(holdings: ContradictedHolding[]): CuriosityFinding {
  const contradicted = holdings.filter((h) => h.ensembleNowSays === 'SELL');

  if (holdings.length === 0) {
    return {
      question: 'What evidence contradicts my current positions?',
      answer: null,
      evidence: ['No open positions to check.'],
      suggestedAction: 'none',
    };
  }
  if (contradicted.length === 0) {
    return {
      question: 'What evidence contradicts my current positions?',
      answer: `None: all ${holdings.length} open position(s) still have a non-opposing ensemble read.`,
      evidence: holdings.map((h) => `${h.symbol}: ensemble now ${h.ensembleNowSays} (${h.ensembleConfidencePct.toFixed(0)}%)`),
      suggestedAction: 'none',
    };
  }

  return {
    question: 'What evidence contradicts my current positions?',
    answer: `${contradicted.length} open long position(s) now have an ensemble reading that actively opposes them. Holding through an opposing signal is a decision, and it should be a deliberate one.`,
    evidence: contradicted.map((h) => `${h.symbol}: holding long, but ensemble now says SELL at ${h.ensembleConfidencePct.toFixed(0)}% confidence`),
    suggestedAction: 'reduce-exposure',
  };
}

// --- "Has this happened before?" --------------------------------------
export function findRepeatedMistakes(tradeLog: TradeLogEntry[]): CuriosityFinding {
  const closed = reconstructClosedTrades(tradeLog);
  const bySymbol = new Map<string, { losses: number; totalLossPnl: number; total: number }>();
  for (const t of closed) {
    const entry = bySymbol.get(t.symbol) ?? { losses: 0, totalLossPnl: 0, total: 0 };
    entry.total++;
    if (t.pnl < 0) {
      entry.losses++;
      entry.totalLossPnl += t.pnl;
    }
    bySymbol.set(t.symbol, entry);
  }

  const repeated = Array.from(bySymbol.entries())
    .filter(([, s]) => s.losses >= MIN_TRADES_FOR_PATTERN && s.losses / s.total > 0.5)
    .sort((a, b) => a[1].totalLossPnl - b[1].totalLossPnl);

  if (closed.length < MIN_TRADES_FOR_PATTERN) {
    return {
      question: 'Has this happened before?',
      answer: null,
      evidence: [`Only ${closed.length} closed trade(s) on record — too few to call anything a repeated pattern.`],
      suggestedAction: 'none',
    };
  }
  if (repeated.length === 0) {
    return {
      question: 'Has this happened before?',
      answer: `No repeated-loss pattern: no symbol has lost on a majority of at least ${MIN_TRADES_FOR_PATTERN} closed trades.`,
      evidence: [`Checked ${bySymbol.size} symbol(s) across ${closed.length} closed trades.`],
      suggestedAction: 'none',
    };
  }

  return {
    question: 'Has this happened before?',
    answer: `Yes — ${repeated.length} symbol(s) show a repeated pattern of losing more often than winning across a meaningful sample. This is the strongest kind of evidence this app can produce for "stop doing that."`,
    evidence: repeated.map(([symbol, s]) => `${symbol}: ${s.losses} loss(es) out of ${s.total} closed trades, $${s.totalLossPnl.toFixed(2)} in losses`),
    suggestedAction: 'run-backtest',
  };
}

// --- The full hourly digest -------------------------------------------
export type CuriosityDigest = {
  ts: number;
  findings: CuriosityFinding[];
};

export function buildCuriosityDigest(params: {
  tradeLog: TradeLogEntry[];
  signalConflicts: SignalConflict[];
  contradictedHoldings: ContradictedHolding[];
  ts: number;
}): CuriosityDigest {
  return {
    ts: params.ts,
    findings: [
      findTodaysFailures(params.tradeLog, params.ts),
      findSignalConflicts(params.signalConflicts),
      findContradictedHoldings(params.contradictedHoldings),
      findRepeatedMistakes(params.tradeLog),
    ],
  };
}

// Actions worth surfacing prominently — a finding whose suggestedAction
// is 'none' is fine, but the ones that imply real follow-up shouldn't be
// buried in a list.
export function actionableFindings(digest: CuriosityDigest): CuriosityFinding[] {
  return digest.findings.filter((f) => f.suggestedAction !== 'none');
}

// ---------------------------------------------------------------------
// Chat context injection — same pattern as every other build*Context.
// ---------------------------------------------------------------------
export function buildCuriosityContext(digest: CuriosityDigest | null, watchlist: WatchItem[]): string {
  if (!digest) {
    return 'CURIOSITY ENGINE: no self-review generated yet — runs automatically on an interval while the app is open.';
  }
  if (watchlist.length === 0) {
    return 'CURIOSITY ENGINE: no watchlist symbols to reason about.';
  }
  const ageMinutes = Math.round((Date.now() - digest.ts) / 60_000);
  const lines: string[] = [
    `CURIOSITY ENGINE (self-review generated ${ageMinutes}m ago, unprompted — every answer below is derived only from this app's real trade log and computed signals; questions with no real data behind them are stated as unanswerable rather than filled in):`,
  ];
  for (const f of digest.findings) {
    lines.push(`Q: ${f.question}`);
    lines.push(`A: ${f.answer ?? 'Not answerable from available data yet.'}`);
    if (f.evidence.length > 0) lines.push(`   Evidence: ${f.evidence.join(' | ')}`);
    if (f.suggestedAction !== 'none') lines.push(`   Suggested follow-up: ${f.suggestedAction}`);
  }
  lines.push(
    'These are self-generated observations, not instructions. Any action they imply still goes through the same confidence gating, Risk Manager, and Supervisor review as everything else.',
  );
  return lines.join('\n');
}
