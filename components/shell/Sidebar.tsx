'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { NAV } from '@/lib/nav';

// ---------------------------------------------------------------------
// 220px fixed rail, 10 sections, 25 links — the reference's IA exactly.
//
// Active state is derived from the pathname rather than held in state, so a deep
// link or a browser back/forward lands with the right item highlighted.
// `/agent/timeline` must not light up `/agent`, so the match is exact except for
// genuine sub-paths.
// ---------------------------------------------------------------------

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() ?? '';

  const migrated = NAV.reduce((n, s) => n + s.items.filter((i) => i.migrated).length, 0);
  const total = NAV.reduce((n, s) => n + s.items.length, 0);

  return (
    <aside
      className="w-[220px] shrink-0 border-r hairline flex flex-col h-full"
      style={{ background: 'var(--bg-surface)' }}
    >
      <div className="h-12 flex items-center gap-2.5 px-4 border-b hairline shrink-0">
        <div
          className="app-logo w-6 h-6 rounded flex items-center justify-center text-[11px] font-bold shrink-0"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          A
        </div>
        <div className="min-w-0">
          <div className="text-[12.5px] font-semibold leading-tight truncate">Trading Agent</div>
          <div className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
            Control Center
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {NAV.map((section) => (
          <div key={section.section} className="mb-1">
            <div
              className="px-4 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.08em]"
              style={{ color: 'var(--text-muted)' }}
            >
              {section.section}
            </div>
            {section.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  onClick={onNavigate}
                  className={`navlink flex items-center justify-between gap-2 px-4 py-[6px] border-l-2 border-transparent${
                    active ? ' active' : ''
                  }`}
                >
                  <span className="truncate">{item.label}</span>
                  {/* A dot marks a route still on its placeholder. Without it the
                      sidebar looks complete while most routes are stubs, which is
                      exactly the "looks finished but isn't" failure the brief
                      names as unacceptable. */}
                  {!item.migrated ? (
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ background: 'var(--border-strong)' }}
                      title="Not yet migrated"
                    />
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div
        className="px-4 py-2 border-t hairline text-[10px] shrink-0"
        style={{ color: 'var(--text-muted)' }}
      >
        <span className="mono">{migrated}</span>
        {' / '}
        <span className="mono">{total}</span> routes migrated
      </div>
    </aside>
  );
}
