import { describe, expect, it } from 'vitest';
import { GHANA_REGIONS, normaliseGhanaPhone, planAddress, planPriceListAssignment } from './parties';

describe('normaliseGhanaPhone (FR-MDM-008)', () => {
  it.each([
    ['0244123456', '+233244123456'],
    ['024 412 3456', '+233244123456'],
    ['024-412-3456', '+233244123456'],
    ['233244123456', '+233244123456'],
    ['+233244123456', '+233244123456'],
    ['+233 54 412 3456', '+233544123456'],
    ['0302123456', '+233302123456'],
    ['+447911123456', '+447911123456'],
  ])('stores %s as %s', (input, stored) => {
    expect(normaliseGhanaPhone(input)).toEqual({ ok: true, value: stored });
  });

  it.each([
    ['024412345', 'too short'],
    ['02441234567', 'too long'],
    ['0144123456', 'a Ghanaian number never starts 01'],
    ['+233144123456', 'nor +233 1'],
    ['+23324412345', 'a +233 number has nine digits'],
    ['+0244123456', 'no country code starts with 0'],
    ['244123456', 'no trunk prefix and no country code'],
    ['024412345a', 'a letter'],
    ['', 'nothing'],
  ])('refuses %s (%s)', (input) => {
    expect(normaliseGhanaPhone(input)).toEqual({ ok: false, error: 'INVALID_PHONE' });
  });
});

describe('planAddress (FR-MDM-008)', () => {
  const address = { region: 'Greater Accra', line1: 'Behind the Dodowa lorry station', digitalAddress: undefined as string | undefined, recipientPhone: '0244123456' };

  it('keeps one of the sixteen regions, a landmark and a normalised driver phone', () => {
    expect(GHANA_REGIONS).toHaveLength(16);
    expect(planAddress(address)).toEqual({ ok: true, value: { region: 'Greater Accra', recipientPhone: '+233244123456', digitalAddress: null } });
  });

  it('accepts a region in any case and returns its proper name', () => {
    expect(planAddress({ ...address, region: 'greater accra ' })).toMatchObject({ ok: true, value: { region: 'Greater Accra' } });
  });

  it('accepts a GhanaPostGPS digital address and upper-cases it', () => {
    expect(planAddress({ ...address, digitalAddress: 'ge-293-0471' })).toMatchObject({ ok: true, value: { digitalAddress: 'GE-293-0471' } });
  });

  it('refuses an unknown region, a malformed digital address, a bad phone, all at once', () => {
    expect(planAddress({ region: 'Lagos', line1: 'x', digitalAddress: 'GE2930471', recipientPhone: '12' })).toEqual({
      ok: false,
      error: [
        { field: '/region', rule: 'UNKNOWN_REGION' },
        { field: '/digitalAddress', rule: 'INVALID_DIGITAL_ADDRESS' },
        { field: '/recipientPhone', rule: 'INVALID_PHONE' },
      ],
    });
  });

  it('needs a landmark or a digital address', () => {
    expect(planAddress({ ...address, line1: '  ' })).toEqual({ ok: false, error: [{ field: '/line1', rule: 'LANDMARK_OR_DIGITAL_ADDRESS' }] });
    expect(planAddress({ ...address, line1: ' ', digitalAddress: 'GA-123-4567' })).toMatchObject({ ok: true });
  });
});

describe('planPriceListAssignment (FR-MDM-021)', () => {
  const at = (iso: string) => new Date(iso);

  it('ends an open assignment that started earlier where the new one starts', () => {
    const plan = planPriceListAssignment([{ id: 'a', validFrom: at('2026-11-01T00:00:00Z'), validTo: null }], at('2026-12-01T00:00:00Z'), null);
    expect(plan).toEqual({ ok: true, value: { end: [{ id: 'a', validTo: at('2026-12-01T00:00:00Z') }], replace: [] } });
  });

  it('replaces an assignment that starts at or after the new one, and leaves one that ended before it alone', () => {
    const plan = planPriceListAssignment(
      [
        { id: 'old', validFrom: at('2026-01-01T00:00:00Z'), validTo: at('2026-06-01T00:00:00Z') },
        { id: 'same', validFrom: at('2026-11-01T00:00:00Z'), validTo: null },
        { id: 'later', validFrom: at('2027-01-01T00:00:00Z'), validTo: null },
      ],
      at('2026-11-01T00:00:00Z'),
      null,
    );
    expect(plan).toEqual({ ok: true, value: { end: [], replace: ['same', 'later'] } });
  });

  it('leaves an assignment that starts after a bounded new one ends', () => {
    const plan = planPriceListAssignment([{ id: 'next', validFrom: at('2027-01-01T00:00:00Z'), validTo: null }], at('2026-11-01T00:00:00Z'), at('2027-01-01T00:00:00Z'));
    expect(plan).toEqual({ ok: true, value: { end: [], replace: [] } });
  });

  it('refuses a window that ends before it starts', () => {
    expect(planPriceListAssignment([], at('2026-11-01T00:00:00Z'), at('2026-11-01T00:00:00Z'))).toEqual({ ok: false, error: [{ field: '/validTo', rule: 'NOT_AFTER_VALID_FROM' }] });
  });
});
