# ADR-0045: Product photographs become public variants in the worker's scan, with `sharp`

- **Status:** Proposed (B04e continued 3; the new runtime dependency `sharp` 0.35.5 needs the owner's approval)
- **Date:** 2026-11-15
- **Session:** B04e continued 3
- **Deciders:** backend track; owner (the dependency)

## Context

FR-DOC-005: "An uploaded product photo is re-encoded into responsive variants (widths 320, 640 and 1280 pixels, WebP with a JPEG fallback), compressed, with the original kept private; only variants are served publicly, from a separate origin." Its acceptance: a 4 MB JPEG produces three variants, none above 200 KB at 640 pixels, and the original requested from the public origin is 404. NFR-005 budgets the catalogue page by these variants. ADR-0044 built the file store: uploads land PENDING in the private bucket and the worker's ClamAV scan marks them CLEAN; it left `platform.stored_file_variant` to this session. Node has no image codec, so re-encoding needs a library, and the repository's rule (ADR-0032, ADR-0037, A-076) is an exact pin, a version at least 14 days old, and the choice argued here. MDM may not read another schema's tables (`docs/MODULE_BOUNDARIES.md` rule 7, the schema-names check), so the product gallery cannot join the file store's.

## Options considered

1. **`sharp` 0.35.5** (published 2026-09-27, Apache-2.0): libvips through prebuilt binaries (`@img/sharp-*`, including `linuxmusl-x64` for the Alpine image), WebP and mozjpeg encoders, shrink-on-load, a decompression-bomb limit (`limitInputPixels`), EXIF orientation and metadata stripping. Three small JavaScript dependencies. No install script in this version, so nothing is added to pnpm's allowed builds; the native code arrives as an optional platform package. The de facto standard for this job in Node.
2. **`jimp`** (pure JavaScript): no native code, but no WebP encoder, several times slower, and its JPEG encoder compresses far worse, which is the requirement.
3. **WebAssembly codecs (`@jsquash/*`)**: WebP and mozjpeg without native binaries, but resizing, orientation and metadata handling would be hand-written around them, several packages to pin, and it is far slower in the worker.
4. **An external image service or the CDN's resizing**: a new vendor and a network dependency on the shop's critical path, and the original would have to be readable by it, against "the original kept private".

## Decision

Option 1, pinned exactly (`sharp` 0.35.5), behind the platform's `ImageRenderer` port with one adapter, `SharpImageRenderer` (`src/platform/storage/image-renderer.ts`). The rules are pure and under a 100 percent coverage gate (`src/platform/storage/image-variant-plan.ts`).

- **When:** in the worker's scan (ADR-0044), never in a request. When ClamAV says CLEAN for a PUBLIC image (only product photographs are PUBLIC, A-124), the worker decodes it, renders the variants, puts them in `S3_BUCKET_PUBLIC_MEDIA`, and records the CLEAN verdict and the six `platform.stored_file_variant` rows in one transaction. A clean photograph therefore always has its variants, and only a photograph ClamAV passed is ever decoded. A photograph that cannot be decoded, has more than 50 million pixels, or cannot be brought within its budget is recorded FAILED with the reason, and is never served or attached. Storage that cannot be reached, or no public bucket configured, leaves it PENDING for the next round.
- **What:** `thumb` 320, `card` 640 and `full` 1280 pixels wide, never wider than the original, the aspect ratio kept, turned upright from the orientation tag, no metadata (no camera location reaches the public origin); each as WebP and as JPEG (mozjpeg, transparency flattened onto white). Quality starts at 80 and steps down to 40 until the rendition fits its budget: 200,000 bytes for `card` (FR-DOC-005), and the same bytes per pixel for the others, 50,000 for `thumb` and 800,000 for `full` (A-126). The database checks the budgets.
- **Where:** `p/<file id>/<variant>.<webp|jpg>` in the public bucket, which anyone may read by key and nobody may list; the original stays under `product-image/<id>` in the private bucket, so the public origin answers 404 for it. `MEDIA_PUBLIC_BASE_URL` is the origin (required for the API in staging and production; in development and test the bucket's path-style URL on the object store, readable through a bucket policy set by `ensureBucket(..., { publicRead: true })`). Production's public bucket and origin are provisioned in B13.
- **The database:** `platform.stored_file_variant` (migration 0036, PROJECTION): written by `hk_worker` only, insert-only (`reject_change`), and a guard (HK007) that admits a variant only for a CLEAN public image. `mdm.product_image` (migration 0037, MASTER) refers to the file by its published key; its guard (HK008) calls **`platform.require_clean_file(file_id, purpose)`**, a function the file store publishes in `tooling/architecture.json`'s shared platform objects, so MDM's trigger asks the rule without reading platform's table.
- **Reading:** MDM's product store reads its own `mdm.product_image` rows and asks `FileStore.publicVariants(tx, fileIds)` for the variants and their public URLs. No join crosses a schema; no new port between modules.
- **Contract 1.13.0, additive:** `addProductImage` and `removeProductImage` are served by code; `ImageVariant` gains `sizeBytes`, `fallbackUrl` and `fallbackSizeBytes` (the WebP rendition is `url`, the JPEG one `fallbackUrl`), so the catalogue references variants "with width and size". The examples now show 320, 640 and 1280.

## Consequences

- The worker needs about 100 MB more memory while it renders a large photograph; it renders one at a time and keeps no decoded image cached.
- The image carries libvips's native code (prebuilt, musl on Alpine). A security fix in libvips is a `sharp` upgrade: change the pin, run `image-renderer.spec.ts` and `image-variants.integration.spec.ts`.
- An attached image's file never changes (HK008); a new photograph is a new image. Removing an image is a soft delete; its public variants stay where they are, since a cached page may still show them.
- Forbidden: decoding a file before ClamAV has passed it; serving or linking an original publicly; a variant row written by the API role.

## Verification

- `src/platform/storage/image-variant-plan.spec.ts` (100 percent gate) and `src/platform/storage/image-renderer.spec.ts`: widths, budgets, the quality ladder, orientation, no metadata, transparency, an undecodable file and the pixel limit.
- `test/integration/doc/image-variants.integration.spec.ts`: a 4 MB JPEG produces six variants, no `card` above 200,000 bytes, each fetched anonymously from the public origin at its recorded size; the original's key is 404 there and 403 on the private bucket; the wrong roles are refused; HK007 and HK008 refuse what they guard.
- `test/contract/b4/product-images.contract.spec.ts`: `Product` and `ImageVariant` as served match contract 1.13.0.
- The Docker image build in CI proves the musl binary installs and loads.
