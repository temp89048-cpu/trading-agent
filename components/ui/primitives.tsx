// ---------------------------------------------------------------------
// Small shared primitives ported from the reference's helper functions:
// `statCard()`, `fmt()`, `pnlClass()`, `.chip`, `.card`, `table.term`.
//
// Every one of them has an explicit "value is missing" path. The reference's
// helpers assume a number is always there because its data is mock; this
// backend returns `null` for anything it could not measure, and `fmt(null)`
// producing "0.00" would report a measurement that was never taken. `Num`
// renders an em dash instead.
// ---------------------------------------------------------------------

import type { ReactNode } from 'react';

/* ===== Layout ===== */

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={`card ${padded ? 'p-4' : ''} ${className}`}>{children}</div>;
}

export function SectionTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <div
        className="font-mono text-[10.5px] uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {children}
      </div>
      {action}
    </div>
  );
}

/* ===== Numbers ===== */

/** Locale-formatted number, or an em dash when there is nothing to show.
 *
 *  `null` -> "—", never "0.00". A zero and an absent value are different facts
 *  and this app is built on keeping them apart. */
export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function pnlColor(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return 'var(--text-muted)';
  return Number(v) >= 0 ? 'var(--positive)' : 'var(--negative)';
}

/** A monospaced numeric cell. `signed` prefixes a `+` on positives, which is
 *  what makes a P&L column readable at a glance. */
export function Num({
  value,
  digits = 2,
  prefix = '',
  suffix = '',
  colored = false,
  signed = false,
  className = '',
}: {
  value: number | null | undefined;
  digits?: number;
  prefix?: string;
  suffix?: string;
  colored?: boolean;
  signed?: boolean;
  className?: string;
}) {
  const missing = value === null || value === undefined || !Number.isFinite(Number(value));
  const sign = !missing && signed && Number(value) > 0 ? '+' : '';
  return (
    <span
      className={`mono ${className}`}
      style={colored ? { color: pnlColor(value) } : undefined}
    >
      {missing ? '—' : `${sign}${prefix}${fmt(value, digits)}${suffix}`}
    </span>
  );
}

/* ===== Stat card ===== */

export function StatCard({
  label,
  value,
  sub,
  color,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  color?: string;
  mono?: boolean;
}) {
  return (
    <div className="card p-3.5">
      <div
        className="font-mono text-[10.5px] uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--text-muted)' }}
      >
        {label}
      </div>
      <div
        className={`${mono ? 'mono ' : ''}text-[19px] font-semibold leading-none`}
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub ? (
        <div className="text-[11px] mt-1.5" style={{ color: 'var(--text-secondary)' }}>
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/* ===== Chip ===== */

export function Chip({
  children,
  on = false,
  onClick,
  title,
}: {
  children: ReactNode;
  on?: boolean;
  onClick?: () => void;
  title?: string;
}) {
  return (
    <button type="button" className={`chip${on ? ' on' : ''}`} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

/* ===== Table ===== */

export function TermTable({
  columns,
  children,
  empty,
}: {
  /** `num: true` right-aligns the column, per the design rule that every
   *  numeric value is monospaced and right-aligned in tables. */
  columns: { key: string; label: string; num?: boolean }[];
  children: ReactNode;
  /** Rendered instead of the body when there are no rows. Required, because an
   *  empty table with no explanation is the most common way a UI hides the fact
   *  that its data source is unavailable. */
  empty?: ReactNode;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className="overflow-x-auto">
      <table className="term w-full text-[12.5px]">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.num ? 'num' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        {hasRows ? (
          <tbody>{children}</tbody>
        ) : (
          <tbody>
            <tr>
              <td colSpan={columns.length} className="py-6 text-center text-[12px]" style={{ color: 'var(--text-muted)' }}>
                {empty ?? 'No rows.'}
              </td>
            </tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

/* ===== Unavailable notice ===== */

/** The standard way this app says "there is no data source for this yet".
 *
 *  Used instead of an empty panel or a plausible-looking placeholder. The
 *  replacement brief makes this a hard requirement: a page that looks finished
 *  but quietly renders mock data is a failure condition, so every gap gets a
 *  visible, specific reason. */
export function NotAvailable({
  what,
  reason,
  compact = false,
}: {
  what: string;
  reason: string;
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? 'text-[11px] leading-relaxed' : 'card p-4 text-[12px] leading-relaxed'}
      style={{ color: 'var(--text-muted)' }}
    >
      <span
        className="font-mono text-[10px] uppercase tracking-wider mr-2 px-1.5 py-0.5 rounded"
        style={{
          background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
          color: 'var(--warning)',
        }}
      >
        Not available
      </span>
      <span style={{ color: 'var(--text-secondary)' }}>{what}</span> — {reason}
    </div>
  );
}
