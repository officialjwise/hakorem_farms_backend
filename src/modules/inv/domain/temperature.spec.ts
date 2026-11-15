import { describe, expect, it } from 'vitest';
import { checkReading, excursionNote, isExcursion, quarantineStart, tenths } from './temperature';

const chilled = { minC: '0.0', maxC: '4.0' };
const frozen = { minC: '-25.0', maxC: '-18.0' };
const at = (iso: string) => new Date(iso);

describe('a reading against its location range (FR-INV-007 acceptance)', () => {
  it('reads temperatures in whole tenths of a degree', () => {
    expect(tenths('3.2')).toBe(32n);
    expect(tenths('-18.5')).toBe(-185n);
    expect(tenths('4')).toBe(40n);
    expect(tenths(' -0.1 ')).toBe(-1n);
    expect(() => tenths('3.25')).toThrow('not a temperature');
  });

  it('keeps 3.2 in the chilled room in range, and records 6.5 as an excursion', () => {
    expect(isExcursion('3.2', chilled)).toBe(false);
    expect(isExcursion('6.5', chilled)).toBe(true);
  });

  it('counts both bounds as in range, and a tenth past either as an excursion', () => {
    expect(isExcursion('0.0', chilled)).toBe(false);
    expect(isExcursion('4.0', chilled)).toBe(false);
    expect(isExcursion('-0.1', chilled)).toBe(true);
    expect(isExcursion('4.1', chilled)).toBe(true);
    expect(isExcursion('-18.0', frozen)).toBe(false);
    expect(isExcursion('-17.9', frozen)).toBe(true);
    expect(isExcursion('-25.1', frozen)).toBe(true);
  });
});

describe('recording a reading', () => {
  const now = at('2026-11-15T10:00:00Z');
  it('needs a location with a range and a time no later than five minutes ahead of the server', () => {
    expect(checkReading({ range: chilled, measuredAt: at('2026-11-15T10:05:00Z'), now })).toEqual([]);
    expect(checkReading({ range: null, measuredAt: at('2026-11-15T10:05:01Z'), now })).toEqual([
      { field: '/locationId', rule: 'NO_TEMPERATURE_RANGE' },
      { field: '/measuredAt', rule: 'IN_THE_FUTURE' },
    ]);
  });

  it('starts the quarantine when the reading was taken, never after now', () => {
    expect(quarantineStart(at('2026-11-15T08:00:00Z'), now)).toEqual(at('2026-11-15T08:00:00Z'));
    expect(quarantineStart(at('2026-11-15T10:03:00Z'), now)).toEqual(now);
  });

  it('says what happened, where, and the range it broke', () => {
    expect(excursionNote('6.5', chilled, 'CHILL-1')).toBe('Temperature excursion: 6.5 °C at CHILL-1, outside 0.0 to 4.0 °C');
  });
});
