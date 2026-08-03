'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { readSSEStream } from '@/lib/sse';
import { buildReflectionMessages, captureContextSnapshot, parseReflectionSections, type ReflectionInput } from '@/lib/reflectionAgent';
import type { ReflectionRecord } from '@/lib/reflectionStore.server';
import { usePortfolio } from './Portfolio';
import { useCandles } from './Candles';
import { useAppState } from './AppState';

// Reflection is READ/ADVISORY ONLY. This provider's only side effects
// are: (1) one buffered, non-streaming-into-any-chat-conversation call
// to /api/chat, and (2) persisting the resulting text via
// /api/reflections. Nothing here ever calls buyPaper/sellPaper,
// executeTradeCommand, or touches Config — there is no code path for a
// reflection's text to become a trade action.

type ReflectionValue = {
  getReflection: (tradeId: string) => ReflectionRecord | undefined;
  getAllReflections: () => Record<string, ReflectionRecord>;
  isGenerating: (tradeId: string) => boolean;
  regenerate: (tradeId: string) => void;
};

const ReflectionContext = createContext<ReflectionValue | null>(null);

export function useReflection(): ReflectionValue {
  const ctx = useContext(ReflectionContext);
  if (!ctx) throw new Error('useReflection must be used within ReflectionProvider');
  return ctx;
}

export function ReflectionProvider({ children }: { children: React.ReactNode }) {
  const { tradeLog, tradeLogLoaded } = usePortfolio();
  const { getCandles } = useCandles();
  const { config, activeProvider, resolvedModel, resolvedApiKey } = useAppState();

  const [reflections, setReflections] = useState<Record<string, ReflectionRecord>>({});
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const [reflectionsLoaded, setReflectionsLoaded] = useState(false);
  const processedRef = useRef<Set<string>>(new Set()); // trade ids attempted this session

  // Load whatever's already been generated, once, on mount.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/reflections');
        const json = await res.json();
        if (Array.isArray(json.reflections)) {
          const map: Record<string, ReflectionRecord> = {};
          for (const r of json.reflections as ReflectionRecord[]) map[r.tradeId] = r;
          setReflections(map);
          for (const id of Object.keys(map)) processedRef.current.add(id);
        }
      } catch {
        // Fail quietly — reflections are advisory extras, not core data.
      } finally {
        setReflectionsLoaded(true);
      }
    })();
  }, []);

  async function generate(trade: (typeof tradeLog)[number]) {
    if (typeof trade.pnl !== 'number' || !isFinite(trade.pnl) || trade.qty <= 0) return;
    if (activeProvider.needsKey && !resolvedApiKey) return; // no key configured yet — skip silently, will retry next time tradeLog/config changes since we don't mark this one processed below on this path
    processedRef.current.add(trade.id);
    setGenerating((prev) => ({ ...prev, [trade.id]: true }));
    try {
      const entryPrice = trade.price - trade.pnl / trade.qty;
      const priorBuy = [...tradeLog]
        .filter((t) => t.symbol === trade.symbol && t.tab === trade.tab && t.side === 'buy' && t.ts <= trade.ts && !!t.entryContext)
        .sort((a, b) => b.ts - a.ts)[0];

      const exitContext = captureContextSnapshot(trade.symbol, getCandles);
      const input: ReflectionInput = {
        tradeId: trade.id,
        symbol: trade.symbol,
        tab: trade.tab,
        side: trade.side,
        qty: trade.qty,
        entryPrice,
        exitPrice: trade.price,
        pnl: trade.pnl,
        entryContext: priorBuy?.entryContext ?? null,
        exitContext,
      };

      const messages = buildReflectionMessages(input);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: resolvedApiKey,
          baseUrl: config.baseUrlOverride || undefined,
          model: resolvedModel,
          messages,
          temperature: 0.2, // fixed, low — this is analytical post-mortem text, not creative chat
          maxTokens: 500,
        }),
      });
      if (!res.ok || !res.body) throw new Error('reflection request failed');

      let content = '';
      const { finishReason } = await readSSEStream(res.body, (delta) => {
        content += delta;
      });
      if (!content.trim()) throw new Error('empty reflection response');
      const sections = parseReflectionSections(content.trim());

      const saveRes = await fetch('/api/reflections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradeId: trade.id,
          symbol: trade.symbol,
          content: content.trim(),
          sections,
          entryContextUsed: input.entryContext,
          exitContextUsed: input.exitContext,
          finishReason,
        }),
      });
      const saveJson = await saveRes.json();
      if (saveJson.reflection) {
        setReflections((prev) => ({ ...prev, [trade.id]: saveJson.reflection }));
      }
    } catch {
      // Fail quietly and un-mark as processed so a later retry (manual
      // regenerate, or next mount) can try again — a failed advisory
      // note shouldn't be treated as a permanent gap.
      processedRef.current.delete(trade.id);
    } finally {
      setGenerating((prev) => ({ ...prev, [trade.id]: false }));
    }
  }

  // Auto-trigger on trade close: watch tradeLog for closed trades
  // (pnl defined) that haven't been processed yet this session and
  // don't already have a saved reflection.
  useEffect(() => {
    if (!tradeLogLoaded || !reflectionsLoaded) return;
    for (const trade of tradeLog) {
      if (typeof trade.pnl !== 'number') continue;
      if (processedRef.current.has(trade.id)) continue;
      if (reflections[trade.id]) {
        processedRef.current.add(trade.id);
        continue;
      }
      generate(trade);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradeLog, tradeLogLoaded, reflectionsLoaded, resolvedApiKey]);

  const value: ReflectionValue = {
    getReflection: (tradeId) => reflections[tradeId],
    getAllReflections: () => reflections,
    isGenerating: (tradeId) => !!generating[tradeId],
    regenerate: (tradeId) => {
      const trade = tradeLog.find((t) => t.id === tradeId);
      if (trade) generate(trade);
    },
  };

  return <ReflectionContext.Provider value={value}>{children}</ReflectionContext.Provider>;
}
