'use client';

import { useState } from 'react';
import { useHypothesis } from './Hypothesis';
import type { HypothesisStatus } from '@/lib/hypothesisStore.server';

const STATUS_LABELS: Record<HypothesisStatus, string> = {
  proposed: 'Proposed — needs your review',
  dismissed: 'Dismissed',
  validated: 'Validated',
  rejected: 'Rejected',
  applied: 'Applied',
};

const STATUS_COLORS: Record<HypothesisStatus, string> = {
  proposed: 'var(--amber)',
  dismissed: 'var(--txt-2)',
  validated: 'var(--green)',
  rejected: 'var(--red)',
  applied: 'var(--cyan)',
};

// Per-trade display for stage 2 of the self-learning pipeline (Section
// 12): shows the Hypothesis Agent's claim + suggested test, and lets a
// human record what they found after actually testing it (via the
// existing Backtest Lab or paper trading) — nothing here runs a
// backtest automatically or writes to any config. "Apply" only records
// that a human already made the change themselves; see
// lib/hypothesisAgent.ts's header comment for why that boundary is
// deliberate, not a missing feature.
export function HypothesisPanel({ tradeId }: { tradeId: string }) {
  const { getHypothesis, isGenerating, regenerate, setStatus } = useHypothesis();
  const hypothesis = getHypothesis(tradeId);
  const generating = isGenerating(tradeId);
  const [note, setNote] = useState('');

  function act(status: HypothesisStatus) {
    setStatus(hypothesis!.id, status, note.trim() || null);
    setNote('');
  }

  return (
    <div className="rounded-lg border border-line bg-bg1 p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[11px] font-mono uppercase tracking-wider text-txt2">Hypothesis</p>
        <button
          onClick={() => regenerate(tradeId)}
          disabled={generating}
          className="px-2 py-1 rounded-md text-[10px] font-mono border border-line text-txt1 hover:bg-bg3 transition disabled:opacity-50"
        >
          {generating ? 'Generating…' : hypothesis ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {hypothesis ? (
        <div className="flex flex-col gap-2">
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-line self-start" style={{ color: STATUS_COLORS[hypothesis.status] }}>
            {STATUS_LABELS[hypothesis.status]}
          </span>
          <p className="text-sm text-txt0">
            <span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Claim:</span>
            {hypothesis.claim}
          </p>
          <p className="text-sm text-amber">
            <span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Test it via:</span>
            {hypothesis.suggestedTest}
          </p>
          {hypothesis.reviewNote && (
            <p className="text-sm text-txt0">
              <span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Your note:</span>
              {hypothesis.reviewNote}
            </p>
          )}

          {hypothesis.status === 'proposed' && (
            <div className="flex flex-col gap-1.5 mt-1">
              <input
                type="text"
                placeholder="Optional note (e.g. what you found when you tested it)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="w-full text-[11px] font-mono px-2 py-1.5 rounded border border-line bg-bg2 text-txt0 placeholder:text-txt2 focus:border-amber outline-none"
              />
              <div className="flex gap-2">
                <button onClick={() => act('validated')} className="flex-1 px-2 py-1 rounded text-[10px] font-mono border border-green text-green hover:bg-green/10 transition">
                  Tested — Validated
                </button>
                <button onClick={() => act('rejected')} className="flex-1 px-2 py-1 rounded text-[10px] font-mono border border-red text-red hover:bg-red/10 transition">
                  Tested — Rejected
                </button>
                <button onClick={() => act('dismissed')} className="px-2 py-1 rounded text-[10px] font-mono border border-line text-txt2 hover:bg-bg3 transition">
                  Dismiss
                </button>
              </div>
            </div>
          )}

          {hypothesis.status === 'validated' && (
            <button
              onClick={() => act('applied')}
              className="self-start px-2 py-1 rounded text-[10px] font-mono border border-cyan text-cyan hover:bg-cyan/10 transition mt-1"
            >
              I've applied this change myself — mark Applied
            </button>
          )}

          <p className="text-[9.5px] text-txt2">
            Advisory only — this never runs a backtest or changes config on its own. Testing and applying are yours to do.
          </p>
        </div>
      ) : generating ? (
        <p className="text-[11px] text-txt2">Turning the reflection's lesson into a testable hypothesis…</p>
      ) : (
        <p className="text-[11px] text-txt2">No hypothesis yet — needs a reflection with a lesson first; will run automatically shortly after one exists.</p>
      )}
    </div>
  );
}
