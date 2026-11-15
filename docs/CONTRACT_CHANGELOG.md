# Contract changelog

Every change to `contract/openapi.yaml`, newest first. A breaking change needs a major version bump, an entry here, and a line at the top of the session report so the frontend track picks it up.

Version numbers follow semantic versioning: a major bump breaks an existing client, a minor bump adds operations or optional fields, a patch fixes descriptions or examples.

## Reading 1.5.0 to 1.18.0 cold (written 2026-11-15, for the frontend track)

The contract moved from 1.4.0 to 1.18.0 in one night while the frontend track was paused, so nothing on the frontend has seen any of it. Each version's own entry below is the record; this section is the one page to read first. **No existing shape was removed, renamed or retyped, and nothing a client sends was made required, in any of the fourteen versions.** A client generated from 1.4.0 still compiles against 1.18.0. What changes for a screen is listed here, loudest first.

**Act on these before switching a screen off the mock**

1. **Step-up on two tax writes (1.5.0).** `createTaxSchemeVersion` and `replaceTaxSchemeCells` now carry `x-requires-step-up: true`. Ask for the TOTP code first, as for the other tax writes.
2. **A new enumeration value in a response (1.14.0).** `FilePurpose` gains `EXPORT`, the file the server writes for an export. A screen that switches exhaustively over `FilePurpose`, or validates it against a fixed list, must handle the new value. This is the one change in the range that can break a strict client at run time, although it compiles.
3. **Fields now required in responses (ADR-0038: breaking for nothing a client sends, but a hand-built fixture or mock response without them no longer matches):** `Uom.displayDecimals` (1.7.0), `ImageVariant.sizeBytes`, `.fallbackUrl`, `.fallbackSizeBytes` (1.13.0), `ImportJob.rowsToCreate`, `.rowsToUpdate` (1.14.0), `StockOnHandLine.uomDisplayDecimals` and `StockUnit.uomDisplayDecimals` (1.16.0). Regenerate the client and mocks from the contract; do not patch fixtures by hand.
4. **Format quantities with the unit's precision** (CR-003): `Uom.displayDecimals` and, on stock lines, `uomDisplayDecimals`. Quantities on the wire keep three places.
5. **Operations that are now public** (no session, no CSRF header in the contract): `validateCoupon` (1.6.0) and `quoteDelivery` (1.9.0). Sending the cookie or the header is harmless; they are ignored.
6. **Wider phone inputs** (1.8.0, 1.9.0): customer, address, branch and supplier phone fields in requests take `PhoneInput`, so `0244123456` is accepted and comes back as `+233244123456`. Responses still use `PhoneNumber`. Let people type the local form.
7. **Always 202 for maker-checker submissions:** `submitTaxSchemeVersion` (1.5.0), `submitPromotion` (1.6.0), an adjustment above the threshold on `submitStockAdjustment` (1.17.0) and a stock take whose variance is at or above it on `submitStockTake` (1.18.0) answer 202 `ApprovalPending`, never 200. The approval endpoints are live from 1.11.0.

**New error codes a screen may now receive (all 422 unless noted; meanings in `docs/API.md` section 10.3)**

`TAX_CELL_INVALID`, `TAX_SCHEME_NOT_IN_FORCE` (1.5.0); `PROMOTION_INVALID`, `COUPON_INVALID`, `COUPON_UNAVAILABLE` (1.6.0); `RECORD_IN_USE`, `WEIGHT_BAND_INVALID` (1.7.0); `LOCATION_INVALID`, `PRICE_LIST_ASSIGNMENT_INVALID` (1.8.0); `PAYMENT_METHOD_INVALID`, `DELIVERY_ZONE_INVALID` (1.9.0); `GRANT_INVALID`, `USER_INVALID` (1.10.0); `ROLE_INVALID`, `VERIFICATION_CODE_INVALID`, `RESET_TOKEN_INVALID`, `RESET_TOKEN_USED`, `RESET_TOKEN_EXPIRED` (1.11.0, the last three answering CR-004 point 3); `FILE_NOT_CLEAN`, plus 413 `PAYLOAD_TOO_LARGE` and 415 `FILE_TYPE_NOT_ALLOWED` on `uploadFile` (1.12.0); `IMPORT_ENTITY_NOT_AVAILABLE` (1.14.0); `GOODS_RECEIPT_INVALID` (1.16.0); `STOCK_TRANSFER_INVALID`, `TRANSFER_VARIANCE`, `STOCK_ADJUSTMENT_INVALID`, `STOCK_REVERSAL_NOT_POSSIBLE` (1.17.0); `STOCK_TAKE_INVALID`, `STOCK_HOLD_INVALID` (1.18.0). Each operation's `x-error-codes` lists the ones it can return, and `details[].code` names the broken rule.

**What answers from the real API now** (174 operations in 1.18.0, up from 24 in 1.4.0): tax (1.5.0); promotions and coupons (1.6.0); the catalogue (1.7.0); branches, locations, customers, tiers, addresses (1.8.0); suppliers, payment methods, delivery zones, reason codes, price list listings (1.9.0); users, roles, grants (1.10.0); role writes, approvals, customer registration, password reset (1.11.0); file upload and download (1.12.0); product photographs (1.13.0); imports and exports (1.14.0, 1.15.0); stock on hand, stock units, trace, goods receipts (1.16.0); movements, reversals, transfers, adjustments (1.17.0); stock takes and holds (1.18.0). Stock counts are blind: a count screen never shows the expected figure while counting is open (1.18.0). Everything else still answers from the mock only.

