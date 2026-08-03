'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { loadLS, saveLS } from '@/lib/storage';
import { buildResearchDigest, type ResearchDigest } from '@/lib/autonomousResearch';
import type { Candle } from '@/lib/indicators';
import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useEventDetection } from './EventDetection';
import { usePortfolio } from './Portfolio';

// ---------------------------------------------------------------------
// Autonomous Research (Level 10) — the scheduling half. Everything this
// module reads (candles, event detection, trade log) is ALREADY being
// polled/cached by other providers already in the tree; this just runs
// the pure analysis in lib/autonomousResearch.ts on its own timer,
// without the user asking, and keeps a short history so "what changed
// overnight" is genuinely comparable run-to-run.
//
// Honest limitation, documented rather than hidden: this is a client-
// side timer that only runs while the app is open in a browser tab, not
// a real always-on server cron (that needs the message-queue/
// microservice infrastructure Level 20 describes, which this app
// doesn't have). It's still real autonomy within that constraint —
// no user prompt triggers any single run, unlike every other feature.
// ---------------------------------------------------------------------

const LS_DIGEST_HISTORY = 'qt_research_digests_v1';
const RUN_INTERVAL_MS = 15 * 60_000; // matches this app's other "slow-moving signal" polling cadence (MarketIntel/EventDetection)
const MAX_HISTORY = 20;

type AutonomousResearchValue = {
  latestDigest: ResearchDigest | null;
  history: ResearchDigest[];
  runNow: () => void;
};

const AutonomousResearchContext = createContext<AutonomousResearchValue | null>(null);

export function useAutonomousResearch(): AutonomousResearchValue {
  const ctx = useContext(AutonomousResearchContext);
  if (!ctx) throw new Error('useAutonomousResearch must be used within AutonomousResearchProvider');
  return ctx;
}

export function AutonomousResearchProvider({ children }: { children: React.ReactNode }) {
  const { watchlist } = useMarketData();
  const { getCandles } = useCandles();
  const { getAllEvents } = useEventDetection();
  const { tradeLog } = usePortfolio();

  const [history, setHistory] = useState<ResearchDigest[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Same ref-freshness pattern as components/Agent.tsx's scheduler —
  // the interval callback below is created once ([hydrated]) and must
  // still see the LATEST watchlist/candles/events/tradeLog, not
  // whatever existed at mount time.
  const watchlistRef = useRef(watchlist);
  watchlistRef.current = watchlist;
  const getCandlesRef = useRef(getCandles);
  getCandlesRef.current = getCandles;
  const getAllEventsRef = useRef(getAllEvents);
  getAllEventsRef.current = getAllEvents;
  const tradeLogRef = useRef(tradeLog);
  tradeLogRef.current = tradeLog;

  useEffect(() => {
    setHistory(loadLS<ResearchDigest[]>(LS_DIGEST_HISTORY, []));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLS(LS_DIGEST_HISTORY, history);
  }, [history, hydrated]);

  function runNow() {
    const wl = watchlistRef.current;
    const candles: Record<string, Candle[] | undefined> = {};
    for (const item of wl) {
      candles[item.symbol] = getCandlesRef.current(item.symbol, '1h')?.candles;
    }
    const digest = buildResearchDigest(wl, candles, getAllEventsRef.current(), tradeLogRef.current, Date.now());
    setHistory((prev) => [...prev, digest].slice(-MAX_HISTORY));
  }
  const runNowRef = useRef(runNow);
  runNowRef.current = runNow;

  useEffect(() => {
    if (!hydrated) return;
    // Run once shortly after mount (data needs a moment to load), then
    // on the regular interval — never blocking on a user prompt.
    const initial = setTimeout(() => runNowRef.current(), 10_000);
    const iv = setInterval(() => runNowRef.current(), RUN_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(iv);
    };
  }, [hydrated]);

  const value: AutonomousResearchValue = {
    latestDigest: history.length > 0 ? history[history.length - 1] : null,
    history,
    runNow: () => runNowRef.current(),
  };

  return <AutonomousResearchContext.Provider value={value}>{children}</AutonomousResearchContext.Provider>;
}
