'use client';

// ---------------------------------------------------------------------
// Resolve design tokens to concrete colour strings.
//
// WHY THIS IS NEEDED AT ALL
//
// Everything in this design system is a CSS custom property, which is what makes
// three themes possible from one stylesheet. But a canvas/WebGL library cannot
// consume `var(--positive)` — lightweight-charts wants `#16C784`. So anything
// drawing outside the DOM has to read the computed value.
//
// AND WHY IT RE-READS ON THEME CHANGE
//
// A one-shot read at mount would freeze the chart on whichever theme happened to
// be active when it mounted, so switching to Platinum would leave a blue chart on
// a gold page. `useTheme()` is in the dependency list so every consumer
// re-resolves and redraws.
//
// The fallbacks are Terminal's values. They matter for the first paint before
// the stylesheet has applied and for a server render, where `getComputedStyle`
// does not exist — a chart that briefly drew with empty colour strings would
// render invisible series rather than merely mistimed ones.
// ---------------------------------------------------------------------

import { useEffect, useState } from 'react';

import { useTheme } from './Theme';

export type ThemeColors = {
  app: string;
  surface: string;
  surface2: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accent2: string;
  positive: string;
  negative: string;
  warning: string;
};

const TOKENS: Record<keyof ThemeColors, string> = {
  app: '--bg-app',
  surface: '--bg-surface',
  surface2: '--bg-surface-2',
  border: '--border',
  borderStrong: '--border-strong',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  accent: '--accent',
  accent2: '--accent-2',
  positive: '--positive',
  negative: '--negative',
  warning: '--warning',
};

/** Terminal's values, used for SSR and the first paint. */
const FALLBACK: ThemeColors = {
  app: '#0A0B0D',
  surface: '#111318',
  surface2: '#16181F',
  border: '#23262E',
  borderStrong: '#2E323C',
  textPrimary: '#E7E9EE',
  textSecondary: '#8A8F9C',
  textMuted: '#5B606B',
  accent: '#3B82F6',
  accent2: '#3B82F6',
  positive: '#16C784',
  negative: '#EA3943',
  warning: '#F0B90B',
};

function resolve(): ThemeColors {
  if (typeof window === 'undefined' || typeof getComputedStyle === 'undefined') return FALLBACK;

  const style = getComputedStyle(document.body);
  const out = { ...FALLBACK };
  for (const [key, token] of Object.entries(TOKENS) as [keyof ThemeColors, string][]) {
    const value = style.getPropertyValue(token).trim();
    // Only overwrite on a non-empty read. An empty string here would set the
    // colour to "" and the series would draw as invisible — worse than a
    // slightly-wrong palette.
    if (value) out[key] = value;
  }
  return out;
}

export function useThemeColors(): ThemeColors {
  const { theme } = useTheme();
  const [colors, setColors] = useState<ThemeColors>(FALLBACK);

  useEffect(() => {
    // A frame after the theme attribute lands, so the computed values are the
    // new theme's rather than the outgoing one's.
    const id = requestAnimationFrame(() => setColors(resolve()));
    return () => cancelAnimationFrame(id);
  }, [theme]);

  return colors;
}
