import { Money, Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { checkReceiptLines, type ReceiptLineDraft, type ReceiptProductFacts } from './goods-receipt';

const goat: ReceiptProductFacts = { tracking: 'SERIAL', stockPolicy: 'SERIALISED', shelfLifeDays: null, isPurchasable: true, isLive: true };
const beef: ReceiptProductFacts = { tracking: 'LOT', stockPolicy: 'CATCH_WEIGHT', shelfLifeDays: 90, isPurchasable: true, isLive: true };
const broilers: ReceiptProductFacts = { tracking: 'LOT', stockPolicy: 'COUNTABLE', shelfLifeDays: null, isPurchasable: true, isLive: true };
const yam: ReceiptProductFacts = { tracking: 'NONE', stockPolicy: 'COUNTABLE', shelfLifeDays: null, isPurchasable: true, isLive: true };

function line(overrides: Partial<ReceiptLineDraft> = {}): ReceiptLineDraft {
  return { qtyReceived: Quantity.parse('1'), value: Money.ofPesewas(1_000n), batchNo: null, expiresOn: null, animalTags: [], ...overrides };
}

const check = (kind: 'PURCHASE' | 'HARVEST' | 'OPENING', lines: Array<[ReceiptLineDraft, ReceiptProductFacts, string?]>) =>
  checkReceiptLines({ kind, receivedOn: '2026-11-13', lines: lines.map(([draft, product, productId], index) => ({ draft, product, productId: productId ?? `p${index}` })) });

describe('goods receipt line rules (FR-INV-005, FR-INV-009)', () => {
  it('accepts four goats with four tags, a beef lot with batch and expiry, broilers as a dated flock and untracked yams', () => {
    expect(
      check('PURCHASE', [
        [line({ qtyReceived: Quantity.parse('4'), animalTags: ['G-0142', 'G-0143', 'G-0144', 'G-0145'] }), goat],
        [line({ qtyReceived: Quantity.parse('15'), batchNo: 'LOT-BEEF-2026-1113', expiresOn: '2026-11-20' }), beef],
        [line({ qtyReceived: Quantity.parse('20'), batchNo: 'BR-2026-11' }), broilers],
        [line({ qtyReceived: Quantity.parse('40') }), yam],
      ]),
    ).toEqual([]);
  });

  it('needs one animal per head, whole heads, each tag once in the receipt, and no batch or expiry on an animal', () => {
    expect(
      check('PURCHASE', [
        [line({ qtyReceived: Quantity.parse('2'), animalTags: ['G-1'] }), goat],
        [line({ qtyReceived: Quantity.parse('1.5'), animalTags: ['G-1'], batchNo: 'X', expiresOn: '2026-12-01' }), goat],
      ]),
    ).toEqual([
      { field: '/lines/0/animals', rule: 'ONE_ANIMAL_PER_HEAD' },
      { field: '/lines/1/qtyReceived', rule: 'WHOLE_ANIMALS_ONLY' },
      { field: '/lines/1/animals', rule: 'ONE_ANIMAL_PER_HEAD' },
      { field: '/lines/1/batchNo', rule: 'NOT_FOR_SERIAL_PRODUCT' },
      { field: '/lines/1/expiresOn', rule: 'NOT_FOR_SERIAL_PRODUCT' },
      { field: '/lines/1/animals/0/tagNo', rule: 'TAG_REPEATED' },
    ]);
  });

  it('needs a batch on a lot, once per product, and an expiry when the product has a shelf life, not before arrival', () => {
    expect(
      check('PURCHASE', [
        [line(), beef, 'beef'],
        [line({ batchNo: 'LOT-1', expiresOn: '2026-11-12' }), beef, 'beef'],
        [line({ batchNo: 'lot-1', expiresOn: '2026-11-13' }), beef, 'beef'],
        [line({ batchNo: 'LOT-1' }), broilers, 'broilers'],
      ]),
    ).toEqual([
      { field: '/lines/0/batchNo', rule: 'BATCH_REQUIRED' },
      { field: '/lines/0/expiresOn', rule: 'EXPIRY_REQUIRED' },
      { field: '/lines/1/expiresOn', rule: 'EXPIRED_ON_ARRIVAL' },
      { field: '/lines/2/batchNo', rule: 'BATCH_REPEATED' },
    ]);
  });

  it('refuses animals, a batch or an expiry on an untracked product, and animals on a lot', () => {
    expect(
      check('HARVEST', [
        [line({ batchNo: 'B', expiresOn: '2026-12-01', animalTags: ['T'] }), yam],
        [line({ batchNo: 'B', animalTags: ['T'] }), broilers],
      ]),
    ).toEqual([
      { field: '/lines/0/animals', rule: 'NOT_FOR_THIS_PRODUCT' },
      { field: '/lines/0/batchNo', rule: 'PRODUCT_NOT_TRACKED' },
      { field: '/lines/0/expiresOn', rule: 'PRODUCT_NOT_TRACKED' },
      { field: '/lines/1/animals', rule: 'NOT_FOR_THIS_PRODUCT' },
    ]);
  });

  it('needs a live, stocked product, purchasable and valued on a purchase; a harvest may carry no value', () => {
    const archived = { ...yam, isLive: false, isPurchasable: false, stockPolicy: 'NON_STOCK' };
    expect(check('PURCHASE', [[line({ value: Money.zero() }), archived]])).toEqual([
      { field: '/lines/0/productId', rule: 'PRODUCT_NOT_ACTIVE' },
      { field: '/lines/0/productId', rule: 'PRODUCT_NOT_STOCKED' },
      { field: '/lines/0/productId', rule: 'PRODUCT_NOT_PURCHASABLE' },
      { field: '/lines/0/valuePesewas', rule: 'VALUE_REQUIRED' },
    ]);
    expect(check('HARVEST', [[line({ value: Money.zero() }), { ...yam, isPurchasable: false }]])).toEqual([]);
  });

  it('values every opening balance line, purchasable or not, since opening stock with no value would understate it (A-147)', () => {
    expect(check('OPENING', [[line({ value: Money.zero() }), { ...yam, isPurchasable: false }]])).toEqual([{ field: '/lines/0/valuePesewas', rule: 'VALUE_REQUIRED' }]);
    expect(check('OPENING', [[line({ value: Money.ofPesewas(1n) }), { ...yam, isPurchasable: false }]])).toEqual([]);
  });
});
