import { describe, expect, it } from 'vitest';
import {
  priceBandErrors,
  productCreateErrors,
  readLocationRow,
  readMinQty,
  readPesewas,
  readPriceEntryRow,
  readProductRow,
  readSupplierRow,
  type PriceEntryRow,
} from './import-rows';

const cells = (values: Record<string, string>) => new Map(Object.entries(values));

describe('product rows (FR-MDM-001, FR-MDM-019)', () => {
  it('reads a full product row, upper-casing codes and writing the pack weight with three places', () => {
    const { row, errors } = readProductRow(2, cells({ sku: 'beef-15kg', name: 'Beef 15 kg pack', category: 'meat', stockPolicy: 'catch_weight', baseUom: 'kg', saleUom: 'KG', nominalPackKg: '15', shelfLifeDays: '5', onlineMode: 'listed', taxCategory: 'processed_meat' }));
    expect(errors).toEqual([]);
    expect(row).toMatchObject({ sku: 'BEEF-15KG', categoryCode: 'MEAT', stockPolicy: 'CATCH_WEIGHT', baseUom: 'KG', nominalPackKg: '15.000', shelfLifeDays: 5, onlineMode: 'LISTED', taxCategoryCode: 'PROCESSED_MEAT' });
    expect(readProductRow(2, cells({ sku: 'X1', nominalPackKg: '2.5' })).row.nominalPackKg).toBe('2.500');
  });

  it('names the column of every malformed cell', () => {
    const { errors } = readProductRow(7, cells({ sku: 'no spaces', stockPolicy: 'LOOSE', nominalPackKg: '1.2345', shelfLifeDays: '0', onlineMode: 'SOMETIMES', category: 'bad code!' }));
    expect(errors.map((error) => error.column)).toEqual(['sku', 'nominalPackKg', 'category', 'stockPolicy', 'shelfLifeDays', 'onlineMode']);
    expect(errors.every((error) => error.rowNo === 7)).toBe(true);
    expect(readProductRow(3, cells({ sku: 'A1', name: 'x'.repeat(121) })).errors[0]!.column).toBe('name');
  });

  it('reads a blank SKU as a row that creates a product, whose SKU the server gives (B09q, ADR-0072)', () => {
    const { row, errors } = readProductRow(3, cells({ sku: '', name: 'Eggs, big, crate of 30' }));
    expect(errors).toEqual([]);
    expect(row.sku).toBeNull();
    expect(readProductRow(3, cells({ name: 'Eggs' })).row.sku).toBeNull();
  });

  it('asks a row that creates a product for its name, category, policy and units', () => {
    const { row } = readProductRow(4, cells({}));
    expect(productCreateErrors(row).map((error) => error.column)).toEqual(['name', 'category', 'stockPolicy', 'baseUom', 'saleUom']);
  });
});

describe('supplier rows (FR-MDM-007, FR-MDM-019)', () => {
  it('normalises a Ghanaian phone, lower-cases the email and reads the categories as distinct codes', () => {
    const { row, errors } = readSupplierRow(2, cells({ name: 'Dodowa Feeds', phone: '0244123456', email: 'Sales@Example.com', categories: 'feed; supplies;FEED' }));
    expect(errors).toEqual([]);
    expect(row).toMatchObject({ publicId: null, phone: '+233244123456', email: 'sales@example.com', categoryCodes: ['FEED', 'SUPPLIES'] });
    expect(readSupplierRow(2, cells({ name: 'A' })).row.categoryCodes).toBeNull();
  });

  it('refuses a bad public ID, phone, email or category without echoing the value', () => {
    const { errors } = readSupplierRow(5, cells({ publicId: 'S-0042', name: 'B', phone: '12345', email: 'no-at-sign', categories: 'MEAT;bad code' }));
    expect(errors.map((error) => error.column)).toEqual(['publicId', 'phone', 'email', 'categories']);
    expect(errors.some((error) => error.message.includes('12345') || error.message.includes('no-at-sign'))).toBe(false);
    expect(readSupplierRow(3, cells({ name: '' })).errors).toEqual([{ rowNo: 3, column: 'name', message: 'Name is empty' }]);
    expect(readSupplierRow(3, cells({ publicId: 'sup_8F3K2M9Q7X4T1V6B', name: '' })).errors).toEqual([]);
    expect(readSupplierRow(3, cells({ publicId: 'sup_8f3k2m9q7x4t1v6b' })).row.publicId).toBe('sup_8F3K2M9Q7X4T1V6B');
    expect(readSupplierRow(3, cells({ name: 'C', categories: Array.from({ length: 51 }, (_, i) => `C${i}`).join(';') })).errors[0]!.column).toBe('categories');
  });
});

