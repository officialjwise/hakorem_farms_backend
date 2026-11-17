import { describe, expect, it } from 'vitest';
import { pageProbe, windowAfter } from './paging';

const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

describe('paging an order list and its history', () => {
  it('reads one row more than a page shows', () => {
    expect(pageProbe(25)).toBe(26);
  });

  it('shows the first page, then the rows after the cursor, and says when no more follow', () => {
    expect(windowAfter(rows, null, 2)).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], hasMore: true });
    expect(windowAfter(rows, 'b', 2)).toEqual({ rows: [{ id: 'c' }, { id: 'd' }], hasMore: true });
    expect(windowAfter(rows, 'd', 2)).toEqual({ rows: [{ id: 'e' }], hasMore: false });
    expect(windowAfter(rows, 'a', 4)).toEqual({ rows: rows.slice(1), hasMore: false });
  });
});
