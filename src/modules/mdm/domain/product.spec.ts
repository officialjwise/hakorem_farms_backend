import { describe, expect, it } from 'vitest';
import { defineProduct, serverAssignedFieldsIn, type ProductDraft, type ProductReferences } from './product';

const LIVE_CATEGORY = { id: '019a7a89-737b-7c17-9150-ca4d5fa2432b', glGroup: 'LIVE_ANIMALS', taxCategoryId: '019a7a8a-6af3-7b33-906b-bc092d2a34e7' } as const;
const MEAT_CATEGORY = { id: '019a7a89-b159-7fde-b516-06bc53047f9a', glGroup: 'MEAT', taxCategoryId: '019a7a8a-89e2-7d1e-a1b3-c4d5e6f7a8b9' } as const;
const EGG_CATEGORY = { id: '019a7a89-d048-7a2c-b3d4-e5f6a7b8c9d0', glGroup: 'PRODUCE_EGGS', taxCategoryId: '019a7a8a-a8d1-7e2f-b4c5-d6e7f8a9b0c1' } as const;
const GOAT = '019a7a8b-a049-7e16-b34e-ea33ee146311';

const references: ProductReferences = {
  category: LIVE_CATEGORY,
  speciesFound: true,
  taxCategoryFound: true,
  units: new Map([
    ['HEAD', 'COUNT'],
    ['KG', 'WEIGHT'],
    ['PACK', 'COUNT'],
    ['CRATE', 'COUNT'],
    ['UNIT', 'COUNT'],
  ]),
};

const goat: ProductDraft = {
  name: 'Goat',
  categoryId: LIVE_CATEGORY.id,
  stockPolicy: 'SERIALISED',
  speciesId: GOAT,
  baseUom: 'HEAD',
  saleUom: 'HEAD',
  onlineMode: 'REQUEST_TO_BUY',
};