describe('location rows (FR-MDM-006, FR-MDM-019)', () => {
  it('reads a cold room row, writing temperatures with one place', () => {
    const { row, errors } = readLocationRow(2, cells({ branch: 'ddw', code: 'cr-01', name: 'Cold room 1', kind: 'cold_room', parent: 'SITE-01', isSellable: 'yes', tempClass: 'chilled', tempMinC: '0', tempMaxC: '4.5', capacityHead: '' }));
    expect(errors).toEqual([]);
    expect(row).toMatchObject({ branchCode: 'DDW', code: 'CR-01', kind: 'COLD_ROOM', parentCode: 'SITE-01', isSellable: true, tempClass: 'CHILLED', tempMinC: '0.0', tempMaxC: '4.5', capacityHead: null });
  });

  it('refuses a virtual kind, an unknown kind and malformed cells', () => {
    expect(readLocationRow(2, cells({ branch: 'DDW', code: 'V-LOSS', kind: 'LOSS' })).errors).toEqual([{ rowNo: 2, column: 'kind', message: 'A virtual location is created with its branch and cannot be imported' }]);
    const { errors } = readLocationRow(3, cells({ branch: 'TOOLONG', code: 'X', kind: 'BARN', isSellable: 'maybe', tempMinC: '4.25', capacityHead: '0' }));
    expect(errors.map((error) => error.column)).toEqual(['branch', 'code', 'kind', 'isSellable', 'tempMinC', 'capacityHead']);
    expect(readLocationRow(4, cells({ branch: '', code: '' })).errors.map((error) => error.message)).toEqual(['Branch is empty', 'Code is empty']);
  });
});

