import type { Config } from 'tailwindcss';

// ---------------------------------------------------------------------
// Both token vocabularies are exposed on purpose.
//
// `app/globals.css` makes the REFERENCE names the source of truth and aliases
// the old names onto them, so a not-yet-migrated component keeps rendering and
// re-themes with the toggle. This file mirrors that: new utilities for new work,
// old utilities still resolving, and both pointing at the same CSS variables.
//
// The old block goes away when no component references an old name. Until then,
// removing it would break all 73 of them at once — which the replacement brief
// explicitly forbids, since the old route has to stay live until its
// replacement is verified against the real backend.
// ---------------------------------------------------------------------

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ---- Reference design system (use these for all new work) ----
        app: 'var(--bg-app)',
        surface: 'var(--bg-surface)',
        surface2: 'var(--bg-surface-2)',
        border: 'var(--border)',
        borderStrong: 'var(--border-strong)',
        textPrimary: 'var(--text-primary)',
        textSecondary: 'var(--text-secondary)',
        textMuted: 'var(--text-muted)',
        accent: 'var(--accent)',
        accent2: 'var(--accent-2)',
        positive: 'var(--positive)',
        negative: 'var(--negative)',
        warning: 'var(--warning)',

        // ---- Legacy aliases (see header) ----
        bg0: 'var(--bg-0)',
        bg1: 'var(--bg-1)',
        bg2: 'var(--bg-2)',
        bg3: 'var(--bg-3)',
        line: 'var(--line)',
        amber: 'var(--amber)',
        amberDim: 'var(--amber-dim)',
        cyan: 'var(--cyan)',
        green: 'var(--green)',
        red: 'var(--red)',
        txt0: 'var(--txt-0)',
        txt1: 'var(--txt-1)',
        txt2: 'var(--txt-2)',
      },
      fontFamily: {
        // The reference uses IBM Plex Mono first and falls back to JetBrains
        // Mono, which is what the app already loads. Both listed so a machine
        // with either renders the intended face, and `tabular-nums` (set on
        // `.mono` in globals.css) keeps table columns aligned regardless.
        mono: ['IBM Plex Mono', 'JetBrains Mono', 'ui-monospace', 'monospace'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};

export default config;
