'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { loadLS, saveLS, uid, LS_KEYS } from '@/lib/storage';
import { PROVIDERS, SYSTEM_PROMPT, THEMES } from '@/lib/constants';
import { readSSEStream } from '@/lib/sse';
import { buildLiveMarketContext } from '@/lib/marketContext';
import { trimApiMessages } from '@/lib/context';
import { parseTradeCommand } from '@/lib/tradeCommand';
import { resolveSymbol } from '@/lib/symbolResolve';
import { detectTradeIntentTab, inferContinuationTab, buildTradeIntentInstruction, extractTradeIntent, resolveTradeIntent, resolveAgentIntent } from '@/lib/tradeIntent';
import { describeCondition } from '@/lib/plannerAgent';
import type { TradeIntentTab } from '@/lib/tradeIntent';
import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';
import { useAgent } from './Agent';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useMarketIntel } from './MarketIntel';
import { useMemory } from './Memory';
import { buildMemoryContext, type ReflectionLessonInput } from '@/lib/memoryContext';
import { useDebate } from './Debate';
import { buildDebateContext } from '@/lib/debateContext';
import { buildIndicatorContext } from '@/lib/indicatorContext';
import { buildMultiTimeframeContext } from '@/lib/multiTimeframe';
import { buildStructureContext } from '@/lib/marketStructure';
import { buildLiquidityContext } from '@/lib/liquidity';
import { buildVolumeProfileContext } from '@/lib/volumeProfile';
import { buildOrderFlowContext } from '@/lib/orderFlow';
import { buildCapabilityContext } from '@/lib/providerCapabilities';
import { buildStrategyContext } from '@/lib/strategyContext';
import { validateTrade, buildRiskContext } from '@/lib/riskManager';
import { formatExplainableRecommendationText } from '@/lib/explainableOutput';
import { useSupervisor } from './Supervisor';
import { computeCorrelationMatrix, buildPortfolioIntelligenceContext } from '@/lib/portfolioIntelligence';
import { buildMultiExchangeContext } from '@/lib/multiExchange';
import { buildArbitrageContext } from '@/lib/strategies/arbitrage';
import { buildEventDetectionContext } from '@/lib/eventDetection';
import { useMultiExchange } from './MultiExchange';
import { useEventDetection } from './EventDetection';
import { buildMarketIntelContext } from '@/lib/sentimentAgent';
import { computeMtfSnapshot } from '@/lib/multiTimeframe';
import { buildStrategyEnsembleContext } from '@/lib/strategyEnsemble';
import { buildAutonomousResearchContext } from '@/lib/autonomousResearch';
import { useAutonomousResearch } from './AutonomousResearch';
import { captureContextSnapshot } from '@/lib/reflectionAgent';
import type { Config, Conversation, Message, WatchItem, TradeTab } from '@/lib/types';
import { DEFAULT_CONFIG } from '@/lib/types';

type AppStateValue = {
  config: Config;
  setConfig: (updater: Config | ((c: Config) => Config)) => void;
  activeProvider: (typeof PROVIDERS)[number];
  resolvedModel: string;
  resolvedApiKey: string;
  hasKey: boolean;

  conversations: Conversation[];
  activeId: string | null;
  activeConv: Conversation | null;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  restoreConversations: (convs: Conversation[]) => void;
  restoreConfig: (partial: Partial<Omit<Config, 'apiKeys'>>) => void;

  input: string;
  setInput: (v: string) => void;
  streaming: boolean;
  lastError: string | null;
  sendMessage: (text?: string) => Promise<void>;
  stopGenerating: () => void;
  regenerate: () => void;
  copyMessage: (content: string) => void;
};

const AppStateContext = createContext<AppStateValue | null>(null);

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within AppStateProvider');
  return ctx;
}

