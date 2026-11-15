import { describe, expect, it } from 'vitest';
import { areaConflicts, defineZoneAreas, matchDeliveryZone, planPaymentMethodChange, quoteForZone, sameArea, type ZoneForMatch } from './reference-data';

const MOMO = { kind: 'MOBILE_MONEY', requiresProviderVerification: true, allowedOffline: false } as const;
const CARD = { kind: 'CARD', requiresProviderVerification: true, allowedOffline: false } as const;
const CASH = { kind: 'CASH', requiresProviderVerification: false, allowedOffline: true } as const;
const TRANSFER = { kind: 'BANK_TRANSFER', requiresProviderVerification: false, allowedOffline: false } as const;
const STRICT = { offlineMobileMoneyAllowed: false };

describe('planPaymentMethodChange (FR-MDM-009)', () => {
  it('refuses to switch provider verification off for mobile money', () => {
    expect(planPaymentMethodChange(MOMO, { requiresProviderVerification: false }, STRICT)).toEqual({
      ok: false,
      error: [{ field: '/requiresProviderVerification', rule: 'VERIFICATION_REQUIRED' }],
    });
  });

  it('refuses to switch provider verification off for card', () => {
    expect(planPaymentMethodChange(CARD, { requiresProviderVerification: false }, STRICT).ok).toBe(false);
  });

  it('lets a bank transfer be marked as needing verification and back again', () => {
    expect(planPaymentMethodChange(TRANSFER, { requiresProviderVerification: true }, STRICT)).toEqual({ ok: true, value: { requiresProviderVerification: true, allowedOffline: false } });
    expect(planPaymentMethodChange({ ...TRANSFER, requiresProviderVerification: true }, { requiresProviderVerification: false }, STRICT)).toEqual({
      ok: true,
      value: { requiresProviderVerification: false, allowedOffline: false },
    });
  });

  it('keeps what is not sent', () => {
    expect(planPaymentMethodChange(CASH, {}, STRICT)).toEqual({ ok: true, value: { requiresProviderVerification: false, allowedOffline: true } });
  });

  it('lets cash be taken offline and taken off it again', () => {
    expect(planPaymentMethodChange({ ...CASH, allowedOffline: false }, { allowedOffline: true }, STRICT).ok).toBe(true);
    expect(planPaymentMethodChange(CASH, { allowedOffline: false }, STRICT)).toEqual({ ok: true, value: { requiresProviderVerification: false, allowedOffline: false } });
  });

  it('refuses mobile money offline unless pos.offline_mobile_money_allowed is on', () => {
    expect(planPaymentMethodChange(MOMO, { allowedOffline: true }, STRICT)).toEqual({ ok: false, error: [{ field: '/allowedOffline', rule: 'OFFLINE_NOT_ALLOWED' }] });
    expect(planPaymentMethodChange(MOMO, { allowedOffline: true }, { offlineMobileMoneyAllowed: true })).toEqual({
      ok: true,
      value: { requiresProviderVerification: true, allowedOffline: true },
    });
  });

  it('never lets a card or a bank transfer be taken offline, whatever the setting', () => {
    expect(planPaymentMethodChange(CARD, { allowedOffline: true }, { offlineMobileMoneyAllowed: true }).ok).toBe(false);
    expect(planPaymentMethodChange(TRANSFER, { allowedOffline: true }, { offlineMobileMoneyAllowed: true }).ok).toBe(false);
  });

  it('refuses an empty channel list and names both rules at once', () => {
    const verdict = planPaymentMethodChange(CARD, { requiresProviderVerification: false, allowedOffline: true, channels: [] }, STRICT);
    expect(!verdict.ok && verdict.error.map((rule) => rule.rule)).toEqual(['VERIFICATION_REQUIRED', 'OFFLINE_NOT_ALLOWED', 'NO_CHANNELS']);
  });
});

describe('defineZoneAreas (FR-MDM-010)', () => {
  it('trims each area and keeps the order given', () => {
    expect(defineZoneAreas(['  Dodowa ', 'Ayikuma', 'Doryumu'])).toEqual({ ok: true, value: ['Dodowa', 'Ayikuma', 'Doryumu'] });
  });

  it('collapses inner spaces', () => {
    expect(defineZoneAreas(['Dodowa   Forest'])).toEqual({ ok: true, value: ['Dodowa Forest'] });
  });

  it('refuses a zone with no area', () => {
    expect(defineZoneAreas([])).toEqual({ ok: false, error: [{ field: '/areas', rule: 'NO_AREAS' }] });
  });

  it('refuses a blank area and an area named twice ignoring case', () => {
    expect(defineZoneAreas(['Dodowa', '  ', 'DODOWA'])).toEqual({
      ok: false,
      error: [
        { field: '/areas/1', rule: 'AREA_BLANK' },
        { field: '/areas/2', rule: 'AREA_REPEATED' },
      ],
    });
  });
});