**Known to change next, so do not build on it yet**

- **Transfer receipt shortfalls (1.17.0).** Today a shortfall on `receiveStockTransfer` is posted at once as a loss with a `TRANSFER_VARIANCE` exception. The owner decided on 2026-11-15 (A-139, ADR-0048) that receipt stays free, the shortfall is held in a variance holding place, and writing it off needs approval under the same threshold and step-up as an adjustment. That arrives with `resolveStockException` (planned in the contract, not yet live), which clears a variance by writing it off or recording it found; `receiveStockTransfer` keeps its shape. A screen should show the variance as awaiting a decision, not as a loss. The write-off goes through `resolveStockException`, which will answer 202 `ApprovalPending` above the threshold.
- **Empty until their modules exist:** `quoteDelivery.slots` (B11), `Supplier.hasProfile` (B7), `Customer.hasBusinessAccount` (B10), `StockOnHandLine.priceBand` (null), a trace's `healthEvents` and a sale's `customer` and `billingDocument`, `GoodsReceipt.receiptNo` (null until numbering), and `OPENING_STOCK` imports (422 `IMPORT_ENTITY_NOT_AVAILABLE` until opening stock is built).

## Requests answered without a change

- **CR-002 (frontend, raised 2026-11-13): weights as decimal strings, never JSON numbers.** Already satisfied by 1.0.0 and 1.1.0, so no version change. `components.schemas.Kilograms` is `type: string` with the pattern `^(0|[1-9][0-9]{0,6})\.[0-9]{3}$` (exactly three decimal places), and its description says it is never a JSON number. The request was raised against a copy taken before re-syncing; re-run `./scripts/sync-contract.sh`. The owner closed it on 2026-11-13: do not reopen it.

## 1.18.0 (2026-11-15, B05 continued 3)

**Additive.** No schema, field, parameter or request was removed, renamed or retyped, and nothing a client sends was made required. Two error codes were added and one was described more fully; descriptions, examples and `x-error-codes` were written. A client generated from 1.17.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Twelve operations now answer from the real API (174 in all): `listStockTakes`, `createStockTake`, `getStockTake`, `startStockTake`, `listStockTakeLines`, `recordStockTakeCounts`, `closeStockTakeCounting`, `submitStockTake`, `cancelStockTake`, `listStockHolds`, `createStockHold` and `releaseStockHold` (FR-INV-013, FR-INV-014, FR-INV-022).

- **New error codes** (422, each with the broken rule in `details[].code`, docs/API.md section 10.3): `STOCK_TAKE_INVALID` on `createStockTake`, `startStockTake` and `recordStockTakeCounts`; `STOCK_HOLD_INVALID` on `createStockHold` and `releaseStockHold`. `STOCK_TAKE_NOT_COUNTED` now names each unfinished line (`NOT_COUNTED`, `RECOUNT_REQUIRED`).
- **Descriptions** state the rules: the count is blind for every reader until counting closes; the tolerance is zero, so every difference is recounted once; the reasons the variances post with; the 202 of `submitStockTake` and its approver; a rejected take is cancelled; a hold's scope, its own `STOCK_HOLD` document, release by a different person with a `HOLD_RELEASE` reason, and a withdrawal hold never released.
- **Examples:** `submitStockTake`'s 202 names a `STOCK_TAKE` subject; `cancelStockTake` answers `CANCELLED`; `createStockHold` and `releaseStockHold` show an investigation and a released quarantine.
- **Not changed, and why:** `listStockTakes` keeps `status` typed as a string, as `listStockAdjustments` does; a value outside the statuses answers 400.

## 1.17.0 (2026-11-15, B05 continued 2)

**Additive.** No schema, field, parameter or request was removed, renamed or retyped, and nothing a client sends was made required. Four error codes were added; descriptions and `x-error-codes` were written. A client generated from 1.16.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Fifteen operations now answer from the real API (162 in all): `listMovementTypes`, `listStockMovements`, `getStockMovement`, `reverseStockMovement`, `listStockUnitMovements`, `listStockTransfers`, `createStockTransfer`, `getStockTransfer`, `dispatchStockTransfer`, `receiveStockTransfer`, `cancelStockTransfer`, `listStockAdjustments`, `createStockAdjustment`, `getStockAdjustment` and `submitStockAdjustment` (FR-INV-001 to FR-INV-004, FR-INV-010 to FR-INV-012).

