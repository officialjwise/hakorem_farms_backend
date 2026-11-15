# ADR-0046: Master data spreadsheets through a bounded codec on Node's zlib, with no new dependency

- **Status:** Proposed (B04e continued 4; awaiting the owner's review of the stacked pull request)
- **Date:** 2026-11-15
- **Session:** B04e continued 4
- **Deciders:** backend track

## Context

FR-MDM-019 imports products, customers, suppliers, locations, price list entries and opening stock from a spreadsheet with a dry run, and applies all rows or none; FR-MDM-020 exports master data to a spreadsheet, audited with its row count, by a signed expiring link, with step-up for a bulk export (SEC-009). ADR-0044 built the file store: an `IMPORT` upload is XLSX or CSV, sniffed from its bytes, scanned PENDING until CLEAN. The openers said a spreadsheet library needs an ADR. The repository's rule for a dependency (ADR-0032, ADR-0037, A-076) is an exact pin, at least 14 days old, argued here; the owner asked, for this phase, for the smallest, best-maintained option and none where the platform already does the job. A spreadsheet arriving from a user is hostile input: a ZIP can be a decompression bomb and an XML parser can expand entities.

## Options considered

1. **`exceljs` 4.4.0** (2023): full workbook model, but nine runtime dependencies (`archiver`, `unzipper`, `jszip`, `saxes`, `fast-csv`, `tmp` and more), no release since 2023, and far more surface than reading one sheet of text cells.
2. **SheetJS `xlsx` 0.18.5 from npm**: the npm release is from 2022 and carries known advisories (prototype pollution, ReDoS); newer releases are published only on the vendor's own CDN, outside the registry and its audit.
3. **`read-excel-file` 9.3.17 with `write-excel-file` 4.1.1**: small and maintained, but four more runtime packages (`fflate`, `saxen`, `worker-f`, `unzipper-esm`), two of them single-maintainer packages with little use, and a release two days old, under the 14-day floor.
4. **A bounded codec in platform on `node:zlib`**: Node 22 already inflates and deflates (`inflateRawSync` with `maxOutputLength`, `deflateRawSync`, `crc32`). What is left is the ZIP directory (about 150 lines) and the fixed vocabulary of a worksheet's parts, read as text with no DTD and no entity but the five XML predefines, and RFC 4180 CSV. It is code we own and must test, but it reads only what a sheet of text cells needs.

## Decision

Option 4. No dependency is added.

- **`src/platform/spreadsheet/`**, a mechanism with no business rule: `zip.ts` (reads stored and deflated parts; refuses encrypted, ZIP64 and multi-disk archives; at most 200 parts, 50 MB a part and 100 MB in all, the inflater itself stopped one byte past the limit, so a declared size is never trusted), `xlsx.ts` (the first sheet in workbook order through its relationship, shared strings with rich text and without phonetic runs, inline strings, booleans, cell references with gaps; formulas never evaluated, their cached value read as text; writes one sheet of inline strings in the Text number format, the header bold), `csv.ts` (RFC 4180, a byte order mark and CRLF on write, either line end on read), `spreadsheet.ts` (`readSheet` by sniffed type with a row limit; `writeSheet`, which neutralises a CSV cell that would start a formula with a leading apostrophe and takes it off when a CSV is read back; an XLSX cell is a string, which no program evaluates). Tested against workbooks written by openpyxl and LibreOffice (`test/fixtures/spreadsheets/`), and the writer's output opened by LibreOffice.
- **MDM owns imports** (`MdmImports`, `mdm.import_job`, `mdm.import_job_error`, migration 0039). Each entity is an `EntitySheet`: its columns, a check of its rows against the database, an apply through the entity's own service in the caller's transaction (`PartiesAdmin.createCustomerIn` and `updateCustomerIn` for customers), and its export rows. A module reads the import file through the platform `FileStore` (`FileStore.content`, only for a CLEAN file, outside any transaction), never through DOC.
- **The dry run** runs in `createImportJob`, within a 5,000-record limit, and writes only the job and its errors. **Apply** re-checks the rows inside one serializable transaction and writes them all, or none. The database holds the job rules (SQLSTATE HK009): an import's file is a CLEAN import file, asked through `platform.require_clean_file`; what a job is about never changes; the status only moves forward; an import with row errors is never applied; an applied import applied every row. A posted job is frozen (HK004).
- **An export** is a new file use, `EXPORT` (migration 0038; DOC lists it CONFIDENTIAL with no upload accepted), registered PENDING like every file. Its link is issued by `createFileSignedUrl` once the worker's scan has passed it, so ADR-0044's rule that nothing is served before CLEAN holds for files the server writes too. Every export needs a fresh step-up and is audited (`EXPORT`) with the entity, the format, the row count and `bulk` above 100 rows.

## Consequences

- No new package, no install script, no native code; the Docker image is unchanged.
- The codec reads text cells only. A date typed in a spreadsheet arrives as the serial number the file stores; the sheets this system writes have no date column. A phone typed as a number in a spreadsheet loses its leading zero; the templates this system writes store every cell as text, so a re-saved export keeps it.
- A new entity is a new `EntitySheet`; its rules stay in its own service.
- Forbidden: evaluating a formula, expanding a DTD or an external entity, reading an import file that is not CLEAN, or writing an entity from an import other than through its own service.

## Verification

- `src/platform/spreadsheet/spreadsheet.spec.ts`: round trips; the openpyxl and LibreOffice workbooks; a declared-size lie, too many parts, a part and a total over the limit; encrypted, ZIP64, multi-disk and unknown-method archives; out-of-order rows and cells; CSV quoting; formula neutralisation.
- `test/integration/mdm/import-jobs.integration.spec.ts` (FR-MDM-019) and `test/integration/mdm/master-data-export.integration.spec.ts` (FR-MDM-020, SEC-009).
