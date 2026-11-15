import { describe, expect, it } from 'vitest';
import { budgetFor, CARD_BUDGET_BYTES, isPublishedImage, nextQuality, QUALITY_LADDER, targetWidth, VARIANT_FORMATS, VARIANT_WIDTHS, variantKey } from './image-variant-plan';

describe('the variants of a public photograph (FR-DOC-005)', () => {
  it('has the widths 320, 640 and 1280, as WebP then JPEG', () => {
    expect(VARIANT_WIDTHS).toEqual({ thumb: 320, card: 640, full: 1_280 });
    expect(VARIANT_FORMATS.map((format) => format.contentType)).toEqual(['image/webp', 'image/jpeg']);
  });

  it('budgets 200,000 bytes at 640 pixels and keeps the bytes per pixel at the other widths', () => {
    expect(CARD_BUDGET_BYTES).toBe(200_000);
    expect(budgetFor('card')).toBe(200_000);
    expect(budgetFor('thumb')).toBe(50_000);
    expect(budgetFor('full')).toBe(800_000);
  });

  it('never enlarges a narrow photograph', () => {
    expect(targetWidth('full', 4_000)).toBe(1_280);
    expect(targetWidth('full', 900)).toBe(900);
    expect(targetWidth('thumb', 320)).toBe(320);
  });

  it('stops at the first quality that fits, steps down while over, and gives up below the last step', () => {
    expect(nextQuality('card', 200_000, 80)).toBeNull();
    expect(nextQuality('card', 200_001, 80)).toBe(70);
    expect(nextQuality('thumb', 50_001, 50)).toBe(40);
    expect(nextQuality('full', 800_001, QUALITY_LADDER.at(-1)!)).toBe('OVER_BUDGET');
  });

  it('keys a variant under the public prefix, never under the original key', () => {
    expect(variantKey('019a7aa1-6055-7206-b73e-29357e88a213', 'card', VARIANT_FORMATS[0]!)).toBe('p/019a7aa1-6055-7206-b73e-29357e88a213/card.webp');
    expect(variantKey('019a7aa1-6055-7206-b73e-29357e88a213', 'thumb', VARIANT_FORMATS[1]!)).toBe('p/019a7aa1-6055-7206-b73e-29357e88a213/thumb.jpg');
  });

  it('publishes only a PUBLIC image', () => {
    expect(isPublishedImage('PUBLIC', 'image/jpeg')).toBe(true);
    expect(isPublishedImage('PUBLIC', 'image/png')).toBe(true);
    expect(isPublishedImage('PUBLIC', 'application/pdf')).toBe(false);
    expect(isPublishedImage('CONFIDENTIAL', 'image/jpeg')).toBe(false);
  });
});
