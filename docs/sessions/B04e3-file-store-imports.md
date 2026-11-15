# B04e continued 2: The file store, uploads and the malware scanner

Date: 2026-11-15 · Branch `b04e3-file-store-imports`, from `b04e2-auth-approvals` · Pull request #15 (stacked on `b04e2-auth-approvals`, not merged) · Status: **phase split** (A-125). The file store part of the gate passed; product images and MDM's imports and exports move to **B04e continued 3**.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (all in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-124 | **Who:** the Owner, Manager, Accountant and Storekeeper hold `platform.file.upload` and `platform.file.read`. Reading or linking someone else's file also needs the new `platform.file.read.any` (Owner, Manager, Accountant). The Cashier, Sales, farm hand, Driver, customer and investor roles hold none yet; B6 and B11 grant them with their uses. **Uses:** the contract's ten purposes, each with an allow-list. Product photographs are PUBLIC, every other use CONFIDENTIAL. **Caps (SA-11):** images 5 MB, PDF and spreadsheets 10 MB. A body over 10 MB is cut off while it arrives; the 5 MB image cap is checked once the part is read. **Links:** five minutes for every classification (SA-04's 15 minutes for confidential files is not used). **Showing:** `getFile` shows a PENDING file so its uploader can follow the scan, and refuses an INFECTED or FAILED one with 422 `FILE_NOT_CLEAN`. **Scanner:** if it cannot be reached, the file stays PENDING and is retried; an unrecognised clamd reply is FAILED. **Evidence:** `Approvals.request` takes an optional `evidenceFileId`; the foreign key checks it exists, and nothing yet checks it is the maker's or CLEAN | Owner |
| A-125 | **Split:** this session built the file store end to end. Product images (FR-DOC-005, which needs an image library and its ADR) and MDM's imports and exports (FR-MDM-019, FR-MDM-020, which need a spreadsheet library and its ADR, over nine entities and seven operations) would not reach their gate in this context. **B04e continued 3** (`b04e4-product-images-imports`) builds both; B5 opens after it | Owner |
| A-057 (updated) | The scanner part is built: `clamav/clamav:1.4.3`, the worker's scan loop (ADR-0044). Alertmanager and the exporters remain B13's | Backend lead |

Phase, scope and gate, as confirmed at the start:

1. Phase: B04e continued 2.
2. Scope as opened: the file store (`uploadFile`, `getFile`, `createFileSignedUrl`), the malware scanner (A-057), `evidence_file_id`, product images, and MDM's imports and exports with a dry run. Scope as built, after the split (A-125): the file store, the scanner and `evidence_file_id`.
3. Gate as built: the three file operations are live on the platform file store with every rule the opener names, each with a wrong-role refusal, and `iam.approval_request.evidence_file_id` exists with its foreign key. The opener also named product images and the imports and exports; they carry over to B04e continued 3 with the rest of the gate.

## Contract changes

**1.12.0, additive** (`docs/CONTRACT_CHANGELOG.md`). Three more operations are served by the real API: `uploadFile`, `getFile` and `createFileSignedUrl`. That makes 129 from code and 471 planned.

What else changed:

- **New responses on `uploadFile`:**
  - 413 `PAYLOAD_TOO_LARGE`.
  - 415 `FILE_TYPE_NOT_ALLOWED`.
- **New response on `getFile`:** 422 `FILE_NOT_CLEAN`.
- **Error codes:** all three were already in `docs/API.md` section 10.
- **Descriptions and `x-error-codes`:** on the three operations, they state each operation's rules.
- **Tag:** the three operations keep the tag `platform`, so the generated client does not move them.
- **`ApprovalRequest.evidenceFileId`:** now carries a value, where it was always null.

No schema, field or request changed shape. Redocly lint is clean, and `contract:generate` is up to date.

## Built