describe('defining a product (shared brief, domain model section 1; FR-MDM-001)', () => {
  it('tracks a serialised animal by serial, takes the ledger group and tax category from its category, and starts active', () => {
    const result = defineProduct(goat, references);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        tracking: 'SERIAL',
        glGroup: 'LIVE_ANIMALS',
        taxCategoryId: LIVE_CATEGORY.taxCategoryId,
        weightTolerancePercent: '10.00',
        status: 'ACTIVE',
        isPurchasable: true,
        isSellable: true,
      }),
    });
  });

  it('tracks catch-weight meat by lot, in kilograms, with its pack size and tolerance as exact decimal strings', () => {
    const result = defineProduct(
      {
        name: 'Goat meat, 5 kg pack',
        categoryId: MEAT_CATEGORY.id,
        stockPolicy: 'CATCH_WEIGHT',
        baseUom: 'KG',
        saleUom: 'PACK',
        nominalPackKg: '5.000',
        weightTolerancePercent: '7.5',
        shelfLifeDays: 30,
        storageTempClass: 'FROZEN',
        onlineMode: 'LISTED',
      },
      { ...references, category: MEAT_CATEGORY },
    );
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ tracking: 'LOT', glGroup: 'MEAT', nominalPackKg: '5.000', weightTolerancePercent: '7.50' }),
    });
  });

  it('tracks a countable by lot when it has a shelf life, and not at all when it has none', () => {
    const eggs = { name: 'Eggs, big, crate of 30', categoryId: EGG_CATEGORY.id, stockPolicy: 'COUNTABLE', baseUom: 'CRATE', saleUom: 'CRATE', onlineMode: 'LISTED' } as const;
    expect(defineProduct({ ...eggs, shelfLifeDays: 21 }, { ...references, category: EGG_CATEGORY })).toEqual({ ok: true, value: expect.objectContaining({ tracking: 'LOT' }) });
    expect(defineProduct(eggs, { ...references, category: EGG_CATEGORY })).toEqual({ ok: true, value: expect.objectContaining({ tracking: 'NONE' }) });
  });

  it('tracks a countable flock by lot when its species is kept in lots, even with no shelf life (A-107)', () => {
    const broilers = { name: 'Broiler chicken', categoryId: LIVE_CATEGORY.id, stockPolicy: 'COUNTABLE', speciesId: GOAT, baseUom: 'HEAD', saleUom: 'HEAD', onlineMode: 'REQUEST_TO_BUY' } as const;
    expect(defineProduct(broilers, { ...references, speciesTrackingDefault: 'LOT' })).toEqual({ ok: true, value: expect.objectContaining({ tracking: 'LOT' }) });
    expect(defineProduct(broilers, { ...references, speciesTrackingDefault: 'SERIAL' })).toEqual({ ok: true, value: expect.objectContaining({ tracking: 'NONE' }) });
    expect(defineProduct(broilers, references)).toEqual({ ok: true, value: expect.objectContaining({ tracking: 'NONE' }) });
  });

  it('keeps an explicit tax category over the category default', () => {
    const override = '019a7a8a-c7c0-7f30-b5d6-e7f8a9b0c1d2';
    expect(defineProduct({ ...goat, taxCategoryId: override }, references)).toEqual({ ok: true, value: expect.objectContaining({ taxCategoryId: override }) });
  });

  it('refuses a serialised product without a species, and one listed for the cart', () => {
    const { speciesId: _omitted, ...noSpecies } = goat;
    expect(defineProduct(noSpecies, references)).toEqual({
      ok: false,
      error: { code: 'STOCK_POLICY_CONFLICT', fields: [{ field: '/speciesId', rule: 'REQUIRED_FOR_SERIALISED' }] },
    });
    expect(defineProduct({ ...goat, onlineMode: 'LISTED' }, references)).toEqual({
      ok: false,
      error: { code: 'STOCK_POLICY_CONFLICT', fields: [{ field: '/onlineMode', rule: 'LIVE_ANIMALS_ARE_REQUEST_TO_BUY' }] },
    });
  });

  it('refuses catch-weight stock held in anything but kilograms, and a pack size on anything else', () => {
    expect(defineProduct({ ...goat, stockPolicy: 'CATCH_WEIGHT', baseUom: 'PACK', onlineMode: 'LISTED' }, references)).toEqual({
      ok: false,
      error: { code: 'STOCK_POLICY_CONFLICT', fields: [{ field: '/baseUom', rule: 'CATCH_WEIGHT_IN_KG' }] },
    });
    expect(defineProduct({ ...goat, nominalPackKg: '15.000' }, references)).toEqual({
      ok: false,
      error: { code: 'STOCK_POLICY_CONFLICT', fields: [{ field: '/nominalPackKg', rule: 'ONLY_FOR_CATCH_WEIGHT' }] },
    });
  });

  it('refuses a non-stock product with a shelf life or a species', () => {
    const delivery: ProductDraft = { name: 'Delivery', categoryId: LIVE_CATEGORY.id, stockPolicy: 'NON_STOCK', baseUom: 'UNIT', saleUom: 'UNIT', onlineMode: 'HIDDEN' };
    expect(defineProduct(delivery, references)).toEqual({ ok: true, value: expect.objectContaining({ tracking: 'NONE' }) });
    expect(defineProduct({ ...delivery, shelfLifeDays: 3, speciesId: GOAT }, references)).toEqual({
      ok: false,
      error: {
        code: 'STOCK_POLICY_CONFLICT',
        fields: [
          { field: '/speciesId', rule: 'NOT_FOR_NON_STOCK' },
          { field: '/shelfLifeDays', rule: 'NOT_FOR_NON_STOCK' },
        ],
      },
    });
  });

  it('names every reference that does not exist, at once', () => {
    const result = defineProduct(
      { ...goat, baseUom: 'SACK', saleUom: 'BOX', taxCategoryId: '019a7a8a-0000-7000-8000-000000000000' },
      { ...references, category: null, speciesFound: false, taxCategoryFound: false },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'REFERENCE_NOT_FOUND',
        fields: [
          { field: '/categoryId', rule: 'UNKNOWN' },
          { field: '/speciesId', rule: 'UNKNOWN' },
          { field: '/taxCategoryId', rule: 'UNKNOWN' },
          { field: '/baseUom', rule: 'UNKNOWN' },
          { field: '/saleUom', rule: 'UNKNOWN' },
        ],
      },
    });
  });

  it('refuses a weight tolerance above one hundred percent or with more than four places', () => {
    expect(defineProduct({ ...goat, weightTolerancePercent: '100.01' }, references)).toEqual({
      ok: false,
      error: { code: 'STOCK_POLICY_CONFLICT', fields: [{ field: '/weightTolerancePercent', rule: 'PERCENT_0_TO_100' }] },
    });
  });
});

describe('the SKU is the server\'s, never input (B09q, ADR-0072)', () => {
  it('names the SKU of an input that carries one, whatever its value, and nothing for an input without one', () => {
    expect(serverAssignedFieldsIn({ name: 'Goat', sku: 'LIV-GOAT' })).toEqual(['/sku']);
    expect(serverAssignedFieldsIn({ sku: null })).toEqual(['/sku']);
    expect(serverAssignedFieldsIn({ sku: '' })).toEqual(['/sku']);
    expect(serverAssignedFieldsIn({ name: 'Goat', skuPrefix: 'LIV' })).toEqual([]);
    expect(serverAssignedFieldsIn({})).toEqual([]);
  });

  it('leaves the SKU out of a definition: it is allocated when the product is stored', () => {
    const result = defineProduct(goat, references);
    expect(result.ok && Object.keys(result.value)).not.toContain('sku');
    expect(result.ok && Object.keys(result.value)).not.toContain('barcode');
  });
});
