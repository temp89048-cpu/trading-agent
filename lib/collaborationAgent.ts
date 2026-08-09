// ---------------------------------------------------------------------
// Collaboration Protocol (TradingOS-Engineering-Spec-and-Prompts.md
// Section 16) — "ask another AI for a second opinion when confidence is
// low or evidence conflicts."
//
// Deliberately NOT an execution path: this module only builds a minimal
// structured prompt and parses a fixed-shape response. The actual model
// call (components/Supervisor.tsx) uses a genuinely SEPARATE, human-
// configured provider/model (components/SettingsModal.tsx's "Second
// Opinion Model" section) — not the same model re-asked, and not
// anything this module reaches out to on its own. The response is
// recorded (lib/collaborationStore.server.ts) and surfaced only as a
// caution note; nothing here can approve, reject, or re-execute a trade.
// It is fire-and-forget from the caller's point of view specifically so
// a second model's latency never delays or blocks the trade decision it
// was asked about — see components/Supervisor.tsx's comment at the call
// site for why that's the deliberate tradeoff, matching the exact
// existing precedent of submitRealOrderAsync in the same file.
// ---------------------------------------------------------------------

export type CollaborationRequestInput = {
  symbol: string;
  side: 'buy' | 'sell';
  ownConfidencePct: number;
  ownReasoning: string[]; // the primary decision's own reason bullets
  conflicts: string[]; // what disagreed (e.g. Debate vs Ensemble, or low composite confidence)
};

const COLLABORATION_SYSTEM_PROMPT = `You are an independent second reviewer for a trading decision another
system already made internally. You are being asked because that system's own confidence was low or its
internal signals conflicted — your job is to give a genuinely independent read, not to defer to what's
already been decided.

Hard rules:
- You are giving an opinion for a human/audit record to review LATER — this trade may already be executing
  or may already be done by the time you answer. Never claim you are executing, monitoring, or affecting it.
- Base your answer only on the information given below — do not invent prices, news, or data not provided.
- Be willing to disagree. If the reasoning given looks weak or the conflict looks material, say so plainly.

Respond in EXACTLY this format — three lines, each starting with the exact label shown, no extra commentary
before/after/between them:
RECOMMENDATION: <BUY, SELL, or HOLD>
CONFIDENCE: <a single integer 0-100>
REASONING: <one or two concise sentences explaining your independent read>`;

export type CollaborationOpinion = {
  recommendation: 'BUY' | 'SELL' | 'HOLD';
  confidencePct: number;
  reasoning: string;
};

export function buildCollaborationMessages(input: CollaborationRequestInput): { role: string; content: string }[] {
  const user = [
    `A trading decision for ${input.symbol} (proposed side: ${input.side.toUpperCase()}) was made with the following reasoning and confidence:`,
    `Own confidence: ${input.ownConfidencePct.toFixed(0)}%`,
    `Own reasoning: ${input.ownReasoning.length > 0 ? input.ownReasoning.join('; ') : 'none stated'}`,
    `What triggered asking you: ${input.conflicts.length > 0 ? input.conflicts.join('; ') : 'low confidence, no specific conflict stated'}`,
  ].join('\n');

  return [
    { role: 'system', content: COLLABORATION_SYSTEM_PROMPT },
    { role: 'user', content: user },
  ];
}

// Tolerant parser, same approach as reflectionAgent/hypothesisAgent —
// returns null (not a guess) if the response didn't follow the format
// or gave an unrecognized recommendation/confidence value.
export function parseCollaborationResponse(content: string): CollaborationOpinion | null {
  const recMatch = /^RECOMMENDATION:\s*(BUY|SELL|HOLD)/im.exec(content);
  const confMatch = /^CONFIDENCE:\s*(\d{1,3})/im.exec(content);
  const reasonMatch = /^REASONING:\s*([\s\S]*?)(?=\n[A-Z_]+:|$)/im.exec(content);
  if (!recMatch || !confMatch) return null;
  const confidencePct = Math.min(100, Math.max(0, parseInt(confMatch[1], 10)));
  if (!isFinite(confidencePct)) return null;
  return {
    recommendation: recMatch[1].toUpperCase() as CollaborationOpinion['recommendation'],
    confidencePct,
    reasoning: reasonMatch?.[1]?.trim() || 'no reasoning provided',
  };
}