| Area | What |
| --- | --- |
| Domain | `src/modules/doc/domain/file-use.ts`, under a new 100 percent gate: the ten purposes with their allow-lists and classifications, SA-11's caps, what is servable and what is quarantined. `src/platform/storage/content-sniffer.ts`, also under a 100 percent gate: the type from the bytes. It recognises JPEG, PNG, WebP and PDF, tells an XLSX workbook from any other ZIP, and takes UTF-8 text as CSV |
| Application | `Files` in the new DOC module: it authorises first, deny by default. Then it sniffs, judges the upload, puts the object outside any transaction, and registers it in a serialisable transaction with an idempotency key. Reading checks ownership against `platform.file.read.any`. A link is issued only for a CLEAN file |
| Platform | `FileStore`: put under `<use>/<UUIDv7>`, register with an audit event, find, and `signedLink`, which signs locally with the store's clock and writes a `platform.file_access_log` row. The `MalwareScanner` port, with `ClamdScanner` over clamd `zINSTREAM`. `FileScanner`, the worker's `file-scan` loop, which records the verdict once as the new SYSTEM principal "Malware scanner". The API now reaches object storage with the files credential |
| Interface | `FilesController`: multer under the 10 MB cap, plus a declared-length check before the body is read. Three fragments moved from the planned file |
| Migrations | `0033`: `platform.stored_file` (MASTER) and `platform.file_access_log` (LEDGER), with the `stored_file_guard` trigger (HK007). `0034`: `evidence_file_id` and its foreign key, the scanner principal, and three permissions. `0035`: their grants. The full rollback and reapply passes in the migration-runner test |
| IAM | `Approvals.request` takes `evidenceFileId`, which `PgApprovalStore` stores and reads; the inbox shows it |
| Configuration | `CLAMAV_HOST`, `CLAMAV_PORT`, `CLAMAV_TIMEOUT_MS` and `FILE_SCAN_INTERVAL_MS`. Staging and production now require the S3 files settings, and the worker there requires `CLAMAV_HOST`. The `scanner` service is in `docker-compose.yml` under `--profile scanner`, because it takes about 1.2 GB of memory |
| Docs | ADR-0044, A-124, A-125 and A-057. `docs/API.md` section 16 and the approvals note. The changelog. `docs/data-model/platform.md` and `iam.md`. The platform and DOC cards. `OPERATIONS` section 3.5. BL-046. ADR-0026 Amendments. The openers |

## Decisions

- **ADR-0044:**
  - **Where the parts live:** the file store is a platform mechanism, and its operations are DOC's. ADR-0009 keeps permission codes and business rules out of platform, and platform cannot import IAM's policy engine, so the handlers live in DOC (layer 3). No new port.
  - **Who records a verdict:** only `hk_worker` can, enforced in the database.
  - **No stub scanner:** `OPERATIONS` had planned `MALWARE_SCAN_MODE=stub`. It is dropped, because a stub would serve files nobody scanned.
- **Real ClamAV in the tests:** the integration spec starts it itself, not in the shared global setup. It needs a gigabyte of memory and up to a minute to start.

## Contract requests (`../frontend/docs/CONTRACT_REQUESTS.md`, read 2026-11-15)

| Request | Answer |
| --- | --- |
| CR-001 | Not this phase: stock is B5 |
| CR-003 | Point 2 is B5 |
| CR-004 | Answered (B3 and B04e continued) |
| CR-005 | **Declined again:** one scripted pass when the frontend resumes |
| CR-006 | Answered earlier |
| CR-007 | Already done; none of the three file operations needs step-up |
| CR-008 | Answered earlier |

## Deferred

- **To B04e continued 3:**
  - product images (FR-DOC-005: `addProductImage`, the variants, `platform.stored_file_variant`, the public origin);
  - MDM's imports and exports (FR-MDM-019, FR-MDM-020).
- **To B6 and B11:** the grants for mortality photographs and proof of delivery, which those sessions give the farm hand and the Driver with their uses.
- **To B13:**
  - `freshclam` and the scanner container in production;
  - the alert on `hk_files_infected_total`.
