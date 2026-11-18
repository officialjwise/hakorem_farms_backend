# B09u: unit names, the egg base unit and the supplier account (lane B)

Date: 2026-11-17 to 2026-11-18 · Branch `b09u-units-supplier-account`, from `main` (`25d2844`), rebased on `main` at `e526e1e` (lane A's B09b continued 1b, #105) · Pull request [#106](https://github.com/officialjwise/hakorem_farms_backend/pull/106) · Status: **gate passed.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-301 | **The Manager holds `pur.supplier_invoice.approve`** (migration 0248, the parent session's leave in IAM): approves supplier credit notes, and so also approves invoices for payment (never their own) and may ask for a variance. A separate credit-note permission would change the approval policy's existing row. | Owner |
| A-302 | **CR-040 as built:** only a line naming its order line with no value typed, on a receipt naming its order; the order price for the accepted base quantity, rounded half-up once, no non-reclaimable levy added; worked out when the line is written; a typed value wins. | Owner, Accountant |
| A-303 | **Unit names and `EGG`:** lowercase `singularName` and `pluralName` on every unit; a new unit `EGG`; the seeded eggs counted in it with every stored figure unchanged (only the seed changes, as A-261); `UNIT` stays for cabbage, lettuce, medicines and delivery; rolled back, `EGG` is kept while anything names it. | Owner |
| A-304 | **`priceVariancePesewas` is per unit** (the parent session's rule (a): no reader treats it as a whole amount, traced below); the new `priceVarianceLinePesewas` is the line's whole difference; the examples are fixed to 40 and 20,000. | Owner, frontend |
| A-305 | **The supplier's balance:** the five figures' definitions, whole branches only, owed and in payment overlap, an unknown supplier 404. | Accountant |
| A-306 | **CR-043:** the maker is refused before the match is taken again; the database holds it; minor version 2.9.0, marked LOUD. | Owner |
| A-307 | **BL-077:** the void's approval (not its request) waits for a pending reversal; a reversal's request is refused beside a waiting void; the database holds one open reversal per payment; no database rule for the second direction (PAY cannot read ORD). | Owner |
| A-308 | **The import's create lock:** taken at apply for customers and suppliers; the product sheet's SKU lock parked as BL-090. | Backend |

**No ADR conflict.** ADR-0086 is new (proposed): INV's `OrderLineValuation` port, which PUR implements (MODULE_BOUNDARIES rule 6 requires an ADR for a port). ADR-0001, ADR-0035, ADR-0075 and ADR-0076 are untouched: the receipt's value is what ADR-0075 anchors the pool at, and ADR-0076's conversion is reused.

**LOUD for the frontend:** `approveSupplierInvoice` now refuses its maker (422 `INVOICE_MAKER_CANNOT_APPROVE`, CR-043, approved by the owner as a breaking behaviour); a void's approval beside a waiting reversal answers 422 `ORDER_INVALID` `REVERSAL_PENDING` where it answered 500, and `reversePayment` beside a waiting void 422 `PAYMENT_REVERSAL_INVALID` `VOID_PENDING`; `priceVariancePesewas` is per unit (the examples that showed 20,000 now show 40, with `priceVarianceLinePesewas` 20,000); the seeded eggs' base unit is `EGG`, no longer `UNIT`.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09u, lane B (`b09u-units-supplier-account`, from `main`).
2. **Scope:** the owner's eight decisions: unit names and the egg unit (MDM, the seed, every example), CR-040 (INV and PUR), the Manager's approval of a supplier credit note (one IAM grant), CR-042, CR-043 and CR-044 (PUR), BL-077 (ORD and PAY), the import's create lock (MDM).
3. **Gate:** every unit answers a singular and a plural name and the seeded eggs are counted in a unit named "egg" with every stored figure unchanged; a receipt line against an order line is valued by the server unless a value is typed; a supplier credit note raised by the Owner and drafted by the Accountant can be approved by a Manager, and never by either of them; a supplier's balance answers from the server; approving a supplier invoice refuses its maker; every write refuses the wrong role.

## Contract changes

**2.9.0, minor, with two LOUD behaviours** (on top of lane A's 2.8.0). The changelog entry and its cold-read line are written.
- **New:** `getSupplierBalance` (`GET /suppliers/{id}/balance`, `pur.supplier_invoice.read`) and `SupplierBalance`.
- **New response fields:** `SupplierInvoiceLine.priceVarianceLinePesewas`; `Uom.singularName` and `Uom.pluralName`.
- **Loosened request field:** `GoodsReceiptLineInput.valuePesewas` is no longer required (a line naming its order line may leave it out). New `GOODS_RECEIPT_INVALID` details: `ORDER_LINE_UNKNOWN`, `ORDER_LINE_OTHER_PRODUCT`.
- **Error code on an operation:** `approveSupplierInvoice` gains `INVOICE_MAKER_CANNOT_APPROVE` (LOUD).
- **Behaviour, loudly:** BL-077's two refusals (above); new details `REVERSAL_PENDING` on `ORDER_INVALID` and `VOID_PENDING` on `PAYMENT_REVERSAL_INVALID`.
- **Descriptions and examples:** CR-044's variances; every egg example in `EGG`; the unit list's example with both names; the seeded role matrix (the Manager's grant).
- **No existing field removed, renamed or retyped.** Checks: `contract:generate --check` up to date (450 operations from code, 194 planned), Redocly clean (no warning), `scripts/contract/versioning.ts` against `main`: ok.

## Built

| Item | What |
| --- | --- |
| 1. Unit names and the egg unit | Migration 0249: `mdm.uom.singular_name` and `plural_name` (NOT NULL, `ck_uom_singular_name`, `ck_uom_plural_name`) and the unit `EGG`; `listUnitsOfMeasure` answers both names; the seed counts EGG-0001 to EGG-0003 in `EGG` (`reference-pricing.ts`); every egg example and test reads `EGG`. |
| 2. CR-040 | INV's `OrderLineValuation` port (`OrderLineValuationRegistry`, ADR-0086); `GoodsReceipts` values a line naming its order line with no value; PUR's `PurchaseOrderLineValues` answers with the domain's `acceptedValueAtOrder`; the request schema's refinement keeps a value required on a line with no order line. |
| 3. The Manager's approval | Migration 0248: the Manager holds `pur.supplier_invoice.approve`. |
| 4. CR-042 | `SupplierInvoices.balance`, `PurchasingStore.supplierBalance`, the route `suppliers/:id/balance`. |
| 5. CR-043 | The domain's `judgeInvoiceApprover`, `approveSupplierInvoice`'s check, migration 0247 (`ck_supplier_invoice_approver`) and its refusal translated; the seed's transport invoice approved by the Owner; every test that approved its own invoice now has someone else approve it. |
| 6. CR-044 | The domain's `lineVariance`; `priceVarianceLinePesewas` worked out on read; the descriptions; the examples fixed to the arithmetic. |
| 7. BL-077 | ORD's `judgeVoid` refuses `REVERSAL_PENDING` at the approval through PAY's new `Receipts.pendingReversalsIn`; PAY's `reversePayment` refuses `VOID_PENDING`; `reverseApprovedIn` refuses a second open reversal. |
| 8. The import's lock | `EntitySheet.createLocks`; the customer and supplier sheets name their create locks; `applyImportJob` takes them before its transaction. |
| Docs | ADR-0086 and its index line, A-301 to A-308, BL-077 done, BL-090, the changelog, `API.md`, the PUR, INV and MDM data models, the MDM, INV, PAY, PUR and ORD cards and the ports table, abuse case 28's control. |

## CR-044 first: what `priceVariancePesewas` means (the parent session's rule)

Every reader of the field and of `pur.supplier_invoice_line.price_variance_pesewas`, traced:
- **The tolerance** (`withinTolerance` in `three-way-match.ts`) compares the per-unit difference with the order's unit price: per unit on both sides, correct.
- **FIN's postings to 5140** (`supplierInvoiceAmounts` in `fin/domain/event-amounts.ts`) work from each ordered line's net plus non-reclaimable levies less its `orderValuePesewas`; the stored variance is never read.
- **The variance approval** (`judgeVarianceLines`, `requestVariance`) reads the match reasons, never the amount; the approval request carries the invoice's gross.
- **The exception report's source (abuse case 28)** is `varianceApprovalRequestId` on `pur.SupplierInvoiceMatched` and the approval request; no amount from the line.
- **Supplier scores** work their own price component from approved invoice nets and quantities (`priceComponent`).
- **The invoice's answer** shows the stored figure, per unit.

**Rule (a) applies:** no reader treats the per-unit figure as a whole-line amount, so this is a description fix, not a money defect. The field stays per unit and is described so; `priceVarianceLinePesewas` (additive) answers the line's whole difference for the screen that needs it (A-F10-06); the examples read 40 and 20,000. Unit-tested at 500 head at 1,290 against 1,250 (40 and 20,000), an exact half (2.500 kg at 3: 8), one below and one above, zero and the largest amount.

## The gate, proved by running it

**`test/integration/pur/supplier-account.integration.spec.ts` (9 tests):**
- **CR-043:** the Accountant who entered and matched an invoice of 7,500 is refused with 422 `INVOICE_MAKER_CANNOT_APPROVE`; the invoice stays `MATCHED`, no journal and no `pur.ExpenseInvoiceApproved`; the Owner approves it. By direct SQL as `hk_app`, approving an invoice by its maker is 23514 `ck_supplier_invoice_approver`.
- **F10g:** a crate at 4,751 with 7 of 30 eggs cracked; the Owner raises the claim, the Accountant enters the invoice and drafts and submits the credit note (1,109), the Owner approves the invoice. The Owner is refused as the credit note's approver (422 `INVOICE_MAKER_CANNOT_APPROVE`, the claim's maker), the Accountant too (422 `MAKER_CANNOT_CHECK`, the requester); nothing is credited. A Manager approves it: the claim is `SETTLED` by the credit note and the invoice is owed 3,642.
- **CR-042:** for a supplier made in the test, each figure equals the SQL sum straight from `pur.supplier_invoice`, `pur.supplier_claim` and `pur.supplier_payment` at the caller's branch, and the hand total: owed **111,142** (7,500 + 3,642 + 60,000 + 40,000), awaiting approval **38,595** (25,000 + 12,345 + 1,250), claimed **1,109**, in payment **15,000**, paid **30,000**; a cancelled invoice of 99,000 counts nowhere. The Owner of another branch sees only that branch's 8,800, and a Dodowa reader none of it. A supplier with nothing answers zero in all five. The Cashier and the Storekeeper are refused (403), a made-up supplier is 404, an anonymous caller 401. The identifier walk (`iam/no-id-is-a-key`) and the handler walk (`iam/authorisation`) cover the new route.
- **CR-044:** 3 crates at 4,790 against 4,751: `priceVariancePesewas` 39, `priceVarianceLinePesewas` 117, `OVER`, matched.

**`test/integration/inv/receipt-order-value.integration.spec.ts` (7 tests, CR-040):** 23 accepted eggs of a crate at 4,751 are valued 3,642 (3,642.43), answered, stored and posted (the `RECEIPT_PURCHASE` movement carries 3,642); 15 eggs are 2,375.5, valued 2,376; 2 crates of 3 are 9,502; a typed 3,600 wins; a changed draft is valued again (29 eggs: 4,593); a line with no order line and no value is 400 and writes nothing; an unknown order line, one of another order and one of another product are refused.

**`test/integration/mdm/uom-names.integration.spec.ts` (6 tests, item 1):** every unit answers both names (`egg`/`eggs`, `crate`/`crates`, `head`/`head`, `kilogram`/`kilograms`, `bunch`/`bunches`); the database refuses an empty or padded name; EGG-0001 to EGG-0003 are counted in `EGG` with a conversion of 30 from `CRATE`, none in `UNIT`; **900 big eggs at 105,000** on the shop floor, the seeded receipt line 30 crates, 900 eggs, 105,000; the base list prices a crate at 6,000 and a single egg at 220, each for its own unit. These are the figures B09e and B09e continued asserted with `UNIT` (A-261, A-268); every one of their specs still passes on the new seed.

**`test/integration/ord/void-pending-reversal.integration.spec.ts` (3 tests, BL-077, the exact case till-cash-paths found):** a cash sale at the till, a reversal of its payment asked for, a void asked for, the void approved: 422 `ORDER_INVALID` `REVERSAL_PENDING` on `/payments` (it was 500), nothing changed (order `COMPLETED`, payment `CLEARED`, one open reversal, no reversing payment); the reversal rejected, the same void approved (`VOIDED`, `REVERSED`). A reversal asked for while a void waits is 422 `PAYMENT_REVERSAL_INVALID` `VOID_PENDING`; the void then goes through. By direct SQL, a second open reversal is 23505 `uq_payment_reversal_open`.

**`test/integration/mdm/import-create-lock.integration.spec.ts` (3 tests, item 8):** a 40-row import applied beside 8 creates, of customers and of suppliers, every request answering at once with none retried, 48 new rows each; an import and a create racing for one phone hold it once.

**Contract:** `test/contract/b9/supplier-claims.contract.spec.ts` checks `SupplierBalance`, `UomPage`, a `GoodsReceipt` valued from its order line (9,502), a matched `SupplierInvoice` with `priceVarianceLinePesewas` (39 and 78) and the maker's `Error`.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | `approveSupplierInvoice`'s maker check removed | **green** (9 of 9): the database's `ck_supplier_invoice_approver` refuses it and is translated to the same 422, which is what it is for |
| 2 | `ck_supplier_invoice_approver` always true | red: 1 of 9 |
| 3 | Both 1 and 2 | red: 2 of 9 |
| 4 | `judgeInvoiceApprover` always ok | red: 1 of 5 (unit) |
| 5 | The Manager's grant (0248) granted to nobody | red: 3 of 9 |
| 6 | A typed value no longer wins on a line naming its order line | red: 1 of 7 |
| 7 | PUR's valuation no longer checks the product | red: 1 of 7 |
| 8 | ORD's `REVERSAL_PENDING` never judged | red: 1 of 3 (PAY's backstop answers `PAYMENT_REVERSAL_INVALID`) |
| 9 | PAY's `VOID_PENDING` removed | red: 1 of 3 |
| 10 | The import without the create lock (the code before the fix) | red: 3 of 3 (retries logged) |
| 11 | The seeded eggs in `UNIT` again | red: 1 of 6 |

## Test first, as it honestly happened

- **Red first, for the right reason:** `supplier-account` (9 of 9 red: the code missing, the Manager forbidden, the route 404), `receipt-order-value` (5 of 7 red: `valuePesewas` required), `void-pending-reversal` (2 of 3 red: the 500 reproduced; the database test was green, the rule already existed), `import-create-lock` (3 of 3 red: retries), `lineVariance` and `acceptedValueAtOrder` unit tests (red: missing).
- **Not red first:** `uom-names` was written after migration 0249 and the seed change, so 5 of its 6 tests passed on their first run (only the names in the answer were red); mutation 11 proves the egg tests bite.
- **The first full merged run on the rebased code was red on 3 tests**, each a list the change had to extend, fixed before the commit: the rollback walk's list of migrations (`bil/archive-link-rollback`, which also proved 0249's down step over the seeded farm), the handler walk's list of operations (`iam/authorisation`), and the unit list's paging (`mdm/catalogue`: `EGG` sorts before `HEAD`). The contract drift test counted 643 operations; it counts 644.

