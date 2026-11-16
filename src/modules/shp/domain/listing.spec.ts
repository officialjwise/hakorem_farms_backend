import { Quantity } from '@hakorem/kernel';
import { describe, expect, it } from 'vitest';
import { assignSlugs, availabilityLevel, priceRange, slugify } from './listing';

describe('catalogue slugs (FR-SHP-002)', () => {
  it('derives a slug from the name when the product has none', () => {
    expect(slugify('Eggs, big, crate of 30')).toBe('eggs-big-crate-of-30');
    expect(slugify('  Full chicken, 15 kg pack ')).toBe('full-chicken-15-kg-pack');
    expect(slugify('Kɔntomire!!')).toBe('k-ntomire');
    expect(slugify('***')).toBe('product');
  });

  it('keeps the product SEO slug, and tells two products with the same name apart by their SKU', () => {
    // Given out of id order: the earlier id keeps the plain slug, whatever order the products arrive in.
    const slugs = assignSlugs([
      { id: 'c', sku: 'MEAT-GOAT-15KG', name: 'Goat meat', seoSlug: 'goat-meat-15-kg-pack' },
      { id: 'b', sku: 'EGG-CRATE-SMALL', name: 'Eggs', seoSlug: null },
      { id: 'a', sku: 'EGG-CRATE-BIG', name: 'Eggs', seoSlug: null },
    ]);
    expect([...slugs.entries()].sort()).toEqual([
      ['a', 'eggs'],
      ['b', 'eggs-egg-crate-small'],
      ['c', 'goat-meat-15-kg-pack'],
    ]);
  });
});

describe('availability levels (FR-SHP-002)', () => {
  const one = Quantity.parse('1.000');
  it('shows ON_REQUEST for a request-to-buy product, whatever is in stock', () => {
    expect(availabilityLevel('REQUEST_TO_BUY', Quantity.parse('4.000'), one, 5n)).toBe('ON_REQUEST');
  });

  it('shows 3 crates as LOW at the threshold of 5, 0 as OUT, and 6 as IN_STOCK, never the count', () => {
    expect(availabilityLevel('LISTED', Quantity.parse('3.000'), one, 5n)).toBe('LOW_STOCK');
    expect(availabilityLevel('LISTED', Quantity.parse('5.000'), one, 5n)).toBe('LOW_STOCK');
    expect(availabilityLevel('LISTED', Quantity.parse('6.000'), one, 5n)).toBe('IN_STOCK');
    expect(availabilityLevel('LISTED', Quantity.zero(), one, 5n)).toBe('OUT_OF_STOCK');
  });

  it('counts catch-weight stock in whole nominal packs: 45 kg of 15 kg packs is 3, and 14.999 kg is none', () => {
    const pack = Quantity.parse('15.000');
    expect(availabilityLevel('LISTED', Quantity.parse('45.000'), pack, 5n)).toBe('LOW_STOCK');
    expect(availabilityLevel('LISTED', Quantity.parse('14.999'), pack, 5n)).toBe('OUT_OF_STOCK');
    expect(availabilityLevel('LISTED', Quantity.parse('90.000'), pack, 5n)).toBe('IN_STOCK');
  });
});

describe('a listed price range (FR-SHP-001)', () => {
  it('is the lowest list price, with the highest as the top only when it differs', () => {
    expect(priceRange([25_000n, 65_000n, 120_000n, 170_000n])).toEqual({ from: 25_000n, to: 170_000n });
    expect(priceRange([4_500n])).toEqual({ from: 4_500n, to: null });
    expect(priceRange([4_500n, 4_500n])).toEqual({ from: 4_500n, to: null });
    expect(priceRange([170_000n, 25_000n, 65_000n])).toEqual({ from: 25_000n, to: 170_000n });
    expect(priceRange([])).toEqual({ from: null, to: null });
  });
});
