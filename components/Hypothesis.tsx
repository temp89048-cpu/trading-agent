'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { readSSEStream } from '@/lib/sse';
import { buildHypothesisMessages, parseHypothesisSections } from '@/lib/hypothesisAgent';
import { uid } from '@/lib/storage';
import type { HypothesisRecord, HypothesisStatus } from '@/lib/hypothesisStore.server';
import { useReflection } from './Reflection';
import { useAppState } from './AppState';

// Stage 2 of the self-learning pipeline (Section 12): Reflection ->
// Hypothesis -> human review. Same "advisory/read-only, no path back
// into execution" discipline as components/Reflection.tsx — this
// provider's only side effects are one buffered /api/chat call and
// persisting the result via /api/hypotheses. It never writes to any
// risk-config or strategy store; see lib/hypothesisAgent.ts's header
// comment for exactly why that's a deliberate boundary, not an
// oversight.

type HypothesisValue = {
  getHypothesis: (tradeId: string) => HypothesisRecord | undefined;
  isGenerating: (tradeId: string) => boolean;
  regenerate: (tradeId: string) => void;
  setStatus: (id: string, status: HypothesisStatus, reviewNote: string | null) => void;
};

const HypothesisContext = createContext<HypothesisValue | null>(null);

export function useHypothesis(): HypothesisValue {
  const ctx = useContext(HypothesisContext);
  if (!ctx) throw new Error('useHypothesis must be used within HypothesisProvider');
  return ctx;
}

const SCAN_INTERVAL_MS = 5000; // how often to check for new reflections lacking a hypothesis yet

export function HypothesisProvider({ children }: { children: React.ReactNode }) {
  const { getReflection, getAllReflections } = useReflection();
  const { config, activeProvider, resolvedModel, resolvedApiKey } = useAppState();
  const getAllReflectionsRef = useRef(getAllReflections);
  getAllReflectionsRef.current = getAllReflections;

  const [hypotheses, setHypotheses] = useState<Record<string, HypothesisRecord>>({});
  const [generating, setGenerating] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const processedRef = useRef<Set<string>>(new Set()); // trade ids attempted this session
  const hypothesesRef = useRef(hypotheses);
  hypothesesRef.current = hypotheses;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/hypotheses');
        const json = await res.json();
        if (Array.isArray(json.hypotheses)) {
          const map: Record<string, HypothesisRecord> = {};
          for (const h of json.hypotheses as HypothesisRecord[]) map[h.tradeId] = h;
          setHypotheses(map);
          for (const id of Object.keys(map)) processedRef.current.add(id);
        }
      } catch {
        // Fail quietly — same advisory-extra treatment as Reflection.
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  async function generate(tradeId: string) {
    const reflection = getReflection(tradeId);
    if (!reflection) return; // no reflection yet to build a hypothesis from
    if (activeProvider.needsKey && !resolvedApiKey) return; // no key configured — skip silently, retried on next reflections/config change
    processedRef.current.add(tradeId);
    setGenerating((prev) => ({ ...prev, [tradeId]: true }));
    try {
      const messages = buildHypothesisMessages(reflection);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: resolvedApiKey,
          baseUrl: config.baseUrlOverride || undefined,
          model: resolvedModel,
          messages,
          temperature: 0.2, // analytical, not creative — same fixed-low value Reflection uses
          maxTokens: 300,
        }),
      });
      if (!res.ok || !res.body) throw new Error('hypothesis request failed');

      let content = '';
      await readSSEStream(res.body, (delta) => {
        content += delta;
      });
      const { claim, suggestedTest } = parseHypothesisSections(content.trim());
      if (!claim || !suggestedTest) throw new Error('hypothesis response missing CLAIM/TEST');

      const record = {
        id: uid(),
        tradeId,
        symbol: reflection.symbol,
        claim,
        suggestedTest,
      };
      const saveRes = await fetch('/api/hypotheses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      });
      const saveJson = await saveRes.json();
      if (saveJson.hypothesis) {
        setHypotheses((prev) => ({ ...prev, [tradeId]: saveJson.hypothesis }));
      }
    } catch {
      // Fail quietly and un-mark so a later retry can try again — same
      // policy as Reflection.tsx.
      processedRef.current.delete(tradeId);
    } finally {
      setGenerating((prev) => ({ ...prev, [tradeId]: false }));
    }
  }

  // Auto-trigger once a reflection exists with an actual lesson and no
  // hypothesis has been attempted yet this session. Polling on an
  // interval rather than watching a live reflections object directly —
  // useReflection() only exposes a getter, not a change-subscribable
  // list, so a short interval is the simplest correct way to notice a
  // newly-generated reflection without threading a new subscription
  // API through Reflection.tsx.
  useEffect(() => {
    if (!loaded) return;
    const scan = () => {
      const all = getAllReflectionsRef.current();
      for (const [tradeId, reflection] of Object.entries(all)) {
        if (processedRef.current.has(tradeId)) continue;
        if (hypothesesRef.current[tradeId]) {
          processedRef.current.add(tradeId);
          continue;
        }
        if (!reflection.sections?.lesson && !reflection.content.trim()) continue; // nothing to build a hypothesis from yet
        generate(tradeId);
      }
    };
    scan();
    const iv = setInterval(scan, SCAN_INTERVAL_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const value: HypothesisValue = {
    getHypothesis: (tradeId) => hypotheses[tradeId],
    isGenerating: (tradeId) => !!generating[tradeId],
    regenerate: (tradeId) => generate(tradeId),
    setStatus: (id, status, reviewNote) => {
      fetch('/api/hypotheses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status, reviewNote }),
      })
        .then((res) => res.json())
        .then((json) => {
          if (json.hypothesis) setHypotheses((prev) => ({ ...prev, [json.hypothesis.tradeId]: json.hypothesis }));
        })
        .catch(() => {});
    },
  };

  return <HypothesisContext.Provider value={value}>{children}</HypothesisContext.Provider>;
}