Nothing was re-run to turn red into green; no assertion was weakened and nothing was skipped.

## Security review (hakorem-security-review)

- **Boundary:** TB2 (back office) and the database.
- SC-01: strict zod (the line refinement keeps the value required without an order line; ids as UUIDs). SC-02: `getSupplierBalance` authorises first, deny by default, then sums only the caller's whole branches; the wrong roles, another branch's Owner, a made-up id and an anonymous caller are tested; the identifier walk covers it. SC-03 and SC-04: parameterised SQL only. SC-05: integer pesewas as bigint; `acceptedValueAtOrder` and `lineVariance` round half-up once on integers. SC-06: every write keeps its idempotency key. SC-17 (maker and checker): an invoice's maker can no longer approve it (domain and database); a supplier credit note's claim maker and drafter are refused and a Manager approves; a void and a reversal of one payment can no longer both wait. SC-22: no ledger row is updated; the receipt's value is written once with the line. SC-23: serializable throughout; the import queues on the create lock.
- **Abuse:** abuse case 28's control gains the invoice approval. No new abuse path: the balance only reads, and the server's receipt value is the order price the farm agreed.

## Deferred

- BL-090: the product sheet's import and createProduct's `SKU_SERIES_LOCK`.
- A screen's names for unit codes elsewhere (`uom`, `baseUom` on other shapes) come from `listUnitsOfMeasure`; no other shape carries the names (A-303 (f)).