- **New error codes** (422, each with the broken rule in `details[].code`, docs/API.md section 10.3): `STOCK_TRANSFER_INVALID` on `createStockTransfer` and `dispatchStockTransfer`; `TRANSFER_VARIANCE` on `receiveStockTransfer` (the code FR-INV-011 names); `STOCK_ADJUSTMENT_INVALID` on `createStockAdjustment` and `submitStockAdjustment`; `STOCK_REVERSAL_NOT_POSSIBLE` on `reverseStockMovement`.
- **Descriptions** state the rules: scopes (a transfer's source for drafting and dispatch, its destination for receipt; an adjustment's location; a movement's physical location), the 50,000 pesewa seed thresholds of `STOCK_WRITE_OFF` and `STOCK_REVERSAL` and their approver `inv.adjustment.approve`, values from the cost pool, animals never adjusted, a typed weight recorded `MANUAL`, a shortfall on arrival posted as a loss with a `TRANSFER_VARIANCE` exception, a reversal kept as a `STOCK_REVERSAL` document.
- **Not changed, and why:** `receiveStockTransfer` keeps no 202: approval of a large variance at receipt (FR-INV-011) would add a response a client must handle, which is the owner's call (A-139).

## 1.16.0 (2026-11-15, B05 continued)

**Additive.** No schema, field, parameter or request was removed, renamed or retyped, and nothing a client sends was made required. One property was added to two response schemas and made required there, which breaks nothing a client sends (ADR-0038); one error code was added. A client generated from 1.15.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Nine operations now answer from the real API (147 in all): `listStockOnHand`, `getStockUnit`, `traceStockUnit`, `listGoodsReceipts`, `createGoodsReceipt`, `getGoodsReceipt`, `updateGoodsReceipt`, `postGoodsReceipt` and `cancelGoodsReceipt` (FR-INV-003, FR-INV-005, FR-INV-006, FR-INV-009).

- **`StockOnHandLine` and `StockUnit` gain `uomDisplayDecimals`** (integer 0 to 3, required in responses): the decimals the line's unit is shown with, so a stock screen formats a quantity without fetching the unit list (CR-003 point 2). The examples of `listStockOnHand`, `getStockUnit` and `listStockUnits` show it.
- **New error code `GOODS_RECEIPT_INVALID`** (422) on `createGoodsReceipt`, `updateGoodsReceipt` and `postGoodsReceipt`, with the broken rule in `details[].code` (docs/API.md section 10.3).
- **CR-001 is met by the live operation:** `StockOnHandLine` already carried `unitCostPesewas`, `valueAtCostPesewas`, `valuationMethod`, and `StockOnHandPage` `totalValueAtCostPesewas` and `asOf`; they are now computed by the backend, each line's value its exact share of its pool and the total over the whole filter. `priceBand` is null for now (A-137).
- **Descriptions and `x-error-codes`** of the nine operations state their rules: the receiving location scope, the animal and lot rules, posting through the movement ledger in one transaction, a frozen posted receipt, `OPENING` refused until opening stock is built, `receiptNo` null until numbering exists, the origins' `costByElement` in a trace, and the fields that stay empty until their modules exist (`healthEvents`, a sale's `customer` and `billingDocument`).

## 1.15.0 (2026-11-15, B04e continued 5)

**Additive.** No schema, field, parameter, enumeration value or error code was added, removed, renamed or retyped, and nothing a client sends was made required. A client generated from 1.14.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

The same seven operations answer for more of the values their `entity` enumeration already listed (FR-MDM-019, FR-MDM-020, A-130):

- **`createImportJob`, `applyImportJob` and `createExportJob` now take `PRODUCT`, `SUPPLIER`, `LOCATION` and `PRICE_LIST_ENTRY`**, where 1.14.0 answered 422 `IMPORT_ENTITY_NOT_AVAILABLE`. Only `OPENING_STOCK` still answers it, until B5.
- **Descriptions** state each sheet's columns and rules: what names a record (`sku`, `supplierNo`, `branch` with `code`, and `priceList` with `sku`, `grade`, `weightBand` and `minQty`), what never changes by import, prices as integer pesewas, price list entries written into the list's `DRAFT` version only, the entity permissions applying and exporting need, and the branch scope of location and price list entry imports (403 when the file writes a branch the user holds no grant at).

## 1.14.0 (2026-11-15, B04e continued 4)

**Additive.** No schema, field, parameter or request was removed, renamed or retyped, and nothing a client sends was made required. Two properties were added to a response schema and made required there, which breaks nothing a client sends (ADR-0038); one enumeration value was added. A client generated from 1.13.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Seven operations now answer from the real API (138 in all): `listImportJobs`, `createImportJob`, `getImportJob`, `listImportErrors`, `applyImportJob`, `cancelImportJob` and `createExportJob` (FR-MDM-019, FR-MDM-020, SEC-009, ADR-0046, A-128).

- **`ImportJob` gains `rowsToCreate` and `rowsToUpdate`** (integer or null, required in responses): the dry run's preview that FR-MDM-019 asks for, null for an export and for an import whose file could not be read.
- **`FilePurpose` gains `EXPORT`**: the private file the server writes for an export. `uploadFile` accepts no upload under it (415 `FILE_TYPE_NOT_ALLOWED`); `getFile` and `createFileSignedUrl` serve it like any file once the scan has passed it.
- **New error code `IMPORT_ENTITY_NOT_AVAILABLE`** (422) on `createImportJob` and `createExportJob`: the entity's sheet is not built yet. Only `CUSTOMER` is built; products, suppliers, locations and price list entries follow in B04e continued 5, opening stock in B5 (A-128, A-129).
- **Descriptions, `x-error-codes` and examples** of the seven operations state their rules: the dry run writes only the job and its row errors; apply writes every row in one transaction or none, re-checks the rows, and needs the entity's own create or update permission; cancel only before apply; every export needs a fresh step-up (unchanged `x-requires-step-up: true`), is audited with its row count and marked bulk above 100 rows, and is downloaded through `createFileSignedUrl` once its file is `CLEAN`. The examples show the preview counts, a `VALIDATED` dry run and a `CANCELLED` job.

## 1.13.0 (2026-11-15, B04e continued 3)

