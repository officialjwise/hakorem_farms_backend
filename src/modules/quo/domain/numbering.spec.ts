import { describe, expect, it } from 'vitest';
import { countOf, lineNumber, nextVersionNo } from './numbering';

describe('numbering a quote', () => {
  it('numbers lines from 1, the next version after the latest, and counts each key', () => {
    expect([lineNumber(0), lineNumber(4), nextVersionNo(1), nextVersionNo(9)]).toEqual([1, 5, 2, 10]);
    expect([...countOf(['a', 'b', 'a']).entries()]).toEqual([['a', 2], ['b', 1]]);
  });
});
