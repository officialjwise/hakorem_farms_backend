/**
 * Which photograph may be attached to a product, and where it goes in the gallery (FR-MDM-001, FR-DOC-005). Pure: the
 * file store's record is handed in as two facts.
 */
export interface AttachableFile {
  readonly purpose: string;
  readonly scanStatus: string;
}

export type AttachRefusal = 'NOT_A_PRODUCT_IMAGE' | 'FILE_NOT_CLEAN' | 'ALREADY_ATTACHED';

/** The most photographs a gallery holds; the sort order of each is between 0 and this, less one (migration 0037). */
export const MAX_SORT_ORDER = 999;

/**
 * A file is attached when it is a product photograph (any other use, or no file, reads as no such photograph), its
 * malware scan said CLEAN (and so its public variants exist), and it is not already in this product's gallery.
 */
export function judgeAttachment(file: AttachableFile | null, fileId: string, attachedFileIds: readonly string[]): AttachRefusal | null {
  if (file === null || file.purpose !== 'PRODUCT_IMAGE') return 'NOT_A_PRODUCT_IMAGE';
  if (file.scanStatus !== 'CLEAN') return 'FILE_NOT_CLEAN';
  if (attachedFileIds.includes(fileId)) return 'ALREADY_ATTACHED';
  return null;
}

/** An image with no stated place goes last: one after the highest, or first in an empty gallery, never past the cap. */
export function nextSortOrder(sortOrders: readonly number[]): number {
  if (sortOrders.length === 0) return 0;
  return Math.min(Math.max(...sortOrders) + 1, MAX_SORT_ORDER);
}

export interface VariantRendition {
  readonly variant: 'thumb' | 'card' | 'full';
  readonly contentType: 'image/webp' | 'image/jpeg';
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
}

/** The contract's `ImageVariant`: the WebP rendition, with the JPEG one as its fallback. */
export interface GalleryVariant {
  readonly variant: 'thumb' | 'card' | 'full';
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly fallbackUrl: string;
  readonly fallbackSizeBytes: number;
}

const ORDER = ['thumb', 'card', 'full'] as const;

/** Pairs each width's WebP and JPEG renditions; a width without both is not shown. */
export function galleryVariants(renditions: readonly VariantRendition[]): GalleryVariant[] {
  const variants: GalleryVariant[] = [];
  for (const name of ORDER) {
    const webp = renditions.find((r) => r.variant === name && r.contentType === 'image/webp');
    const jpeg = renditions.find((r) => r.variant === name && r.contentType === 'image/jpeg');
    if (webp === undefined || jpeg === undefined) continue;
    variants.push({ variant: name, url: webp.url, width: webp.width, height: webp.height, sizeBytes: webp.sizeBytes, fallbackUrl: jpeg.url, fallbackSizeBytes: jpeg.sizeBytes });
  }
  return variants;
}
