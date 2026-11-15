import { describe, expect, it } from 'vitest';
import { productBarcode } from './label';

describe('what a product label encodes (B05x, A-151)', () => {
  it("encodes the product's own barcode when it has one, as Code 128", () => {
    expect(productBarcode({ sku: 'EGG-CRATE-BIG', barcode: '6034123757' })).toEqual({ symbology: 'CODE_128', payload: '6034123757', text: '6034123757' });
  });

  it('encodes the SKU when the product has no barcode', () => {
    expect(productBarcode({ sku: 'PRD-YAM-TUBER', barcode: null })).toEqual({ symbology: 'CODE_128', payload: 'PRD-YAM-TUBER', text: 'PRD-YAM-TUBER' });
  });
});
