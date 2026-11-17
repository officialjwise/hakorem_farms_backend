import { describe, expect, it } from 'vitest';
import { productLabel } from './label';

const eggs = {
  id: '019a7a8d-4c1e-7a35-9f62-1b0c2d3e4f50',
  sku: 'EGG-0003',
  name: 'Eggs, big, crate of 30',
  saleUom: 'CRATE',
  nominalPackKg: null,
  shelfLifeDays: 21,
  storageTempClass: 'AMBIENT',
} as const;

describe('what a product label prints (B05x, A-151; no barcode from contract 2.0.0, ADR-0072)', () => {
  it('prints the SKU, name, sale unit, pack weight, shelf life and storage class, and nothing else', () => {
    expect(productLabel(eggs)).toEqual({
      product: { id: eggs.id, sku: 'EGG-0003', name: 'Eggs, big, crate of 30' },
      saleUom: 'CRATE',
      nominalPackKg: null,
      shelfLifeDays: 21,
      storageTempClass: 'AMBIENT',
    });
  });

  it('carries no barcode, whatever else the product holds', () => {
    const label = productLabel({ ...eggs, barcode: '6034123757', description: 'Big eggs' } as typeof eggs);
    expect(Object.keys(label).sort()).toEqual(['nominalPackKg', 'product', 'saleUom', 'shelfLifeDays', 'storageTempClass']);
    expect(Object.keys(label.product).sort()).toEqual(['id', 'name', 'sku']);
  });
});