**Additive.** No schema, field, parameter or request was removed, renamed or retyped, and nothing a client sends was made required. Three properties were added to a response schema and made required there, which breaks nothing a client sends (ADR-0038). A client generated from 1.12.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Two operations now answer from the real API (131 in all): `addProductImage` and `removeProductImage` (FR-DOC-005, ADR-0045).

- **`ImageVariant` gains `sizeBytes`, `fallbackUrl` and `fallbackSizeBytes`** (required in responses). `url` is the WebP rendition; `fallbackUrl` is the JPEG one of the same width, for a browser without WebP; the sizes are bytes, for page-weight budgets (NFR-005). The variant names are unchanged: `thumb` is 320 pixels wide, `card` 640 and `full` 1280, never wider than the original. Every example that shows a product image now shows those widths and the new fields.
- **`x-error-codes` and descriptions** on the two operations state their rules (A-126): only a `CLEAN` product photograph is attached (`FILE_NOT_CLEAN` while it is `PENDING`, or if it failed); a file of another use, or none, is `REFERENCE_NOT_FOUND` on `/fileId`; one already in the gallery is `DUPLICATE_VALUE`; someone else's upload also needs `platform.file.read.any`; with no `sortOrder` a photograph goes last; removing is a soft delete; both publish `mdm.ProductChanged` with `images` changed and leave the product's `version` where it was.
- **`Product.images`** now carries the gallery, where it was always empty.

## 1.12.0 (2026-11-15, B04e continued 2)

**Additive.** No schema, field, parameter or request was removed, renamed or retyped, and nothing a client sends was made required. A client generated from 1.11.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Three operations now answer from the real API (129 in all), with the schemas 1.2.0 already published: `uploadFile`, `getFile`, `createFileSignedUrl`. They keep their tag `platform`; DOC owns them in code (ADR-0044).

