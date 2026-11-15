# ADR-0050: A higher module contributes an import sheet to MDM's imports through a port

- **Status:** Proposed (B05 continued 4; awaiting the owner)
- **Date:** 2026-11-15
- **Session:** B05 continued 4
- **Deciders:** backend track

## Context

FR-MDM-019 lists opening stock among the spreadsheets MDM imports, and ADR-0046 built the import mechanism in MDM: `MdmImports` reads a CLEAN file, runs the dry run and applies every row in one serializable transaction, or none, through one `EntitySheet` per entity whose rows go through the entity's own service. Opening stock is not master data. Its rows create stock units, movements and cost pools, which INV owns (MODULE_BOUNDARIES section 4), and INV is layer 5, above MDM (layer 3). MDM may not import INV, so it cannot build the sheet itself; A-128 left `OPENING_STOCK` answering `IMPORT_ENTITY_NOT_AVAILABLE` until B5. The B05 continued 4 opener asks for the sheet to be INV's, registered with `MdmImports` through a port MDM defines and INV implements, and section 6 says a new port needs an ADR.

## Options considered

1. **A separate opening stock endpoint in INV.** No port, but a second upload, dry run, all-or-none apply and job record beside MDM's, and a contract change for a screen that already exists (`createImportJob` with `entity: OPENING_STOCK`).
2. **MDM writes the stock tables.** Breaks the one-owner rule and the schema check.
3. **`EntitySheet` as a port.** MDM publishes `EntitySheet` (with its `SheetCheck`, `SheetRecords`, `readRows`, `duplicateErrors` and `RowError`) and `MdmImports.registerSheet` through its `index.ts`. A higher module implements the sheet and registers it in its module's `onModuleInit`, as modules register approval handlers with IAM (ADR-0017) and MDM registers `ScopeNames` with IAM (ADR-0033).

## Decision

Option 3.

- `MdmImports.registerSheet(sheet)` adds a sheet for an entity no sheet covers yet; a second registration for one entity throws at start-up. MDM's own five sheets are given to its constructor as before.
- The sheet decides everything about its rows, in the caller's transaction: its columns, its dry run against its own tables and MDM's published `MasterDataRefs` (which gains `branchByCodeIn`, `locationByCodeIn` and `productBySkuIn` for this, read only), its apply through its own module's services, and its export rows. `permissions` names the entity's own permission, which `applyImportJob` checks as well as `mdm.import.apply`; a sheet may also authorise inside `apply` for each place its rows write.
- INV's `OpeningStockSheet` is the first: it drafts and posts one goods receipt of kind `OPENING` per location through `GoodsReceipts.createIn` and `postIn` (A-147), so every stock unit, `OPENING_BALANCE` movement through `Stock.postIn`, cost pool, audit event and posting event is the one a receipt writes. Its permission is `inv.opening_stock.load`, authorised at each location the file writes. Its export is the empty template.
- The row is added to `docs/MODULE_BOUNDARIES.md` section 6.

## Consequences

- MDM keeps one import mechanism, one job table and one contract for every sheet; the frontend's import screen works for opening stock unchanged.
- A sheet in a higher module depends on MDM's index (downward); MDM depends on nothing above it. Nothing MDM writes is owned by INV.
- A module that registers a sheet must keep its dry run free of writes, as ADR-0046 requires of every sheet.

## Verification

- `test/integration/inv/opening-stock.integration.spec.ts`: the dry run's row errors, an apply refused to the Manager (no `inv.opening_stock.load`) writing nothing, the Owner's apply posting three receipts and four `OPENING_BALANCE` movements at their cost, a second load refused, the template export, and a receipt of kind `OPENING` still refused over HTTP.
- `test/integration/mdm/import-sheets.integration.spec.ts`: `OPENING_STOCK` reaches the registered sheet.