describe('sameArea', () => {
  it('matches ignoring case, outer spaces and repeated inner spaces', () => {
    expect(sameArea(' dodowa  forest', 'Dodowa Forest')).toBe(true);
    expect(sameArea('Dodowa', 'Dodowa Forest')).toBe(false);
  });
});

describe('areaConflicts (FR-MDM-010: an address maps to one zone or none)', () => {
  const others = [
    { code: 'ADENTA', areas: ['Adenta', 'Madina'] },
    { code: 'ODA', areas: ['Oyibi'] },
  ];

  it('names each area another live zone already covers, with that zone', () => {
    expect(areaConflicts(['Dodowa', 'madina', 'Oyibi'], others)).toEqual([
      { field: '/areas/1', rule: 'AREA_IN_ZONE:ADENTA' },
      { field: '/areas/2', rule: 'AREA_IN_ZONE:ODA' },
    ]);
  });

  it('finds no conflict for areas nobody covers', () => {
    expect(areaConflicts(['Dodowa'], others)).toEqual([]);
  });
});

describe('matchDeliveryZone and quoteForZone (FR-MDM-010)', () => {
  const dodowa: ZoneForMatch = { id: 'z1', code: 'DODOWA', name: 'Dodowa and surrounds', areas: ['Dodowa', 'Ayikuma'], feePesewas: 1_500n, freeOverPesewas: null, cutoffTime: '14:00' };
  const accra: ZoneForMatch = { id: 'z2', code: 'ACC-EAST', name: 'Accra East', areas: ['Madina', 'Accra'], feePesewas: 3_000n, freeOverPesewas: 50_000n, cutoffTime: '12:00' };
  const free: ZoneForMatch = { id: 'z3', code: 'FARM', name: 'Farm gate', areas: ['Afienya'], feePesewas: 0n, freeOverPesewas: null, cutoffTime: '17:00' };

  it('finds the zone covering the address area, ignoring case', () => {
    expect(matchDeliveryZone({ area: ' dodowa ', city: 'Dodowa' }, [accra, dodowa])).toBe(dodowa);
  });

  it('prefers a zone that covers the area over one that covers only the city', () => {
    expect(matchDeliveryZone({ area: 'Madina', city: 'Dodowa' }, [dodowa, accra])).toBe(accra);
  });

  it('falls back to the city when no zone covers the area', () => {
    expect(matchDeliveryZone({ area: 'Ashaley Botwe', city: 'Accra' }, [dodowa, accra])).toBe(accra);
  });

  it('finds no zone for an address nobody delivers to', () => {
    expect(matchDeliveryZone({ area: 'Ho', city: 'Ho' }, [dodowa, accra])).toBeNull();
  });

  it('quotes exactly the zone fee of 1,500 pesewas, with its cut-off', () => {
    expect(quoteForZone(dodowa)).toEqual({ deliverable: true, zone: { id: 'z1', code: 'DODOWA', name: 'Dodowa and surrounds' }, feePesewas: 1_500n, freeOverPesewas: null, cutoffTime: '14:00' });
  });

  it('quotes a free zone as a fee of exactly zero, and still deliverable', () => {
    expect(quoteForZone(free)).toMatchObject({ deliverable: true, feePesewas: 0n });
  });

  it('carries the free-over threshold as an exact integer', () => {
    expect(quoteForZone(accra)).toMatchObject({ feePesewas: 3_000n, freeOverPesewas: 50_000n });
  });

  it('quotes an address in no zone as delivery unavailable, with no fee rather than a zero fee', () => {
    expect(quoteForZone(null)).toEqual({ deliverable: false, zone: null, feePesewas: null, freeOverPesewas: null, cutoffTime: null });
  });

  it('keeps the largest fee the contract allows exactly', () => {
    expect(quoteForZone({ ...dodowa, feePesewas: 9_007_199_254_740_991n }).feePesewas).toBe(9_007_199_254_740_991n);
  });
});
