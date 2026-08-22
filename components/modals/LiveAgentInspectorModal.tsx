'use client';

// ---------------------------------------------------------------------
// The Live Agent Inspector — 8-stage tracker, 3-column live panel, and a
// streaming console.
//
// The brief singles this out: its News, Polymarket and Console panels must EACH be
// individually marked with their real data source or explicitly flagged as
// unavailable, and must not silently fall back to mock content. So each panel
// carries its own provenance line, and all three are honest about what they are:
//
//   NEWS       `app/api/news` (Next.js, public RSS). It returns
//              {title, link, source, pubDate} and NOTHING ELSE — no sentiment, no
//              relevance, no per-asset tagging. So the reference's sentiment badge
//              and relevance gauge are OMITTED rather than invented, and the panel
//              says the feed is unfiltered.
//
//   POLYMARKET `/api/polymarket/snapshots` — real, and currently returns
//              `applicable: false` until an operator confirms a mapping.
//
//   CONSOLE    node-level graph events from the shared stream. The reference
//              streams 14 templated action lines every 1.5s from a timer; no
//              backend event exists at that granularity, so this shows real node
//              transitions and says so. It will look calmer than the mockup.
//
// SUBSCRIPTION LIFECYCLE: it attaches to the EXISTING global stream (filtered),
// never its own socket, and detaches on unmount. That is the pattern the
// reference's `clearInterval` on `closeLiveInspector()` establishes and the brief
// asks to preserve — here it falls out of `useEffect` cleanup in the store hooks.
// ---------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';

