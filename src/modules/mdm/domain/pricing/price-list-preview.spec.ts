import { describe, expect, it } from 'vitest';
import { comparePriceListVersions, entryIdentity, linesAfter, previewInstant, previewRefusal, type PreviewEntry } from './price-list-preview';

/**
 * CR-009: a draft compared with the version in force, line by line, by the identity the engine resolves on
 * (product, grade, band, quantity break; ADR-0004, docs/data-model/mdm.md `uq_price_list_entry`). Prices are pesewas.
 */
const GOAT = '019a7a8d-137d-74bf-b9f8-54cda260cdab';
const SHEEP = '019a7a8d-326c-7ea3-83db-f3051c116be3';
const GRADE_A = '019a7a8c-d59f-70f8-9631-185eaefe913c';
const BAND_M = '019a7a8c-59e3-796a-9ea3-9f80c83a185e';
const BAND_L = '019a7a8c-78d2-734e-a886-3db841ebb696';

const goatM = (fields: Partial<PreviewEntry> & { readonly id: string }): PreviewEntry & { readonly id: string } => ({
  productId: GOAT,
  gradeId: GRADE_A,
  weightBandId: BAND_M,
  minQty: '0.000',
  basis: 'PER_HEAD',
  listPricePesewas: 85_000n,
  floorPricePesewas: 70_000n,
  ceilingPricePesewas: 98_000n,
  quoteOnly: false,
  ...fields,
});

describe('the identity of a price list entry is the engine\'s own', () => {
  it('is product, grade, band and quantity break, and nothing else', () => {
    const a = goatM({ id: 'a' });
    expect(entryIdentity(a)).toBe(entryIdentity(goatM({ id: 'b', listPricePesewas: 1n, floorPricePesewas: 1n, ceilingPricePesewas: 1n, basis: 'PER_KG', quoteOnly: true })));
    expect(entryIdentity(a)).not.toBe(entryIdentity(goatM({ id: 'c', gradeId: null })));
    expect(entryIdentity(a)).not.toBe(entryIdentity(goatM({ id: 'd', weightBandId: BAND_L })));
    expect(entryIdentity(a)).not.toBe(entryIdentity(goatM({ id: 'e', productId: SHEEP })));
    expect(entryIdentity(a)).not.toBe(entryIdentity(goatM({ id: 'f', minQty: '10.000' })));
  });

  it('reads the quantity break exactly, so 5, 5.0 and 5.000 are one break', () => {
    expect(entryIdentity(goatM({ id: 'a', minQty: '5' }))).toBe(entryIdentity(goatM({ id: 'b', minQty: '5.000' })));
    expect(entryIdentity(goatM({ id: 'a', minQty: '5.0' }))).toBe(entryIdentity(goatM({ id: 'b', minQty: '5.000' })));
  });

  it('orders a missing grade or band before any grade or band, and breaks by quantity numerically', () => {
    const keys = [
      goatM({ id: '1', minQty: '100.000' }),
      goatM({ id: '2', minQty: '20.000' }),
      goatM({ id: '3', gradeId: null }),
      goatM({ id: '4', weightBandId: null }),
      goatM({ id: '5', gradeId: null, weightBandId: null }),
    ].map((entry) => [entryIdentity(entry), entry.id] as const);
    expect([...keys].sort(([x], [y]) => (x < y ? -1 : 1)).map(([, id]) => id)).toEqual(['5', '3', '4', '2', '1']);
  });
});

