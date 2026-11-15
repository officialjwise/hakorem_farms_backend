import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SharpImageRenderer } from './image-renderer';

const photograph = (width: number, height: number, options: { alpha?: boolean; orientation?: number } = {}) => {
  const channels = options.alpha === true ? 4 : 3;
  const image = sharp({ create: { width, height, channels, background: { r: 180, g: 120, b: 60, alpha: 0.5 } } });
  return options.alpha === true ? image.png().toBuffer() : image.jpeg({ quality: 90 }).withMetadata({ orientation: options.orientation ?? 1 }).toBuffer();
};

describe('SharpImageRenderer (FR-DOC-005)', () => {
  const renderer = new SharpImageRenderer();

  it('renders three widths as WebP and JPEG, in that order, at the photograph aspect ratio', async () => {
    const result = await renderer.render(await photograph(2_000, 1_500));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.variants.map((v) => `${v.variant}:${v.contentType}:${v.width}x${v.height}`)).toEqual([
      'thumb:image/webp:320x240',
      'thumb:image/jpeg:320x240',
      'card:image/webp:640x480',
      'card:image/jpeg:640x480',
      'full:image/webp:1280x960',
      'full:image/jpeg:1280x960',
    ]);
    const card = result.variants[2]!;
    expect((await sharp(card.content).metadata()).format).toBe('webp');
    expect((await sharp(result.variants[3]!.content).metadata()).format).toBe('jpeg');
  });

  it('never enlarges a narrow photograph', async () => {
    const result = await renderer.render(await photograph(500, 500));
    expect(result.ok && result.variants.map((v) => v.width)).toEqual([320, 320, 500, 500, 500, 500]);
  });

  it('turns a photograph upright from its orientation tag and keeps no metadata', async () => {
    const result = await renderer.render(await photograph(1_600, 800, { orientation: 6 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const card = result.variants.find((v) => v.variant === 'card' && v.contentType === 'image/jpeg')!;
    expect([card.width, card.height]).toEqual([640, 1_280]);
    const metadata = await sharp(card.content).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it('flattens transparency onto white for the JPEG fallback', async () => {
    const result = await renderer.render(await photograph(800, 600, { alpha: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const jpeg = result.variants.find((v) => v.contentType === 'image/jpeg')!;
    expect((await sharp(jpeg.content).metadata()).channels).toBe(3);
  });

  it('refuses bytes that are not a decodable image', async () => {
    const result = await renderer.render(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2_000, 7)]));
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^image could not be (decoded|re-encoded)/) });
  });

  it('refuses a photograph with more than 50 million pixels before decoding it', async () => {
    const result = await renderer.render(await sharp({ create: { width: 10_000, height: 5_001, channels: 3, background: '#000' } }).jpeg().toBuffer());
    expect(result).toEqual({ ok: false, reason: expect.stringMatching(/^image could not be decoded: .*pixel limit/) });
  });
});
