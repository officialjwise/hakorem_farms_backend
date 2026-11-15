import { describe, expect, it } from 'vitest';
import { dueDateFrom } from './terms';

describe('a supplier invoice due date from payment terms (FR-PUR-001, FR-PUR-008)', () => {
  it('falls due on the invoice date with no terms, and 14 days later on 14-day terms', () => {
    expect(dueDateFrom('2026-11-15', 0)).toBe('2026-11-15');
    expect(dueDateFrom('2026-11-15', 14)).toBe('2026-11-29');
  });

  it('crosses a month end, a year end and the end of February in a leap year by calendar days', () => {
    expect(dueDateFrom('2026-11-20', 30)).toBe('2026-12-20');
    expect(dueDateFrom('2026-12-20', 30)).toBe('2027-01-19');
    expect(dueDateFrom('2028-02-15', 14)).toBe('2028-02-29');
    expect(dueDateFrom('2027-02-15', 14)).toBe('2027-03-01');
  });
});
