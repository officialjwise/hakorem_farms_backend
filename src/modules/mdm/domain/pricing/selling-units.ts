/**
 * The units a product is sold by at a till (B09b continued 2, CR-038): every unit some list in force holds an entry
 * for (an entry with no unit is the base unit's), that the product converts to its base unit, the sale unit first when
 * it is one of them and the rest by code. A unit with no entry is not sold, so a crate's price is never worked out from
 * an egg's. A product priced in no unit is not sold at the till at all (an empty list). Pure.
 */
export function sellingUnits(product: { readonly saleUom: string; readonly baseUom: string; readonly converts: (uom: string) => boolean }, entryUoms: readonly (string | null)[]): string[] {
  const units = new Set<string>();
  for (const uom of entryUoms) {
    const unit = uom ?? product.baseUom;
    if (unit === product.baseUom || product.converts(unit)) units.add(unit);
  }
  const rest = [...units].filter((u) => u !== product.saleUom).sort();
  return units.has(product.saleUom) ? [product.saleUom, ...rest] : rest;
}

/**
 * The unit a sale line is in when it names none (CR-038): the first unit the product is sold by, which is its sale
 * unit when it is priced in it (a crate of eggs) and otherwise the unit it is priced in (a meat pack sold by the
 * kilogram); the base unit when it is priced in none, so the engine answers that it needs a quote. Pure.
 */
export function defaultLineUom(baseUom: string, units: readonly string[]): string {
  return units[0] ?? baseUom;
}
