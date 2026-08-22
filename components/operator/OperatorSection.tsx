'use client';

// ---------------------------------------------------------------------
// The container every operator panel is mounted in.
//
// WHY THIS EXISTS AT ALL
//
// The old root route was one page hosting `TradingSidebar`, which mounted 31 real
// operator panels — placing a paper trade, editing the watchlist, configuring risk
// limits, starting the autonomous trader, creating a Mission, connecting an
// exchange. Redirecting `/` to `/home` made every one of them unreachable.
//
// Those panels are not mock-ups and not legacy: they are framework-native React
// components already wired to the live providers and the real stores. Rebuilding
// them from scratch would have thrown away working, tested behaviour and replaced
// it with a second implementation that could disagree with the first about whether
// a trade was placed. So they are MOUNTED, each on the route whose subject it
// belongs to, rather than reimplemented or dropped.
//
// They use the OLD design tokens (`bg1`, `txt2`, `amber`, `line`). That is why
// `app/globals.css` keeps an alias layer mapping the 13 old token names onto the
// new ones — the panels inherit whichever of the three themes is active without a
// single edit to their markup.
// ---------------------------------------------------------------------

import type { ReactNode } from 'react';

import { Card, SectionTitle } from '@/components/ui/primitives';

export function OperatorSection({
  title,
  note,
  action,
  children,
}: {
  title: string;
  /** What this control does and what it writes to. Shown small, under the title. */
  note?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <SectionTitle action={action}>{title}</SectionTitle>
      {note ? (
        <div className="text-[10.5px] mb-2.5 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {note}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

/** Paper/real switch, for the panels that take a `tab` prop. */
export function TabSwitch({
  tab,
  onChange,
}: {
  tab: 'paper' | 'real';
  onChange: (t: 'paper' | 'real') => void;
}) {
  return (
    <span className="flex gap-1.5">
      {(['paper', 'real'] as const).map((t) => (
        <button key={t} type="button" className={`chip${tab === t ? ' on' : ''}`} onClick={() => onChange(t)}>
          {t}
        </button>
      ))}
    </span>
  );
}
