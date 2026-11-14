import { Quantity, Weight } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import {
  extendPrice,
  judgeAgreedPrice,
  resolvePrice,
  weightBandFor,
  type PriceEntry,
  type PriceListCandidate,
  type PriceListRef,
  type PricingQuery,
  type WeightBand,
} from './pricing-engine';

// Goat weight bands, half-open [min, max): a weight on a boundary belongs to the upper band (FR-MDM-005).
const GOAT_S: WeightBand = { id: 'band-s', code: 'GOAT-S', min: Weight.parseKg('10.000'), max: Weight.parseKg('18.000') };
const GOAT_M: WeightBand = { id: 'band-m', code: 'GOAT-M', min: Weight.parseKg('18.000'), max: Weight.parseKg('28.000') };
const GOAT_L: WeightBand = { id: 'band-l', code: 'GOAT-L', min: Weight.parseKg('28.000'), max: Weight.parseKg('40.000') };
const BANDS = [GOAT_L, GOAT_S, GOAT_M];
const GRADE_A = 'grade-a';
const GRADE_B = 'grade-b';

const CUSTOMER_LIST: PriceListRef = { id: 'list-customer', code: 'CATERERS-2026', name: 'Caterers 2026', kind: 'CUSTOMER' };
const TIER_LIST: PriceListRef = { id: 'list-tier', code: 'WHL-RESELLER', name: 'Resellers, wholesale', kind: 'TIER' };
const CHANNEL_LIST: PriceListRef = { id: 'list-channel', code: 'WHOLESALE', name: 'Wholesale prices', kind: 'CHANNEL' };
const BASE_LIST: PriceListRef = { id: 'list-base', code: 'BASE', name: 'Base prices', kind: 'BASE' };

let entrySeq = 0;
function entry(fields: Partial<PriceEntry> & Pick<PriceEntry, 'listPricePesewas'>): PriceEntry {
  entrySeq += 1;
  return {
    id: `entry-${entrySeq}`,
    gradeId: null,
    weightBandId: null,
    basis: 'PER_HEAD',
    floorPricePesewas: fields.listPricePesewas,
    ceilingPricePesewas: fields.listPricePesewas,
    quoteOnly: false,
    minQty: Quantity.zero(),
    ...fields,
  };
}

function query(fields: { grade?: string; kg?: string; qty?: string } = {}): PricingQuery {
  return {
    gradeId: fields.grade ?? null,
    weight: fields.kg === undefined ? null : Weight.parseKg(fields.kg),
    quantity: Quantity.parse(fields.qty ?? '1.000'),
  };
}

function priced(result: ReturnType<typeof resolvePrice>): { list: string; entry: string; listPrice: bigint } {
  if (result.kind !== 'Resolved') {
    throw new Error(`expected a price, got QuoteRequired ${result.reason}`);
  }
  return { list: result.list.code, entry: result.entry.id, listPrice: result.entry.listPricePesewas };
}

describe('weight band mapping (FR-MDM-005)', () => {
  it('maps a weight to the one half-open band that contains it', () => {
    expect(weightBandFor(BANDS, Weight.parseKg('17.999'))?.code).toBe('GOAT-S');
    expect(weightBandFor(BANDS, Weight.parseKg('18.000'))?.code).toBe('GOAT-M');
    expect(weightBandFor(BANDS, Weight.parseKg('28.000'))?.code).toBe('GOAT-L');
    expect(weightBandFor(BANDS, Weight.parseKg('10.000'))?.code).toBe('GOAT-S');
  });

  it('maps a weight outside every band to none', () => {
    expect(weightBandFor(BANDS, Weight.parseKg('9.999'))).toBeNull();
    expect(weightBandFor(BANDS, Weight.parseKg('40.000'))).toBeNull();
    expect(weightBandFor([], Weight.parseKg('20.000'))).toBeNull();
  });
});

