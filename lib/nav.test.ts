// The IA is the brief's Phase 2 contract, so it gets asserted rather than eyeballed.
//
// The check that earns its place is "every route in NAV has a page file". A link in
// the sidebar pointing at a route that does not exist is a 404 the sidebar itself
// makes look intentional — and with 25 routes generated from a table, one typo in
// either place produces exactly that.
//
// The migration is now COMPLETE, so this file's job has changed: it used to assert
// which routes were still placeholders, and now it asserts that none are, that no
// legacy duplicate of a migrated screen survives, and that the panels relocated out
// of the deleted sidebar are all still mounted somewhere.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALL_ROUTES, findRoute, NAV } from './nav';

const ROOT = path.resolve(__dirname, '..');
const GROUP = path.join(ROOT, 'app', '(terminal)');

const pageFor = (href: string) => path.join(GROUP, href.replace(/^\//, ''), 'page.tsx');

describe('navigation structure', () => {
  it('has the reference file\'s 10 sections in order', () => {
    expect(NAV.map((s) => s.section)).toEqual([
      'Home',
      'Command Center',
      'Markets',
      'Trading',
      'Agent',
      'Strategies',
      'Risk',
      'Learning',
      'Research',
      'System',
    ]);
  });

  it('declares all 25 routes', () => {
    expect(ALL_ROUTES).toHaveLength(25);
  });

  it('has no duplicate hrefs or ids', () => {
    expect(new Set(ALL_ROUTES.map((r) => r.href)).size).toBe(25);
    expect(new Set(ALL_ROUTES.map((r) => r.id)).size).toBe(25);
  });

  it('has a page file for every route', () => {
    const missing = ALL_ROUTES.filter((r) => !fs.existsSync(pageFor(r.href))).map((r) => r.href);
    expect(missing).toEqual([]);
  });

  it('serves /dashboard from exactly one place', () => {
    // Next.js rejects two routes on one path, so the legacy page had to be deleted
    // in the same change that created the replacement — this is the only route in
    // the 25 that could not be staged behind a placeholder first.
    expect(fs.existsSync(pageFor('/dashboard'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'app', 'dashboard', 'page.tsx'))).toBe(false);
  });

  it('redirects / to /home rather than 404ing it', () => {
    // `/` is the URL people bookmark and the one a bare host resolves to. Deleting
    // `app/page.tsx` outright would make it a 404.
    const root = fs.readFileSync(path.join(ROOT, 'app', 'page.tsx'), 'utf8');
    expect(root).toContain("redirect('/home')");
  });

  it('resolves the longest matching route so a sub-path does not match its parent', () => {
    // `/agent/timeline` must not resolve to `/agent`, or the sidebar highlights the
    // wrong item and a future breadcrumb names the wrong page.
    expect(findRoute('/agent/timeline')?.id).toBe('timeline');
    expect(findRoute('/agent')?.id).toBe('agent');
    expect(findRoute('/strategies/performance')?.id).toBe('strategy-perf');
    expect(findRoute('/strategies')?.id).toBe('strategies');
    expect(findRoute('/learning/failures')?.id).toBe('failures');
    // The trade-detail route is not a nav item, but it must still resolve to
    // `/history` so the sidebar highlights Trade History while it is open.
    expect(findRoute('/history/abc123')?.id).toBe('history');
  });
});

describe('migration ledger', () => {
  it('marks every one of the 25 routes as migrated', () => {
    // Asserted as an explicit list rather than a count, so flipping a flag without
    // building the page fails on the pairing with the next two tests.
    expect(ALL_ROUTES.filter((r) => r.migrated).map((r) => r.href).sort()).toEqual([
      '/agent',
      '/agent/timeline',
      '/backtesting',
      '/chat',
      '/dashboard',
      '/decisions',
      '/execution',
      '/exposure',
      '/history',
      '/home',
      '/intel',
      '/learning',
      '/learning/failures',
      '/learning/trades',
      '/logs',
      '/markets',
      '/orders',
      '/polymarket',
      '/positions',
      '/replay',
      '/risk',
      '/settings',
      '/strategies',
      '/strategies/performance',
      '/system',
    ]);
  });

  it('has no route still rendering the placeholder', () => {
    // The failure this catches: a flag flipped to `true` while the file still
    // renders `RoutePlaceholder`, so the sidebar drops its "not migrated" dot and
    // the route looks finished when it is not.
    for (const route of ALL_ROUTES) {
      const src = fs.readFileSync(pageFor(route.href), 'utf8');
      expect(src, route.href).not.toContain('RoutePlaceholder');
    }
  });

  it('has no mock-data marker anywhere in the new routes', () => {
    // The brief's hard failure condition.
    for (const route of ALL_ROUTES) {
      const src = fs.readFileSync(pageFor(route.href), 'utf8');
      expect(src, route.href).not.toContain('TODO: REMOVE MOCK DATA');
    }
  });

  it('retired the legacy page behind every route that claims to replace one', () => {
    // The ledger's meaning INVERTED once a route landed. While a route was a
    // placeholder, its legacy page had to still exist; now that all 25 are real, a
    // surviving legacy page would be a second implementation of the same screen
    // — two pages that can disagree about whether a trade happened.
    for (const route of ALL_ROUTES.filter((r) => r.replacesLegacy)) {
      const dir = route.replacesLegacy!.replace(/^\//, '');
      expect(
        fs.existsSync(path.join(ROOT, 'app', dir, 'page.tsx')),
        `${route.replacesLegacy} still exists alongside its replacement ${route.href}`,
      ).toBe(false);
    }
  });

  it('deleted the old single-page sidebar and its four routes', () => {
    for (const p of [
      path.join(ROOT, 'components', 'TradingSidebar.tsx'),
      path.join(ROOT, 'app', 'log', 'page.tsx'),
      path.join(ROOT, 'app', 'log', '[id]', 'page.tsx'),
      path.join(ROOT, 'app', 'audit', 'page.tsx'),
      path.join(ROOT, 'app', 'glassbox', 'page.tsx'),
      path.join(ROOT, 'app', 'backtest', 'page.tsx'),
    ]) {
      expect(fs.existsSync(p), `${p} should be deleted`).toBe(false);
    }
  });

  it('kept a trade-detail route, which /log/[id] was the only home for', () => {
    // Deleting `app/log/` without this would have removed the structured
    // reflection, its regenerate control, the per-trade HypothesisPanel and the
    // delete — four things the history table cannot show inline.
    const file = path.join(GROUP, 'history', '[id]', 'page.tsx');
    expect(fs.existsSync(file)).toBe(true);
    const src = fs.readFileSync(file, 'utf8');
    expect(src).toContain('HypothesisPanel');
    expect(src).toContain('useReflection');
    expect(src).toContain('deleteTradeLogEntry');
  });
});

describe('relocated operator panels', () => {
  // The regression this exists to prevent: `/` redirecting to `/home` made all 31
  // panels the deleted sidebar mounted unreachable. Each is now mounted on the
  // route whose subject it belongs to. If one is dropped in a future edit, this
  // fails by name rather than being noticed months later by a user who cannot find
  // the control any more.
  const PANELS = [
    'WatchlistEditor',
    'PaperTradePanel',
    'RealPortfolioPanel',
    'TradeLogPanel',
    'RiskMeter',
    'PortfolioStats',
    'PortfolioAnalytics',
    'NewsPanel',
    'ChartModal',
    'AgentPanel',
    'MTFBadges',
    'LiquidityVolumePanel',
    'OrderFlowPanel',
    'StrategyEnsemblePanel',
    'RiskManagerPanel',
    'MarketIntelPanel',
    'PolymarketPanel',
    'MultiExchangePanel',
    'PortfolioIntelligencePanel',
    'EventDetectionPanel',
    'SystemHealthPanel',
    'MemoryPanel',
    'DebatePanel',
    'AutonomousResearchPanel',
    'TradingControlsPanel',
    'ExchangeConnectionsPanel',
    'AgentOSPanel',
    'MissionPlannerPanel',
    'AutonomousTraderPanel',
    // From the deleted Glass-Box route.
    'AgentActivityTerminal',
    'DebateVisualizer',
    'TradeHistoryTable',
    // From the deleted /backtest route — the optimizer especially, since an
    // earlier draft of /backtesting dropped it.
    'BacktestPanel',
    'OptimizerPanel',
    'HypothesisPanel',
  ];

  /** Every source file that can mount a panel: the new pages and the wrappers. */
  const sources = (() => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.tsx')) out.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(GROUP);
    walk(path.join(ROOT, 'components', 'operator'));
    return out;
  })();

  it('mounts every panel the deleted sidebar and legacy routes hosted', () => {
    const unmounted = PANELS.filter(
      (name) => !sources.some((src) => src.includes(`<${name} `) || src.includes(`<${name}/>`) || src.includes(`<${name}>`)),
    );
    expect(unmounted).toEqual([]);
  });
});
