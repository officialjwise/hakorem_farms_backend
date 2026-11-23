import { describe, expect, it } from 'vitest';
import { accraDay, byLineNumber, lineNumber, nextLineNumber } from './line-numbers';

describe('line numbers', () => {
  it('counts a request line from 1, and a later line after the highest used', () => {
    expect(lineNumber(0)).toBe(1);
    expect(nextLineNumber([1, 3, 2])).toBe(4);
    expect(nextLineNumber([])).toBe(1);
    expect([{ lineNo: 3 }, { lineNo: 1 }, { lineNo: 2 }].sort(byLineNumber).map((l) => l.lineNo)).toEqual([1, 2, 3]);
  });

  it('takes an Accra day as midnight to midnight UTC, the next day excluded', () => {
    expect(accraDay('2026-11-23')).toEqual({ from: new Date('2026-11-23T00:00:00Z'), to: new Date('2026-11-24T00:00:00Z') });
  });
});
