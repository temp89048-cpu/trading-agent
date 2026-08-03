'use client';

import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { usePortfolio } from '@/components/Portfolio';
import { useReflection } from '@/components/Reflection';

export default function TradeDetailPage({ params }: { params: { id: string } }) {
  const { tradeLog, deleteTradeLogEntry } = usePortfolio();
  const { getReflection, isGenerating, regenerate } = useReflection();
  const router = useRouter();
  const trade = tradeLog.find((t) => t.id === params.id);
  const reflection = trade ? getReflection(trade.id) : undefined;
  const generating = trade ? isGenerating(trade.id) : false;

  function handleDelete() {
    if (!trade) return;
    if (confirm(`Delete this ${trade.side} ${trade.symbol} log entry? This can't be undone.`)) {
      deleteTradeLogEntry(trade.id);
      router.push(`/log?tab=${trade.tab}`);
    }
  }

  return (
    <div className="min-h-screen bg-bg0 text-txt0">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-line bg-bg1 sticky top-0 z-10">
        <button onClick={() => router.back()} className="p-1.5 rounded-md hover:bg-bg3 transition text-txt1" title="Back">
          <Icon name="chevron-down" size={18} className="rotate-90" />
        </button>
        <span className="font-mono text-sm font-semibold">Trade Detail</span>
      </header>

      <main className="max-w-xl mx-auto px-4 py-8">
        {!trade ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-txt2">No trade found with that ID — it may have been from a different browser/device (trade logs are stored locally, not synced).</p>
            <button onClick={() => router.push('/log')} className="self-start px-3 py-1.5 rounded-md text-xs font-mono bg-amber text-black">
              Back to Trade Log
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-3">
              <span
                className="px-2.5 py-1 rounded-md text-xs font-mono font-bold uppercase"
                style={{ background: trade.side === 'buy' ? 'rgba(62,207,122,0.15)' : 'rgba(239,90,90,0.15)', color: trade.side === 'buy' ? 'var(--green)' : 'var(--red)' }}
              >
                {trade.side}
              </span>
              <h1 className="text-2xl font-mono font-bold">{trade.symbol}</h1>
            </div>

            <div className="grid grid-cols-2 gap-4 rounded-lg border border-line bg-bg1 p-4">
              <DetailRow label="Tab" value={trade.tab === 'paper' ? 'Paper Trading' : 'Real Ledger'} />
              <DetailRow label="Quantity" value={trade.qty.toString()} />
              <DetailRow label="Price" value={`$${trade.price.toLocaleString(undefined, { maximumFractionDigits: 8 })}`} />
              <DetailRow label="Total Value" value={`$${(trade.qty * trade.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
              {typeof trade.pnl === 'number' && (
                <DetailRow
                  label="Realized P&L"
                  value={`${trade.pnl >= 0 ? '+' : '−'}$${Math.abs(trade.pnl).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                  valueColor={trade.pnl >= 0 ? 'var(--green)' : 'var(--red)'}
                />
              )}
              <DetailRow label="Timestamp" value={new Date(trade.ts).toLocaleString()} />
              <DetailRow label="Trade ID" value={trade.id} mono />
            </div>

            {trade.note && (
              <div className="rounded-lg border border-line bg-bg1 p-4">
                <p className="text-[11px] font-mono uppercase tracking-wider text-txt2 mb-1">Note</p>
                <p className="text-sm text-txt0">{trade.note}</p>
              </div>
            )}

            {typeof trade.pnl === 'number' && (
              <div className="rounded-lg border border-line bg-bg1 p-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[11px] font-mono uppercase tracking-wider text-txt2">AI Reflection</p>
                  <button
                    onClick={() => regenerate(trade.id)}
                    disabled={generating}
                    className="px-2 py-1 rounded-md text-[10px] font-mono border border-line text-txt1 hover:bg-bg3 transition disabled:opacity-50"
                  >
                    {generating ? 'Generating…' : reflection ? 'Regenerate' : 'Generate'}
                  </button>
                </div>
                {reflection ? (
                  <div className="flex flex-col gap-2">
                    {reflection.sections && (reflection.sections.whyOutcome || reflection.sections.failedSignal || reflection.sections.earlierExit || reflection.sections.confidenceAssessment || reflection.sections.lesson) ? (
                      <div className="flex flex-col gap-2">
                        {reflection.sections.whyOutcome && (
                          <p className="text-sm text-txt0"><span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Why:</span>{reflection.sections.whyOutcome}</p>
                        )}
                        {reflection.sections.failedSignal && (
                          <p className="text-sm text-txt0"><span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Failed signal:</span>{reflection.sections.failedSignal}</p>
                        )}
                        {reflection.sections.earlierExit && (
                          <p className="text-sm text-txt0"><span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Earlier exit?:</span>{reflection.sections.earlierExit}</p>
                        )}
                        {reflection.sections.confidenceAssessment && (
                          <p className="text-sm text-txt0"><span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Confidence too high?:</span>{reflection.sections.confidenceAssessment}</p>
                        )}
                        {reflection.sections.lesson && (
                          <p className="text-sm text-amber"><span className="font-mono text-[10px] uppercase tracking-wider text-txt2 mr-1">Lesson:</span>{reflection.sections.lesson}</p>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-txt0 whitespace-pre-wrap">{reflection.content}</p>
                    )}
                    {reflection.finishReason === 'length' && (
                      <p className="text-[10px] font-mono text-amber">⚠ Response was cut off at the model's token limit — may be incomplete.</p>
                    )}
                    <details className="text-[10px] font-mono text-txt2">
                      <summary className="cursor-pointer">Context used</summary>
                      <p className="mt-1">Entry: {reflection.entryContextUsed ?? 'not captured for this trade'}</p>
                      <p className="mt-1">Exit: {reflection.exitContextUsed}</p>
                    </details>
                    <p className="text-[9.5px] text-txt2">
                      Advisory only — read/analysis, never re-fed into trade execution.
                    </p>
                  </div>
                ) : generating ? (
                  <p className="text-[11px] text-txt2">Analyzing this trade's entry/exit context…</p>
                ) : (
                  <p className="text-[11px] text-txt2">No reflection yet — click Generate, or it will run automatically shortly.</p>
                )}
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                onClick={() => router.push(`/log?tab=${trade.tab}`)}
                className="px-3 py-1.5 rounded-md text-xs font-mono border border-line text-txt1 hover:bg-bg3 transition"
              >
                ← Back to {trade.tab} trade log
              </button>
              <button onClick={handleDelete} className="px-3 py-1.5 rounded-md text-xs font-mono border border-line text-red hover:bg-bg3 transition">
                Delete entry
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function DetailRow({ label, value, mono, valueColor }: { label: string; value: string; mono?: boolean; valueColor?: string }) {
  return (
    <div>
      <p className="text-[10px] font-mono uppercase tracking-wider text-txt2">{label}</p>
      <p className={`text-sm ${mono ? 'font-mono text-[11px] break-all' : ''}`} style={{ color: valueColor ?? 'var(--txt-0)' }}>
        {value}
      </p>
    </div>
  );
}