- **New responses:** `uploadFile` can answer **413** `PAYLOAD_TOO_LARGE` (over the purpose's cap: images 5 MB, PDF and spreadsheets 10 MB) and **415** `FILE_TYPE_NOT_ALLOWED` (the bytes are not a type the purpose accepts); `getFile` can answer **422** `FILE_NOT_CLEAN` for a quarantined (infected or unscannable) file. The codes were already in `docs/API.md` section 10.
- **`x-error-codes` and descriptions** on the three operations state their rules (A-124): the allow-list per purpose, the caps, `PENDING` until the scanner says `CLEAN`, only `CLEAN` linked, five-minute links logged, and `platform.file.read.any` for a file someone else uploaded.
- **`ApprovalRequest.evidenceFileId`** now carries the attached file's id (it was always null).

## 1.11.0 (2026-11-15, B04e continued)

**Additive.** No schema, field, parameter or response was removed, renamed or retyped, and nothing a client sends was made required. A client generated from 1.10.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Eleven operations now answer from the real API (126 in all), with the schemas 1.2.0 already published: `createRole`, `updateRole`, `listApprovals`, `getApproval`, `approveRequest`, `rejectRequest`, `cancelApprovalRequest`, `registerCustomer`, `verifyCustomerPhone`, `requestPasswordReset`, `resetPassword`.

- **Five new error codes**, also in `docs/API.md` section 10.3: **`ROLE_INVALID`**, **`VERIFICATION_CODE_INVALID`**, and, answering CR-004 point 3, **`RESET_TOKEN_INVALID`**, **`RESET_TOKEN_USED`** and **`RESET_TOKEN_EXPIRED`** (all 422).
- **`x-error-codes` and descriptions** on the eleven operations state their rules (A-122, A-123): only the Owner changes roles, and never one they hold or beyond what they hold; deciding needs the policy's permission and, where the policy says, a step-up; only the maker withdraws; registration and reset requests answer alike for known and unknown accounts; a sixth phone code is refused.
- **`loginCustomer`** can now answer `VERIFICATION_REQUIRED` (already in `LoginResult.status`) for a customer whose phone is not yet verified.

## 1.10.0 (2026-11-15, B04e)

**Additive.** No schema, field, parameter or response was removed, renamed or retyped, and nothing a client sends was made required. A client generated from 1.9.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Fourteen operations now answer from the real API (115 in all), with the schemas 1.2.0 already published: `listUsers`, `createUser`, `getUser`, `updateUser`, `disableUser`, `enableUser`, `unlockUser`, `resetUserPassword`, `listRoles`, `getRole`, `listPermissions`, `listGrants`, `createGrant`, `revokeGrant`.

- **Two new error codes**, also in `docs/API.md` section 10.3: **`GRANT_INVALID`** and **`USER_INVALID`** (422).
- **`x-error-codes` and descriptions** on the fourteen operations state their rules: nobody administers their own access, nobody grants or revokes a role beyond what they hold at that scope, the last Owner stays, a temporary password is shown once (and again only to a retry with the same key), and `realm: INVESTOR` is refused until investor records exist (B12).

## 1.9.0 (2026-11-15, B04d continued 3)

**Additive, with request schemas widened.** No schema, field, parameter or response was removed, renamed or retyped, and nothing a client sends was made required. A client generated from 1.8.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Nineteen operations now answer from the real API (101 in all), with the schemas 1.2.0 already published: `listSuppliers`, `createSupplier`, `getSupplier`, `updateSupplier`, `archiveSupplier`, `listPaymentMethods`, `updatePaymentMethod`, `listDeliveryZones`, `createDeliveryZone`, `getDeliveryZone`, `updateDeliveryZone`, `quoteDelivery`, `listReasonCodes`, `listPriceLists`, `updatePriceList`, `archivePriceList`, `listPriceListVersions`, `listPriceListEntries`, `archiveProduct`.

- **`PaymentMethodUpdate.requiresProviderVerification`** (new optional field): FR-MDM-009's acceptance sends it. It cannot be switched off for mobile money or card (422 `PAYMENT_METHOD_INVALID`, `VERIFICATION_REQUIRED`).
- **`listPaymentMethods` `includeDisabled`** (new optional query parameter, default false): a tender screen sees only enabled methods; the settings screen asks for all seven.
- **`SupplierCreate.phone` and `SupplierUpdate.phone`** take `PhoneInput` instead of `PhoneNumber`, as the customer and branch phones did in 1.8.0. Every E.164 value is still accepted; responses keep `PhoneNumber`.
- **`quoteDelivery`** is public only: its `security` is `{}` and it no longer lists the optional CSRF header or a customer session. A client that sends either is still answered.
- **Two new error codes**, also in `docs/API.md` section 10.3: **`PAYMENT_METHOD_INVALID`** and **`DELIVERY_ZONE_INVALID`** (422).
- **`x-error-codes` and descriptions** on the nineteen operations state their rules: the exact zone fee and "delivery unavailable" with `feePesewas: null` (never zero), one active zone per area, the fixed reason code list with no write operation, the archive refusals of a price list or product still in use, and `taxInclusive` fixed once a version was approved.
- **Behaviour a client should know, with no shape change:** `CustomerAddress.deliveryZone` is now the zone the address was in when it was saved; `quoteDelivery.slots` is empty and `Supplier.hasProfile` false until delivery scheduling (B11) and procurement (B7) exist.

## 1.8.0 (2026-11-15, B04d continued 2)

**Additive, with request schemas widened.** No schema, field, parameter or response was removed, renamed or retyped, and nothing a client sends was made required. A client generated from 1.7.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Twenty-one operations now answer from the real API (82 in all), with the schemas 1.2.0 already published: `listBranches`, `createBranch`, `getBranch`, `updateBranch`, `listLocations`, `createLocation`, `getLocation`, `updateLocation`, `archiveLocation`, `listCustomers`, `createCustomer`, `getCustomer`, `updateCustomer`, `archiveCustomer`, `listCustomerTiers`, `createCustomerTier`, `listCustomerAddresses`, `createCustomerAddress`, `updateCustomerAddress`, `archiveCustomerAddress`, `assignCustomerPriceList`.

- **`PhoneInput`** (new schema): a phone number as a person types it, `^\+?[0-9][0-9 -]{6,22}$`. It replaces `PhoneNumber` in the request schemas `CustomerCreate.phone`, `CustomerUpdate.phone`, `CustomerAddressCreate.recipientPhone`, `CustomerAddressUpdate.recipientPhone`, `BranchCreate.phone` and `BranchUpdate.phone`, so FR-MDM-008's `0244123456` is accepted and stored as `+233244123456`. Every E.164 value 1.7.0 accepted is still accepted; responses keep `PhoneNumber`. A value that is no Ghanaian or E.164 number is 400 `VALIDATION_FAILED`, `details[].code` `INVALID_PHONE`.
- **Two new error codes**, also in `docs/API.md` section 10.3: **`LOCATION_INVALID`** and **`PRICE_LIST_ASSIGNMENT_INVALID`** (422).
- **`x-error-codes` and descriptions** on the twenty-one operations state their rules: virtual locations, the parent in the same branch, cold room ranges, phone normalisation and uniqueness, Ghana address rules, the encrypted TIN, the assignment window replacing what it meets.
- **Behaviour a client should know, with no shape change:** `listLocations` leaves out virtual locations unless `includeVirtual=true`; `CustomerAddress.deliveryZone` is null and `Customer.hasBusinessAccount` false until delivery zones (B04d continued 3) and wholesale accounts (B10) exist.

## 1.7.0 (2026-11-15, B04d continued)

**Additive.** No schema, field, parameter or response was removed, renamed or retyped, and nothing a client sends was made required. One response schema gained a required field (`Uom.displayDecimals`), which breaks nothing a client sends (ADR-0038). A client generated from 1.6.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Eighteen catalogue operations now answer from the real API (61 in all), with the schemas 1.2.0 already published: `listCategories`, `createCategory`, `getCategory`, `updateCategory`, `archiveCategory`, `listUnitsOfMeasure`, `listSpeciesList`, `createSpecies`, `updateSpecies`, `listGrades`, `createGrade`, `updateGrade`, `archiveGrade`, `listWeightBands`, `createWeightBand`, `updateWeightBand`, `archiveWeightBand`, `updateProduct`.

- **CR-003: `Uom.displayDecimals`** (integer 0 to 3, required in responses): 0 for counted units (head, crate, tuber, pack, bunch, bag, unit), 3 for kilograms and litres. Quantities on the wire keep three places. Part 2 of CR-003 (the unit's precision beside `uom` on stock lines) lands with the stock schemas in B5.
- **Descriptions** of `createCategory`, `updateCategory`, `archiveCategory`, `createWeightBand`, `updateWeightBand`, `archiveGrade`, `archiveWeightBand`, `updateProduct` and `listUnitsOfMeasure` now state their rules. `listCategories`' summary is spelled correctly.
- **`x-error-codes`** on the eighteen operations. Two new codes, also in `docs/API.md` section 10.3: **`RECORD_IN_USE`** (422: a category with live products or children, or a grade or band a pending or active price list version prices with, is archived or moved; `details[].code` is `HAS_LIVE_PRODUCTS`, `HAS_LIVE_CHILDREN` or `USED_BY_LIVE_PRICES`) and **`WEIGHT_BAND_INVALID`** (422: an empty range, or one that meets another band of the species, `details[].code` `NOT_ABOVE_MIN` or `OVERLAPS_BAND:<code>`).
- **Behaviour a client should know, with no shape change:** lists return live records in creation order; `getCategory` also returns an archived category. `updateProduct` never moves a product back to `DRAFT` (422 `INVALID_STATE_TRANSITION`) and refuses a shelf-life change that would move a countable product between held in lots and not (422 `STOCK_POLICY_CONFLICT`, `TRACKING_FIXED`); moving a product to another category keeps its tax category unless the change names one.

## 1.6.0 (2026-11-15, B04d)

**Additive, with one relaxation on a public operation.** No schema, field or response was removed, renamed or retyped, and nothing a client sends was made required. A client generated from 1.5.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Nine promotion operations now answer from the real API (43 in all), with the schemas 1.2.0 already published: `listPromotions`, `createPromotion`, `getPromotion`, `updatePromotion`, `submitPromotion`, `endPromotion`, `listCoupons`, `createCoupon`, `validateCoupon`.

- **`resolvePrices` fills `promotions`** on each resolved line (it was always `[]`): the line promotions that discount it, each `discountPesewas` taken from the line extended at list price and rounded half-up once; never on a `CUSTOMER` list price; one per stack group, an exclusive one alone (ADR-0040). `couponCode` now names a real coupon; an unknown code is still 422 `REFERENCE_NOT_FOUND`, and one that cannot be used is the new 422 **`COUPON_UNAVAILABLE`** (`details[0].code`: `EXPIRED`, `LIMIT_REACHED`, `NOT_APPLICABLE`, `ALREADY_USED`).
- **`validateCoupon` is public, without the optional customer session or CSRF header** the planned contract offered (`security: [{}]`, no `X-CSRF-Token` parameter). A client that sends the cookie or the header is not refused; they are ignored. It ignores `customerId` (it never reveals who used a coupon) and refuses a `cartId` with 422 `REFERENCE_NOT_FOUND` until carts exist (B7). Descriptions say so.
- **Descriptions** of `createPromotion`, `updatePromotion`, `submitPromotion`, `endPromotion` and `createCoupon` now state their rules; `submitPromotion` always answers 202.
- **`x-error-codes`** on the nine operations. Three new codes, also in `docs/API.md` section 10.3: `PROMOTION_INVALID`, `COUPON_INVALID`, `COUPON_UNAVAILABLE`.
- **Example:** the `validateCoupon` request example no longer carries a `cartId`.

## 1.5.0 (2026-11-15, B04 continued)

**Additive, with one behaviour change on two operations nothing implemented before.** No schema, field, parameter or response was removed, renamed, retyped or made required. A client generated from 1.4.x compiles unchanged. The frontend track is paused, so nothing reviewed this entry; read it before resuming.

Ten tax operations now answer from the real API (34 in all), with the request and response schemas 1.2.0 already published: `listTaxLevies`, `createTaxLevy`, `listTaxCategories`, `createTaxCategory`, `listTaxSchemeVersions`, `createTaxSchemeVersion`, `getTaxSchemeVersion`, `replaceTaxSchemeCells`, `submitTaxSchemeVersion`, `calculateTax`.

- **LOUD: `createTaxSchemeVersion` and `replaceTaxSchemeCells` now require step-up** (`x-requires-step-up: true`, and the description says so). The planned contract did not mark them, but step-up belongs to the permission they check, `mdm.tax.manage`, which the other three tax writes already marked, and ADR-0020 makes every tax configuration change a step-up action (ADR-0039). A screen asks for the TOTP code before these writes, as it does for `createTaxLevy`, `createTaxCategory` and `submitTaxSchemeVersion`. Nothing called them before: they were not implemented.
- **`listTaxSchemeVersions` description** now says what it returns: each version with an empty `cells` array; `getTaxSchemeVersion` returns the full matrix. The old text ("omits cells except on the first version") did not say which version was first. No shape change.
- **Example:** the 202 example of `submitTaxSchemeVersion` names a `TAX_SCHEME_VERSION` subject instead of a stock adjustment.
- **`x-error-codes`** on the ten operations. Two new codes, also in `docs/API.md` section 10.3: `TAX_CELL_INVALID` (422, a cell breaks a tax rule, `details[].code` names which: `TAX_RATE_NOT_ALLOWED`, `TAX_BASE_INVALID`, `TAX_BASE_CIRCULAR`, `TAX_CALC_ORDER_DUPLICATE`, `TAX_CALC_ORDER_INVALID`, `TAX_LEVY_DUPLICATE`) and `TAX_SCHEME_NOT_IN_FORCE` (422 on `calculateTax`, no approved scheme covers the tax date). `TAX_MATRIX_INCOMPLETE` names each missing pair as `details[].code`, `CATEGORY/LEVY`.
- **Behaviour a client should know, with no shape change:**
  - `submitTaxSchemeVersion` always answers **202 `ApprovalPending`**; activation is always maker-checker, approved by a holder of `mdm.tax.approve` (seeded: Owner). Its documented 200 response is never returned.
  - A version whose `validFrom` has passed when it is approved starts on the day of approval; `validFrom` and `validTo` are business dates and `validTo` is the first day a version no longer applies.
  - Only one version can be open (draft or pending) at a time: a second `createTaxSchemeVersion` answers 422 `INVALID_STATE_TRANSITION` with detail `OPEN_VERSION_EXISTS`.
  - `replaceTaxSchemeCells` takes the whole matrix: a cell for every live category and levy.
  - `calculateTax` prints `ratePercent` with two places (`15.00`, `2.50`). While `tax.registered` is false on the tax date every levy is 0 and `ratePercent` is `0.00`.

## 1.4.0 (2026-11-14, B4)

**Additive only.** A client generated from 1.3.x keeps working; it simply does not read the new field.

- **`TotpEnrolment.qrCodeDataUri` (CR-006 point 2)**, always present, in the response of `startTotpEnrolment`: the `otpauthUri` drawn as a QR code, an SVG image as a data URI (`data:image/svg+xml;base64,…`). Show it in an `<img>` with a text alternative, and keep `secretBase32` on screen for a phone that cannot scan. The QR code carries nothing the response did not already carry: it is the same URI, drawn. The example in the contract is a real code that decodes to the example's own `otpauthUri`, so the mock serves one that scans (ADR-0037).
- **Required in a minor version (ADR-0038).** `qrCodeDataUri` is in `TotpEnrolment.required` because the server always sends it. A new required field in a response is minor: it breaks no reader. Making a field required is breaking only on a request body or a parameter. A hand-built test fixture of this response needs the field to compile.

## 1.3.0 (2026-11-14, B4)

**Additive only. No existing shape changed: no field, schema, parameter or response was removed, renamed, retyped or made required.** A client generated from 1.2.x keeps working unchanged. The frontend track is paused; when it resumes it should read this entry first, because nothing reviewed it when it was made.

Seven more operations now answer from the real API (24 in all), and their published text is the code's (ADR-0031): `resolvePrices`, `createPriceList`, `getPriceList`, `createPriceListVersion`, `getPriceListVersion`, `replacePriceListEntries`, `submitPriceListVersion`. Their request and response schemas are the ones 1.2.0 already published.

- **`x-requires-step-up: true` (CR-007)** beside `x-permission` on the 30 operations whose description says "Requires step-up". A test keeps the flag and the prose in step, and an integration test keeps the flag equal to `iam.permission.requires_step_up` for every permission the database has seeded. A screen can now ask for the TOTP code before the write instead of after a 403 `STEP_UP_REQUIRED`. `approveRequest` and `rejectRequest` carry no flag: whether a decision needs step-up depends on the approval kind's policy (`PRICE_LIST_ACTIVATION` does), so they still answer 403 `STEP_UP_REQUIRED` when it is needed.
- **Examples (CR-008):** the 200 examples of `listBranches` (three rows listed twice), `listSpeciesList` and `listDeliveryZones` (one row each) no longer repeat a row. A contract test now refuses any example list that repeats an id. The 202 example of `submitPriceListVersion` names a `PRICE_LIST_VERSION` subject instead of a stock adjustment.
- **`x-error-codes`** on the seven new operations. One new code, also in `docs/API.md` section 10.3: `PRICE_ENTRY_INVALID` (422, an entry breaks a price rule: floor above list, list above ceiling, a zero floor on a priced entry, a grade or band of another species). `PRICE_ENTRY_DUPLICATE`, `INVALID_STATE_TRANSITION`, `DUPLICATE_VALUE` and `REFERENCE_NOT_FOUND` were already catalogued.
- **Behaviour a client should know, with no shape change:**
  - `submitPriceListVersion` always answers **202 `ApprovalPending`**; activation is always maker-checker. Its documented 200 response is never returned in this version and stays only so the published shape does not change.
  - `resolvePrices` returns `promotions: []` on every line until promotions are built (B04 continued); a `couponCode`, and a line's `stockUnitId` until inventory exists (B5), name no record and answer 422 `REFERENCE_NOT_FOUND` naming the field. A line the engine cannot price is still a 200 with `outcome: QUOTE_REQUIRED`, never an error.
  - A version whose `validFrom` has passed when it is approved starts at the moment of approval, so `getPriceListVersion` can show a later `validFrom` than was drafted (ADR-0036).
- **Not in this version (CR-006 point 2):** `TotpEnrolment.qrCodeDataUri` waited for the owner's decision on the dependency; it is in 1.4.0.

## 1.2.0 (2026-11-14, B3)

Additive only. A client generated from 1.1.x keeps working. Seventeen operations are now implemented in code and answer from the real API; their published text is the code's (ADR-0031). The frontend should regenerate its client and switch these operations off its stub: `getHealth`, `loginStaff`, `loginCustomer`, `loginInvestor`, `verifyTotp`, `refreshSession`, `logout`, `getCurrentSession`, `changePassword`, `startTotpEnrolment`, `confirmTotpEnrolment`, `stepUp`, `listSessions`, `revokeSession`, `listProducts`, `createProduct`, `getProduct`. The login flow, token lifetimes and cookie attributes are in `docs/sessions/B03-platform-slice.md`.

- **Login challenges carry the steps between password and session.** `PasswordChangeRequest` and `TotpCodeRequest` gain an optional `challengeToken`; `startTotpEnrolment` gains an optional request body, the new schema `TotpEnrolmentStart` (`challengeToken`). During login these three operations take the challenge in the body and no cookie, so they use `CsrfTokenOptional` and list an empty security requirement beside the session schemes. `confirmTotpEnrolment` during login also completes the login: the session cookies are set on its response.
- **`realm` query parameter (optional)** on `refreshSession`, `getCurrentSession` and `logout`: which session to use when one browser holds sessions in more than one realm. Leave it out with one session. With several and no `realm`, the API answers 400 `VALIDATION_FAILED` naming `/realm` (refresh: 401).
- **`x-error-codes`** on every implemented operation lists the codes it can raise, adopting the "Added" codes of `docs/API.md` operation by operation (A-074). New codes, also in `docs/API.md` section 10.3: `TOTP_ALREADY_ENROLLED`, `APPROVAL_SUBJECT_CHANGED`, `DUPLICATE_VALUE`, `REFERENCE_NOT_FOUND`, `STOCK_POLICY_CONFLICT`.
- **New responses:** 503 `ServiceUnavailable` on the login operations, `verifyTotp` and `refreshSession` (the login rate limit fails closed when Redis is down); 403 `Forbidden` on `refreshSession` (`ORIGIN_NOT_ALLOWED`).
- **Descriptions:** `getHealth` names the checks reported so far (database, Redis, outbox backlog, dead letters, audit sealing lag) and says DEGRADED still answers 200; `verifyTotp`, `refreshSession`, `changePassword`, `startTotpEnrolment` and `confirmTotpEnrolment` describe the challenge and realm rules. `ErrorBody.code` and `CsrfTokenOptional` describe the above.
- **Not yet accepted:** API keys (`apiKey` security) on the implemented operations answer 401 until integrations arrive (A-084); the schemes stay in the contract as the target.

## 1.1.0 (2026-11-13, B1)

Additive only: new optional fields and enum values. A client generated from 1.0.x keeps working; the POS offline queue should adopt the new fields.

- `TenderInput.unverifiedMobileMoney` (optional): an offline mobile money tender taken under the setting `pos.offline.allow_unverified_mobile_money`, with payer phone, network, any reference shown, and the approving manager.
- `ShiftClose.lastDeviceCounter` (optional): so a gap after the last synced sale is detected at close.
- `OfflineSyncBatch.sales`: at most 500 per batch. `OfflineSyncResult.cashMovementResults`: an outcome per synced cash movement.
- `DriverSyncItem.outcome`: adds `APPLIED_WITH_EXCEPTION`.
- `GoodsReceiptCreate.kind`: adds `OPENING` for opening stock (`docs/DATA_MIGRATION.md`).
- `ExceptionKind`: adds `SYNC_REJECTED` and `LATE_POSTING`.
- Example: the opening balance manual journal now shows bank against opening balance equity.

## 1.0.1 (2026-11-13, B1)

Examples and one description only. No operation, field or schema changed; a client generated from 1.0.0 needs no change.

- Catalogue and product page: catch-weight prices are per kilogram, as `priceBasis` says (goat meat GHS 26.00 per kg, not a pack price).
- Quotes: the standard-rated delivery fee carries its levies (GHS 12.00 on GHS 60.00); the quote list no longer repeats one total.
- Animals and stock on hand: an animal's `priceBand` is the band for its weight band; processed animals in processing and trace examples are no longer animals shown alive elsewhere.
- Receivables: Royal Palm Hotel's overdue invoice is 24 days late (1 to 30 bucket), consistent with its account not being on hold.
- Exceptions: the stock exception item carries abuse case 11 only; case 10 is a device counter gap.
- `CapitalTransactionCreate.unitPricePesewas`: the default is GHS 100.00 per unit, matching every example and ASSUMPTIONS A-031.

## 1.0.0 (2026-11-13, B1)

First version, written by hand before any endpoint exists so the frontend can build against a mock server.

- **Scope:** 600 operations on 476 paths, covering every module in the shared brief, including those not built until B12. 807 schemas. Tagged by module, grouped for Redoc with `x-tagGroups`.
- **Conventions:** money as integer `...Pesewas` fields with `currency` on the object; weights, quantities and percentages as decimal strings; one error envelope with `correlationId`; cursor pagination; `Idempotency-Key` on every state-changing request and `X-CSRF-Token` on cookie-authenticated ones; 202 `ApprovalPending` for maker-checker actions (ADR-0029).
- **Security schemes:** staff, customer and investor session cookies (`__Host-hk_s_at`, `__Host-hk_c_at`, `__Host-hk_i_at`), integration API keys, and a POS device credential.
- **Extensions:** `x-permission` on every staff operation names the permission the domain layer checks; `x-owner-module` where the owning module differs from the tag.
- **Examples:** every list operation has at least five realistic rows from one consistent seeded farm in Dodowa. Counter sale, tax, processing cost and distribution figures are computed with the same largest-remainder rule the backend will use, so they are exact.
- **Frontend requests:** CR-001 implemented (`unitCostPesewas`, `valueAtCostPesewas`, `valuationMethod`, `totalValueAtCostPesewas`, `asOf` on `GET /stock/on-hand`; cost and price never share a field). Enum values are upper case: `WEIGHTED_AVERAGE`, `SPECIFIC_IDENTIFICATION`.
- **Lint:** `npx @redocly/cli lint contract/openapi.yaml` passes with no errors and no warnings under `redocly.yaml` (recommended rules; the localhost server warning is turned off because the local and mock servers are listed on purpose).
