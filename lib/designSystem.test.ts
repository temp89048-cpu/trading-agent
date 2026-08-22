// Design-system invariants.
//
// No DOM environment is configured for vitest here, so these assert against the
// SOURCE — which is the right level anyway for the two rules that matter:
//
//   1. the alias layer is complete, because a missing alias silently breaks one of
//      73 not-yet-migrated components and nothing type-checks it;
//   2. tints use `color-mix()`, not concatenated hex+alpha — the reference fixed
//      that bug deliberately and the brief says not to reintroduce it.

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'app', 'globals.css'), 'utf8');
const TW = fs.readFileSync(path.join(ROOT, 'tailwind.config.ts'), 'utf8');
/** Source with comments removed.
 *
 *  EVERY source-text check below must use this, and the reason is that the naive
 *  version of the concatenated-hex check *failed on the comment warning against
 *  concatenated hex* — the string `var(--accent) + '18'` appears in Badge.tsx only
 *  as an example of what not to do.
 *
 *  That is the fifth time in this project a text search matched the prose
 *  documenting a rule rather than a breach of it. On the Python side the fix was
 *  to switch every such check to AST; there is no cheap AST here, so comments are
 *  stripped instead. A check that cannot tell a warning from a violation trains
 *  authors to delete the warning. */
function code(file: string): string {
  return fs
    .readFileSync(path.join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const BADGE = code('components/ui/Badge.tsx');
const GAUGE = code('components/ui/Gauge.tsx');
const THEME = code('components/ui/Theme.tsx');

const REFERENCE_TOKENS = [
  '--bg-app',
  '--bg-surface',
  '--bg-surface-2',
  '--border',
  '--border-strong',
  '--text-primary',
  '--text-secondary',
  '--text-muted',
  '--accent',
  '--accent-2',
  '--positive',
  '--negative',
  '--warning',
  '--card-bg-img',
  '--glow',
  '--header-grad',
  '--orb-opacity',
];

// Every token the 73 existing components reach for through Tailwind.
const LEGACY_TOKENS = [
  '--bg-0', '--bg-1', '--bg-2', '--bg-3', '--line',
  '--txt-0', '--txt-1', '--txt-2',
  '--cyan', '--amber', '--amber-dim', '--green', '--red',
];

describe('themes', () => {
  it('defines all three, with Terminal on :root', () => {
    expect(CSS).toMatch(/:root\s*\{/);
    expect(CSS).toContain("body[data-theme='aurora']");
    expect(CSS).toContain("body[data-theme='platinum']");
  });

  it('declares every reference token in all three themes', () => {
    const blocks = {
      terminal: CSS.slice(CSS.indexOf(':root {'), CSS.indexOf("body[data-theme='aurora']")),
      aurora: CSS.slice(CSS.indexOf("body[data-theme='aurora'] {"), CSS.indexOf("body[data-theme='platinum']")),
      platinum: CSS.slice(CSS.indexOf("body[data-theme='platinum'] {")),
    };
    for (const [name, block] of Object.entries(blocks)) {
      for (const token of REFERENCE_TOKENS) {
        expect(block, `${name} is missing ${token}`).toContain(`${token}:`);
      }
    }
  });

  it('keeps the reference\'s exact accent values', () => {
    expect(CSS).toContain('#3B82F6'); // Terminal
    expect(CSS).toContain('#7C6FE0'); // Aurora
    expect(CSS).toContain('#C9A961'); // Platinum champagne gold
    expect(CSS).toContain('#E8CE8E'); // Platinum gradient end
  });

  it('keeps Aurora and Platinum ambient values toned down', () => {
    // The brief is explicit: Aurora's orb is .28 and Platinum's is .10, both already
    // reduced from an earlier over-saturated version. Re-intensifying is called out
    // as a regression, so the numbers are pinned.
    expect(CSS).toMatch(/--orb-opacity:\s*0?\.28/);
    expect(CSS).toMatch(/--orb-opacity:\s*0?\.10/);
  });

  it('gives Terminal no ambient gradient', () => {
    // "No gradients, no glow" is the theme, not a default that happens to apply.
    const terminal = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf("body[data-theme='aurora']"));
    expect(terminal).toMatch(/--body-grad:\s*none/);
    expect(terminal).toMatch(/--glow:\s*none/);
    expect(terminal).toMatch(/--orb-opacity:\s*0;/);
  });
});

describe('alias layer', () => {
  it('maps every legacy token onto a reference token', () => {
    // A missing alias breaks one of 73 unmigrated components with no type error and
    // no test failure anywhere else — it just renders the wrong colour, or none.
    for (const token of LEGACY_TOKENS) {
      const re = new RegExp(`${token}:\\s*var\\(--[a-z0-9-]+\\)`);
      expect(CSS, `${token} is not aliased`).toMatch(re);
    }
  });

  it('exposes both vocabularies through Tailwind', () => {
    for (const name of ['surface2', 'textMuted', 'accent2', 'positive', 'negative']) {
      expect(TW, `new token ${name}`).toContain(name);
    }
    for (const name of ['bg2', 'txt2', 'cyan', 'amber']) {
      expect(TW, `legacy token ${name}`).toContain(name);
    }
  });
});

describe('color-mix, not concatenated hex', () => {
  it('is used for every tint in the CSS', () => {
    expect(CSS).toContain('color-mix(in srgb');
  });

  it('Badge tints with color-mix', () => {
    expect(BADGE).toContain('color-mix(in srgb');
  });

  it('no component builds a colour by string-concatenating an alpha suffix', () => {
    // `var(--accent) + '18'` only works when the variable holds a 6-digit hex.
    // Aurora and Platinum would produce an invalid colour and fall back to
    // transparent — a whole theme's badges silently vanishing.
    for (const [name, src] of Object.entries({ BADGE, GAUGE, THEME })) {
      expect(src, name).not.toMatch(/var\(--[a-z0-9-]+\)\s*\+\s*['"][0-9a-fA-F]{2}['"]/);
      expect(src, name).not.toMatch(/\$\{[^}]*\}[0-9a-fA-F]{2}['"`]/);
    }
  });
});

describe('Badge', () => {
  it('covers the reference\'s full status vocabulary', () => {
    for (const state of [
      'PASS', 'WARN', 'FAIL',
      'RUNNING', 'COMPLETED', 'WAITING', 'IDLE', 'SKIPPED', 'FAILED',
    ]) {
      expect(BADGE, state).toContain(`${state}:`);
    }
  });

  it('animates only in-progress states', () => {
    // A pulsing badge means "work is happening now". Applying it to a settled state
    // would make the signal meaningless.
    expect(BADGE).toMatch(/ANIMATED\s*=\s*new Set\(\[\s*'RUNNING',\s*'SCANNING'\s*\]\)/);
  });

  it('does not colour an unknown state as if it were known', () => {
    expect(BADGE).toContain("'var(--text-secondary)'");
  });
});

describe('Gauge', () => {
  it('renders an unmeasured value differently from zero', () => {
    // An empty bar reads as "measured, and it is zero". The backend distinguishes
    // `None` from `0.0` end to end; a gauge that collapsed them would undo that at
    // the last step.
    expect(GAUGE).toContain('dashed');
    expect(GAUGE).toMatch(/not measured/i);
  });

  it('clamps a measured value into range', () => {
    expect(GAUGE).toContain('Math.max(0, Math.min(100');
  });
});

describe('Theme toggle', () => {
  it('cycles Terminal -> Aurora -> Platinum', () => {
    expect(THEME).toMatch(/THEMES\s*=\s*\[\s*'terminal',\s*'aurora',\s*'platinum'\s*\]/);
  });

  it('removes the attribute for Terminal rather than setting one', () => {
    // Terminal is `:root`, matching the reference. Setting data-theme="terminal"
    // would need a matching CSS rule, i.e. two places to keep in sync for nothing.
    expect(THEME).toContain("removeAttribute('data-theme')");
  });

  it('applies the stored theme in a layout effect, not during render', () => {
    // Reading localStorage during render mismatches the server HTML and produces a
    // hydration error; a layout effect lands before the next paint instead.
    expect(THEME).toContain('useLayoutEffect');
  });
});
