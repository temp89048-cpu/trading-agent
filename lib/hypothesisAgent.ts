import type { ReflectionRecord } from './reflectionStore.server';

// ---------------------------------------------------------------------
// Hypothesis Agent — the second stage of the self-learning pipeline
// (TradingOS-Engineering-Spec-and-Prompts.md Section 12):
//
//   Trade -> Reflection -> Hypothesis -> (human tests it) -> human Apply
//
// Turns a Reflection's LESSON into ONE specific, testable claim, plus a
// concrete way to test it — using only knobs that already exist in this
// app (risk-config values already exposed in components/
// TradingControlsPanel.tsx, or a parameter already runnable through the
// existing Backtest Lab). It deliberately does NOT ask the model to name
// an exact config field to mutate, and nothing here ever writes to
// production config automatically — seeing a hypothesis, testing it, and
// applying it are three separate, human-gated steps (see
// components/Hypothesis.tsx and components/HypothesisPanel.tsx). This is
// the literal enforcement of Section 12's "Learning improves
// understanding — it does not, by itself, deploy anything," and of the
// explicit "Never allowed: Loss -> AI rewrites strategy -> Live Trading"
// path that section calls out.
// ---------------------------------------------------------------------

const HYPOTHESIS_SYSTEM_PROMPT = `You are a quantitative research assistant reviewing ONE trade's post-mortem
reflection. Your only job is to turn its lesson into a specific, falsifiable hypothesis a human can test —
you never decide anything, you never claim a change should be made, and you never claim this has already
been validated or applied.

Hard rules:
- Propose exactly ONE claim, about ONE existing, real trading concept (e.g. an RSI/EMA threshold, a
  confidence-floor number, a stop-loss/take-profit distance, a timeframe, a position-size limit) — never a
  new mechanism, indicator, or data source that doesn't already exist in this app.
- The claim must be falsifiable: it must be checkable by running the existing backtester or by paper-trading
  for a while, not just plausible-sounding.
- Do not output anything that looks like a trade command or a config change instruction.
- Do not claim this is validated, approved, or already in effect. It is a proposal for a human to test.

Respond in EXACTLY this format — two lines, each starting with the exact label shown, one or two concise
sentences per line, no extra commentary before/after/between them:
CLAIM: <the specific, falsifiable claim>
TEST: <one concrete way a human could test this — reference only real, existing knobs/tools in this app>`;

export type HypothesisSections = {
  claim: string | null;
  suggestedTest: string | null;
};

const SECTION_LABELS: { key: keyof HypothesisSections; label: string }[] = [
  { key: 'claim', label: 'CLAIM' },
  { key: 'suggestedTest', label: 'TEST' },
];

// Same tolerant parsing approach as lib/reflectionAgent.ts's
// parseReflectionSections — whichever labels are found are extracted;
// anything missing stays honestly null rather than guessed.
export function parseHypothesisSections(content: string): HypothesisSections {
  const result: HypothesisSections = { claim: null, suggestedTest: null };
  const labelPattern = SECTION_LABELS.map((s) => s.label).join('|');
  const re = new RegExp(`^(${labelPattern}):\\s*([\\s\\S]*?)(?=(?:\\n(?:${labelPattern}):)|$)`, 'gm');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const entry = SECTION_LABELS.find((s) => s.label === match![1]);
    if (entry) {
      const value = match[2].trim();
      if (value) result[entry.key] = value;
    }
  }
  return result;
}

export function buildHypothesisMessages(reflection: ReflectionRecord): { role: string; content: string }[] {
  const s = reflection.sections;
  const lessonText = s?.lesson ?? reflection.content;
  const user = [
    `Symbol: ${reflection.symbol}`,
    `Reflection lesson: ${lessonText}`,
    s?.whyOutcome ? `Why it won/lost: ${s.whyOutcome}` : null,
    s?.failedSignal ? `Signal that failed/misled: ${s.failedSignal}` : null,
    s?.confidenceAssessment ? `Confidence assessment: ${s.confidenceAssessment}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return [
    { role: 'system', content: HYPOTHESIS_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}
