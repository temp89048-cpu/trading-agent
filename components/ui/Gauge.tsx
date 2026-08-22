// ---------------------------------------------------------------------
// ONE horizontal bar, used identically for risk checks, ensemble confidence,
// Polymarket relevance and the Live Inspector's analysis rows — exactly as the
// replacement brief specifies.
//
// THE `null` CASE IS THE REASON THIS IS NOT A ONE-LINER.
//
// The reference's `gauge(pct)` always draws a bar, because its data is mock and
// therefore always present. This backend routinely reports a value it could not
// measure, and the distinction between "measured 0%" and "not measured" is
// enforced end to end — `None` vs `0.0` in the specialists, `unavailable` vs
// `delegated` in the risk manager, `applicable: false` vs `directional: null`
// in the Polymarket snapshots.
//
// A gauge that rendered `null` as an empty track would erase all of that at the
// final step: an empty bar reads as "measured, and it is zero". So `pct === null`
// renders a visibly different, labelled state instead.
// ---------------------------------------------------------------------

export function Gauge({
  pct,
  color = 'var(--accent)',
  label,
  value,
  unavailableReason,
  height = 6,
}: {
  /** 0–100. `null`/`undefined` means NOT MEASURED — rendered as such. */
  pct: number | null | undefined;
  color?: string;
  /** Left-hand caption. When present the label row renders above the bar. */
  label?: string;
  /** Right-hand value text. Defaults to the rounded percentage. */
  value?: string;
  /** Shown as a tooltip on the unmeasured state. */
  unavailableReason?: string;
  height?: number;
}) {
  const measured = typeof pct === 'number' && Number.isFinite(pct);
  const clamped = measured ? Math.max(0, Math.min(100, pct as number)) : 0;

  const bar = measured ? (
    <div className="gauge-track" style={{ height }}>
      <div style={{ width: `${clamped}%`, height: '100%', background: color }} />
    </div>
  ) : (
    // A dashed, empty track — deliberately unlike a 0% fill, which is a
    // measurement. `title` carries the reason so hovering explains it.
    <div
      className="gauge-track"
      style={{
        height,
        background: 'transparent',
        border: '1px dashed var(--border-strong)',
        boxSizing: 'border-box',
      }}
      title={unavailableReason ?? 'not measured'}
    />
  );

  if (!label && value === undefined) return bar;

  return (
    <div>
      <div className="analysis-bar-label">
        {label ? <span>{label}</span> : <span />}
        <span className="mono" style={{ color: 'var(--text-secondary)' }}>
          {value ?? (measured ? `${Math.round(clamped)}%` : '—')}
        </span>
      </div>
      {bar}
    </div>
  );
}
