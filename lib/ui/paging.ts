// ---------------------------------------------------------------------
// Row paging for the long tables (`/history`, `/logs`, the agent timeline).
//
// NOT VIRTUALISATION, and the difference matters. True windowing needs a fixed row
// height and absolute positioning; these tables have wrapping cells whose height
// depends on their text, so a windowed list would mis-measure and jump. Rendering a
// bounded prefix with an explicit "N more" control gets the same DOM-size win
// without lying about row geometry.
//
// THE COUNT IS ALWAYS STATED. A silent `.slice(0, 50)` reads as "that is all the
// data" — which on a trade log or an audit trail is the kind of wrong that changes
// what an operator believes happened. `hidden` exists so the caller can say so.
//
// Pure, so it is tested without a DOM.
// ---------------------------------------------------------------------

export const DEFAULT_PAGE = 50;

export type Page<T> = {
  /** The rows to render. */
  rows: T[];
  /** How many rows exist beyond `rows`. 0 means everything is shown. */
  hidden: number;
  /** Total rows available, for the "showing X of Y" label. */
  total: number;
  /** The `shown` value that reveals the next page, or null when none is left. */
  next: number | null;
};

export function page<T>(all: readonly T[], shown: number, step: number = DEFAULT_PAGE): Page<T> {
  const total = all.length;
  // A caller can pass 0 or a negative from a bad state; clamp rather than
  // rendering an empty table that looks like "no data".
  const limit = Math.max(step, Math.min(shown, total));
  const rows = all.slice(0, limit);
  const hidden = total - rows.length;
  return { rows, hidden, total, next: hidden > 0 ? limit + step : null };
}

/** "Showing 50 of 812" — or null when there is nothing to qualify. */
export function pageLabel(p: Page<unknown>): string | null {
  if (p.hidden === 0) return null;
  return `Showing ${p.rows.length} of ${p.total} — ${p.hidden} not rendered`;
}
