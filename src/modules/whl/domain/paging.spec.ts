import { describe, expect, it } from 'vitest';
import { pageFrom, pageProbe } from './paging';

describe('a keyset page', () => {
  it('reads one row more than it shows, so it knows whether another page follows', () => {
    expect([pageProbe(1), pageProbe(25), pageProbe(100)]).toEqual([2, 26, 101]);
  });
});

describe('a page from a cursor over an ordered list', () => {
  it('starts at the first row after the cursor, says whether more follow, and is empty past the end', () => {
    expect(pageFrom([1, 2, 3, 4, 5], null, 2)).toEqual({ page: [1, 2], hasMore: true });
    expect(pageFrom([1, 2, 3, 4, 5], (n) => n > 2, 2)).toEqual({ page: [3, 4], hasMore: true });
    expect(pageFrom([1, 2, 3, 4, 5], (n) => n > 3, 2)).toEqual({ page: [4, 5], hasMore: false });
    expect(pageFrom([1, 2, 3], (n) => n > 3, 2)).toEqual({ page: [], hasMore: false });
  });
});
