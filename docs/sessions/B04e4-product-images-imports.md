# B04e continued 3: Product photographs and their public variants

Date: 2026-11-15 · Branch `b04e4-product-images-imports`, from `b04e3-file-store-imports` · Pull request #16 (stacked on #15, not merged) · Status: **phase split** (A-127). The product photograph part of the gate passed. MDM's imports and exports move to **B04e continued 4**.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Needs the owner's approval

- **New runtime dependency: `sharp` 0.35.5**, published 2026-09-27 (Apache-2.0). Its native parts come as prebuilt optional packages: `@img/sharp-linuxmusl-x64` 0.35.5 and `@img/sharp-libvips-linuxmusl-x64` 1.3.4 for the Alpine image, and the glibc pair on this machine.
  - It has no install script, so nothing was added to pnpm's `onlyBuiltDependencies`.
  - ADR-0045 is **Proposed** and argues the choice against `jimp`, the WebAssembly codecs and an external image service.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-126 | **Variants:**<br>- The contract's names keep their meaning at FR-DOC-005's widths: `thumb` 320, `card` 640, `full` 1280 pixels, never wider than the original.<br>- Each width is one `ImageVariant`: `url` is the WebP rendition, `fallbackUrl` the JPEG one, and both carry their size in bytes.<br>**Budgets:** "200 KB" is read as 200,000 bytes, for `card`. `thumb` and `full` keep its bytes per pixel, so 50,000 and 800,000. The database checks all three.<br>**Quality:** steps 80, 70, 60, 50, 40 until the image fits its budget. A photograph that fits at none, cannot be decoded, or has more than 50 million pixels is FAILED.<br>**When:** variants are rendered in the worker's scan, before CLEAN is recorded, so a CLEAN photograph always has them.<br>**Who:** attaching and removing need `mdm.product.update` (Owner, Manager). Someone else's upload also needs `platform.file.read.any`.<br>**Refusals:**<br>- a file of another use, or no file: 422 `REFERENCE_NOT_FOUND`;<br>- a file that is not CLEAN: 422 `FILE_NOT_CLEAN`;<br>- a photograph already in the gallery: 422 `DUPLICATE_VALUE`.<br>**Gallery:**<br>- With no `sortOrder`, a photograph goes last.<br>- A gallery change publishes `mdm.ProductChanged` (`images`) and does not move the product's `version`.<br>- Removing is a soft delete; the variants stay on the origin.<br>**Origin:** `MEDIA_PUBLIC_BASE_URL`.<br>**Seed:** no photographs are seeded | Owner |
| A-127 | **Split:** product photographs are built. The imports and exports (FR-MDM-019, FR-MDM-020) go to **B04e continued 4** (`b04e5-mdm-imports-exports`). `OPENING_STOCK` writes stock, which B5 builds; that session decides whether it waits for B5 | Owner |

Phase, scope and gate, as confirmed at the start:

1. Phase: B04e continued 3.
2. Scope as opened: product images through the file store with their variants, and MDM's imports and exports with a dry run. Scope as built, after the split (A-127): product images.
3. Gate as built: `addProductImage` attaches a CLEAN `PRODUCT_IMAGE` file through `mdm.product_image`. The file is re-encoded into variants at 320, 640 and 1280 pixels, WebP with a JPEG fallback, in `platform.stored_file_variant`. For a 4 MB JPEG, no variant at 640 pixels is above 200 KB. The original is never served publicly. Every write has a wrong-role refusal. The imports and exports part carries over to B04e continued 4.

## Contract changes

**1.13.0, additive** (`docs/CONTRACT_CHANGELOG.md`). Two more operations are served by the real API: `addProductImage` and `removeProductImage`. That makes 131 from code and 469 planned.

- **`ImageVariant`:** gains `sizeBytes`, `fallbackUrl` and `fallbackSizeBytes`, required in responses. They break nothing a client sends (ADR-0038). Every example with an image now shows 320, 640 and 1280.
- **The two operations:** descriptions and `x-error-codes` state their rules.
- **`Product.images`:** now carries the gallery, where it was always empty.

No field was removed, renamed or retyped. Redocly lint is clean, and `contract:generate` is up to date.

## Built

