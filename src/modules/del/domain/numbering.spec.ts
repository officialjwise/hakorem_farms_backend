import { describe, expect, it } from 'vitest';
import { nextAttemptNo, pageProbe } from './numbering';

describe('numbering and paging', () => {
  it('numbers the first attempt 1 and each next one more, and probes one row past a page', () => {
    expect([nextAttemptNo(0), nextAttemptNo(1), pageProbe(25)]).toEqual([1, 2, 26]);
  });
});
