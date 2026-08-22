'use client';

// ---------------------------------------------------------------------
// What an unmigrated route renders.
//
// This exists so the shell and navigation can be verified across all 25 routes
// before any page is built, WITHOUT shipping a page that looks finished and
// isn't. The brief calls that out as a failure condition, so the placeholder is
// deliberately unmistakable: it states the route is not built, links to the old
// screen when one exists, and names the backend sources the real page will use
// plus any known gap.
//
// It is not a "coming soon" card. It carries the Phase 7 contract information for
// that route, so the page that replaces it starts from a stated contract rather
// than from a guess.
// ---------------------------------------------------------------------

import Link from 'next/link';

import { Badge } from '@/components/ui/Badge';
import { findRoute } from '@/lib/nav';

export type PlaceholderStatus = 'PLANNED' | 'BLOCKED';

export function RoutePlaceholder({
  href,
  title,
  purpose,
  sources,
  gaps,
  status = 'PLANNED',
}: {
  href: string;
  title: string;
  /** One line on what the finished page shows. */
  purpose: string;
  /** Backend endpoints/events the real page will bind to. */
  sources: string[];
  /** Elements with no backing data today. Rendered explicitly rather than
   *  omitted — an unlisted gap becomes an invisible one. */
  gaps?: string[];
  status?: PlaceholderStatus;
}) {
  const route = findRoute(href);
  const legacy = route?.replacesLegacy;

  return (
    <div className="max-w-[900px]">
      <div className="flex items-center gap-2.5 mb-1">
        <h1 className="text-[17px] font-semibold">{title}</h1>
        <Badge state={status === 'BLOCKED' ? 'BLOCKED' : 'WAITING'} label={status === 'BLOCKED' ? 'Blocked' : 'Not built'} />
      </div>
      <p className="text-[12.5px] mb-4 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {purpose}
      </p>

      <div className="card p-4 mb-3">
        <div
          className="font-mono text-[10.5px] uppercase tracking-wider mb-2"
          style={{ color: 'var(--text-muted)' }}
        >
          Planned backend contract
        </div>
        {sources.length === 0 ? (
          <div className="text-[12px]" style={{ color: 'var(--negative)' }}>
            No backend source exists for this route yet.
          </div>
        ) : (
          <ul className="space-y-1">
            {sources.map((s) => (
              <li key={s} className="mono text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>

      {gaps && gaps.length > 0 ? (
        <div className="card p-4 mb-3">
          <div
            className="font-mono text-[10.5px] uppercase tracking-wider mb-2"
            style={{ color: 'var(--warning)' }}
          >
            Known gaps — will be omitted, not faked
          </div>
          <ul className="space-y-1.5">
            {gaps.map((g) => (
              <li key={g} className="text-[12px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                • {g}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {legacy ? (
        <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          The existing screen for this is still live at{' '}
          <Link href={legacy} className="mono underline" style={{ color: 'var(--accent)' }}>
            {legacy}
          </Link>{' '}
          and stays until this route is verified against the real backend.
        </div>
      ) : null}
    </div>
  );
}
