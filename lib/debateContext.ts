import type { FullDebateResult } from './debate/runDebate';

// Same injection pattern as every other buildXContext in this app — a
// pure formatter, injected as a system message. Matches the "Final
// explanation" shape from the roadmap: recommendation, calibrated
// confidence, supporting evidence, opposing views, risk, suggested
// position — every line traceable to a real field on FullDebateResult,
// nothing paraphrased or invented for readability.

export function buildDebateContext(symbol: string, debate: FullDebateResult | undefined): string {
  if (!debate) {
    return `Debate System: no live multi-agent debate has been run for ${symbol} yet this session.`;
  }

  const lines: string[] = [`Debate System — ${symbol}:`];
  lines.push(`Recommendation: ${debate.moderator.recommendation}`);
  lines.push(`Confidence: ${(debate.composite.compositeConfidence * 100).toFixed(0)}% (calibrated from raw ${(debate.moderator.rawConfidence * 100).toFixed(0)}%; ${debate.calibration.note})`);
  lines.push(`Risk: ${debate.composite.riskLevel}`);
  lines.push(`Suggested position: ${debate.suggestedPositionPct}% (indicative — actual sizing still goes through the Risk Manager)`);

  if (debate.regime) lines.push(`Current regime: ${debate.regime.trend}/${debate.regime.vol}`);
  lines.push(debate.moderator.agreementSummary);

  if (debate.moderator.supportingEvidence.length > 0) {
    lines.push('Supporting evidence:');
    for (const e of debate.moderator.supportingEvidence) lines.push(`  ✔ ${e}`);
  }
  if (debate.moderator.opposingViews.length > 0) {
    lines.push('Opposing views:');
    for (const e of debate.moderator.opposingViews) lines.push(`  • ${e}`);
  }

  return lines.join('\n');
}
