import { PROMPT_CHIPS } from '@/lib/constants';

export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 gap-6 rise">
      <div className="font-mono text-3xl font-bold tracking-widest flex items-center gap-2">
        <span className="text-amber">QUANT</span>
        <span className="text-txt2">//</span>
      </div>
      <p className="max-w-md text-sm text-txt1">
        Ask about strategy, risk, or market structure. Nothing here is financial advice.
      </p>
      <div className="flex flex-wrap justify-center gap-2 max-w-2xl">
        {PROMPT_CHIPS.map((p) => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="px-3 py-1.5 rounded-full text-xs font-mono border transition border-line bg-bg2 text-txt1 hover:border-amberDim hover:text-txt0"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
