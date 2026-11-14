import { describe, expect, it } from 'vitest';
import { defineEntries, definePriceList, defineVersionWindow, planActivation, type EntryInput, type EntryReferences } from './price-list';

const GOAT = 'species-goat';
const SHEEP = 'species-sheep';
const goat = 'product-goat';
const eggs = 'product-eggs';
const refs: EntryReferences = {
  products: new Map([
    [goat, { speciesId: GOAT }],
    [eggs, { speciesId: null }],
  ]),
  grades: new Map([
    ['grade-goat-a', { speciesId: GOAT }],
    ['grade-sheep-a', { speciesId: SHEEP }],
  ]),
  bands: new Map([
    ['band-goat-m', { speciesId: GOAT }],
    ['band-sheep-m', { speciesId: SHEEP }],
  ]),
};
const priced = (fields: Partial<EntryInput> = {}): EntryInput => ({
  productId: goat,
  basis: 'PER_HEAD',
  listPricePesewas: 90_000n,
  floorPricePesewas: 80_000n,
  ceilingPricePesewas: 100_000n,
  ...fields,
});

describe('a price list occupies one slot of the resolution order', () => {
  it('needs a channel for CHANNEL and a channel and tier for TIER', () => {
    expect(definePriceList({ kind: 'CHANNEL' })).toEqual({ ok: false, error: [{ field: '/channel', rule: 'REQUIRED' }] });
    expect(definePriceList({ kind: 'TIER', channel: 'WHOLESALE' })).toEqual({ ok: false, error: [{ field: '/customerTierId', rule: 'REQUIRED' }] });
    expect(definePriceList({ kind: 'TIER', channel: 'WHOLESALE', customerTierId: 't' })).toEqual({ ok: true, value: { kind: 'TIER', channel: 'WHOLESALE', customerTierId: 't' } });
  });

  it('refuses a channel or a tier on a slot that does not take one', () => {
    expect(definePriceList({ kind: 'BASE', channel: 'POS', customerTierId: 't' })).toEqual({
      ok: false,
      error: [
        { field: '/channel', rule: 'NOT_ALLOWED' },
        { field: '/customerTierId', rule: 'NOT_ALLOWED' },
      ],
    });
    expect(definePriceList({ kind: 'CUSTOMER', channel: 'ONLINE' })).toEqual({ ok: false, error: [{ field: '/channel', rule: 'NOT_ALLOWED' }] });
    expect(definePriceList({ kind: 'CHANNEL', channel: 'POS', customerTierId: 't' })).toEqual({ ok: false, error: [{ field: '/customerTierId', rule: 'NOT_ALLOWED' }] });
    expect(definePriceList({ kind: 'CUSTOMER' })).toEqual({ ok: true, value: { kind: 'CUSTOMER', channel: null, customerTierId: null } });
  });
});

describe('a version has a validity window', () => {
  it('ends after it starts, or never', () => {
    const from = new Date('2026-12-01T00:00:00Z');
    expect(defineVersionWindow(from, null)).toEqual({ ok: true, value: { validFrom: from, validTo: null } });
    expect(defineVersionWindow(from, from)).toEqual({ ok: false, error: [{ field: '/validTo', rule: 'NOT_AFTER_VALID_FROM' }] });
  });
});

