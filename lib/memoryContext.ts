import type { TradeLogEntry } from './types';
import { computeOverallStats, computeFavoriteAssets, computeActiveHours, inferRiskPreference, type RiskPreference } from './memoryStats';

// Same pattern as buildIndicatorContext / buildStructureContext / etc.:
// a pure formatter injected as a system message into /api/chat. Trade
// stats are derived live from tradeLog (already loaded client-side via
// usePortfolio()) — nothing here is a persisted duplicate of the trade
// log. The one persisted piece is the explicit stated risk preference,
// which the caller fetches via useMemory() (backed by /api/memory ->
// lib/memoryStore.server.ts) and passes in.

// Minimal shape from lib/reflectionAgent.ts's ReflectionSections — kept
// local (not imported from lib/reflectionStore.server.ts, which pulls in
// Node's `fs` and isn't safe to import into this client-usable module).
export type ReflectionLessonInput = { tradeId: string; lesson: string | null };

const MAX_LESSONS_PER_CATEGORY = 5;

// Folds the Reflection Agent's per-trade "LESSON:" line (Level 6) back
// into Memory (Level 5) as "mistakes" (lessons from losing trades) and
// "successful strategies" (lessons from winning trades) — previously
// these only existed as unlinked free-text notes attached to individual
// trades, never surfaced here. Most-recent-first, capped rather than
// unbounded so this doesn't grow into an ever-expanding wall of text.
function summarizeLessons(trades: TradeLogEntry[], reflections: ReflectionLessonInput[]): { mistakes: string[]; successes: string[] } {
  const lessonByTradeId = new Map(reflections.filter((r) => r.lesson).map((r) => [r.tradeId, r.lesson as string]));
  const closedDesc = [...trades].filter((t) => typeof t.pnl === 'number' && lessonByTradeId.has(t.id)).sort((a, b) => b.ts - a.ts);

  const mistakes: string[] = [];
  const successes: string[] = [];
  for (const t of closedDesc) {
    const lesson = lessonByTradeId.get(t.id)!;
    if ((t.pnl as number) < 0 && mistakes.length < MAX_LESSONS_PER_CATEGORY) mistakes.push(`${t.symbol}: ${lesson}`);
    else if ((t.pnl as number) > 0 && successes.length < MAX_LESSONS_PER_CATEGORY) successes.push(`${t.symbol}: ${lesson}`);
    if (mistakes.length >= MAX_LESSONS_PER_CATEGORY && successes.length >= MAX_LESSONS_PER_CATEGORY) break;
  }
  return { mistakes, successes };
}

export function buildMemoryContext(trades: TradeLogEntry[], explicitRiskPreference: RiskPreference | null, reflections: ReflectionLessonInput[] = []): string {
  if (trades.length === 0) {
    return 'Memory & Trade Journal: no trade history yet — no win/loss stats, favorite assets, or trading-hours pattern available. This will fill in as trades are logged.';
  }

  const overall = computeOverallStats(trades);
  const favorites = computeFavoriteAssets(trades);
  const activeHours = computeActiveHours(trades);
  const inferred = inferRiskPreference(trades);

  const lines: string[] = ['Memory & Trade Journal:'];

  if (overall.winRate !== null) {
    const pnlSign = overall.totalPnl >= 0 ? '+' : '';
    lines.push(
      `- ${(overall.winRate * 100).toFixed(0)}% win rate over ${overall.closedCount} closed trades (${overall.wins}W/${overall.losses}L), total realized P&L ${pnlSign}${overall.totalPnl.toFixed(2)}.`,
    );
  } else {
    lines.push(`- ${overall.totalTrades} trade(s) logged, none closed yet — no win/loss rate available.`);
  }

  if (favorites.mostTraded) {
    lines.push(`- Most traded: ${favorites.mostTraded.symbol} (${favorites.mostTraded.trades} trades).`);
  }
  if (favorites.bestPerforming) {
    const sign = favorites.bestPerforming.totalPnl >= 0 ? '+' : '';
    lines.push(`- Best performer: ${favorites.bestPerforming.symbol} (${sign}${favorites.bestPerforming.totalPnl.toFixed(2)} over ${favorites.bestPerforming.closedCount} closed trades).`);
  } else {
    lines.push('- Best performer: not enough closed trades per symbol yet to call one out honestly.');
  }

  if (activeHours.peakWindowUtc) {
    lines.push(`- Typically trades around ${activeHours.peakWindowUtc}.`);
  } else {
    lines.push('- Active-hours pattern: not enough trade history yet to identify one.');
  }

  if (explicitRiskPreference) {
    lines.push(`- Stated risk preference: ${explicitRiskPreference} (set explicitly by the user — treat as authoritative over any inference below).`);
  } else if (inferred.preference) {
    lines.push(`- Inferred risk preference: ${inferred.preference} (heuristic based on ${inferred.reason} — not explicitly stated, treat as a rough signal only).`);
  } else {
    lines.push(`- Risk preference: not stated, and not yet inferable (${inferred.reason}).`);
  }

  const { mistakes, successes } = summarizeLessons(trades, reflections);
  if (mistakes.length > 0) {
    lines.push(`- Recent mistakes/lessons (from Reflection Agent post-mortems on losing trades, most recent first): ${mistakes.join(' | ')}`);
  }
  if (successes.length > 0) {
    lines.push(`- Recent successful strategies (from Reflection Agent post-mortems on winning trades, most recent first): ${successes.join(' | ')}`);
  }
  if (mistakes.length === 0 && successes.length === 0) {
    lines.push('- Mistakes/successful-strategy history: no Reflection Agent post-mortems with a usable lesson yet.');
  }

  return lines.join('\n');
}
