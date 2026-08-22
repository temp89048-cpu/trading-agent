'use client';

// ---------------------------------------------------------------------
// Sidebar + TopBar + Main, plus the globally-mounted cross-cutting UI.
//
// WHERE THIS SITS IN THE PROVIDER TREE, AND WHY IT MATTERS
//
// `app/layout.tsx` nests 22 providers and the order is load-bearing — CLAUDE.md
// records what has already broken because of it (`Supervisor` sits above
// `AppStateProvider` and therefore cannot call `useAppState()`;
// `AutonomousTrader` sits below `AgentProvider` because it calls `startAgent()`).
//
// This shell is rendered from a route-group layout, i.e. as part of `{children}`,
// which places it BELOW every one of those providers. That is required, not
// incidental: `CommandDrawer` calls `useAppState()` and `TopBar` reads the
// realtime store. Hoisting the shell into `app/layout.tsx` above the providers
// would break the drawer, and restructuring the tree to compensate is the
// single highest-risk change available in this codebase.
//
// Mounted once here, per the brief's "build once, mount globally": TopBar,
// Emergency Stop (inside TopBar), Command Drawer. The Live Agent Inspector is
// mounted by the routes that can open it, since it needs a subject.
// ---------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';

import { ThemeOrbs } from '@/components/ui/Theme';

import { CommandDrawer } from './CommandDrawer';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export function AppShell({ children }: { children: React.ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const openDrawer = useCallback(() => setDrawerOpen(true), []);

  // Cmd/Ctrl+K opens the drawer — the shortcut people reach for without being
  // told. Bound at the shell so it works on every route rather than being
  // re-registered per page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setDrawerOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden relative" style={{ background: 'var(--bg-app)' }}>
      <ThemeOrbs />

      {/* Desktop rail. Below 1024px it becomes an overlay — the reference is
          desktop-only, so the breakpoints are new work rather than a port. */}
      <div className="hidden lg:flex relative z-10">
        <Sidebar />
      </div>

      {sidebarOpen ? (
        <>
          <div
            className="lg:hidden fixed inset-0 z-30 modal-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
          <div className="lg:hidden fixed inset-y-0 left-0 z-40">
            <Sidebar onNavigate={() => setSidebarOpen(false)} />
          </div>
        </>
      ) : null}

      <div className="flex-1 flex flex-col min-w-0 relative z-10">
        <div className="flex items-center lg:hidden border-b hairline" style={{ background: 'var(--bg-surface)' }}>
          <button
            type="button"
            className="chip m-2"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open navigation"
          >
            ☰
          </button>
        </div>

        <TopBar onAskAgent={openDrawer} />

        <main className="flex-1 overflow-y-auto p-4">{children}</main>
      </div>

      <CommandDrawer open={drawerOpen} onClose={closeDrawer} />
    </div>
  );
}
