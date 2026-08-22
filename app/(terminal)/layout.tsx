// ---------------------------------------------------------------------
// Route-group layout for every new-design route.
//
// A ROUTE GROUP, so the parentheses do not appear in any URL: `/home` really is
// `/home`. That matters because the brief specifies exact paths.
//
// WHY THE SHELL IS MOUNTED HERE AND NOT IN `app/layout.tsx`
//
// `app/layout.tsx` nests 22 providers, and the order is load-bearing — CLAUDE.md
// documents what has already broken because of it. Rendering the shell from this
// layout makes it part of that layout's `{children}`, which places it BELOW every
// provider. `CommandDrawer` calls `useAppState()` and only resolves there.
//
// It also means the OLD routes (`/`, `/dashboard`, `/audit`, `/backtest`,
// `/glassbox`, `/log`) keep their own presentation untouched while they are
// migrated one at a time — which is the brief's rule that a route's old page
// stays live until its replacement is verified against the real backend.
// ---------------------------------------------------------------------

import { AppShell } from '@/components/shell/AppShell';
import { ThemeProvider } from '@/components/ui/Theme';

export default function TerminalLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AppShell>{children}</AppShell>
    </ThemeProvider>
  );
}