- **Backlog BL-046:** a sweep of objects nobody references, which a replayed or rolled-back upload leaves in the private bucket.
- **Seed:** nothing is seeded. The seeded farm has no files; product photographs come with B04e continued 3.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | 536 passed. New: `file-use.spec.ts` and `content-sniffer.spec.ts`, both at 100 percent on all four measures under new `fullCoverage` gates; `malware-scanner.spec.ts`; `app-config.spec.ts` extended. Every earlier gate holds |
| Integration | 485 passed. New: `doc/file-store.integration.spec.ts` (17 tests, against the real ClamAV); `roles-approvals` gains the evidence test; the handler walk covers 129 routes |
| Coverage, merged | 1,021 passed. Statements 93.03 percent, branches 84.22 percent (gate 80); every 100 percent gate holds |
| Contract | 43 passed. New: `b4/file-store.contract.spec.ts` covers `StoredFile`, `SignedUrl` and the 413, 415 and 422 envelopes; the drift probe now claims a B8 operation |
| Test support | The coupon race in `promotion-schema.integration.spec.ts` built its own pool with no error listener. On CI, the forced drop of its database at teardown terminated that pool's closing clients (57P01), and the unhandled pool error failed the coverage job of push run `43678168649`. `expectTeardownTermination` in `test/support/test-database.ts` now guards every pool a test opens, and the file then passed three times running here |
| Lint, type check | Clean |
| End to end | `product-slice.e2e.spec.ts` gains an upload on the built stack: the Manager's file is stored PENDING and typed by its bytes, and the Cashier gets 403. It runs in CI on the production image; I did not run it on this machine |

## Gate (the file store part)

**Passed.** I proved it by running these tests in `test/integration/doc/file-store.integration.spec.ts`, against real PostgreSQL, Versity Gateway and ClamAV 1.4.3:

- **Wrong roles:**
  - The Cashier, Sales, the Driver, the farm hand and a user with no grant are each refused `uploadFile`, `getFile` and `createFileSignedUrl` with 403. Nothing is stored, and every upload refusal is audited.
  - One Storekeeper is refused another's file; the Manager and the Accountant read it.
  - The handler walk now covers all 129 routes, and a user with no grant gets 403 on each.
- **Size cap before the body is read:**
  - A 12 MB PDF is 413, and a declared 11 MB body is 413 unread.
  - A 6 MB photograph is 413 at the 5 MB cap.
  - A 10 MB PDF is accepted.
- **Type by content sniffing:**
  - A ZIP renamed `.jpg` is 415.
  - A JPEG named `../../etc/report.pdf` is stored as `image/jpeg`. Its name keeps no path, its key is `evidence/<uuid>`, and its SHA-256 and the bytes in storage match.
- **PENDING until CLEAN:**
  - EICAR is found `INFECTED` by the real scanner. After that, `getFile` and `createFileSignedUrl` answer 422 `FILE_NOT_CLEAN`, and the verdict is audited as the scanner principal.
  - A clean photograph becomes `CLEAN`, and its link fetches exactly its bytes.
  - If the scanner cannot be reached, the file stays `PENDING` and is not linked.
- **Signed expiring links, logged:**
  - Each link expires 300 s after it was signed.
  - Three issues give three `file_access_log` rows, with the address.
  - One extra character in the signature is 403, and so is a link used 5 minutes and 1 second after it was signed.
- **Database:**
  - HK007 refuses the API role recording a verdict, a changed content column, a second verdict, and a row inserted as CLEAN.
  - The access log refuses update for every role.
- **`evidence_file_id`:**
  - The foreign key refuses an unknown file and takes a stored one.
  - `roles-approvals.integration.spec.ts` shows an uploaded evidence id in `getApproval`, and null where there is none.
- **Replay:** the same key returns the first response with one row; a different body under that key is 409.

**Not part of this gate (A-125):** product images and the imports and exports, which are B04e continued 3's gate.

**CI:** see the end of this report.