// During streaming we batch UI updates instead of calling setState on
// every single SSE delta — a fast/chatty stream can emit dozens of
// deltas per second, and re-rendering the whole message list that often
// adds visible jank for no benefit the user can actually perceive.
const UI_FLUSH_MS = 60;

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const { watchlist, ticks } = useMarketData();
  const { portfolio, tradeLog, buyPaper, sellPaper, addRealPosition, removeRealPosition } = usePortfolio();
  const { reviewAndExecute } = useSupervisor();
  const { startAgent, events: agentEvents, markEventsSeen } = useAgent();
  const { getCandles } = useCandles();
  const { getOrderFlow } = useOrderFlow();
  const { getNews, getFearGreed, getDerivatives, aggregatorNote } = useMarketIntel();
  const { getAllSnapshots, getSnapshot } = useMultiExchange();
  const { getAllEvents } = useEventDetection();
  const { getRiskPreference } = useMemory();
  const { getLatestDebate } = useDebate();
  const { latestDigest } = useAutonomousResearch();

  function buildAllDebateContext(): string {
    const withDebates = watchlist
      .map((w) => ({ symbol: w.symbol, debate: getLatestDebate(w.symbol) }))
      .filter((x): x is { symbol: string; debate: NonNullable<ReturnType<typeof getLatestDebate>> } => !!x.debate);
    if (withDebates.length === 0) return 'Debate System: no live multi-agent debate has been run this session for any watchlist symbol.';
    return withDebates.map((x) => buildDebateContext(x.symbol, x.debate.result)).join('\n\n');
  }
  // Builds Commit 12's StrategyContext from whatever's already cached —
  // no fetching here, purely assembling data Commits 8-11 already
  // computed. Reused by both sendMessage and regenerate below.
  function getStrategyContextFor(item: WatchItem) {
    const primary = getCandles(item.symbol, '1h');
    if (!primary || primary.candles.length === 0) return null;
    return buildStrategyContext(item, primary.candles, getCandles, getOrderFlow(item.symbol));
  }
  function paperEquityUsd(): number {
    return portfolio.paper.cash + portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  }
  function paperExistingExposureUsd(): number {
    return portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  }
  // Commit 21: correlation matrix built from whatever 1h candle history
  // is already cached for the watchlist — no new fetch, reuses Commit
  // 8's data. Recomputed on demand rather than cached in state since
  // it's cheap pure math over arrays already in memory.
  function getWatchlistPriceHistories(): Record<string, number[]> {
    const priceHistories: Record<string, number[]> = {};
    for (const item of watchlist) {
      const primary = getCandles(item.symbol, '1h');
      if (primary && primary.candles.length > 0) priceHistories[item.symbol] = primary.candles.map((c) => c.c);
    }
    return priceHistories;
  }
  function getWatchlistCorrelationMatrix() {
    return computeCorrelationMatrix(getWatchlistPriceHistories());
  }
  function paperPositionsForCorrelation(): { symbol: string; valueUsd: number }[] {
    return portfolio.paper.positions.map((p) => ({ symbol: p.symbol, valueUsd: p.qty * (ticks[p.symbol]?.price ?? p.avgCost) }));
  }
  // Commit 13's gate — only ever called for a BUY (opening a new
  // position). Selling/closing is never risk-gated: refusing an exit
  // because "spread is wide" would trap someone in a trade they wanted
  // out of, not protect them. Returns null if there isn't enough market
  // data yet to run the checks at all (fails closed, doesn't skip the
  // check silently).
  function runBuyRiskGate(symbol: string, tab: TradeTab, qty: number) {
    const item: WatchItem = watchlist.find((w) => w.symbol === symbol) ?? { symbol, type: symbol.includes('/') ? 'crypto' : 'equity' };
    const ctx = getStrategyContextFor(item);
    if (!ctx) return null;
    const existingExposureUsd = tab === 'paper'
      ? portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0)
      : null;
    return validateTrade({
      ctx,
      side: 'buy',
      requestedQty: qty,
      equityUsd: tab === 'paper' ? paperEquityUsd() : null,
      tradeLog,
      tab,
      existingExposureUsd,
      newsHeadlines: getNews(),
      correlationInputs: tab === 'paper'
        ? { matrix: getWatchlistCorrelationMatrix(), existingPositions: paperPositionsForCorrelation().filter((p) => p.symbol !== symbol), equityUsd: paperEquityUsd() }
        : null,
    });
  }
  const [config, setConfigState] = useState<Config>(DEFAULT_CONFIG);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [reflectionLessons, setReflectionLessons] = useState<ReflectionLessonInput[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Fetched directly (not via useReflection()) — ReflectionProvider sits
  // BELOW AppStateProvider in app/layout.tsx's provider tree (it reads
  // config/resolvedApiKey from useAppState()), so AppState can't consume
  // Reflection's context without a cycle. Same endpoint Reflection.tsx
  // already loads from; refetched whenever tradeLog's length changes so
  // a reflection generated shortly after a trade closes shows up here
  // without needing a full reload.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/reflections');
        const json = await res.json();
        if (Array.isArray(json.reflections)) {
          setReflectionLessons(
            json.reflections.map((r: { tradeId: string; sections?: { lesson?: string | null } | null }) => ({
              tradeId: r.tradeId,
              lesson: r.sections?.lesson ?? null,
            })),
          );
        }
      } catch {
        // Best-effort only — memory context still works without lessons folded in.
      }
    })();
  }, [tradeLog.length]);

  useEffect(() => {
    const cfg = loadLS<Partial<Config>>(LS_KEYS.config, {});
    setConfigState({ ...DEFAULT_CONFIG, ...cfg, apiKeys: { ...DEFAULT_CONFIG.apiKeys, ...(cfg.apiKeys || {}) } });
    const convs = loadLS<Conversation[]>(LS_KEYS.conversations, []);
    setConversations(convs);
    if (convs.length > 0) setActiveId(convs[0].id);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLS(LS_KEYS.config, config);
    const theme = THEMES[config.theme] ?? THEMES.amber;
    document.documentElement.style.setProperty('--amber', theme.accent);
    document.documentElement.style.setProperty('--amber-dim', theme.accentDim);
  }, [config, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    saveLS(LS_KEYS.conversations, conversations);
  }, [conversations, hydrated]);

  function setConfig(updater: Config | ((c: Config) => Config)) {
    setConfigState((prev) => (typeof updater === 'function' ? (updater as (c: Config) => Config)(prev) : updater));
  }

  const activeProvider = useMemo(() => PROVIDERS.find((p) => p.id === config.provider) ?? PROVIDERS[0], [config.provider]);
  const resolvedModel = config.model || activeProvider.models[0] || '';
  const resolvedBaseUrl = config.baseUrlOverride || activeProvider.baseUrl;
  const resolvedApiKey = config.apiKeys[config.provider] || '';
  const hasKey = !activeProvider.needsKey || !!resolvedApiKey;

  const activeConv = useMemo(() => conversations.find((c) => c.id === activeId) ?? null, [conversations, activeId]);

  function newConversation() {
    const conv: Conversation = { id: uid(), title: 'New chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
  }

  function selectConversation(id: string) {
    setActiveId(id);
  }

  function deleteConversation(id: string) {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  }

  function restoreConversations(convs: Conversation[]) {
    setConversations(convs);
    if (convs.length > 0) setActiveId(convs[0].id);
  }

  function restoreConfig(partial: Partial<Omit<Config, 'apiKeys'>>) {
    setConfigState((prev) => ({ ...prev, ...partial, apiKeys: prev.apiKeys }));
  }

  function copyMessage(content: string) {
    navigator.clipboard?.writeText(content).catch(() => {});
  }

  function updateConv(id: string, updater: (c: Conversation) => Conversation) {
    setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
  }

  // Turns each agent event (a real trade that just actually happened, at
  // the real time, at the real price — see components/Agent.tsx) into a
  // normal assistant message in whichever conversation started that
  // agent. This is what replaces the model faking "after 2 minutes...":
  // the update only appears once the real thing has actually occurred.
  useEffect(() => {
    if (agentEvents.length === 0) return;
    const seenIds: string[] = [];
    for (const event of agentEvents) {
      seenIds.push(event.id);
      const targetConvId = event.conversationId ?? activeId;
      if (!targetConvId) continue;
      const msg: Message = { id: uid(), role: 'assistant', content: event.message, ts: event.ts };
      setConversations((prev) => prev.map((c) => (c.id === targetConvId ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() } : c)));
    }
    markEventsSeen(seenIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentEvents]);

  function ensureConversation(firstUserText: string): { convId: string; baseMessages: Message[] } {
    if (activeId) {
      return { convId: activeId, baseMessages: conversations.find((c) => c.id === activeId)?.messages ?? [] };
    }
    const conv: Conversation = { id: uid(), title: firstUserText.slice(0, 48), messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
    return { convId: conv.id, baseMessages: [] };
  }

  async function streamInto(
    convId: string,
    apiMessages: { role: string; content: string }[],
    assistantMsgId: string,
    tradeIntentTab?: TradeIntentTab,
  ) {
    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setLastError(null);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: resolvedApiKey,
          baseUrl: resolvedBaseUrl,
          model: resolvedModel,
          messages: trimApiMessages(apiMessages),
          temperature: config.temperature,
          maxTokens: config.maxTokens,
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      let acc = '';
      let pending = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;

      function flush() {
        if (!pending) return;
        acc += pending;
        pending = '';
        updateConv(convId, (c) => ({
          ...c,
          messages: c.messages.map((m) => (m.id === assistantMsgId ? { ...m, content: acc } : m)),
          updatedAt: Date.now(),
        }));
      }

      const { finishReason } = await readSSEStream(
        res.body,
        (delta) => {
          pending += delta;
          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              flush();
            }, UI_FLUSH_MS);
          }
        },
        controller.signal,
      );
      if (flushTimer) clearTimeout(flushTimer);
      flush();

      if (acc.trim().length === 0 && !controller.signal.aborted) {
        throw new Error('Model returned an empty response.');
      }

      // Natural-language trade path: the model was asked (via
      // buildTradeIntentInstruction) to end its analysis with either a
      // ```trade-action (one-off) or ```agent-action (repeating plan)
      // block. Extract it, strip it from what's shown, and only ever
      // touch the trade log / start a real scheduler if the app's own
      // safety gate (confidence + something it can verify itself) passes.
      if (tradeIntentTab && !controller.signal.aborted) {
        const { extracted, displayText } = extractTradeIntent(acc);
        let finalContent = displayText || acc;

        if (!extracted) {
          finalContent += `\n\n---\n⚠ No trade-action returned by the model — nothing was logged automatically.`;
        } else if (extracted.kind === 'trade') {
          const resolved = resolveTradeIntent(extracted.intent, watchlist, ticks);
          if (resolved.ok) {
            const intent = !('error' in extracted.intent) ? extracted.intent : null;
            // Commit 24: the model's trade-action block no longer gets
            // its own bespoke risk-gate-then-execute path — it goes
            // through the same Supervisor every other AI-agent-
            // initiated trade does now.
            const { decision, executed, pendingApprovalId, realOrderSubmitted } = reviewAndExecute({
              symbol: resolved.symbol,
              side: resolved.side,
              tab: resolved.tab,
              qty: resolved.qty,
              price: resolved.price,
              originTag: 'chat-trade-action',
              rationale: intent?.rationale,
              entryContext: captureContextSnapshot(resolved.symbol, getCandles),
            });

            finalContent += !decision.approved
              ? `\n\n---\n🛡️ **Supervisor rejected this trade**: ${decision.reasons.join('; ')}`
              : pendingApprovalId
                ? `\n\n---\n⏸️ **Queued for manual approval** (Trading Controls) — this trade exceeds your configured approval threshold. Approve or reject it there.`
                : realOrderSubmitted
                  ? `\n\n---\n📡 **Real order submitted** to the exchange — confirming fill. Check the Audit Trail for the result.`
                  : executed
                    ? `\n\n---\n✅ **Logged to the ${resolved.tab} trade log**: ${resolved.side.toUpperCase()} ${resolved.qty.toFixed(6).replace(/\.?0+$/, '')} ${resolved.symbol} @ $${resolved.price.toLocaleString()}.`
                    : `\n\n---\n⚠ Didn't log — ${resolved.side === 'sell' ? `no open ${resolved.tab} position in ${resolved.symbol} to close` : 'insufficient paper cash for that size'}.`;

            if (decision.conflictNotes.length > 0) {
              finalContent += `\n\n⚠ **Supervisor conflict notes** (cross-agent disagreement, informational):\n${decision.conflictNotes.map((n) => `- ${n}`).join('\n')}`;
            }

            // Explainable Output Schema (Level 15) — already built as
            // part of the Supervisor's review, approved or not.
            if (decision.explainable) {
              finalContent += `\n\n${formatExplainableRecommendationText(decision.explainable)}`;
            }
          } else {
            finalContent += `\n\n---\n⚠ Didn't log a trade automatically — ${resolved.reason}. You can also use the precise \`@${tradeIntentTab === 'real' ? 'real' : 'papertrade'} buy/sell ...\` syntax for a guaranteed manual entry.`;
          }
        } else {
          // extracted.kind === 'agent' — a repeating plan. This starts a
          // REAL scheduler (components/Agent.tsx) that checks the real
          // clock and real live price every few seconds — nothing here
          // pretends time has passed the way the model narrating "let's
          // wait 2 minutes" would.
          const resolvedAgent = resolveAgentIntent(extracted.intent, watchlist);
          if (resolvedAgent.ok) {
            const task = startAgent({ ...resolvedAgent.spec, conversationId: convId });
            const planDesc =
              task.mode === 'interval'
                ? `every ${task.intervalMinutes} minute${task.intervalMinutes === 1 ? '' : 's'}`
                : task.mode === 'take-profit'
                  ? `each waiting for a ${task.tpPercent}% move in favor${task.slPercent ? ` (stop at -${task.slPercent}%)` : ''}, reinvesting profit into the next leg`
                  : `waiting for ${task.triggerCondition ? describeCondition(task.triggerCondition) : 'a trigger condition'}${task.watchCondition ? `, then watching for ${describeCondition(task.watchCondition)}` : ''}, then entering with a ${task.tpPercent}% target${task.slPercent ? ` (stop at -${task.slPercent}%)` : ''}`;
            finalContent += `\n\n---\n🤖 **Started an agent**: ${task.totalTrades} ${task.tab} trades on ${task.symbol}, ${planDesc}. $${task.marginUsd} margin × ${task.leverage}x per leg. I'll post an update right here as each one actually happens — you don't need to ask again. You can cancel it any time from the Trading Agent panel in the sidebar.`;
          } else {
            finalContent += `\n\n---\n⚠ Didn't start an agent — ${resolvedAgent.reason}.`;
          }
        }

        acc = finalContent;
        updateConv(convId, (c) => ({
          ...c,
          messages: c.messages.map((m) => (m.id === assistantMsgId ? { ...m, content: finalContent } : m)),
        }));
      }

      if (finishReason === 'length') {
        updateConv(convId, (c) => ({
          ...c,
          messages: c.messages.map((m) =>
            m.id === assistantMsgId ? { ...m, content: `${m.content}\n\n_⚠ Response cut off at the Max Response Length setting — raise it in Settings for longer replies._` } : m,
          ),
        }));
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // user hit Stop — keep whatever was streamed so far
      } else {
        const message = err instanceof Error ? err.message : 'Unknown error';
        setLastError(message);
        updateConv(convId, (c) => ({
          ...c,
          messages: c.messages.map((m) => (m.id === assistantMsgId ? { ...m, content: m.content || `⚠ ${message}` } : m)),
        }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  // "@papertrade buy 0.5 BTC/USDT" / "@real sell NVDA" etc. execute
  // instantly against the Portfolio context and log to the Trade Log —
  // no model call at all, so these are as fast as clicking the Buy/Sell
  // buttons in the sidebar. This is a bonus fast path for anyone who
  // wants exact, deterministic execution — it is NOT the primary way to
  // trade via chat anymore. Anything that doesn't match this exact
  // grammar (including a natural sentence that just mentions @real or
  // @papertrade) falls through to sendMessage's natural-language path
  // below instead of showing a "couldn't parse" error here.
  // This manual `@real`/`@papertrade` syntax is documented elsewhere as
  // "a guaranteed manual entry" — a deliberate, explicit override where
  // the person typed an exact size and (optionally) price themselves.
  // Gating that through rejection would break its own stated guarantee,
  // so it's never blocked. It still gets the same risk read as the AI
  // path, just as a non-blocking note rather than a refusal.
  function riskAdvisorySuffix(symbol: string, tab: TradeTab, qty: number): string {
    const risk = runBuyRiskGate(symbol, tab, qty);
    if (!risk) return '';
    if (!risk.approved) return `\n\n🛡️ Risk Manager note (not blocking a manual entry): ${risk.rejectionReasons.join('; ')}`;
    if (risk.stopLossTakeProfit) {
      return `\n\n🛡️ Suggested SL ${risk.stopLossTakeProfit.stopLoss.toFixed(2)} / TP ${risk.stopLossTakeProfit.takeProfit.toFixed(2)} (${risk.stopLossTakeProfit.method}) — informational only, not applied automatically.`;
    }
    return '';
  }

  function executeTradeCommand(rawText: string): boolean {
    const parsed = parseTradeCommand(rawText);
    if (!parsed) return false;

    const cmd = { ...parsed, symbol: resolveSymbol(parsed.symbol, watchlist) };
    let reply: string;

    if (cmd.tab === 'real' && cmd.side === 'sell') {
      const existed = portfolio.real.positions.some((p) => p.symbol === cmd.symbol);
      removeRealPosition(cmd.symbol, ticks[cmd.symbol]?.price);
      reply = existed
        ? `✅ Removed **${cmd.symbol}** from the Real ledger — logged to the Real trade log.`
        : `⚠ No open Real position in **${cmd.symbol}** to remove.`;
    } else {
      let price = cmd.price;
      if (price === undefined) price = ticks[cmd.symbol]?.price;
      if (price === undefined) {
        reply = `⚠ No live price available for **${cmd.symbol}** — add it to the watchlist first, or specify one with \`@ <price>\`.`;
      } else if (cmd.tab === 'paper') {
        const ok = cmd.side === 'buy' ? buyPaper(cmd.symbol, cmd.qty, price, captureContextSnapshot(cmd.symbol, getCandles), undefined, 'user-command') : sellPaper(cmd.symbol, cmd.qty, price);
        reply = ok
          ? `✅ Paper **${cmd.side}** ${cmd.qty} **${cmd.symbol}** @ ${price} — logged to the Paper trade log.`
          : `⚠ Paper ${cmd.side} failed — ${cmd.side === 'buy' ? 'insufficient paper cash' : "you don't hold enough of that symbol in Paper"}.`;
        if (ok && cmd.side === 'buy') reply += riskAdvisorySuffix(cmd.symbol, 'paper', cmd.qty);
      } else {
        addRealPosition(cmd.symbol, cmd.qty, price, captureContextSnapshot(cmd.symbol, getCandles), undefined, 'user-command');
        reply = `✅ Added ${cmd.qty} **${cmd.symbol}** @ ${price} to the Real ledger — logged to the Real trade log.`;
        if (cmd.side === 'buy') reply += riskAdvisorySuffix(cmd.symbol, 'real', cmd.qty);
      }
    }

    const { convId } = ensureConversation(rawText);
    const userMsg: Message = { id: uid(), role: 'user', content: rawText, ts: Date.now() };
    const assistantMsg: Message = { id: uid(), role: 'assistant', content: reply, ts: Date.now() };
    updateConv(convId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? rawText.slice(0, 48) : c.title,
      messages: [...c.messages, userMsg, assistantMsg],
      updatedAt: Date.now(),
    }));
    setInput('');
    return true;
  }

  async function sendMessage(text?: string) {
    const content = (text ?? input).trim();
    if (!content || streaming) return;

    if (executeTradeCommand(content)) return;

    if (activeProvider.needsKey && !resolvedApiKey) {
      setLastError('No API key set for this provider — open Settings.');
      return;
    }

    const { convId, baseMessages } = ensureConversation(content);
    const userMsg: Message = { id: uid(), role: 'user', content, ts: Date.now() };
    const assistantMsg: Message = { id: uid(), role: 'assistant', content: '', ts: Date.now() };

    updateConv(convId, (c) => ({
      ...c,
      title: c.messages.length === 0 ? content.slice(0, 48) : c.title,
      messages: [...c.messages, userMsg, assistantMsg],
      updatedAt: Date.now(),
    }));
    setInput('');

    const history = [...baseMessages, userMsg].map((m) => ({ role: m.role, content: m.content }));
    const tradeIntentTab = detectTradeIntentTab(content) ?? inferContinuationTab(history);
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: buildLiveMarketContext(watchlist, ticks) },
      { role: 'system', content: buildIndicatorContext(watchlist, ['1h', '4h'], getCandles) },
      { role: 'system', content: buildMultiTimeframeContext(watchlist, getCandles) },
      { role: 'system', content: buildStructureContext(watchlist, getCandles) },
      { role: 'system', content: buildLiquidityContext(watchlist, getCandles) },
      { role: 'system', content: buildVolumeProfileContext(watchlist, getCandles) },
      { role: 'system', content: buildCapabilityContext(watchlist) },
      { role: 'system', content: buildOrderFlowContext(watchlist, getOrderFlow) },
      { role: 'system', content: buildStrategyEnsembleContext(watchlist, getStrategyContextFor, (symbol) => getSnapshot(symbol) ?? null) },
      { role: 'system', content: buildAutonomousResearchContext(latestDigest) },
      { role: 'system', content: buildRiskContext(watchlist, getStrategyContextFor, (tradeIntentTab ?? 'paper') as TradeTab, (tradeIntentTab === 'real') ? null : paperEquityUsd(), tradeLog, (tradeIntentTab === 'real') ? null : paperExistingExposureUsd(), getNews(), getWatchlistCorrelationMatrix(), paperPositionsForCorrelation()) },
      { role: 'system', content: buildPortfolioIntelligenceContext(watchlist, getWatchlistCorrelationMatrix(), paperPositionsForCorrelation(), paperEquityUsd(), getWatchlistPriceHistories()) },
      { role: 'system', content: buildMultiExchangeContext(getAllSnapshots(), watchlist) },
      { role: 'system', content: buildArbitrageContext(getAllSnapshots(), watchlist) },
      { role: 'system', content: buildEventDetectionContext(getAllEvents(), watchlist) },
      { role: 'system', content: buildMarketIntelContext(watchlist, getNews(), getFearGreed(), getDerivatives, (item) => computeMtfSnapshot(item, getCandles), aggregatorNote) },
      { role: 'system', content: buildMemoryContext(tradeLog, getRiskPreference(), reflectionLessons) },
      { role: 'system', content: buildAllDebateContext() },
      ...(tradeIntentTab ? [{ role: 'system', content: buildTradeIntentInstruction(tradeIntentTab) }] : []),
      ...history,
    ];

    await streamInto(convId, apiMessages, assistantMsg.id, tradeIntentTab ?? undefined);
  }

  function stopGenerating() {
    abortRef.current?.abort();
  }

  function regenerate() {
    if (!activeConv || streaming) return;
    const msgs = activeConv.messages;
    const lastUserIdx = [...msgs].reverse().findIndex((m) => m.role === 'user');
    if (lastUserIdx === -1) return;
    const cutIdx = msgs.length - 1 - lastUserIdx;
    const trimmed = msgs.slice(0, cutIdx + 1);
    const assistantMsg: Message = { id: uid(), role: 'assistant', content: '', ts: Date.now() };
    updateConv(activeConv.id, (c) => ({ ...c, messages: [...trimmed, assistantMsg] }));

    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'system', content: buildLiveMarketContext(watchlist, ticks) },
      { role: 'system', content: buildIndicatorContext(watchlist, ['1h', '4h'], getCandles) },
      { role: 'system', content: buildMultiTimeframeContext(watchlist, getCandles) },
      { role: 'system', content: buildStructureContext(watchlist, getCandles) },
      { role: 'system', content: buildLiquidityContext(watchlist, getCandles) },
      { role: 'system', content: buildVolumeProfileContext(watchlist, getCandles) },
      { role: 'system', content: buildCapabilityContext(watchlist) },
      { role: 'system', content: buildOrderFlowContext(watchlist, getOrderFlow) },
      { role: 'system', content: buildStrategyEnsembleContext(watchlist, getStrategyContextFor, (symbol) => getSnapshot(symbol) ?? null) },
      { role: 'system', content: buildAutonomousResearchContext(latestDigest) },
      { role: 'system', content: buildRiskContext(watchlist, getStrategyContextFor, 'paper', paperEquityUsd(), tradeLog, paperExistingExposureUsd(), getNews(), getWatchlistCorrelationMatrix(), paperPositionsForCorrelation()) },
      { role: 'system', content: buildPortfolioIntelligenceContext(watchlist, getWatchlistCorrelationMatrix(), paperPositionsForCorrelation(), paperEquityUsd(), getWatchlistPriceHistories()) },
      { role: 'system', content: buildMultiExchangeContext(getAllSnapshots(), watchlist) },
      { role: 'system', content: buildArbitrageContext(getAllSnapshots(), watchlist) },
      { role: 'system', content: buildEventDetectionContext(getAllEvents(), watchlist) },
      { role: 'system', content: buildMarketIntelContext(watchlist, getNews(), getFearGreed(), getDerivatives, (item) => computeMtfSnapshot(item, getCandles), aggregatorNote) },
      { role: 'system', content: buildMemoryContext(tradeLog, getRiskPreference(), reflectionLessons) },
      { role: 'system', content: buildAllDebateContext() },
    ];
    streamInto(activeConv.id, apiMessages, assistantMsg.id);
  }

  const value: AppStateValue = {
    config, setConfig, activeProvider, resolvedModel, resolvedApiKey, hasKey,
    conversations, activeId, activeConv, newConversation, selectConversation, deleteConversation,
    restoreConversations, restoreConfig,
    input, setInput, streaming, lastError, sendMessage, stopGenerating, regenerate, copyMessage,
  };

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}
