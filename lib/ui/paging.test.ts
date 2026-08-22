import { describe, expect, it } from 'vitest';

import { DEFAULT_PAGE, page, pageLabel } from './paging';

const rows = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('page', () => {
  it('renders everything when the total fits', () => {
    const p = page(rows(10), DEFAULT_PAGE);
    expect(p.rows).toHaveLength(10);
    expect(p.hidden).toBe(0);
    expect(p.next).toBeNull();
    // Nothing is hidden, so there is nothing to qualify — a label here would be
    // noise on every short table.
    expect(pageLabel(p)).toBeNull();
  });

  it('reports the hidden count rather than truncating silently', () => {
    const p = page(rows(812), 50, 50);
    expect(p.rows).toHaveLength(50);
    expect(p.hidden).toBe(762);
    expect(p.total).toBe(812);
    expect(pageLabel(p)).toBe('Showing 50 of 812 — 762 not rendered');
  });

  it('advances by a step and ends with next === null', () => {
    const first = page(rows(120), 50, 50);
    expect(first.next).toBe(100);
    const second = page(rows(120), first.next!, 50);
    expect(second.rows).toHaveLength(100);
    expect(second.next).toBe(150);
    const third = page(rows(120), second.next!, 50);
    expect(third.rows).toHaveLength(120);
    expect(third.hidden).toBe(0);
    expect(third.next).toBeNull();
  });

  it('clamps a nonsensical shown value up to one step, not down to zero', () => {
    // The failure this guards: a 0 or negative from a bad reset renders an empty
    // table, which is indistinguishable from "no data" on a trade log.
    expect(page(rows(10), 0, 50).rows).toHaveLength(10);
    expect(page(rows(200), -5, 50).rows).toHaveLength(50);
  });

  it('handles an empty list without claiming rows are hidden', () => {
    const p = page([], 50, 50);
    expect(p.rows).toEqual([]);
    expect(p.hidden).toBe(0);
    expect(p.total).toBe(0);
    expect(p.next).toBeNull();
  });
});