## Contract requests

The frontend's `main` was read at `678f8c9`; it holds CR-001 to CR-044.
- **CR-040:** implemented (the server values the line; the field is optional against an order line).
- **CR-042:** implemented as the request names it.
- **CR-043:** implemented: the refusal, in the domain and the database, with the code in `x-error-codes`.
- **CR-044:** implemented as descriptions, plus the additive `priceVarianceLinePesewas`: the request's point (3), "`priceVariancePesewas` is the line's whole difference", is not what the server computes and no reader treats it so (above); the whole-line figure is the new field, and the examples now match the arithmetic. The screen should read `priceVarianceLinePesewas` for "GH₵ over the order's price on this line".
- **CR-041:** placed by the owner in B10 (its opener names it). **CR-039:** B11. **CR-031 to CR-033 and CR-038:** lane A's (B09b's continued parts).
- **Everything else:** answered in earlier phases.

## Tests (this machine, 2026-11-18)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`), on the rebased head | **3,363 passed**, 275 files. Statements 94.29 percent, branches 84.75 (the gate is 80), functions 97.79, lines 96.97; every 100 percent gate held. |
| Contract (`pnpm test:contract`) | **124 passed**, 47 files. |
| Lint (module boundaries, lint fixtures, test placement, schema names), typecheck, Redocly (no warning), `contract:generate --check`, versioning against `main`, the dependency audit (the owner's live waiver only) | Clean. |
| End to end, setup, the image, the scans, the last migration rolled back and applied again | Run in CI (0249's down step was also proved over the seeded farm by `bil/archive-link-rollback`). |

## Gate

**Passed:** every unit answers a singular and a plural name and the seeded eggs are counted in `EGG` with every stored figure unchanged (900 at 105,000, 30 a crate, 6,000 and 220); a receipt line against an order line is valued by the server (3,642, 2,376, 9,502) unless a value is typed; a supplier credit note the Owner's claim raised and the Accountant drafted is approved by a Manager and refused to both; the supplier's balance answers each figure exactly as PUR's tables sum; approving a supplier invoice refuses its maker in the domain and the database; every new read and write refuses the wrong role.

## Notes for the frontend track

- **2.9.0:** the supplier account screen can drop `HK_REQUESTED_CONTRACT=CR-042` and read `getSupplierBalance`. Owed and in payment overlap until a payment is paid.
- **Invoice approval** now needs a second person; show the 422 in words (CR-043's note says the screen already does).
- **Variances:** show `priceVarianceLinePesewas` as the line's difference and `priceVariancePesewas` as the difference per unit; `qtyVariance` is in the product's base unit (A-F10-06 read it in the line's `uom`).
- **Receiving against an order:** the cost field can be left empty on a line with its order line; the answer carries the value.
- **Units:** say "540 eggs" and "from 10 crates" with `pluralName` and `singularName` from `listUnitsOfMeasure`; the seeded eggs' base unit code is now `EGG`.
- **A void beside a reversal** answers 422 with `REVERSAL_PENDING` or `VOID_PENDING`, never 500.

## CI

- **`dc29c8e`** (the rebased code head, pull request #106): run **44247449885 (push)** **succeeded** and run **44247480503 (pull_request)** **succeeded**. Their jobs: lint and type check; unit and integration with the coverage gate; contract (with the contract compared against `main` on the pull request run); the setup script with end to end and smoke, and the last migration (0249) rolled back and applied again; the image build and scan; the secret scan, the dependency audit (the owner's live waiver only) and static analysis.
- **The merge slot:** taken once the gate passed locally; `main` was still at `e526e1e`, the base of the rebase, so nothing was renumbered again.
- **This report's own commit:** a report cannot name the runs of the commit that adds it, so they are named in the session's closing message. The pull request merges only when every run on its head is green.

## Next session

B10, copied from `docs/prompts/session-openers.md` on `main` (no split: B10's opener already reads this report).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B09u-units-supplier-account.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the QUO and WHL requirement blocks of docs/SRS.md (nothing else from the SRS),
docs/data-model/quo.md and whl.md, the QUO and WHL cards in docs/MODULE_BOUNDARIES.md, DOMAIN_MODEL
section 5.12, and ADR-0004, ADR-0017, ADR-0019 (quote reservations) and ADR-0085 (statements), and the abuse case 14 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B10 only, on branch b10-quotations-wholesale: requests for quote, quotes made of immutable
versions with the margin floor and its approval, reservations for the validity period, acceptance once
through the signed expiring link, conversion to exactly one order with every link kept, business
accounts with credit limit, terms and exposure, the credit override with a different approver, ageing
computed from invoice due dates, dunning, standing orders, overdue hold. Customer statements are built (B08 continued
2d, ADR-0085, A-300): add FR-WHL-009's ageing summary to them additively, and decide whether money held on deposit for
the customer (2200) belongs on them (A-300 (i)); sendStatement stays B11's. Run scenario 2
of docs/UAT.md as a dry run and record any difference, including the two rules that scenario flags
for the owner (credit check and delivery fee on a partial dispatch).
The owner, 2026-11-16 (A-212 (d)): a bounced cheque (a reversal with CHEQUE_DISHONOURED) counts against the customer's
credit standing.
CR-041 (owner, 2026-11-17, F10f): who holds a buyer's price list. getCustomerPriceList (GET
/customers/{id}/price-list, mdm.customer.read): the buyer's assignments, current and future; listPriceListAssignments
(GET /price-lists/{id}/assignments): the buyers who hold a list, with their windows; and PriceListEntry.baseUom, the
unit minQtyBase is in. Both reads are authorised and join the contract-generated identifier walk (B09q continued).
The owner, 2026-11-17, from the frontend's F10i (answer CR-045 to CR-047 in the report as committed on the frontend's
main; if one is not there yet, build from these words and say so), each test-first:
1. CR-045: a quote line names its unit (a crate or a single egg), priced by that unit's own entry, never derived from
   another unit's price; converted to the base unit through MasterDataRefs.toBaseIn for the reservation.
2. CR-046: an order over the customer's credit limit or past their terms does not go through. An approval request in
   place of a plain refusal is kept, but the response carries the amount over the limit and the reason (over limit,
   past terms, or both), the order stays blocked until approved, the override needs a written reason, and the
   approver is never the person who asked (mutation-checked). Exact pesewas at the limit, one pesewa over, and past
   terms by one day.
3. CR-047: the quote link carries its own long random token (ADR-0074: at least 128 bits, stored only as its hash,
   with an expiry), never the quote's id or number, with clear states the public read answers: expired, replaced (a
   newer version), accepted and declined. Accepted once only, by the token of the live version; test that a replaced
   version's token, an expired one, a guessed one and the quote id each open nothing.
4. The public request-for-quote form takes a quantity and its unit (crate or single egg), validated against the
   units the product is sold by.
5. Roles, in the role matrix and the seed: Sales builds, sends and converts quotes; the Accountant may put an account
   on hold; releasing a hold, approving a credit override and changing a credit limit are Owner or Manager only, and
   never by the person who asked. A wrong-role refusal test for each, and a maker-is-checker refusal for each of the
   three, mutation-checked.
Stop at the gate and write docs/sessions/B10-quotations-wholesale.md.
```