describe('price list entry rows: money in integer pesewas (FR-MDM-015, A-130)', () => {
  it('reads prices as exact integers of pesewas, never through a float', () => {
    const { row, errors } = readPriceEntryRow(2, cells({ priceList: 'retail-pos', sku: 'goat-live', grade: 'a', weightBand: 'b20-25', basis: 'per_head', listPricePesewas: '90000', floorPricePesewas: '80000', ceilingPricePesewas: '100000' }));
    expect(errors).toEqual([]);
    expect(row).toMatchObject({ priceListCode: 'RETAIL-POS', sku: 'GOAT-LIVE', gradeCode: 'A', weightBandCode: 'B20-25', basis: 'PER_HEAD', minQty: '0.000', quoteOnly: false });
    expect(row.listPricePesewas).toBe(90_000n);
    expect(row.floorPricePesewas).toBe(80_000n);
    expect(row.ceilingPricePesewas).toBe(100_000n);
  });

  it('reads zero and the largest amount the database holds exactly, and refuses one pesewa more', () => {
    expect(readPesewas('0')).toBe(0n);
    expect(readPesewas('9007199254740991')).toBe(9_007_199_254_740_991n);
    expect(readPesewas('9007199254740992')).toBeNull();
  });

  it('refuses a price in cedis with a decimal point, a negative, a separator or a blank, naming the column', () => {
    for (const value of ['850.00', '-1', '85,000', '1e5', ' ']) expect(readPesewas(value), value).toBeNull();
    const { errors } = readPriceEntryRow(9, cells({ priceList: 'RETAIL-POS', sku: 'GOAT-LIVE', basis: 'PER_HEAD', listPricePesewas: '850.00', floorPricePesewas: '', ceilingPricePesewas: '-5' }));
    expect(errors).toEqual([
      { rowNo: 9, column: 'listPricePesewas', message: 'listPricePesewas must be a whole number of pesewas, such as 85000 for GHS 850.00' },
      { rowNo: 9, column: 'floorPricePesewas', message: 'floorPricePesewas is empty' },
      { rowNo: 9, column: 'ceilingPricePesewas', message: 'ceilingPricePesewas must be a whole number of pesewas, such as 85000 for GHS 850.00' },
    ]);
  });

  it('reads the minimum quantity with three places and refuses more places or a sign', () => {
    expect(readMinQty(null)).toBe('0.000');
    expect(readMinQty('10')).toBe('10.000');
    expect(readMinQty('2.5')).toBe('2.500');
    expect(readMinQty('1.2345')).toBeNull();
    expect(readMinQty('-1')).toBeNull();
    expect(readPriceEntryRow(2, cells({ priceList: 'P1', sku: 'S1', basis: 'PER_KG', listPricePesewas: '1', floorPricePesewas: '1', ceilingPricePesewas: '1', minQty: 'x' })).errors[0]!.column).toBe('minQty');
  });

  it('names every missing key cell and an unknown basis', () => {
    const { errors } = readPriceEntryRow(4, cells({ priceList: '', sku: '', basis: 'PER_BOX', listPricePesewas: '1', floorPricePesewas: '1', ceilingPricePesewas: '1', quoteOnly: 'perhaps' }));
    expect(errors.map((error) => error.column)).toEqual(['priceList', 'sku', 'basis', 'quoteOnly']);
    expect(readPriceEntryRow(4, cells({ priceList: 'P1', sku: 'S1', basis: '', listPricePesewas: '1', floorPricePesewas: '1', ceilingPricePesewas: '1' })).errors).toEqual([{ rowNo: 4, column: 'basis', message: 'basis is empty' }]);
  });

  describe('the band: floor <= list <= ceiling, and a priced entry never at nothing', () => {
    const entry = (list: bigint | null, floor: bigint | null, ceiling: bigint | null, quoteOnly = false): PriceEntryRow => ({
      rowNo: 6,
      priceListCode: 'P1',
      sku: 'S1',
      gradeCode: null,
      weightBandCode: null,
      minQty: '0.000',
      basis: 'PER_HEAD',
      listPricePesewas: list,
      floorPricePesewas: floor,
      ceilingPricePesewas: ceiling,
      quoteOnly,
    });

    it('accepts a band where floor, list and ceiling are equal', () => {
      expect(priceBandErrors(entry(85_000n, 85_000n, 85_000n))).toEqual([]);
    });

    it('refuses a floor of 90,000 above a list of 80,000, one pesewa above too', () => {
      expect(priceBandErrors(entry(80_000n, 90_000n, 100_000n))).toEqual([{ rowNo: 6, column: 'floorPricePesewas', message: 'The floor price is above the list price' }]);
      expect(priceBandErrors(entry(80_000n, 80_001n, 100_000n))[0]!.column).toBe('floorPricePesewas');
    });

    it('refuses a ceiling one pesewa below the list', () => {
      expect(priceBandErrors(entry(80_000n, 70_000n, 79_999n))).toEqual([{ rowNo: 6, column: 'ceilingPricePesewas', message: 'The ceiling price is below the list price' }]);
    });

    it('refuses a zero floor on a priced entry and accepts it on a quote-only entry', () => {
      expect(priceBandErrors(entry(0n, 0n, 0n))[0]!.column).toBe('floorPricePesewas');
      expect(priceBandErrors(entry(0n, 0n, 0n, true))).toEqual([]);
      expect(priceBandErrors(entry(1n, 1n, 1n))).toEqual([]);
    });

    it('leaves the band alone when a price could not be read', () => {
      expect(priceBandErrors(entry(null, 1n, 1n))).toEqual([]);
    });
  });
});
