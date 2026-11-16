import type { Quantity } from '@hakorem/kernel';

export type Availability = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'ON_REQUEST';

const MAX_SLUG = 80;

/** A URL slug from a product name: lower-case letters and digits joined by single hyphens. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/g, '');
  return slug.length === 0 ? 'product' : slug;
}

/**
 * Each listed product's slug (A-178): its SEO slug if it has one, else one made from its name; a slug already taken
 * by a product earlier in id order is told apart by the product's SKU. Deterministic, so a refresh keeps every link.
 */
export function assignSlugs(products: readonly { readonly id: string; readonly sku: string; readonly name: string; readonly seoSlug: string | null }[]): Map<string, string> {
  const taken = new Set(products.flatMap((p) => (p.seoSlug === null ? [] : [p.seoSlug])));
  const result = new Map<string, string>();
  for (const product of [...products].sort((a, b) => a.id.localeCompare(b.id, 'en'))) {
    if (product.seoSlug !== null) {
      result.set(product.id, product.seoSlug);
      continue;
    }
    const base = slugify(product.name);
    const slug = taken.has(base) ? slugify(`${base}-${product.sku}`) : base;
    taken.add(slug);
    result.set(product.id, slug);
  }
  return result;
}

/**
 * What a visitor is told about stock, never the count (FR-SHP-002, SA-19): a request-to-buy product is on request;
 * otherwise the whole sale units available (packs of the nominal weight, crates, heads), out at none and low up to
 * the threshold.
 */
export function availabilityLevel(onlineMode: 'LISTED' | 'REQUEST_TO_BUY', available: Quantity, basePerSaleUnit: Quantity, lowAt: bigint): Availability {
  if (onlineMode === 'REQUEST_TO_BUY') return 'ON_REQUEST';
  const units = available.thousandths <= 0n ? 0n : available.thousandths / basePerSaleUnit.thousandths;
  if (units === 0n) return 'OUT_OF_STOCK';
  return units <= lowAt ? 'LOW_STOCK' : 'IN_STOCK';
}

/** "From ... to ...": the lowest resolved list price, and the highest when it is higher (FR-SHP-001). */
export function priceRange(listPrices: readonly bigint[]): { readonly from: bigint | null; readonly to: bigint | null } {
  if (listPrices.length === 0) return { from: null, to: null };
  const from = listPrices.reduce((a, b) => (b < a ? b : a));
  const top = listPrices.reduce((a, b) => (b > a ? b : a));
  return { from, to: top > from ? top : null };
}
