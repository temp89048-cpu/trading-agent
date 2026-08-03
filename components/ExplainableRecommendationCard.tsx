'use client';

import type { ExplainableRecommendation } from '@/lib/explainableOutput';
import { isAvailable } from '@/lib/explainableOutput';

function FieldRow({ label, unit, field }: { label: string; unit?: string; field: ExplainableRecommendation['probability'] }) {
  return (
    <div className="flex justify-between items-start text-[10px] font-mono gap-2">
      <span className="text-txt2 shrink-0">{label}</span>
      {isAvailable(field) ? (
        <span className="text-right">
          <span className="text-txt0">
            {field.value.toFixed(unit === 'R' ? 2 : unit === '%' ? 0 : 4)}
            {unit}
          </span>
          <span className="block text-[8.5px] text-txt2">source: {field.source}</span>
        </span>
      ) : (
        <span className="text-right text-txt2 italic">unavailable — {field.reason}</span>
      )}
    </div>
  );
}

export function ExplainableRecommendationCard({ rec }: { rec: ExplainableRecommendation }) {
  return (
    <div className="rounded-md border border-line p-3 flex flex-col gap-2 bg-bg2">
      <p className="text-[9.5px] font-mono uppercase tracking-wider text-txt2">Explainable Recommendation Schema</p>
      <div className="flex flex-col gap-1">
        {rec.reasonBullets.map((b, i) => (
          <p key={i} className="text-[10px] font-mono text-txt1">
            • {b.text} <span className="text-[8.5px] text-txt2">[{b.source}]</span>
          </p>
        ))}
      </div>
      <div className="flex flex-col gap-1 pt-1 border-t border-line">
        <FieldRow label="Probability" unit="%" field={rec.probability} />
        <FieldRow label="Expected value" unit="R" field={rec.expectedR} />
        <FieldRow label="Stop-loss" field={rec.stopLoss} />
        <FieldRow label="Take-profit" field={rec.takeProfit} />
      </div>
      <p className="text-[8.5px] text-txt2">
        Every field above names the real module that computed it — stop-loss/take-profit are never model-invented, always sourced from the Risk Manager's
        ATR + swing-structure calculation.
      </p>
    </div>
  );
}