describe('resolution order (FR-MDM-016, ADR-0004)', () => {
  const customer = entry({ weightBandId: GOAT_M.id, gradeId: GRADE_A, listPricePesewas: 85_000n });
  const tier = entry({ weightBandId: GOAT_M.id, listPricePesewas: 87_500n });
  const channel = entry({ weightBandId: GOAT_M.id, listPricePesewas: 90_000n });
  const base = entry({ weightBandId: GOAT_M.id, listPricePesewas: 95_000n });
  const all: PriceListCandidate[] = [
    { list: CUSTOMER_LIST, entries: [customer] },
    { list: TIER_LIST, entries: [tier] },
    { list: CHANNEL_LIST, entries: [channel] },
    { list: BASE_LIST, entries: [base] },
  ];
  const goatAMedium = query({ grade: GRADE_A, kg: '22.400' });

  it("takes the customer's own list first: 85,000, not the channel list's 90,000", () => {
    expect(priced(resolvePrice(goatAMedium, BANDS, all))).toEqual({ list: 'CATERERS-2026', entry: customer.id, listPrice: 85_000n });
  });

  it('takes the tier and channel list when the customer list has no matching entry', () => {
    expect(priced(resolvePrice(goatAMedium, BANDS, all.slice(1)))).toEqual({ list: 'WHL-RESELLER', entry: tier.id, listPrice: 87_500n });
  });

  it('takes the channel list when neither customer nor tier lists price it', () => {
    expect(priced(resolvePrice(goatAMedium, BANDS, all.slice(2)))).toEqual({ list: 'WHOLESALE', entry: channel.id, listPrice: 90_000n });
  });

  it('falls back to the base list last', () => {
    expect(priced(resolvePrice(goatAMedium, BANDS, all.slice(3)))).toEqual({ list: 'BASE', entry: base.id, listPrice: 95_000n });
  });

  it('skips a list whose entries do not match and keeps walking', () => {
    const otherGrade = query({ grade: GRADE_B, kg: '22.400' });
    expect(priced(resolvePrice(otherGrade, BANDS, all)).list).toBe('WHL-RESELLER');
    expect(priced(resolvePrice(goatAMedium, BANDS, [{ list: CUSTOMER_LIST, entries: [] }, ...all.slice(3)])).list).toBe('BASE');
  });

  it('returns the list, the entry and the band that produced the price, so support can explain it', () => {
    const result = resolvePrice(goatAMedium, BANDS, all);
    expect(result).toEqual({ kind: 'Resolved', list: CUSTOMER_LIST, entry: customer, weightBand: GOAT_M });
  });
});

describe('specificity inside one list (FR-MDM-016)', () => {
  const gradeAndBand = entry({ gradeId: GRADE_A, weightBandId: GOAT_M.id, listPricePesewas: 99_000n });
  const bandOnly = entry({ weightBandId: GOAT_M.id, listPricePesewas: 92_000n });
  const gradeOnly = entry({ gradeId: GRADE_A, listPricePesewas: 88_000n });
  const productOnly = entry({ listPricePesewas: 80_000n });
  // Deliberately out of order: the engine ranks them, the order of rows does not matter.
  const list: PriceListCandidate[] = [{ list: BASE_LIST, entries: [productOnly, gradeOnly, bandOnly, gradeAndBand] }];

  it('prefers product with grade and band', () => {
    expect(priced(resolvePrice(query({ grade: GRADE_A, kg: '20.000' }), BANDS, list)).entry).toBe(gradeAndBand.id);
  });

  it('then product with band', () => {
    expect(priced(resolvePrice(query({ grade: GRADE_B, kg: '20.000' }), BANDS, list)).entry).toBe(bandOnly.id);
  });

  it('then product with grade', () => {
    expect(priced(resolvePrice(query({ grade: GRADE_A, kg: '35.000' }), BANDS, list)).entry).toBe(gradeOnly.id);
  });

  it('then the product alone', () => {
    expect(priced(resolvePrice(query(), BANDS, list)).entry).toBe(productOnly.id);
    expect(priced(resolvePrice(query({ grade: GRADE_B, kg: '35.000' }), BANDS, list)).entry).toBe(productOnly.id);
  });
});

