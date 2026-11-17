/** The facts of a product a shelf label prints. */
export interface ProductLabelFacts {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly saleUom: string;
  readonly nominalPackKg: string | null;
  readonly shelfLifeDays: number | null;
  readonly storageTempClass: 'AMBIENT' | 'CHILLED' | 'FROZEN' | null;
}

/** The contract's `ProductLabel`: what a shelf or counter label prints, as text. */
export interface ProductLabelPrint {
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly saleUom: string;
  readonly nominalPackKg: string | null;
  readonly shelfLifeDays: number | null;
  readonly storageTempClass: 'AMBIENT' | 'CHILLED' | 'FROZEN' | null;
}

/**
 * What a product label prints (B05x, A-151): its SKU, name, sale unit, nominal pack weight, shelf life and storage
 * class. From contract 2.0.0 a label carries no barcode (owner 2026-11-17, ADR-0072); it is built field by field, so
 * nothing else the product holds can reach it.
 */
export function productLabel(product: ProductLabelFacts): ProductLabelPrint {
  return {
    product: { id: product.id, sku: product.sku, name: product.name },
    saleUom: product.saleUom,
    nominalPackKg: product.nominalPackKg,
    shelfLifeDays: product.shelfLifeDays,
    storageTempClass: product.storageTempClass,
  };
}
