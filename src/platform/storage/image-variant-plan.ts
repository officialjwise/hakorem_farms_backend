/**
 * The responsive variants a public photograph is re-encoded into (FR-DOC-005, NFR-005, ADR-0045): three widths, each
 * as WebP with a JPEG fallback, each within a byte budget, keyed under the public prefix so the original's private key
 * never appears on the public origin. Pure: no I/O, no image library.
 */
export const VARIANT_NAMES = ['thumb', 'card', 'full'] as const;
export type VariantName = (typeof VARIANT_NAMES)[number];

/** FR-DOC-005's widths, in pixels: 320, 640 and 1280. */
export const VARIANT_WIDTHS: Readonly<Record<VariantName, number>> = { thumb: 320, card: 640, full: 1_280 };

export interface VariantFormat {
  readonly contentType: 'image/webp' | 'image/jpeg';
  readonly extension: 'webp' | 'jpg';
}

/** WebP first; JPEG is the fallback for a browser without WebP. */
export const VARIANT_FORMATS: readonly VariantFormat[] = [
  { contentType: 'image/webp', extension: 'webp' },
  { contentType: 'image/jpeg', extension: 'jpg' },
];

/** FR-DOC-005: no variant at 640 pixels above 200 KB, counted as 200,000 bytes. */
export const CARD_BUDGET_BYTES = 200_000;
const CARD_WIDTH = VARIANT_WIDTHS.card;

/**
 * Each variant's budget keeps the card's bytes per pixel (A-126): the thumbnail has a quarter of its pixels and a
 * quarter of its budget (50,000 bytes), the full variant four times both (800,000 bytes).
 */
export function budgetFor(name: VariantName): number {
  const ratio = VARIANT_WIDTHS[name] / CARD_WIDTH;
  return Math.round(CARD_BUDGET_BYTES * ratio * ratio);
}

/** Encoder qualities tried in turn until a rendition fits its budget. */
export const QUALITY_LADDER: readonly number[] = [80, 70, 60, 50, 40];

/** A photograph with more pixels than this is refused before it is decoded: about 8,200 by 6,100 (A-126). */
export const MAX_INPUT_PIXELS = 50_000_000;

/** A variant is never wider than its original: a narrow photograph is re-encoded at its own width, not enlarged. */
export function targetWidth(name: VariantName, originalWidth: number): number {
  return Math.min(VARIANT_WIDTHS[name], originalWidth);
}

/** The next quality to try after a rendition of `sizeBytes` at `quality`: null when it fits, 'OVER_BUDGET' when none is left. */
export function nextQuality(name: VariantName, sizeBytes: number, quality: number): number | null | 'OVER_BUDGET' {
  if (sizeBytes <= budgetFor(name)) return null;
  const next = QUALITY_LADDER.find((step) => step < quality);
  return next ?? 'OVER_BUDGET';
}

/** The public key of a variant: `p/<file id>/<variant>.<extension>`. The original's key is never derived from it. */
export function variantKey(fileId: string, name: VariantName, format: VariantFormat): string {
  return `p/${fileId}/${name}.${format.extension}`;
}

const PUBLISHED_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** Only a PUBLIC image is re-encoded and published; every other file stays private, served by signed link alone. */
export function isPublishedImage(classification: string, contentType: string): boolean {
  return classification === 'PUBLIC' && PUBLISHED_TYPES.includes(contentType);
}
