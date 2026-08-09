'use client';

import { useAutonomousResearch } from './AutonomousResearch';

function timeAgo(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

const ACTION_LABELS: Record<string, string> = {
  'create-hypothesis': 'worth turning into a testable hypothesis',
  'run-backtest': 'worth backtesting',
  'ask-second-opinion': 'worth a second-opinion model',
  'reduce-exposure': 'consider reducing exposure',
};

export function AutonomousResearchPanel() {
  const { latestDigest, latestCuriosity, runNow } = useAutonomousResearch();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-[9.5px] font-mono text-txt2">{latestDigest ? `Last run: ${timeAgo(latestDigest.ts)}` : 'No run yet — first run happens shortly after load.'}</p>
        <button onClick={runNow} className="px-2 py-1 rounded-md text-[10px] font-mono border border-line text-txt1 hover:bg-bg3 transition">
          Run now
        </button>
      </div>

      {!latestDigest ? (
        <p className="text-[11px] text-txt2">No digest yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Trending (24h, your watchlist)</p>
            {latestDigest.trending.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {latestDigest.trending.slice(0, 5).map((t) => (
                  <div key={t.symbol} className="flex justify-between text-[10px] font-mono">
                    <span className="text-txt1">{t.symbol}</span>
                    <span className={t.direction === 'up' ? 'text-green' : 'text-red'}>
                      {t.pctChange >= 0 ? '+' : ''}
                      {t.pctChange.toFixed(1)}%{t.volumeRatio !== null && <span className="text-txt2"> (vol {t.volumeRatio.toFixed(1)}x)</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] font-mono text-txt2">Not enough 24h history cached yet.</p>
            )}
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Category performance (approximate)</p>
            {latestDigest.sectors.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {latestDigest.sectors.map((s) => (
                  <div key={s.category} className="flex justify-between text-[10px] font-mono">
                    <span className="text-txt1">{s.category}</span>
                    <span className={s.avgPctChange >= 0 ? 'text-green' : 'text-red'}>
                      {s.avgPctChange >= 0 ? '+' : ''}
                      {s.avgPctChange.toFixed(1)}% <span className="text-txt2">({s.symbolCount})</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] font-mono text-txt2">Not enough data yet.</p>
            )}
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">Highest historical-edge setups</p>
            {latestDigest.highestEdgeSetups.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                {latestDigest.highestEdgeSetups.map((g) => (
                  <div key={g.group} className="flex justify-between text-[10px] font-mono">
                    <span className="text-txt1">{g.group}</span>
                    <span className="text-amber">
                      {g.winRatePct?.toFixed(0)}% <span className="text-txt2">({g.trades} trades)</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] font-mono text-txt2">Not enough closed trades per origin yet.</p>
            )}
          </div>

          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-txt2 mb-1">What changed overnight</p>
            {latestDigest.overnightChanges.length > 0 ? (
              <div className="flex flex-col gap-1">
                {latestDigest.overnightChanges.map((o) => (
                  <div key={o.symbol} className="text-[9.5px] font-mono">
                    <span className="text-txt1">{o.symbol}</span>
                    {o.pctChange !== null && (
                      <span className={o.pctChange >= 0 ? 'text-green' : 'text-red'}>
                        {' '}
                        ({o.pctChange >= 0 ? '+' : ''}
                        {o.pctChange.toFixed(1)}%)
                      </span>
                    )}
                    {o.events.map((e, i) => (
                      <p key={i} className="text-txt2 pl-2">
                        · {e.detail}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10px] font-mono text-txt2">Nothing notable detected.</p>
            )}
          </div>
        </div>
      )}

      {latestCuriosity && (
        <div className="border-t border-line pt-2">
          <p className="font-mono text-[10px] uppercase tracking-wider text-amber mb-1">Curiosity Engine — self-review</p>
          <div className="flex flex-col gap-1.5">
            {latestCuriosity.findings.map((f, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <p className="text-[9.5px] font-mono text-txt1">{f.question}</p>
                <p className="text-[9.5px] text-txt0">
                  {f.answer ?? <span className="text-txt2 italic">Not answerable from available data yet.</span>}
                </p>
                {f.evidence.slice(0, 3).map((e, j) => (
                  <p key={j} className="text-[8.5px] font-mono text-txt2 pl-2">
                    · {e}
                  </p>
                ))}
                {f.suggestedAction !== 'none' && (
                  <p className="text-[9px] font-mono text-amber pl-2">→ {ACTION_LABELS[f.suggestedAction] ?? f.suggestedAction}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[9.5px] text-txt2">
        Runs automatically every 15 min while this app is open (client-side timer, not a true always-on server cron — no user prompt triggers it).
        Watchlist-scoped, not a global market scanner. Also injected into chat context so the assistant can reference it proactively. Every
        Curiosity answer above is derived only from the real trade log and computed signals — a question with no real data behind it is shown as
        unanswerable rather than filled in.
      </p>
    </div>
  );
}
