# B09q: QR codes, barcodes, SKUs and public IDs (contract 2.0.0)

Date: 2026-11-17 · Branch `b09q-ids-barcodes`, from `main` (`e722cac`, with main's `e066cdd` merged in) · Status: **built, gate passed for the shape changes; phase split** (decision 5 moves to B09q continued, A-254). B09q continued runs next, then B09e.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-248 | **SKU generation:** the category's prefix given (`skuPrefix`, additive) or the first three letters of its code (`CAT` with fewer than two letters); four digits at least, never truncated; a SKU typed before 0210 kept and stepped over; a rolled-back number returns to the counter (no product ever held it); creates queue on one advisory lock (`mdm.sku`); `sku` sent with any value is 422 `FIELD_SERVER_ASSIGNED`, after authorisation. | Owner |
| A-249 | **Barcode, expand then contract:** no read, no write, unique index dropped (0211); the column goes in the first migration after 2.0.0 is deployed (BL-075); `barcode` in a body is 400 `UNKNOWN_FIELD`; `listProducts?barcode=` is 400 rather than ignored. | Owner |
| A-250 | **The product sheet** (supersedes A-130's product part): the `sku` column stays required in the header; a held SKU changes that product, a blank one creates with a generated SKU, an unknown SKU is a row error; a `barcode` column fails the sheet. | Owner |
| A-251 | **What keeps a barcode** (supersedes A-151, keeps A-161): product and lot or animal labels print text only; the meat pack operations and components are byte for byte 1.54.0's, examples included; the planned picking of a pack by its barcode (B11) stays; `OfflineProduct.barcode` goes (no till scanning). | Owner |
| A-252 | **The seeded SKUs:** prefixes `LIV`, `MEAT`, `EGG`, `PRD`, `FEED`; seed order gives `LIV-0001` broiler to `LIV-0007` rabbit, `MEAT-0001` to `MEAT-0008` (goat offal), `EGG-0001` to `EGG-0003`, `PRD-0001` to `PRD-0006`, `FEED-0001` to `FEED-0003`; the seed checks each and refuses a database that held products of a prefix first. Every amount unchanged. | Owner |
| A-253 | **Public IDs as built:** exactly 16 characters, upper-case body, lower-case prefix; search compares a whole ID typed any way (O as 0, I or L as 1); `publicId` in a body is 400; the numbers stay allocated, stored and in `mdm.SupplierRegistered` v1, never shown; the database's generator backfills and serves inserts without one; the application retries a collision five times, then 500 with nothing written. | Owner |
| A-254 | **The split:** decision 5 (no identifier is a key, every customer link with its own random token) moves unchanged to B09q continued, after B09q and before B09e; it changes behaviour and tests, not shapes. | Owner |
| A-255 | **2.0.0 keeps `/v1`** and shipped without a release of notice: nothing is deployed and the frontend builds against the mock; from the first deployment a major version takes the next `/vN` alongside the old (noted in docs/API.md section 1). | Owner |

Resolved or superseded: A-130's product part (by A-250), A-151 (by A-251).
Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-204, A-206, A-207, A-209, A-211, A-213, A-214, A-216 to A-240, A-242 to A-255.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09q (`b09q-ids-barcodes`, from `main` at `e722cac`).
2. **Scope:** the owner's six decisions of 2026-11-17: TOTP the only QR; no product barcode, lookup, scanning or label barcode while the meat pack labels stay as built; server-generated SKUs; public IDs for customers and suppliers; no ID is a key with customer links' own tokens; contract 2.0.0 with a loud changelog and every example updated.
3. **Gate:** as the opener states it. Split at the sub-domain boundary between the shape changes (decisions 1 to 4 and 6) and the authorisation and link-token proofs (decision 5), after all shape changes, so the whole breaking bump is in 2.0.0 here and B09q continued needs no further major version.

## Contract changes

**2.0.0, MAJOR, BREAKING, approved by the owner (2026-11-17).** Full list in `docs/CONTRACT_CHANGELOG.md`; the cold-read summary is rewritten for it.
- **Removed:** `barcode` from `Product`, `ProductCreate`, `ProductUpdate`, `ProductLabel`, `StockUnitLabel`, `OfflineProduct`; the `barcode` parameter of `listProducts` (now 400); `sku` from `ProductCreate` (sending it is 422 `FIELD_SERVER_ASSIGNED`, also on `updateProduct`); `customerNo` from `Customer`, `CustomerRef`, `CustomerProfile` and `supplierNo` from `Supplier`, `SupplierRef` (98 operations); the sheets' `customerNo`, `supplierNo` and `barcode` columns.
- **Added:** `publicId` (required) with `CustomerPublicId` and `SupplierPublicId`; `Category.skuPrefix` (required in the answer; optional on create and update); the error code `FIELD_SERVER_ASSIGNED`.
- **Changed, same shape:** `Product.sku` is the server's (`EGG-0001`); search by public ID; descriptions; every example (generated SKUs, one deterministic public ID per party).
- **Unchanged on purpose:** the meat pack operations and every component they reach (snapshot test against 1.54.0), and `PickInput.packBarcode`/`FulfilmentLine.packBarcode` (B11).
- 422 operations from code, 214 planned (636). `contract:generate --check` up to date; Redocly clean with no warnings; `tsx scripts/contract/versioning.ts` against `main` prints `contract versioning: ok`.

## Built

| Area | What |
| --- | --- |
| Lint | A `no-restricted-imports` group refuses QR and barcode libraries (`uqr`, `qrcode`, `jsqr`, `@zxing/*`, `bwip-js`, `jsbarcode`…) in `src` except `iam/infrastructure/uqr-qr-codes.ts` and its spec; two lint fixtures (application and domain) prove it fires. |
| Migrations | **0210** `category.sku_prefix` (trigger default, backfill with the version trigger held off), `mdm.sku_counter` (PROJECTION, forward-only trigger), `mdm.allocate_sku` (SECURITY DEFINER, steps over held SKUs), `uq_product_sku` over every row, `mdm.product_sku_fixed`. **0211** drops `uq_product_barcode` (expand). **0212** `mdm.new_public_id`, `public_id` on customer and supplier (volatile default backfill, pattern check, unique, `mdm.public_id_fixed`). All three roll back (the 0155 rollback walk covers them). |
| MDM domain | `serverAssignedFieldsIn`; `productLabel` (text only); `public-id.ts` (`publicIdFrom`, `readPublicId`, the Crockford alphabet; 100 percent gate); the product, customer and supplier sheet rows. |
| MDM application | `ProductCatalogue`: no barcode, `refuseServerAssigned`, `allocateSku` once valid, `SKU_SERIES_LOCK`; `CatalogueAdmin`: `skuPrefix`; `PublicIds` (provider: `next`, `insertWithFresh` with savepoint retry); `PartiesAdmin`, `ReferenceDataAdmin`: public IDs on create, in views and in `q`; the three sheets; `MasterDataRefs` facts carry `publicId`. |
| INV | `stockUnitLabel` and `getStockUnitLabel` without barcode. |
| Other modules | `CustomerRef`/`SupplierRef` builders in INV, LIV, PUR, ORD, BIL and PAY show `publicId`. PRC untouched. |
| Seed | Categories with prefixes; products created without a SKU and checked (`expectSeededSku`); every test naming a seeded product remapped to the generated SKUs (amounts unchanged). |
| Docs | ADR-0072, ADR-0073 (indexed), A-248 to A-255, BL-075, the changelog, API.md (sections 1, 4, 10.3, MDM, INV), data model (`category`, `product`, `sku_counter`, `customer`, `supplier`), the MDM, INV and PRC cards, ADR-0026 Amendments and the openers (B09q continued inserted; B09e reads its report). |

## The gate, proved by running it

- **No QR code but TOTP enrolment:** a search of `src`, `test`, `scripts`, `packages` and `migrations` for `qr`, `qrcode`, `qr_code` finds only `iam.module.ts`, `iam/infrastructure/uqr-qr-codes.ts` and its spec, `startTotpEnrolment.yaml`, `authentication.service.ts`, `iam/application/ports.ts`, `iam/domain/totp.ts`, and two tests that decode the TOTP QR (`examples-and-extensions`, `second-factor`). Kept so by the lint rule and the contract test (a QR only in `startTotpEnrolment` and `TotpEnrolment`). B9b's opener already sends the receipt link by SMS, never a QR code.
- **No product barcode, lookup or scanning; no barcode on product or lot/animal labels:** the contract test finds a barcode only in the meat pack and picking operations and in descriptions saying it went in 2.0.0; `barcode` refused on create and update (400) and as a lookup (400); both labels answer exactly their text keys (integration); a sheet with a `barcode` column fails.
- **Meat pack labels byte for byte:** `createPacks`, `listPacks`, `printPackLabels` and the 29 components they reach equal the snapshot of 1.54.0 taken before any change (`test/fixtures/contract/meat-pack-labels-1.54.0.json`); the pack label and the pack answer exactly their 1.54.0 keys (integration). No PRC code and no migration 0085 changed; the only PRC files touched are other processing operations' example SKUs (the generated form).
- **SKU generated, unique, never reused, never input:** schema tests (prefix, counter forward only, step-over, past 9999, fifty concurrent distinct, archived SKU refused, no change by any role); API tests (generated in answer, audit and event; 422 for any `sku` on create and update with nothing written; eight concurrent consecutive; category move keeps it; archived never reissued; prefix given, derived, changed for later only); sheet (blank creates, unknown refused).
- **Public IDs in place of numbers:** schema tests (default of its pattern, 2,000 distinct over all 32 characters, unique even archived, pattern, no change by any role); API tests (answer has `publicId` and no number, numbers stay internal, six distinct, search typed loosely finds the one and a number finds nothing, a sent ID is 400, a collision retried once and twice, five collisions 500 with nothing written); contract (no `customerNo`/`supplierNo` anywhere, five shapes require `publicId`, one ID per party across examples).
- **Contract 2.0.0:** loud changelog, cold-read summary rewritten, every example valid against its schema (a new contract test over all 1,135 examples).
- **Mutation checks:** counter not moving (5 red), no step-over and live-only index (3 red), `sku` let through (2 red), database generator repeating one byte (1 red), no collision retry (2 red), application generator of two values (5 red). Each restored and green.
- **Not in this phase (split, A-254):** "knowing a public ID, a SKU or a UUID reads nothing without authorisation, and every link sent to a customer carries its own long random token, each proved by a test" is B09q continued's gate. The handler walk (`authorisation.integration.spec.ts`) still refuses a user with no grant on every route, as before.

## Test first, as it honestly happened

- Red before code: the three contract guards' barcode tests; `sku-schema` (no column) and `public-id-schema` (no column); the label unit specs; the public ID unit spec (no module).
- Written after the code, then proved by mutation: `products.integration` rewrite (SKU refusals), `public-ids.integration` (the retry). Honest gap: the domain helper `serverAssignedFieldsIn` was written before its spec.
- Stale tests updated because this phase made them stale: the 0155 rollback walk (0210 to 0212), the versioning spec (its "next major" was hard-coded 2.0.0), the import sheets, export, parties, reference data, catalogue, livestock, uom conversions, orders and image tests, and every test naming a seeded SKU.
- Two full-suite reds found and fixed in their cause, not re-run: 0210's backfill tripped `touch_version` on a re-applied, seeded database (the rollback walk), fixed by holding the version trigger off for the backfill; a lower-case `beef-15kg` the SKU remap missed. Nothing skipped, quarantined or retried.

## Decisions

- ADR-0072 (SKUs, no barcode, TOTP the only QR) and ADR-0073 (public IDs), both Accepted by the owner's decisions of 2026-11-17. No accepted ADR set the SKU as input or the product barcode; A-130 and A-151 are superseded in part. ADR-0070's HMAC tracking token is for B09q continued to supersede.

## Security review (hakorem-security-review)

- **Boundaries:** TB2 back office, TB7 administration (imports).
- **Standards item by item:** SC-01 strict schemas, `sku` let through only to be refused; SC-02 every changed handler authorises first; SC-03/04 parameterised SQL, generators `SECURITY DEFINER` with fixed `search_path`; SC-05 no money; SC-06 idempotency unchanged; SC-07/08 no secret, public IDs from `randomBytes` and `gen_random_uuid`; SC-11 unchanged; SC-22/23 no ledger table, creates queue on an advisory lock at serializable. Not applicable: cookies, CORS, uploads, webhooks, payments, encryption.
- **Abuse:** sequential numbers let anyone count customers or mistype into a neighbour; public IDs close that. Enumeration by any identifier is B09q continued's. No new abuse path; the threat model is unchanged.

## Deferred

- B09q continued (A-254): decision 5.
- BL-075: dropping `mdm.product.barcode` after 2.0.0 deploys.

## Contract requests

I fetched the frontend's `main` at `0efb338` (the commit B09x continued read): CR-001 to CR-033, nothing new or changed.
- **CR-016** (labels for products and lots): its interim plan drew a Code 128 from `Product.barcode`; from 2.0.0 the labels print text only (owner's decision), so the frontend drops the barcode drawing.
- **CR-031, CR-032, CR-033** stay with B9b; CR-033 point 2's QR at the counter is replaced by the SMS link (owner, ADR-0072). **CR-018** stays with B12.
- The others were answered in earlier phases (CR-005, CR-023, CR-027 in B09x; CR-028 in B09x continued; CR-013 in B09a continued 2g; CR-012 1.20.0; CR-014 to CR-017 1.21.0; CR-020 1.38.0; CR-026 1.40.0; CR-030 1.43.0; CR-009 to CR-011, CR-019, CR-021, CR-025, CR-029 in their phases).

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit | **1,482 passed**, 126 files |
| Coverage, merged (`pnpm test:coverage`) | **2,999 passed**, 243 files, exit 0. Statements 93.77 percent, branches 83.64 (gate 80), functions 97.21, lines 96.39. Every 100 percent gate held, the new `mdm/domain/public-id.ts` and the rewritten `mdm/domain/label.ts` and `inv/domain/label.ts` among them |
| Integration (in the merged run) | 1,517; new: `sku-schema` (10), `public-id-schema` (5), `public-ids` (7), and the SKU, barcode and public ID tests in existing files |
| Contract | **118 passed**, 44 files (new: 8 in `b9/ids-barcodes`) |
| Lint, typecheck | Clean (boundary rule, 22 lint fixtures, 295 specs in place, schema names) |
| End to end | CI only |

## Gate

**Passed for the shape changes; phase split (A-254).** No QR code but TOTP enrolment's, kept by a lint rule and a contract test; no product barcode field, lookup or till scanning and no barcode on product or lot/animal labels, while the meat pack labels are byte for byte as built; a product's SKU is generated by the server, unique, never reused and never accepted as input; customers and suppliers carry an unguessable public ID, shown in responses and accepted in search, in place of their sequential numbers; contract 2.0.0 with a loud changelog and every example updated. The remaining clause, "knowing a public ID, a SKU or a UUID reads nothing without authorisation, and every link sent to a customer carries its own long random token, each proved by a test", is B09q continued's gate.

## Notes for the frontend track

- **Contract 2.0.0, breaking.** Read `publicId` wherever you read `customerNo` or `supplierNo`, show it to people and let them search with it (any case, spaces fine). Never show a UUID.
- Do not send `sku` (422) or `barcode` (400). Show the SKU the server returns; a category screen may set `skuPrefix`.
- Labels print text: drop the Code 128 drawing for products and lots. Meat pack labels are unchanged.
- Import templates: CUSTOMER and SUPPLIER start with `publicId`; PRODUCT keeps `sku` (blank creates) and has no `barcode`.

## CI

- **`7bf126f`** (all code, tests and documents before this report; pull request #84 opened on it): run **44068818495 (push)**, success; run **44068871208 (pull_request**, which also compares the contract with `main`), success.
- A commit cannot name its own runs, so the runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B09q continued, copied from `docs/prompts/session-openers.md` (inserted by this split; B09e follows it).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09q-ids-barcodes.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md).
For this phase, read the owner's decision 5 below, ADR-0073, ADR-0070 (the tracking token it replaces),
docs/security/SECURE_CODING_STANDARDS.md SC-02, the abuse cases on enumeration and on customer links in
docs/security/THREAT_MODEL.md, and test/integration/iam/authorisation.integration.spec.ts (the handler walk). Load
hakorem-security-review, hakorem-endpoint, hakorem-migration and hakorem-tests. Do not read any other document unless
this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09q continued only, on branch b09q2-no-id-is-a-key, branched from main. The owner's decision 5
(2026-11-17), as B09q's opener gave it:
5. No ID is ever a key: every read is authorised, whatever identifier it is given. Any link sent to a customer (order
   tracking, the receipt, a document link) carries its own long random token. Test that knowing someone's public ID,
   SKU or UUID gets you nothing, per operation that takes one, as an anonymous caller and as another customer.
In practice: list from the contract every implemented operation that takes a UUID, a public ID (`q` on listCustomers
and listSuppliers) or a SKU (`q` on listProducts, the import sheets) and write one generated test per operation that
calls it as an anonymous caller, as another customer and as a staff role without its permission, expecting 401, 404 or
403 as SC-02 says and nothing in the answer; a customer's own reads (getMyOrder and the like) answer 404 for another
customer's record. Replace trackOrder's HMAC-signed id token (ADR-0070) with a random token of at least 128 bits made
when the order is placed, stored only as its hash in ORD, looked up in constant time, never derived from the order id;
record the change as an ADR superseding that part of ADR-0070, and keep trackOrder's shape. Name, in the report, the
link B9b's receipt and B11's SMS must follow. Mutation-check the refusals (remove an authorisation and see the tests go
red). The contract stays 2.0.x: descriptions, examples and at most additive changes.
Stop at the gate, write docs/sessions/B09q2-no-id-is-a-key.md, and merge into main when every run on the pull request
is green.
```