describe('comparing a draft with the version in force (CR-009)', () => {
  // The seeded case: one line of each kind.
  const current = [
    goatM({ id: 'cur-unchanged', weightBandId: BAND_L, listPricePesewas: 140_000n, floorPricePesewas: 120_000n, ceilingPricePesewas: 195_000n }),
    goatM({ id: 'cur-changed' }),
    goatM({ id: 'cur-removed', productId: SHEEP, gradeId: null, weightBandId: null }),
  ];
  const proposed = [
    goatM({ id: 'new-changed', listPricePesewas: 92_000n }),
    goatM({ id: 'new-unchanged', weightBandId: BAND_L, listPricePesewas: 140_000n, floorPricePesewas: 120_000n, ceilingPricePesewas: 195_000n }),
    goatM({ id: 'new-added', minQty: '10.000', listPricePesewas: 80_000n }),
  ];

  it('pairs each line by identity and names it ADDED, CHANGED, REMOVED or UNCHANGED, in identity order', () => {
    const { lines } = comparePriceListVersions(current, proposed);
    expect(lines.map((line) => [line.kind, line.current?.id ?? null, line.proposed?.id ?? null])).toEqual([
      ['CHANGED', 'cur-changed', 'new-changed'],
      ['ADDED', null, 'new-added'],
      ['UNCHANGED', 'cur-unchanged', 'new-unchanged'],
      ['REMOVED', 'cur-removed', null],
    ]);
    expect(lines.map((line) => line.key)).toEqual([...lines.map((line) => line.key)].sort());
  });

  it('counts every kind over the whole comparison, not a page', () => {
    expect(comparePriceListVersions(current, proposed).counts).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1 });
  });

  it('calls a line CHANGED when any one of basis, list, floor, ceiling or quote-only differs', () => {
    const base = goatM({ id: 'x' });
    for (const change of [
      { basis: 'PER_KG' },
      { listPricePesewas: 85_001n },
      { floorPricePesewas: 69_999n },
      { ceilingPricePesewas: 98_001n },
      { quoteOnly: true },
    ] as const) {
      expect(comparePriceListVersions([base], [goatM({ id: 'y', ...change })]).counts).toEqual({ added: 0, changed: 1, removed: 0, unchanged: 0 });
    }
    expect(comparePriceListVersions([base], [goatM({ id: 'y' })]).lines[0]!.kind).toBe('UNCHANGED');
  });

  it('calls every line ADDED when nothing is in force', () => {
    const { lines, counts } = comparePriceListVersions(null, proposed);
    expect(lines.every((line) => line.kind === 'ADDED' && line.current === null)).toBe(true);
    expect(counts).toEqual({ added: 3, changed: 0, removed: 0, unchanged: 0 });
  });

  it('calls every line REMOVED for an empty draft', () => {
    expect(comparePriceListVersions(current, []).counts).toEqual({ added: 0, changed: 0, removed: 3, unchanged: 0 });
  });

  it('refuses two entries of one version with one identity, which the database already makes impossible', () => {
    expect(() => comparePriceListVersions(null, [goatM({ id: 'a' }), goatM({ id: 'b', minQty: '0' })])).toThrow(/two entries/);
  });
});

describe('paging a comparison by identity', () => {
  const lines = comparePriceListVersions(null, [goatM({ id: 'a' }), goatM({ id: 'b', minQty: '10' }), goatM({ id: 'c', minQty: '20' })]).lines;

  it('starts at the first line and goes on after the cursor\'s identity', () => {
    expect(linesAfter(lines, null).map((line) => line.proposed!.id)).toEqual(['a', 'b', 'c']);
    expect(linesAfter(lines, lines[0]!.key).map((line) => line.proposed!.id)).toEqual(['b', 'c']);
    expect(linesAfter(lines, lines[2]!.key)).toEqual([]);
  });
});

describe('what a version is compared against', () => {
  const now = new Date('2026-11-15T09:00:00Z');

  it('is the moment the version would take effect: its validFrom, or now for a validFrom already past (ADR-0036 decision 3)', () => {
    expect(previewInstant(new Date('2026-12-01T00:00:00Z'), now)).toEqual(new Date('2026-12-01T00:00:00Z'));
    expect(previewInstant(new Date('2026-11-01T00:00:00Z'), now)).toEqual(now);
    expect(previewInstant(now, now)).toEqual(now);
  });

  it('previews a draft or a version waiting for approval, and refuses the others', () => {
    expect(previewRefusal('DRAFT')).toBeNull();
    expect(previewRefusal('PENDING_APPROVAL')).toBeNull();
    for (const status of ['ACTIVE', 'SUPERSEDED', 'REJECTED'] as const) {
      expect(previewRefusal(status)).toBe(status);
    }
  });
});
