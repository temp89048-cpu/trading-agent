'use client';

// ---------------------------------------------------------------------
// Theme: Terminal (default) -> Aurora -> Platinum -> Terminal.
//
// The reference sets `data-theme` on `<body>`, and `app/globals.css` selects on
// `body[data-theme=...]`, so this writes the same attribute rather than a class
// on a wrapper div — a wrapper would put the variables one level below `body`
// and `body`'s own background would never re-theme.
//
// WHY THE STORED THEME IS APPLIED IN A LAYOUT EFFECT AND NOT DURING RENDER
//
// The server renders with no knowledge of localStorage, so any theme read
// during render mismatches the server HTML and React logs a hydration error.
// Writing the attribute in `useLayoutEffect` instead means the first paint is
// Terminal (the documented default) and the stored theme lands before the
// browser paints again — no flash, no hydration warning.
// ---------------------------------------------------------------------

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

export const THEMES = ['terminal', 'aurora', 'platinum'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'tradingos.theme';

const LABELS: Record<Theme, string> = {
  terminal: 'Terminal',
  aurora: 'Aurora',
  platinum: 'Platinum',
};

type Ctx = { theme: Theme; setTheme: (t: Theme) => void; cycle: () => void };

const ThemeContext = createContext<Ctx>({
  theme: 'terminal',
  setTheme: () => {},
  cycle: () => {},
});

function apply(theme: Theme) {
  if (typeof document === 'undefined') return;
  // Terminal is `:root`, so it carries NO attribute — matching the reference,
  // where `:root` is the default and only the other two are selected by
  // attribute. Setting `data-theme="terminal"` would work only if globals.css
  // also had a rule for it, and adding one would mean two places to keep in
  // sync for no benefit.
  if (theme === 'terminal') document.body.removeAttribute('data-theme');
  else document.body.setAttribute('data-theme', theme);
}

function isTheme(v: unknown): v is Theme {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('terminal');

  useLayoutEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isTheme(stored)) {
        setThemeState(stored);
        apply(stored);
        return;
      }
    } catch {
      // Private-browsing or a blocked storage partition. Terminal is already
      // applied, so there is nothing to recover from.
    }
    apply('terminal');
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    apply(t);
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // Non-fatal: the theme still applies for this session.
    }
  }, []);

  const cycle = useCallback(() => {
    setThemeState((current) => {
      const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
      apply(next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* see setTheme */
      }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, cycle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const [mounted, setMounted] = useState(false);
  // The label depends on localStorage, so it is only correct after mount.
  // Rendering the real label on the server would reintroduce the mismatch the
  // layout effect exists to avoid.
  useEffect(() => setMounted(true), []);

  return (
    <button
      type="button"
      onClick={cycle}
      title="Cycle theme: Terminal → Aurora → Platinum"
      className="chip"
      style={{ minWidth: 84 }}
    >
      {mounted ? LABELS[theme] : LABELS.terminal}
    </button>
  );
}

/** The ambient background orbs. Their opacity is driven entirely by
 *  `--orb-opacity`, which is `0` in Terminal — so this renders nothing visible
 *  there rather than needing to be conditionally mounted. */
export function ThemeOrbs() {
  return (
    <>
      <div
        className="bg-orb"
        style={{ width: 520, height: 520, left: '-8%', top: '-12%', background: 'var(--accent)' }}
        aria-hidden
      />
      <div
        className="bg-orb"
        style={{ width: 420, height: 420, right: '-6%', top: '6%', background: 'var(--accent-2)' }}
        aria-hidden
      />
    </>
  );
}
