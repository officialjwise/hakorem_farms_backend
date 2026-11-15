# ADR-0044: The file store as built: a platform mechanism, DOC's operations, ClamAV in the worker

- **Status:** Proposed (B04e continued 2; awaiting the owner's review of the stacked pull request)
- **Date:** 2026-11-15
- **Session:** B04e continued 2
- **Deciders:** backend track

## Context

ADR-0009 puts the file store among the platform mechanisms ("upload validation, object storage port, signed URLs, access log, image variants") and says platform code holds no permission codes and does not decide who may do something. The contract already names `uploadFile`, `getFile` and `createFileSignedUrl` with the permissions `platform.file.upload` and `platform.file.read`, and ADR-0035 requires every handler to authorise in the application layer through IAM's policy engine. Platform (layer 1) cannot import IAM (layer 2), so a handler in `src/platform` cannot authorise. A-057 says the deployment needs a malware scanner (ClamAV) from the first upload. SA-11 sets the caps, SA-04 and `docs/security/DATA_CLASSIFICATION.md` the link lifetimes, SC-12 the upload rules.

## Options considered

1. **All of it in platform, with a new port** through which platform asks IAM to authorise. A port is allowed only as an exception (`docs/MODULE_BOUNDARIES.md` section 6), and the per-use allow-lists, caps and classifications are business rules, which ADR-0009 keeps out of platform.
2. **The operations in IAM.** IAM can authorise, but files are not identity, and IAM would own business rules about supplier invoices and import files.
3. **The mechanism in platform, the operations in DOC.** Platform's `FileStore` writes the object, keeps `platform.stored_file`, signs links and writes `platform.file_access_log`, with no rule about who or what. DOC (layer 3, "documents and media", the owner of FR-DOC-005 to FR-DOC-007) holds the uses, their allow-lists, caps and classifications, the `Files` handlers that authorise, and the controller. ADR-0009's division table already lists DOC's platform mechanism as "File store".

## Decision

Option 3.

- **Platform** (`src/platform/storage/`): `sniffContentType` (the type from the bytes: JPEG, PNG, WebP, PDF, an XLSX workbook told apart from any other ZIP, UTF-8 text as CSV); `FileStore` (`put` outside any transaction under `<use>/<UUIDv7>` in `S3_BUCKET_PRIVATE`, `register` in the caller's transaction with its audit event, `find`, `signedLink`, which signs locally with the store's clock and logs the issue); the `MalwareScanner` port with its one adapter `ClamdScanner` (clamd `zINSTREAM` over TCP); `FileScanner`, the worker's loop that reads each PENDING object outside a transaction, scans it, and records the verdict once as the SYSTEM principal "Malware scanner" (migration 0034). A scanner that cannot be reached leaves the file PENDING; PENDING is never served.
- **DOC** (`src/modules/doc/`, created now; templates and the archive still arrive in B8): `domain/file-use.ts` (the ten purposes of the contract's `FilePurpose`, each with its allow-list and classification; SA-11's caps by sniffed type: images 5 MB, PDF and spreadsheets 10 MB; only `CLEAN` is servable; `INFECTED` and `FAILED` are quarantined), `application/files.ts` (`Files`: authorise first, then type, cap, put, register, idempotency), `interface/files.controller.ts`. The operations keep their contract tag `platform`, so the generated client does not move them.
- **The database** holds three rules (migration 0033, SQLSTATE HK007): a stored file's content columns never change; a file is inserted `PENDING` and its status moves once; only `hk_worker` records a verdict, so the API role cannot mark its own upload clean.
- **The scanner** is `clamav/clamav:1.4.3` (published 2025, past the 14-day floor), the `scanner` service in `docker-compose.yml`. Development and CI run it with the signatures its image ships (`CLAMAV_NO_FRESHCLAMD=true`); production runs `freshclam` (B13, `docs/OPERATIONS.md`). The integration suite starts it only in the specs that scan.
- **Caps**: a declared body over 10 MB plus the multipart envelope is refused before a byte is read; multer's limit cuts off a longer body while it streams; the use's own cap (5 MB for images) is checked after the part is read, since the purpose field may arrive after the file.
- **No stub scanner.** `docs/OPERATIONS.md` had planned a `MALWARE_SCAN_MODE=stub` for local and CI; it is dropped. A stub that marks files clean would serve unscanned files; without `CLAMAV_HOST` the worker scans nothing and files stay `PENDING`.
- **Links** live `SIGNED_URL_TTL_SECONDS` (300, the shortest lifetime in the classification table and the contract's promise), whatever the classification.

## Consequences

- `docs/MODULE_BOUNDARIES.md` (platform and DOC cards) and `docs/data-model/platform.md` are updated. No new port between modules.
- MDM's product images (FR-DOC-005) and imports (FR-MDM-019) reference `platform.stored_file` and read it through `FileStore`, not through DOC; image variants (`platform.stored_file_variant`) are written by the platform mechanism when product images are built.
- The API reaches object storage with the files credential (`S3_ACCESS_KEY_ID`), which staging and production now require; the worker needs `CLAMAV_HOST` there.
- Uploading an object before its registration means a replayed or rolled-back upload leaves an unreferenced object in the private bucket. It is never served; a sweep of unreferenced objects is in `docs/BACKLOG.md`.

## Verification

`test/integration/doc/file-store.integration.spec.ts` against real PostgreSQL, Versity Gateway and ClamAV: the wrong roles refused and audited, ownership, sniffing, both caps, replay, EICAR found `INFECTED` and never served, a clean file linked and fetched, three issues three log rows, a tampered and an expired link refused by the store, an unreachable scanner leaving the file PENDING, and the HK007 rules. `src/modules/doc/domain/file-use.ts` is under a 100 percent coverage gate.