describe('entries of a draft version (FR-MDM-015)', () => {
  it('accepts a band of floor <= list <= ceiling', () => {
    const result = defineEntries([priced({ gradeId: 'grade-goat-a', weightBandId: 'band-goat-m' }), priced({ productId: eggs, basis: 'PER_UNIT', listPricePesewas: 4_500n, floorPricePesewas: 4_500n, ceilingPricePesewas: 4_500n })], refs);
    expect(result.ok).toBe(true);
  });

  it('refuses floor 90,000 above list 80,000, and list above ceiling', () => {
    const result = defineEntries([priced({ floorPricePesewas: 90_000n, listPricePesewas: 80_000n }), priced({ weightBandId: 'band-goat-m', ceilingPricePesewas: 89_999n })], refs);
    expect(result).toEqual({
      ok: false,
      error: [
        { field: '/entries/0/floorPricePesewas', rule: 'ABOVE_LIST' },
        { field: '/entries/1/ceilingPricePesewas', rule: 'BELOW_LIST' },
      ],
    });
  });

  it('refuses a priced entry whose floor is zero, so no sale can be agreed at nothing', () => {
    expect(defineEntries([priced({ floorPricePesewas: 0n })], refs)).toEqual({ ok: false, error: [{ field: '/entries/0/floorPricePesewas', rule: 'ZERO_PRICE' }] });
  });

  it('accepts a quote-only entry with no price', () => {
    expect(defineEntries([priced({ quoteOnly: true, listPricePesewas: 0n, floorPricePesewas: 0n, ceilingPricePesewas: 0n })], refs).ok).toBe(true);
  });

  it('refuses two entries for the same product, grade, band and quantity break', () => {
    const result = defineEntries([priced({ weightBandId: 'band-goat-m' }), priced({ weightBandId: 'band-goat-m', listPricePesewas: 95_000n }), priced({ weightBandId: 'band-goat-m', minQty: '10.000' })], refs);
    expect(result).toEqual({ ok: false, error: [{ field: '/entries/1', rule: 'DUPLICATE_ENTRY' }] });
  });

  it("refuses unknown records and a grade or band of another species than the product's", () => {
    const result = defineEntries(
      [
        priced({ productId: 'nope' }),
        priced({ gradeId: 'grade-sheep-a', weightBandId: 'band-sheep-m' }),
        priced({ productId: eggs, gradeId: 'grade-goat-a' }),
        priced({ gradeId: 'nope', weightBandId: 'nope' }),
      ],
      refs,
    );
    expect(result).toEqual({
      ok: false,
      error: [
        { field: '/entries/0/productId', rule: 'UNKNOWN' },
        { field: '/entries/1/gradeId', rule: 'OTHER_SPECIES' },
        { field: '/entries/1/weightBandId', rule: 'OTHER_SPECIES' },
        { field: '/entries/2/gradeId', rule: 'OTHER_SPECIES' },
        { field: '/entries/3/gradeId', rule: 'UNKNOWN' },
        { field: '/entries/3/weightBandId', rule: 'UNKNOWN' },
      ],
    });
  });
});

describe('activation supersedes what it overlaps (ADR-0036)', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

  it('ends an earlier open-ended version where the new one starts', () => {
    expect(planActivation({ validFrom: d('2026-12-01'), validTo: null }, [{ id: 'v1', validFrom: d('2026-11-01'), validTo: null }])).toEqual([{ id: 'v1', action: 'END', validTo: d('2026-12-01') }]);
  });

  it('supersedes a version that starts on or after the new one', () => {
    expect(planActivation({ validFrom: d('2026-12-01'), validTo: null }, [{ id: 'v2', validFrom: d('2026-12-01'), validTo: d('2027-01-01') }])).toEqual([{ id: 'v2', action: 'SUPERSEDE' }]);
  });

  it('leaves alone a version that does not overlap', () => {
    const plan = planActivation({ validFrom: d('2026-12-01'), validTo: d('2026-12-31') }, [
      { id: 'before', validFrom: d('2026-11-01'), validTo: d('2026-12-01') },
      { id: 'after', validFrom: d('2026-12-31'), validTo: null },
    ]);
    expect(plan).toEqual([]);
  });

  it('supersedes a later version that a new open-ended version covers', () => {
    expect(planActivation({ validFrom: d('2026-11-15'), validTo: null }, [{ id: 'later', validFrom: d('2027-01-01'), validTo: null }])).toEqual([{ id: 'later', action: 'SUPERSEDE' }]);
  });
});