describe('quantity breaks (min_qty)', () => {
  const retail = entry({ basis: 'PER_KG', listPricePesewas: 2_000n });
  const bulk = entry({ basis: 'PER_KG', listPricePesewas: 1_800n, minQty: Quantity.parse('100.000') });
  const list: PriceListCandidate[] = [{ list: BASE_LIST, entries: [bulk, retail] }];

  it('applies the entry with the largest minimum not above the quantity', () => {
    expect(priced(resolvePrice(query({ qty: '99.999' }), [], list)).listPrice).toBe(2_000n);
    expect(priced(resolvePrice(query({ qty: '100.000' }), [], list)).listPrice).toBe(1_800n);
    expect(priced(resolvePrice(query({ qty: '250.000' }), [], list)).listPrice).toBe(1_800n);
  });

  it('ranks specificity before the quantity break', () => {
    const banded = entry({ weightBandId: GOAT_M.id, listPricePesewas: 90_000n });
    const bulkAnyBand = entry({ listPricePesewas: 70_000n, minQty: Quantity.parse('10.000') });
    const result = resolvePrice(query({ kg: '20.000', qty: '12.000' }), BANDS, [{ list: BASE_LIST, entries: [bulkAnyBand, banded] }]);
    expect(priced(result).listPrice).toBe(90_000n);
  });

  it('does not match an entry whose minimum is above the quantity', () => {
    const result = resolvePrice(query({ qty: '5.000' }), [], [{ list: BASE_LIST, entries: [bulk] }]);
    expect(result).toEqual({ kind: 'QuoteRequired', reason: 'NO_RULE', stoppedAt: null });
  });
});

describe('quote required, never an error and never zero (FR-MDM-016, FR-MDM-017)', () => {
  it('stops the walk at a quote-only entry even though the base list has a price', () => {
    const quoteOnly = entry({ listPricePesewas: 0n, quoteOnly: true });
    const result = resolvePrice(query(), [], [
      { list: CHANNEL_LIST, entries: [quoteOnly] },
      { list: BASE_LIST, entries: [entry({ listPricePesewas: 45_000n })] },
    ]);
    expect(result).toEqual({ kind: 'QuoteRequired', reason: 'QUOTE_ONLY', stoppedAt: CHANNEL_LIST });
  });

  it('lets a more specific priced entry win over a less specific quote-only one', () => {
    const quoteOnlyAnySize = entry({ listPricePesewas: 0n, quoteOnly: true });
    const medium = entry({ weightBandId: GOAT_M.id, listPricePesewas: 90_000n });
    expect(priced(resolvePrice(query({ kg: '19.000' }), BANDS, [{ list: BASE_LIST, entries: [quoteOnlyAnySize, medium] }])).listPrice).toBe(90_000n);
    expect(resolvePrice(query({ kg: '45.000' }), BANDS, [{ list: BASE_LIST, entries: [quoteOnlyAnySize, medium] }])).toMatchObject({ reason: 'QUOTE_ONLY' });
  });

  it('asks for a quote when a goat priced by weight band has no weight', () => {
    const lists: PriceListCandidate[] = [{ list: BASE_LIST, entries: [entry({ weightBandId: GOAT_M.id, listPricePesewas: 90_000n })] }];
    expect(resolvePrice(query(), BANDS, lists)).toEqual({ kind: 'QuoteRequired', reason: 'MISSING_GRADE_OR_WEIGHT', stoppedAt: null });
  });

  it('asks for a quote when a product priced by grade has no grade', () => {
    const lists: PriceListCandidate[] = [{ list: BASE_LIST, entries: [entry({ gradeId: GRADE_A, listPricePesewas: 90_000n })] }];
    expect(resolvePrice(query({ kg: '20.000' }), BANDS, lists)).toEqual({ kind: 'QuoteRequired', reason: 'MISSING_GRADE_OR_WEIGHT', stoppedAt: null });
  });

  it('asks for a quote, reason NO_RULE, for a 52.500 kg goat that falls outside every band', () => {
    const lists: PriceListCandidate[] = [
      { list: CHANNEL_LIST, entries: [entry({ weightBandId: GOAT_L.id, listPricePesewas: 150_000n })] },
      { list: BASE_LIST, entries: [GOAT_S, GOAT_M, GOAT_L].map((band, i) => entry({ weightBandId: band.id, listPricePesewas: 60_000n + BigInt(i) * 45_000n })) },
    ];
    expect(weightBandFor(BANDS, Weight.parseKg('52.500'))).toBeNull();
    expect(resolvePrice(query({ kg: '52.500' }), BANDS, lists)).toEqual({ kind: 'QuoteRequired', reason: 'NO_RULE', stoppedAt: null });
  });

  it('asks for a quote, reason NO_RULE, when no list prices the product at all', () => {
    expect(resolvePrice(query(), [], [])).toEqual({ kind: 'QuoteRequired', reason: 'NO_RULE', stoppedAt: null });
    expect(resolvePrice(query(), [], [{ list: BASE_LIST, entries: [] }])).toEqual({ kind: 'QuoteRequired', reason: 'NO_RULE', stoppedAt: null });
  });

  it('still takes a later list that matches when an earlier one needed a weight the request lacks', () => {
    const lists: PriceListCandidate[] = [
      { list: CUSTOMER_LIST, entries: [entry({ weightBandId: GOAT_M.id, listPricePesewas: 85_000n })] },
      { list: BASE_LIST, entries: [entry({ listPricePesewas: 100_000n })] },
    ];
    expect(priced(resolvePrice(query(), BANDS, lists))).toMatchObject({ list: 'BASE', listPrice: 100_000n });
  });
});