## Security review (hakorem-security-review)

- **Boundaries:**
  - TB2, the back office: uploads and reads.
  - The database: the verdict guard.
  - The worker: the scan.
- **SECURE_CODING_STANDARDS, item by item:**
  - **SC-12, uploads:** passed. The size cap applies before the body is fully read. The type comes from sniffing against a per-purpose allow-list. The key is random with no user input, in the private bucket. Files are PENDING until the worker's scan, and only CLEAN is served. The original name is kept for display only, with path separators and control characters removed.
  - **Authorisation:** the check is in `Files` and denies by default, with object ownership through `platform.file.read.any`. New permissions are granted only by migration 0035, to four roles. Every refusal is audited detached.
  - **Input:** zod checks `purpose` strictly. Multer allows one file and one field, and anything more is 400. All SQL is parameterised.
  - **Idempotency:** the key is claimed in the registering transaction, and a replay returns the stored response.
  - **Logging:** no file content and no signed URL is logged. The infected signature is logged with the file id.
  - **Data:** the access log IP is CONFIDENTIAL in a LEDGER table, as DATA_CLASSIFICATION L-1 already records for `platform.file_access_log.ip`.
  - **External calls:** the object put happens before the transaction, never inside one. Signing is local.
  - **Secrets:** `S3_SECRET_ACCESS_KEY` comes from the environment only. No secret was added.
- **Not applicable, with the reason:**
  - payments and webhooks: none here;
  - exports: B04e continued 3;
  - image re-encoding: B04e continued 3, so originals are not served publicly at all yet;
  - the public media origin: nothing public exists yet.
- **Abuse:**
  - SEC-027 holds: infected files are quarantined and logged, with a counter for the alert (B13).
  - No new abuse case: storage exhaustion by an insider is bounded by the cap, the permission and the rate limit group `console`.

## Notes for the frontend track

- **Uploading:** send the multipart form with `purpose` before `file`. The answer is `PENDING`; poll `getFile` until `CLEAN` before asking for a link.
- **Errors to name:** 415 means the file is the wrong kind for that use, and 413 means it is too large (5 MB for images, 10 MB for PDF and spreadsheets). A 422 `FILE_NOT_CLEAN` means it failed the virus check.
- **Links:** a link lasts five minutes; ask again rather than caching it.

## Next session

B04e continued 3. The opener is in `docs/prompts/session-openers.md`, section "B04e continued 3 — Product images and MDM imports and exports":

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B04e3-file-store-imports.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-MDM-019, FR-MDM-020, FR-DOC-005 and SEC-009 in docs/SRS.md (nothing else),
docs/data-model/mdm.md (product images, import jobs and their errors), docs/data-model/platform.md
(the file store tables), the platform, MDM and DOC cards in docs/MODULE_BOUNDARIES.md, ADR-0041, ADR-0044
and A-124 and A-125 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe, and run
hakorem-security-review on every operation: they are uploads, exports and permissions.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B04e continued 3 only, on branch b04e4-product-images-imports, branched from
b04e3-file-store-imports: product images through the file store with their variants (an image library
needs an ADR), and MDM's imports and exports with a dry run (a spreadsheet library needs an ADR). Reuse
the platform FileStore and the DOC upload; do not add a second upload path. Write the failing tests first
for every permission rule. Stop at the gate, write docs/sessions/B04e4-product-images-imports.md, push,
and open a stacked pull request against b04e3-file-store-imports.
```

## CI

Every run that exists for each commit, checked through the GitHub API (CLAUDE.md step 6):

- **`3f6a3aa`** (the first report commit): pull_request run `43678190066` **success**. Push run `43678168649` **failed**: every test passed, but the coverage job counted two unhandled 57P01 teardown errors from `promotion-schema.integration.spec.ts`. Fixed in `test(support): guard a pool a test builds itself against the teardown termination`.
- **This report's final commit:** its runs are named in the session's closing message, since a commit cannot name its own runs.
