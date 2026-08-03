// ---------------------------------------------------------------------
// Explainable Output Schema (Level 15).
//
// A strict shape every trade recommendation this app surfaces gets
// pushed through: reason bullets -> probability -> expected R -> SL ->
// TP. The rule that makes this more than a formatting exercise: EVERY
// field carries a `source` string naming which real upstream module
// computed it. There is no field a caller can fill in without also
// saying where it came from — that's enforced at the type level below,
// not just by convention.
//
// This does NOT mean every field is always "independently calibrated."
// A quick chat trade-action's stated confidence is the MODEL's own
// self-reported number — that's disclosed plainly as its source
// ("model self-reported, not empirically calibrated") rather than
// dressed up as something it isn't. What's genuinely never allowed is a
// numeric field with NO source at all, or a stop-loss/take-profit that
// didn't come from lib/riskManager.ts's real ATR+structure computation
// — those two are the ones with real money/risk consequences, and this
// schema exists specifically so they can never be silently model-
// invented.
// ---------------------------------------------------------------------

export type SourcedField<T> = { value: T; source: string };
export type UnavailableField = { value: null; source: 'unavailable'; reason: string };
export type Sourced<T> = SourcedField<T> | UnavailableField;

export function sourced<T>(value: T, source: string): SourcedField<T> {
  return { value, source };
}
export function unavailable(reason: string): UnavailableField {
  return { value: null, source: 'unavailable', reason };
}
export function isAvailable<T>(f: Sourced<T>): f is SourcedField<T> {
  return f.source !== 'unavailable';
}

export type ReasonBullet = { text: string; source: string };

export type ExplainableRecommendation = {
  symbol: string;
  side: 'buy' | 'sell';
  reasonBullets: ReasonBullet[];
  probability: Sourced<number>; // 0-100
  expectedR: Sourced<number>; // expected value in units of R (risk)
  stopLoss: Sourced<number>;
  takeProfit: Sourced<number>;
  generatedAt: number;
};

export function buildExplainableRecommendation(params: {
  symbol: string;
  side: 'buy' | 'sell';
  reasonBullets: ReasonBullet[];
  probability: Sourced<number>;
  expectedR: Sourced<number>;
  stopLoss: Sourced<number>;
  takeProfit: Sourced<number>;
}): ExplainableRecommendation {
  return { ...params, generatedAt: Date.now() };
}

// ---------------------------------------------------------------------
// Validation — a lightweight self-check a caller can run before
// displaying/executing on a recommendation, catching the exact failure
// mode this schema exists to prevent: a numeric field present with no
// real source attached (an empty/missing `source` string slipping
// through despite the type), or SL/TP that's suspiciously equal to
// price with no stated computation source.
// ---------------------------------------------------------------------
export function validateExplainableRecommendation(rec: ExplainableRecommendation): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (rec.reasonBullets.length === 0) issues.push('No reason bullets — a recommendation with zero stated reasoning should not be shown.');
  for (const b of rec.reasonBullets) {
    if (!b.source || b.source.trim().length === 0) issues.push(`Reason bullet "${b.text.slice(0, 40)}..." has no source attribution.`);
  }
  const numericFields: [string, Sourced<number>][] = [
    ['probability', rec.probability],
    ['expectedR', rec.expectedR],
    ['stopLoss', rec.stopLoss],
    ['takeProfit', rec.takeProfit],
  ];
  for (const [name, f] of numericFields) {
    if (f.source !== 'unavailable' && (!f.source || f.source.trim().length === 0)) {
      issues.push(`${name} has a value but no source — this should never happen and indicates a caller bypassed buildExplainableRecommendation().`);
    }
  }
  return { ok: issues.length === 0, issues };
}

// ---------------------------------------------------------------------
// Plain-text formatter — used in chat confirmations and anywhere else
// this needs to render outside a React component.
// ---------------------------------------------------------------------
function fmtSourced(f: Sourced<number>, unit: string = ''): string {
  if (!isAvailable(f)) return `unavailable (${f.reason})`;
  return `${f.value.toFixed(unit === 'R' ? 2 : unit === '%' ? 0 : 4)}${unit} [source: ${f.source}]`;
}

export function formatExplainableRecommendationText(rec: ExplainableRecommendation): string {
  const lines: string[] = [];
  lines.push(`**${rec.side.toUpperCase()} ${rec.symbol}** — Explainable Recommendation:`);
  lines.push('Reasoning:');
  for (const b of rec.reasonBullets) lines.push(`  • ${b.text} [source: ${b.source}]`);
  lines.push(`Probability: ${fmtSourced(rec.probability, '%')}`);
  lines.push(`Expected value: ${fmtSourced(rec.expectedR, 'R')}`);
  lines.push(`Stop-loss: ${fmtSourced(rec.stopLoss)}`);
  lines.push(`Take-profit: ${fmtSourced(rec.takeProfit)}`);
  return lines.join('\n');
}