| Area | What |
| --- | --- |
| Domain | `src/platform/storage/image-variant-plan.ts`, under a new 100 percent gate: the widths, the budgets, the quality ladder, the pixel limit and the public keys `p/<file id>/<variant>.<webp\|jpg>`. `src/modules/mdm/domain/product-images.ts`, also under a 100 percent gate: which file may be attached, the next sort order, and how WebP and JPEG pair into a variant |
| Platform | `SharpImageRenderer`, behind the `ImageRenderer` port: it turns the image upright, resizes without enlarging, strips metadata and flattens transparency for the JPEG. `FileScanner`: when a PUBLIC image comes back CLEAN, it renders the variants, puts them in the public bucket, and records the verdict and the six variant rows in one transaction. Storage it cannot reach defers the file; an undecodable image is FAILED. `FileStore.publicVariants` returns the variants with their public URLs. `ensureBucket(..., { publicRead })` lets anyone read the development and test buckets by key, with no listing. A failed verdict is cut to 200 characters |
| MDM | `ProductGallery` (`add`, `remove`): it authorises first, then claims the idempotency key, locks the product, checks the file's owner, judges the file, writes the row, audits, and publishes `mdm.ProductChanged`. `DrizzleProductStore` reads each gallery and asks `FileStore` for the variants, with no join across schemas |
| Interface | `POST /products/{id}/images` and `DELETE /products/{id}/images/{imageId}` on `ProductsController`. Their two fragments moved out of the planned file |
| Migrations | `0036`: `platform.stored_file_variant` (PROJECTION, insert-only, written only by `hk_worker`), its HK007 guard and budget check, and `platform.require_clean_file`, added to `tooling/architecture.json`'s shared objects. `0037`: `mdm.product_image` (MASTER), with its HK008 guard. The full rollback and reapply passes in the migration-runner test |
| Configuration | `MEDIA_PUBLIC_BASE_URL`, which the API requires in staging and production. The worker requires `S3_BUCKET_PUBLIC_MEDIA` there. It is also in Compose and `.env.example` |
| Docs | ADR-0045 and the decision index. A-126, A-127, and ADR-0026 Amendments. `docs/API.md` section 16 and the changelog. `docs/data-model/platform.md` and `mdm.md`. The platform and MDM cards. `OPERATIONS` section 3.5. The openers: B04e continued 4 is inserted before B5, and B5 now reads its report |

## Decisions

- **ADR-0045 (proposed):**
  - **The library:** `sharp`.
  - **When rendering happens:** in the worker's scan, after ClamAV, so nothing unscanned is ever decoded and a CLEAN photograph always has its variants.
  - **How MDM asks the file store:** MDM's trigger cannot read platform's table. The schema-names check refused my first draft, which did. MDM's trigger now calls the platform function `platform.require_clean_file`, listed as a shared platform object like `allocate_number`.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15; unchanged since B04e continued 2)

| Request | Answer |
| --- | --- |
| CR-001 | Not this phase: stock is B5 |
| CR-003 | Point 2 is B5 |
| CR-004 | Answered (B3 and B04e continued) |
| CR-005 | **Declined again:** one scripted pass when the frontend resumes |
| CR-006 | Answered earlier |
| CR-007 | Already done; neither gallery operation needs step-up |
| CR-008 | Answered earlier |

## Deferred

- **To B04e continued 4:** MDM's imports and exports (FR-MDM-019, FR-MDM-020), with the spreadsheet library and its ADR.
- **To B13:**
  - provisioning the production public bucket's read policy and the media origin;
  - `freshclam` (unchanged).
- **Seed:** no product photograph is seeded (A-126).
- **Process note:** I loaded the `hakorem-security-review` skill only after writing the code, not before. The review was still run item by item before the pull request.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 556 passed. New: `image-variant-plan.spec.ts`, `image-renderer.spec.ts` (real libvips) and `product-images.spec.ts`; `app-config.spec.ts` extended |
| Integration | 497 passed. New: `doc/image-variants.integration.spec.ts` (12 tests). The handler walk covers 131 routes and now sends DELETE |
| Coverage, merged | 1,053 passed. Statements 93.13 percent, branches 84.34 percent (gate 80). Every 100 percent gate holds, including the two new ones |
| Contract | 44 passed. New: `b4/product-images.contract.spec.ts` (`Product`, `ImageVariant`, the 422 envelope, the empty 204) |
| Lint, type check | Clean |
| End to end | `product-slice.e2e.spec.ts` gains a gallery check on the production image: an unscanned photograph is 422 `FILE_NOT_CLEAN`, and the cashier gets 403. It runs in CI; I did not run it on this machine |

## Gate (the product photograph part)

**Passed.** I proved it by running `test/integration/doc/image-variants.integration.spec.ts`, against real PostgreSQL, Versity Gateway and libvips. The scanner port answers CLEAN there; the real ClamAV is proved in `file-store.integration.spec.ts`.