import { PolymarketCard, type PolymarketCardData } from '@/components/cards/PolymarketCard';
import { Badge } from '@/components/ui/Badge';
import { Gauge } from '@/components/ui/Gauge';
import { NotAvailable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { NODE_LEVEL_ONLY } from '@/lib/realtime/store';
import { useBackend, useEventFeed, useGraphNodes } from '@/lib/realtime/useRealtime';

const STAGES = ['Ingest', 'News', 'Polymarket', 'Indicators', 'Regime', 'Signal', 'Risk', 'Decision'] as const;

/** Which graph nodes correspond to each visible stage.
 *
 *  `News` and `Polymarket` map to specialists that report `available=false` in
 *  this backend (no news feed; Polymarket needs a confirmed mapping). They are
 *  kept as stages because the reference has them and because their absence is
 *  itself the information — a stage that silently vanished would hide a gap. */
const STAGE_NODES: Record<string, string[]> = {
  Ingest: ['market_data', 'market_analysis', 'data_validation'],
  News: ['specialist_news'],
  Polymarket: ['specialist_prediction', 'specialist_event_risk'],
  Indicators: ['technical_analysis', 'compute_indicators'],
  Regime: ['regime_classification', 'market_regime'],
  Signal: ['strategy_candidates', 'strategy_scoring', 'opportunity_detection', 'debate'],
  Risk: ['risk_gateway', 'specialist_risk'],
  Decision: ['supervisor', 'trade_thesis_narrative'],
};

type NewsItem = { title: string; link?: string; source?: string; pubDate?: string | null };

function StageRow({ activeIndex, reached }: { activeIndex: number; reached: number }) {
  return (
    <div className="stepper-row">
      {STAGES.map((s, i) => {
        const done = i < reached;
        const active = i === activeIndex;
        return (
          <div key={s} className="flex items-center">
            <div className={`step-pill${active ? ' active' : ''}`} style={done ? { opacity: 0.55 } : undefined}>
              <div
                className="step-num"
                style={done ? { background: 'var(--positive)', borderColor: 'var(--positive)', color: '#fff' } : undefined}
              >
                {done ? '✓' : String(i + 1).padStart(2, '0')}
              </div>
              <div className="text-[11px]">{s}</div>
            </div>
            {i < STAGES.length - 1 ? <div className="step-connector" /> : null}
          </div>
        );
      })}
    </div>
  );
}

function Provenance({ source, warn = false }: { source: string; warn?: boolean }) {
  return (
    <div
      className="text-[9.5px] mono mb-2 px-1.5 py-0.5 rounded inline-block"
      style={{
        background: `color-mix(in srgb, ${warn ? 'var(--warning)' : 'var(--accent)'} 12%, transparent)`,
        color: warn ? 'var(--warning)' : 'var(--accent)',
      }}
    >
      {source}
    </div>
  );
}

export function LiveAgentInspectorModal({
  symbol,
  strategy,
  onClose,
}: {
  /** `null` closes the modal. */
  symbol: string | null;
  strategy?: string | null;
  onClose: () => void;
}) {
  const nodes = useGraphNodes();
  const feed = useEventFeed({ limit: 40 });
  const news = useBackend<{ items?: NewsItem[] }>(symbol ? '/api/news' : null);
  const snapshots = useBackend<{ snapshots?: Record<string, unknown>[] }>(
    symbol ? BACKEND_PATHS.polymarketSnapshots : null,
    { intervalMs: 30_000 },
  );

  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!symbol) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [symbol, onClose]);

  // Stage progress derived from real node statuses. `reached` counts stages whose
  // nodes have all completed; `active` is the first stage with a RUNNING node.
  const { activeIndex, reached } = useMemo(() => {
    let firstRunning = -1;
    let completed = 0;
    STAGES.forEach((stage, i) => {
      const names = STAGE_NODES[stage] ?? [];
      const states = names.map((n) => nodes[n]?.status).filter(Boolean);
      if (states.includes('RUNNING') && firstRunning === -1) firstRunning = i;
      if (states.length > 0 && states.every((s) => s === 'COMPLETED' || s === 'SKIPPED')) completed = i + 1;
    });
    return { activeIndex: firstRunning, reached: completed };
  }, [nodes]);

  const pmRows: PolymarketCardData[] = useMemo(() => {
    const rows = (snapshots.data?.snapshots ?? []) as Record<string, unknown>[];
    const mine = rows.filter((r) => !symbol || r.symbol === symbol);
    return mine.flatMap((r) => {
      const out: PolymarketCardData[] = [];
      const dir = r.directional as Record<string, unknown> | null | undefined;
      const ev = r.eventRisk as Record<string, unknown> | null | undefined;
      if (dir && typeof dir === 'object') {
        out.push({
          question: String(dir.event ?? 'Directional price market'),
          category: 'Directional',
          yes: null,
          role: 'directional',
          confidence: typeof dir.confidence === 'number' ? dir.confidence : null,
          confirmed: true,
          observation: typeof dir.observation === 'string' ? dir.observation : null,
        });
      }
      if (ev && typeof ev === 'object') {
        out.push({
          question: String(ev.title ?? ev.key ?? 'Event-risk market'),
          category: String(ev.key ?? 'Event'),
          yes: typeof ev.probability === 'number' ? ev.probability : null,
          role: 'event_risk',
          concern: typeof ev.concern === 'number' ? ev.concern : null,
          confirmed: true,
          observation: typeof ev.observation === 'string' ? ev.observation : null,
        });
      }
      return out;
    });
  }, [snapshots.data, symbol]);

  const notApplicable = (snapshots.data?.snapshots ?? []).some(
    (r) => (!symbol || (r as Record<string, unknown>).symbol === symbol) && (r as Record<string, unknown>).applicable === false,
  );

  if (!symbol) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop p-4">
      <div className="card w-full max-w-[1180px] max-h-[88vh] flex flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 p-4 border-b hairline shrink-0">
          <div>
            <div className="flex items-center gap-2">
              <span className="live-dot" aria-hidden />
              <span className="text-[14px] font-semibold">Live Agent Activity — {symbol}</span>
            </div>
            <div className="text-[11.5px] mt-1" style={{ color: 'var(--text-secondary)' }}>
              {strategy ?? 'No strategy selected'} · stages below track real graph nodes
            </div>
          </div>
          <button type="button" className="chip" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="p-4 border-b hairline shrink-0 overflow-x-auto">
          <StageRow activeIndex={activeIndex} reached={reached} />
          {activeIndex === -1 && reached === 0 ? (
            <div className="text-[11px] mt-2" style={{ color: 'var(--text-muted)' }}>
              No graph node is running. Stages fill in from the live stream when a cycle starts —
              they are not animated on a timer.
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto p-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* ---- News ---- */}
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
              Reading News
            </div>
            <Provenance source="app/api/news · public RSS · unfiltered" warn />
            {news.state === 'unreachable' ? (
              <NotAvailable what="News feed" reason="the /api/news route did not respond" compact />
            ) : (news.data?.items ?? []).length === 0 ? (
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {news.state === 'loading' ? 'Loading headlines…' : 'No headlines returned.'}
              </div>
            ) : (
              <>
                <div className="live-scroll" style={{ maxHeight: 320 }}>
                  {(news.data?.items ?? []).slice(0, 8).map((n, i) => (
                    <div key={i} className="news-item neu">
                      <div className="text-[10.5px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
                        {n.source ?? 'unknown source'}
                      </div>
                      <div className="text-[12px] leading-snug">{n.title}</div>
                    </div>
                  ))}
                </div>
                {/* The reference shows a sentiment badge and a relevance gauge per
                    headline. Both are omitted: the feed carries neither, and no
                    backend node scores them. */}
                <div className="text-[10px] mt-2 leading-relaxed" style={{ color: 'var(--warning)' }}>
                  No sentiment or relevance is shown because none is computed — this feed is
                  not per-asset filtered and no backend node scores headlines. Nothing in{' '}
                  <span className="mono">backend/</span> consumes it.
                </div>
              </>
            )}
          </div>

          {/* ---- Polymarket ---- */}
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
              Reading Polymarket
            </div>
            <Provenance source="/api/polymarket/snapshots · live" />
            {snapshots.state === 'unreachable' ? (
              <NotAvailable what="Polymarket snapshots" reason="the backend did not respond" compact />
            ) : pmRows.length === 0 ? (
              <div className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {notApplicable
                  ? 'No confirmed Polymarket mapping for this symbol, so the feed contributes nothing here — and costs the panel nothing either.'
                  : 'No prediction-market reading this cycle.'}
              </div>
            ) : (
              <div className="space-y-2 live-scroll" style={{ maxHeight: 320 }}>
                {pmRows.map((r, i) => (
                  <PolymarketCard key={i} data={r} compact />
                ))}
              </div>
            )}
          </div>

          {/* ---- Market condition ---- */}
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-wider mb-1" style={{ color: 'var(--text-muted)' }}>
              Market Condition
            </div>
            <Provenance source="specialist findings · live graph state" />
            <div className="space-y-2.5">
              {Object.values(nodes)
                .filter((n) => n.name.startsWith('specialist_'))
                .map((n) => (
                  <div key={n.name}>
                    <div className="analysis-bar-label">
                      <span>{n.name.replace('specialist_', '')}</span>
                      <span className="mono" style={{ color: 'var(--text-secondary)' }}>
                        {n.status}
                      </span>
                    </div>
                    <Gauge
                      pct={n.status === 'COMPLETED' ? 100 : n.status === 'RUNNING' ? 50 : null}
                      color={n.status === 'FAILED' ? 'var(--negative)' : 'var(--accent)'}
                      unavailableReason={`${n.name} has not reported this cycle`}
                    />
                  </div>
                ))}
              {Object.keys(nodes).length === 0 ? (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  No node has reported yet. This panel fills in from the live stream.
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {/* ---- Console ---- */}
        <div className="border-t hairline shrink-0" style={{ background: 'var(--bg-surface-2)' }}>
          <div className="flex items-center justify-between px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
                Live Agent Console
              </span>
              <Badge state="INFO" label="node-level" title={NODE_LEVEL_ONLY} />
            </div>
            <button type="button" className="chip" onClick={() => setPaused((p) => !p)}>
              {paused ? 'Resume' : 'Pause'}
            </button>
          </div>

          <div className="px-4 pb-3 max-h-[160px] overflow-y-auto font-mono text-[11px] space-y-0.5">
            {feed.length === 0 ? (
              <div style={{ color: 'var(--text-muted)' }}>
                No events yet. {NODE_LEVEL_ONLY}
              </div>
            ) : (
              (paused ? feed.slice(0, 1) : feed).map((e, i) => (
                <div key={i} className="log-line flex gap-2">
                  <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                    {typeof e.timestamp === 'string' ? e.timestamp.slice(11, 19) : '--:--:--'}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {String(e.event_type)}
                    {typeof e.symbol === 'string' ? ` · ${e.symbol}` : ''}
                    {typeof e.detail === 'string' ? ` — ${e.detail}` : ''}
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="px-4 pb-3 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {NODE_LEVEL_ONLY}
          </div>
        </div>
      </div>
    </div>
  );
}
