'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { runFullDebate, type FullDebateResult } from '@/lib/debate/runDebate';
import type { DebateRecord } from '@/lib/debate/types';
import type { StrategyContext } from '@/lib/strategyContext';
import type { SentimentResult } from '@/lib/sentimentAgent';
import type { Candle } from '@/lib/indicators';
import type { StabilityScore } from '@/lib/backtest/stabilityScore';
import { uid } from '@/lib/storage';
import { usePortfolio } from './Portfolio';

type DebateValue = {
  records: DebateRecord[];
  recordsLoaded: boolean;
  runDebate: (params: {
    symbol: string;
    ctx: StrategyContext;
    sentiment: SentimentResult | null;
    liveCandles: Candle[];
    backtestStability?: StabilityScore | null;
    monteCarloRiskOfRuinPct?: number | null;
  }) => Promise<{ id: string; result: FullDebateResult }>;
  getLatestDebate: (symbol: string) => { id: string; result: FullDebateResult; ts: number } | undefined;
};

const DebateContext = createContext<DebateValue | null>(null);

export function useDebate(): DebateValue {
  const ctx = useContext(DebateContext);
  if (!ctx) throw new Error('useDebate must be used within DebateProvider');
  return ctx;
}

const DEBATE_FRESHNESS_MS = 10 * 60_000;

export function DebateProvider({ children }: { children: React.ReactNode }) {
  const { tradeLog, tradeLogLoaded } = usePortfolio();
  const [records, setRecords] = useState<DebateRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [latestBySymbol, setLatestBySymbol] = useState<Record<string, { id: string; result: FullDebateResult; ts: number }>>({});
  const processedOutcomes = useRef<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/debate');
        const json = await res.json();
        if (Array.isArray(json.records)) setRecords(json.records);
      } catch {
        // Fail quietly — debate history is advisory.
      } finally {
        setRecordsLoaded(true);
      }
    })();
  }, []);

  async function runDebate(params: {
    symbol: string;
    ctx: StrategyContext;
    sentiment: SentimentResult | null;
    liveCandles: Candle[];
    backtestStability?: StabilityScore | null;
    monteCarloRiskOfRuinPct?: number | null;
  }): Promise<{ id: string; result: FullDebateResult }> {
    const result = runFullDebate({
      ctx: params.ctx,
      sentiment: params.sentiment,
      historicalRecords: records,
      liveCandles: params.liveCandles,
      backtestStability: params.backtestStability,
      monteCarloRiskOfRuinPct: params.monteCarloRiskOfRuinPct,
    });

    const id = uid();
    const record: DebateRecord = {
      id,
      ts: Date.now(),
      symbol: params.symbol,
      opinions: result.opinions,
      moderator: result.moderator,
      regime: result.regime,
      calibratedConfidence: result.calibration.calibratedConfidence,
      riskLevel: result.composite.riskLevel,
      suggestedPositionPct: result.suggestedPositionPct,
      tradeId: null,
      outcome: null,
      outcomePnlUsd: null,
    };

    try {
      await fetch('/api/debate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
      setRecords((prev) => [...prev, record]);
    } catch {
      // advisory persistence failure — proceed with the in-memory result regardless
    }

    setLatestBySymbol((prev) => ({ ...prev, [params.symbol]: { id, result, ts: Date.now() } }));
    return { id, result };
  }

  useEffect(() => {
    if (!tradeLogLoaded) return;
    for (const trade of tradeLog) {
      if (typeof trade.pnl !== 'number') continue;
      if (processedOutcomes.current.has(trade.id)) continue;
      const priorBuy = [...tradeLog]
        .filter((t) => t.symbol === trade.symbol && t.tab === trade.tab && t.side === 'buy' && t.ts <= trade.ts && !!t.debateId)
        .sort((a, b) => b.ts - a.ts)[0];
      processedOutcomes.current.add(trade.id);
      if (!priorBuy?.debateId) continue;

      fetch('/api/debate', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradeId: priorBuy.id, outcome: trade.pnl >= 0 ? 'win' : 'loss', outcomePnlUsd: trade.pnl }),
      })
        .then((res) => res.json())
        .then((json) => {
          if (json.record) setRecords((prev) => prev.map((r) => (r.id === json.record.id ? json.record : r)));
        })
        .catch(() => {
          // best-effort
        });
    }
  }, [tradeLog, tradeLogLoaded]);

  const value: DebateValue = {
    records,
    recordsLoaded,
    runDebate,
    getLatestDebate: (symbol) => {
      const entry = latestBySymbol[symbol];
      if (!entry || Date.now() - entry.ts > DEBATE_FRESHNESS_MS) return undefined;
      return entry;
    },
  };

  return <DebateContext.Provider value={value}>{children}</DebateContext.Provider>;
}