- **A 4 MB JPEG** (4,000,000 bytes or more, 3,400 by 2,550 pixels):
  - While it is PENDING, attaching it is 422 `FILE_NOT_CLEAN`.
  - After the scan it has six variants: 320, 640 and 1280 pixels wide, WebP and JPEG.
  - Each `card` rendition is at most 200,000 bytes.
  - Every variant is fetched anonymously from the public origin with its type and its recorded size.
- **The original:**
  - The public origin answers 404 for the original's key, for `p/<id>/original.jpg` and for `p/<id>`.
  - The private bucket answers 403 to an anonymous request.
- **Wrong roles:**
  - `addProductImage` and `removeProductImage` refuse the Accountant, Cashier, Sales, Driver, Farm hand, Storekeeper and a user with no grant, each audited, and nothing changes.
  - A user given `mdm.product.update` without `platform.file.read.any` cannot attach another user's upload.
- **Rules:**
  - A file of another use, or none, is `REFERENCE_NOT_FOUND`; an image already in the gallery is `DUPLICATE_VALUE`.
  - A replay returns the stored response; a different body under the same key is 409.
  - Removal is a soft delete with its reason, audited, and a second removal is 404.
  - An undecodable "JPEG" becomes FAILED with no variants.
  - Evidence files get no variants.
- **Database:**
  - HK008 refuses a PENDING or wrong-use file, and a change to an image's file.
  - HK007 refuses a variant of a confidential file.
  - The API role cannot insert a variant (42501), and no role can change one: 42501 for the worker, HK001 for the admin role.
  - The budget check refuses a 200,001-byte `card`.

**Not part of this gate (A-127):** the imports and exports, which are B04e continued 4's.

**CI:** see the end of this report.

## Security review (hakorem-security-review)

- **Boundaries:**
  - TB2, the back office: the gallery.
  - The worker: decoding.
  - The public media origin.
- **SECURE_CODING_STANDARDS, item by item:**
  - **Uploads:** passed.
    - An image is decoded only after ClamAV has passed it.
    - The pixel limit refuses decompression bombs.
    - The image is re-encoded with its metadata stripped, so no camera location is published.
    - The original stays private.
    - The public bucket can be read by key and cannot be listed.
  - **Authorisation:** checked in `ProductGallery`, deny by default, including object ownership of the file. No new permission and no new grant.
  - **Input:** zod strict schemas; all SQL is parameterised.
  - **Idempotency:** a claim in each write.
  - **Audit:** `CREATE` and `ARCHIVE` on `ProductImage`, with before and after. The verdict's audit lists the variants.
  - **Database roles:** the PROJECTION grants follow its class, and the data checks pass.
  - **Logging:** no content, no URL secrets.
  - **Secrets:** none added.
- **Not applicable, with the reason:**
  - payments and webhooks: none here;
  - exports: B04e continued 4.
- **Abuse:** no new case. Putting a photograph on the shop is limited to the Owner and the Manager and is audited.

## Notes for the frontend track

- **Attaching:** upload with `PRODUCT_IMAGE`, poll `getFile` until `CLEAN`, then call `addProductImage`.
- **Showing:** render `images[].variants` in a `<picture>`: WebP `url` with JPEG `fallbackUrl`, `srcset` by `width`, and lazy loading. No signed link is needed.
- **Errors:** 422 `FILE_NOT_CLEAN` means "still being checked" while the file is PENDING, and "this file cannot be used" when it FAILED (check `getFile`).

## Next session

B04e continued 4. The opener is in `docs/prompts/session-openers.md`, section "B04e continued 4 — MDM imports and exports":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e4-product-images-imports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019, FR-MDM-020 and SEC-009 in docs/SRS.md (nothing else), docs/data-model/mdm.md
(import jobs and their errors, and the tables of the entities an import writes), docs/data-model/platform.md
(the file store tables), the platform, MDM and DOC cards in docs/MODULE_BOUNDARIES.md, ADR-0041, ADR-0044,
ADR-0045 and A-124 to A-127 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and
run hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 4 only, on branch b04e5-mdm-imports-exports, branched from
b04e4-product-images-imports: MDM's imports and exports with a dry run (a spreadsheet library needs an ADR),
reading the IMPORT file through the platform FileStore; do not add a second upload path. Write the failing
tests first for every permission rule. Stop at the gate, write docs/sessions/B04e5-mdm-imports-exports.md,
push, and open a stacked pull request against b04e4-product-images-imports.
```

## CI

Every run that exists for each commit, checked through the GitHub API (CLAUDE.md step 6):

- **`c4131fc`** (the last code and docs commit before this report): push run `43680390159` **success**; pull_request run `43680412880` **success** (the jobs include the production image build with `sharp` on Alpine and the end-to-end suite on it).
- **This report's final commit:** its runs are named in the session's closing message, since a commit cannot name its own runs.
