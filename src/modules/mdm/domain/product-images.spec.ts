import { describe, expect, it } from 'vitest';
import { galleryVariants, judgeAttachment, MAX_SORT_ORDER, nextSortOrder, type VariantRendition } from './product-images';

const FILE = '019a7aa1-6055-7206-b73e-29357e88a213';
const photograph = (scanStatus: string) => ({ purpose: 'PRODUCT_IMAGE', scanStatus });

describe('attaching a photograph to a product (FR-DOC-005)', () => {
  it('attaches a CLEAN product photograph not yet in the gallery', () => {
    expect(judgeAttachment(photograph('CLEAN'), FILE, [])).toBeNull();
  });

  it('reads no file, and a file of any other use, as no such photograph', () => {
    expect(judgeAttachment(null, FILE, [])).toBe('NOT_A_PRODUCT_IMAGE');
    expect(judgeAttachment({ purpose: 'EVIDENCE', scanStatus: 'CLEAN' }, FILE, [])).toBe('NOT_A_PRODUCT_IMAGE');
  });

  it('refuses a photograph the scanner has not passed', () => {
    for (const status of ['PENDING', 'INFECTED', 'FAILED']) {
      expect(judgeAttachment(photograph(status), FILE, []), status).toBe('FILE_NOT_CLEAN');
    }
  });

  it('refuses the same photograph twice in one gallery', () => {
    expect(judgeAttachment(photograph('CLEAN'), FILE, [FILE])).toBe('ALREADY_ATTACHED');
  });
});

describe('the place of a new photograph', () => {
  it('is first in an empty gallery and after the highest otherwise, never past the cap', () => {
    expect(nextSortOrder([])).toBe(0);
    expect(nextSortOrder([0, 4, 2])).toBe(5);
    expect(nextSortOrder([MAX_SORT_ORDER])).toBe(MAX_SORT_ORDER);
  });
});

describe('the variants a gallery shows', () => {
  const rendition = (variant: VariantRendition['variant'], contentType: VariantRendition['contentType'], sizeBytes: number): VariantRendition => ({
    variant,
    contentType,
    url: `https://media.example/p/${FILE}/${variant}.${contentType === 'image/webp' ? 'webp' : 'jpg'}`,
    width: 640,
    height: 480,
    sizeBytes,
  });

  it('pairs each WebP rendition with its JPEG fallback, smallest first', () => {
    expect(galleryVariants([rendition('card', 'image/jpeg', 30_000), rendition('card', 'image/webp', 20_000), rendition('thumb', 'image/webp', 6_000), rendition('thumb', 'image/jpeg', 8_000)])).toEqual([
      { variant: 'thumb', url: `https://media.example/p/${FILE}/thumb.webp`, width: 640, height: 480, sizeBytes: 6_000, fallbackUrl: `https://media.example/p/${FILE}/thumb.jpg`, fallbackSizeBytes: 8_000 },
      { variant: 'card', url: `https://media.example/p/${FILE}/card.webp`, width: 640, height: 480, sizeBytes: 20_000, fallbackUrl: `https://media.example/p/${FILE}/card.jpg`, fallbackSizeBytes: 30_000 },
    ]);
  });

  it('leaves out a width that lacks either rendition', () => {
    expect(galleryVariants([rendition('full', 'image/webp', 90_000)])).toEqual([]);
  });
});