describe('agreed price against the band (FR-MDM-017)', () => {
  // Goat grade A, band 20-25 kg, retail: list 90,000, floor 80,000, ceiling 100,000.
  const band = { listPricePesewas: 90_000n, floorPricePesewas: 80_000n, ceilingPricePesewas: 100_000n };

  it('records no variance at the list price', () => {
    expect(judgeAgreedPrice(band, 90_000n, 0n)).toEqual({ kind: 'AT_LIST' });
  });

  it('records 5,000 below list for 85,000, without approval inside the role allowance', () => {
    expect(judgeAgreedPrice(band, 85_000n, 10_000n)).toEqual({ kind: 'VARIANCE', amountPesewas: 5_000n, direction: 'BELOW', approval: null });
    expect(judgeAgreedPrice(band, 85_000n, 5_000n)).toEqual({ kind: 'VARIANCE', amountPesewas: 5_000n, direction: 'BELOW', approval: null });
  });

  it('needs approval when the discount is one pesewa beyond what the role has left for the shift', () => {
    expect(judgeAgreedPrice(band, 85_000n, 4_999n)).toEqual({ kind: 'VARIANCE', amountPesewas: 5_000n, direction: 'BELOW', approval: 'BEYOND_ROLE_LIMIT' });
  });

  it('accepts the floor itself and refuses 75,000 below the floor without approval', () => {
    expect(judgeAgreedPrice(band, 80_000n, 10_000n)).toEqual({ kind: 'VARIANCE', amountPesewas: 10_000n, direction: 'BELOW', approval: null });
    expect(judgeAgreedPrice(band, 75_000n, 1_000_000n)).toEqual({ kind: 'VARIANCE', amountPesewas: 15_000n, direction: 'BELOW', approval: 'OUTSIDE_BAND' });
  });

  it('records a price above list up to the ceiling without approval, and above the ceiling with it', () => {
    expect(judgeAgreedPrice(band, 100_000n, 0n)).toEqual({ kind: 'VARIANCE', amountPesewas: 10_000n, direction: 'ABOVE', approval: null });
    expect(judgeAgreedPrice(band, 100_001n, 0n)).toEqual({ kind: 'VARIANCE', amountPesewas: 10_001n, direction: 'ABOVE', approval: 'OUTSIDE_BAND' });
  });
});

describe('extending a unit price to a line, rounded half-up once (ADR-0001)', () => {
  const measure = (qty: string, kg?: string) => ({ quantity: Quantity.parse(qty), weight: kg === undefined ? null : Weight.parseKg(kg) });

  it('rounds an exact half pesewa up: 0.500 kg at 2,001 per kg is 1,000.5, so 1,001', () => {
    expect(extendPrice(2_001n, 'PER_KG', measure('0.500', '0.500'))).toEqual({ ok: true, value: 1_001n });
  });

  it('rounds below the half down and above it up', () => {
    // 1.235 kg x 1,999 = 2,468.765
    expect(extendPrice(1_999n, 'PER_KG', measure('1.000', '1.235'))).toEqual({ ok: true, value: 2_469n });
    // 15.250 kg x 2,333 = 35,578.25
    expect(extendPrice(2_333n, 'PER_KG', measure('1.000', '15.250'))).toEqual({ ok: true, value: 35_578n });
  });

  it('multiplies per head and per unit prices by the quantity exactly', () => {
    expect(extendPrice(85_000n, 'PER_HEAD', measure('3.000'))).toEqual({ ok: true, value: 255_000n });
    expect(extendPrice(4_500n, 'PER_UNIT', measure('2.000'))).toEqual({ ok: true, value: 9_000n });
  });

  it('refuses a per-kilogram line without a weight rather than guessing one', () => {
    expect(extendPrice(2_000n, 'PER_KG', measure('15.000'))).toEqual({ ok: false, error: 'WEIGHT_REQUIRED' });
  });
});
