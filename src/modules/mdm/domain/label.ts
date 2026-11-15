/** The one barcode symbology labels carry until a printer or scanner needs another (A-151): Code 128 takes any ASCII. */
export const LABEL_SYMBOLOGY = 'CODE_128';

export interface ProductLabelBarcode {
  readonly symbology: typeof LABEL_SYMBOLOGY;
  readonly payload: string;
  readonly text: string;
}

/** A product label encodes the product's own barcode, or its SKU when it has none (B05x, A-151). */
export function productBarcode(product: { readonly sku: string; readonly barcode: string | null }): ProductLabelBarcode {
  const payload = product.barcode ?? product.sku;
  return { symbology: LABEL_SYMBOLOGY, payload, text: payload };
}
