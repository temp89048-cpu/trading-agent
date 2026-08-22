// ---------------------------------------------------------------------
// Information architecture — the reference's `NAV` array, with real hrefs.
//
// Section grouping, order and labels are reproduced exactly, per the brief's
// "reproduce section grouping and labels exactly". The only addition is `href`,
// since the reference is a single page switching `PAGES.<id>` and this is a real
// router.
//
// `migrated` is the migration ledger. It gates what the sidebar marks as ready
// and is the source for the Phase 9 contract table, so there is one list rather
// than a comment somewhere and a table somewhere else that drift apart.
// ---------------------------------------------------------------------

export type NavItem = {
  /** The reference's `PAGES` key, kept so the mapping back to the spec is
   *  traceable when reviewing a page against it. */
  id: string;
  label: string;
  href: string;
  /** false => the route renders the migration placeholder, and the OLD route
   *  (if any) stays live. */
  migrated: boolean;
  /** Set when the old app serves an equivalent screen that must stay reachable
   *  until this route is verified against the real backend. */
  replacesLegacy?: string;
};

export type NavSection = { section: string; items: NavItem[] };

export const NAV: NavSection[] = [
  {
    section: 'Home',
    // `/` now redirects here rather than serving the old single-page terminal, so
    // there is no legacy route left to keep live.
    items: [{ id: 'home', label: 'Home', href: '/home', migrated: true }],
  },
  {
    section: 'Command Center',
    items: [
      // The one route that could not be staged behind a placeholder: Next.js
      // rejects two routes on one path, so `app/dashboard/page.tsx` was deleted in
      // the SAME change that created `app/(terminal)/dashboard/page.tsx`.
      { id: 'dashboard', label: 'Dashboard', href: '/dashboard', migrated: true },
    ],
  },
  {
    section: 'Markets',
    items: [
      { id: 'markets', label: 'Live Markets', href: '/markets', migrated: true },
      { id: 'intel', label: 'Market Intelligence', href: '/intel', migrated: true },
      { id: 'polymarket', label: 'Polymarket Signals', href: '/polymarket', migrated: true },
    ],
  },
  {
    section: 'Trading',
    items: [
      { id: 'positions', label: 'Positions', href: '/positions', migrated: true },
      { id: 'orders', label: 'Orders', href: '/orders', migrated: true },
      { id: 'history', label: 'Trade History', href: '/history', migrated: true, replacesLegacy: '/log' },
      { id: 'execution', label: 'Execution', href: '/execution', migrated: true, replacesLegacy: '/audit' },
    ],
  },
  {
    section: 'Agent',
    items: [
      { id: 'agent', label: 'Agent Brain', href: '/agent', migrated: true, replacesLegacy: '/glassbox' },
      { id: 'decisions', label: 'Decisions', href: '/decisions', migrated: true },
      { id: 'timeline', label: 'Agent Timeline', href: '/agent/timeline', migrated: true },
      { id: 'chat', label: 'Agent Chat', href: '/chat', migrated: true },
    ],
  },
  {
    section: 'Strategies',
    items: [
      { id: 'strategies', label: 'Strategy Center', href: '/strategies', migrated: true },
      { id: 'strategy-perf', label: 'Performance', href: '/strategies/performance', migrated: true },
    ],
  },
  {
    section: 'Risk',
    items: [
      { id: 'risk', label: 'Risk Center', href: '/risk', migrated: true },
      { id: 'exposure', label: 'Exposure', href: '/exposure', migrated: true },
    ],
  },
  {
    section: 'Learning',
    items: [
      { id: 'learning', label: 'Learning Center', href: '/learning', migrated: true },
      { id: 'failures', label: 'Failure Analysis', href: '/learning/failures', migrated: true },
      { id: 'trades', label: 'Trade Analysis', href: '/learning/trades', migrated: true },
      { id: 'replay', label: 'Agent Replay', href: '/replay', migrated: true },
    ],
  },
  {
    section: 'Research',
    items: [
      { id: 'backtest', label: 'Backtesting Lab', href: '/backtesting', migrated: true, replacesLegacy: '/backtest' },
    ],
  },
  {
    section: 'System',
    items: [
      { id: 'system', label: 'System Health', href: '/system', migrated: true },
      { id: 'logs', label: 'Event Logs', href: '/logs', migrated: true },
      { id: 'settings', label: 'Settings', href: '/settings', migrated: true },
    ],
  },
];

export const ALL_ROUTES: NavItem[] = NAV.flatMap((s) => s.items);

export function findRoute(href: string): NavItem | undefined {
  // Longest match first, so `/agent/timeline` is not matched by `/agent`.
  return [...ALL_ROUTES]
    .sort((a, b) => b.href.length - a.href.length)
    .find((r) => href === r.href || href.startsWith(`${r.href}/`));
}
