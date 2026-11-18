import { describe, expect, it } from 'vitest';
import { pageProbe } from './paging';

describe('a keyset page', () => {
  it('reads one row more than it shows, so it knows whether another page follows', () => {
    expect([pageProbe(1), pageProbe(25), pageProbe(100)]).toEqual([2, 26, 101]);
  });
});
