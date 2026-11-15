import sharp from 'sharp';
import { MAX_INPUT_PIXELS, nextQuality, QUALITY_LADDER, targetWidth, VARIANT_FORMATS, VARIANT_NAMES, type VariantFormat, type VariantName } from './image-variant-plan';

/** One rendition of a photograph, ready to publish. */
export interface RenderedVariant {
  readonly variant: VariantName;
  readonly contentType: VariantFormat['contentType'];
  readonly extension: VariantFormat['extension'];
  readonly width: number;
  readonly height: number;
  readonly content: Buffer;
}

export type RenderResult =
  | { readonly ok: true; readonly variants: readonly RenderedVariant[] }
  | { readonly ok: false; readonly reason: string };

/** Re-encodes a photograph into its public variants (ADR-0045). */
export interface ImageRenderer {
  render(content: Buffer): Promise<RenderResult>;
}

// The worker renders one photograph at a time; libvips keeps no cache of decoded images between them.
sharp.cache(false);

/**
 * The one image adapter (ADR-0045): libvips through sharp. Every variant is decoded from the original afresh, turned
 * upright from its orientation tag, resized without enlarging, and encoded with no metadata, so no camera location or
 * serial number reaches the public origin. A photograph that cannot be decoded, has more than MAX_INPUT_PIXELS, or
 * cannot be brought within a variant's budget is refused with the reason, never published.
 */
export class SharpImageRenderer implements ImageRenderer {
  async render(content: Buffer): Promise<RenderResult> {
    let originalWidth: number;
    try {
      const metadata = await sharp(content, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate().metadata();
      originalWidth = (metadata.orientation ?? 1) >= 5 ? metadata.height : metadata.width;
    } catch (error) {
      return { ok: false, reason: `image could not be decoded: ${error instanceof Error ? error.message : String(error)}` };
    }
    const variants: RenderedVariant[] = [];
    try {
      for (const variant of VARIANT_NAMES) {
        for (const format of VARIANT_FORMATS) {
          const rendered = await this.fit(content, variant, format, targetWidth(variant, originalWidth));
          if (rendered === null) {
            return { ok: false, reason: `image cannot be compressed within the ${variant} budget as ${format.contentType}` };
          }
          variants.push(rendered);
        }
      }
    } catch (error) {
      return { ok: false, reason: `image could not be re-encoded: ${error instanceof Error ? error.message : String(error)}` };
    }
    return { ok: true, variants };
  }

  /** The first quality on the ladder whose rendition fits the budget, or null when none does. */
  private async fit(content: Buffer, variant: VariantName, format: VariantFormat, width: number): Promise<RenderedVariant | null> {
    let quality: number | null | 'OVER_BUDGET' = QUALITY_LADDER[0]!;
    while (typeof quality === 'number') {
      const pipeline = sharp(content, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate().resize({ width, withoutEnlargement: true });
      const encoded = format.contentType === 'image/webp' ? pipeline.webp({ quality }) : pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      const next = nextQuality(variant, data.length, quality);
      if (next === null) {
        return { variant, contentType: format.contentType, extension: format.extension, width: info.width, height: info.height, content: data };
      }
      quality = next;
    }
    return null;
  }
}
