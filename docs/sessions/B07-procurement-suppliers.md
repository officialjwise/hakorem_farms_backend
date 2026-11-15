# B7: procurement, purchase to pay (phase split)

Date: 2026-11-15 · Branch `b07-procurement-suppliers`, from `main` (`be21450`) · Pull request #42 · Status: **phase split (A-165). The gate's first half passed; the second half moves to B07 continued 2.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-164 | **How purchase to pay is built, taking the most conservative reading.** (a) **Approval limit:** one `PURCHASE_ORDER` policy is judged "at or above" and seeded at 200,001, so above 200,000 pesewas needs a second person. The requester's own `iam.role_limit` is not read yet. The threshold judged is kept on the order, and the database refuses an approved, sent or received order at or above it that has no approval request. A refused order goes back to DRAFT. (b) **Units:** an order line names an optional `uom` and converts through `toBaseIn`. Received and invoiced quantities are in the base unit, and an invoice line takes its order line's unit. (c) **Receipts:** INV publishes `inv.GoodsReceiptPosted`, and PUR keeps `qty_received` in the receipt's own transaction. A refusal there (`RECEIPT_EXCEEDS_ORDER`, `RECEIPT_ORDER_MISMATCH`) rolls the whole receipt back. A receipt's value is not checked against the order price. (d) **`qty_invoiced` is derived, not stored.** (e) **Match:** price within 1 percent either way. Quantity may not exceed what was received less what other live invoices hold. A product line with no order line, a different product, or a levy that differs from the calculated one each mismatch. Approval matches again. A payment allocation to an unmatched invoice answers `THREE_WAY_MATCH_FAILED`, not API.md's older `INVOICE_NOT_MATCHED`. The approved-variance route is not built. (f) **Invoices:** `INVOICE` kind only. Prices are tax-exclusive. The due date defaults to the invoice date. `branchId` is required when there is no order. The optional `statedGrossPesewas` must equal the lines. A number is unique per supplier among invoices that are not cancelled. (g) **Orders:** tax-inclusive orders are refused. Sending renders no document yet (B8), and numbers stay null (B8). (h) **Payments:** allocations are written when the payment is prepared, and those of rejected or cancelled payments stop counting. A payment is always approved by a different person, and only APPROVED invoices can be paid. `bankAccountId` is refused until B8, and there is no remittance document yet. (i) **Grants:** see below. | Owner (a, i); accountant (e, f, h) |
| A-165 | **B7 split at sub-domain boundaries.** **B07 continued** (`b07b-supplier-register`) covers profiles and payout details with the different-approver rule, documents, requisitions, credit notes, the approved variance, remittance data and scores. **B07 continued 2** (`b07c-storefront-checkout`) covers the catalogue, cart, checkout reservation and the slot table, and carries the gate's second half. Recorded in ADR-0026 Amendments and the openers; B8 now reads the B07 continued 2 report. | Owner |

**Needs the owner's approval:**
- **The split itself.** Two continued phases come before B8.
- **The approval limit.** It is one branch policy, above 200,000 pesewas, and ignores per-role limits for now.
- **The grants.**
  - The Storekeeper and the Manager make purchase orders; the Owner and the Manager approve, send and close them.
  - The Accountant and the Owner enter, match and approve invoices, and prepare payments and mark them paid.
  - The Owner and the Manager approve payments, never their own.
- **No new dependency.**

**I found no ADR conflict.** There is no new ADR and no new port. The receipt subscriber is one of the three transactional kinds ADR-0010 allows: a module keeping its own aggregate consistent with a lower module's fact. ADR-0047, ADR-0051 and ADR-0052 are untouched.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B7 (`b07-procurement-suppliers`, from `main`).
2. **Scope:** PUR and SHP, with the delivery slot table. It was too large for one context, so it was split before building, at sub-domain boundaries. This session built purchase to pay.
3. **Gate:**
   - The three-way match blocks payment on disagreement (built here).
   - Checkout reserves stock and releases it on timeout (moved to B07 continued 2).

## Contract changes

**Version 1.28.0, minor and additive. No existing field was removed, renamed or retyped.**
- **Counts:** 282 operations from code, 348 planned, 630 published.
- **From code now (21):** `listPurchaseOrders`, `createPurchaseOrder`, `getPurchaseOrder`, `updatePurchaseOrder`, `submitPurchaseOrder`, `sendPurchaseOrder`, `closePurchaseOrder`, `cancelPurchaseOrder`, `listSupplierInvoices`, `createSupplierInvoice`, `getSupplierInvoice`, `updateSupplierInvoice`, `matchSupplierInvoice`, `approveSupplierInvoice`, `cancelSupplierInvoice`, `listSupplierPayments`, `createSupplierPayment`, `getSupplierPayment`, `submitSupplierPayment`, `markSupplierPaymentPaid`, `cancelSupplierPayment`.
- **New optional request fields:**
  - `PurchaseOrderLineInput.uom`
  - `SupplierInvoiceCreate.branchId` and `.statedGrossPesewas`
  - `SupplierInvoiceUpdate.statedGrossPesewas`
- **New response fields (required):**
  - `PurchaseOrderLine.baseUom`, `.qtyOrderedBase` and `.qtyOutstanding`
  - `SupplierInvoiceLine.uom`
  - `PurchaseLevyAmount.calculatedAmountPesewas`
- **New error codes:**
  - `PURCHASE_ORDER_INVALID`
  - `RECEIPT_EXCEEDS_ORDER` and `RECEIPT_ORDER_MISMATCH`, also on `postGoodsReceipt`
  - `SUPPLIER_INVOICE_INVALID`
  - `SUPPLIER_PAYMENT_INVALID`
  - `THREE_WAY_MATCH_FAILED`, `DUPLICATE_SUPPLIER_INVOICE` and `ALLOCATION_EXCEEDS_AVAILABLE` are now raised.
- **Other changes:**
  - Every operation now carries `x-error-codes`.
  - `matchReasons` are now codes, not sentences.
  - The examples were corrected.
- The changelog entry and the cold-read summary are written. Redocly lint is clean, and `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0093:** document types `PURCHASE_ORDER`, `SUPPLIER_INVOICE` and `SUPPLIER_PAYMENT`.<br>**0094:** the `pur` schema: orders and lines; invoices, lines and levy rows (snapshotted, with `is_reclaimable`); payments, and allocations (LEDGER). Database rules:<ul><li>status guards;</li><li>`ck_purchase_order_approved`;</li><li>`ck_purchase_order_line_tolerance`;</li><li>a check that the line net is round(qty x price);</li><li>deferred checks that totals equal their lines and levy rows, that `paid_pesewas` equals what PAID payments allocated, and that a payment's amount equals its allocations;</li><li>the allocation guard (only an APPROVED and MATCHED or NOT_REQUIRED invoice of the same supplier, never above its gross across live payments);</li><li>settlement on PAID by trigger;</li><li>the unique supplier invoice number among invoices not cancelled;</li><li>the unique reference per method.</li></ul>**0095:** 13 permissions, and the `PURCHASE_ORDER` (200,001) and `SUPPLIER_PAYMENT` (always) policies, both with step-up.<br>**0096:** grants. |
| MDM | `ProductFacts.taxCategoryId`, and `MasterDataRefs.taxCategoriesIn`. |
| INV | `inv.GoodsReceiptPosted`, published once when a receipt is posted. |
| PUR domain (100 percent gate) | `three-way-match.ts` (FR-PUR-009's named test), `purchasing.ts` (line net, receipt tolerance, order actions, payment allocations). The specs were written first and seen red (missing modules). |
| PUR application, infrastructure and interface | `PurchaseOrders` (also the approval handler and the receipt subscriber), `SupplierInvoices` and `SupplierPayments` (also an approval handler), `PgPurchasingStore`, `PurchasingController` (21 routes) and strict zod schemas. Each handler authorises first, scoped to its branch and location, claims the idempotency key, runs serializable, audits before and after, and publishes through the outbox: `pur.PurchaseOrderApproved`, `.PurchaseOrderSent`, `.SupplierInvoiceMismatched`, ◆`.SupplierInvoiceMatched`, ◆`.ExpenseInvoiceApproved` and ◆`.SupplierPaymentMade`. |
| Seed | `farm-pur.ts`, run after the PRC seed, dated by the app clock. The Manager orders 4 bags of grower pellets from Awutu at 45,000 (180,000, approved on submit) and sends the order. The Accountant enters Kpone's transport invoice `KLT-T-0457` (15,000, NOT_REQUIRED) and approves it. No stock moves, so the B5 hand count is unchanged. |
| Docs | <ul><li>A-164 and A-165.</li><li>The as-built note in `docs/data-model/pur.md`.</li><li>The PUR, INV and MDM cards.</li><li>`DOMAIN_MODEL.md` (the event, and the tolerance rule now in the database).</li><li>`API.md` (the B7 section and the codes).</li><li>The SRS traceability rows.</li><li>Threat model case 19.</li><li>ADR-0026 Amendments.</li><li>The openers: the two new sections, the table, and the B8 lines.</li><li>The changelog.</li></ul> |

## Contract requests

The frontend's `main` lists CR-001 to CR-019 (fetched 2026-11-15). None of them concerns procurement.
- **CR-019** (server-side sort): **declined here** because it is outside this phase's scope. It stays parked as BL-057.
- **CR-005**: standing decline.
- The rest were answered in earlier phases.

## Security review (hakorem-security-review)

Written into PR #42.
- **Boundary:** TB2, the back office, and the database.
- **Authorisation:**
  - Deny by default; every handler authorises in the application layer.
  - Lists are narrowed to the reader's grants. Order lists honour location grants; invoice and payment lists show only branches the reader holds as a whole.
  - The handler walk covers all 21 routes, and the wrong roles are refused on every write.
- **Maker and checker:** IAM's database constraint keeps them apart, and the approval hash binds the order and the payment. Tests:
  - The Manager cannot approve the Manager's own order.
  - The Owner cannot approve the Owner's own payment.
  - The Accountant lacks the approver permission.
- **Money:**
  - Integer pesewas, rounded half-up once (2.5 bags at 45,025 is 112,563).
  - Totals are held to their lines by deferred triggers.
  - Two payments racing for one invoice: one is refused.
  - A payment reference is unique per method.
- **Database:** DOCUMENT tables have no DELETE; the allocation LEDGER table refuses UPDATE and DELETE, for hk_app (42501) and for the owner (HK001).
- **Not applicable:** uploads (an invoice scan must be a CLEAN `SUPPLIER_INVOICE` file, and there is no new upload path), webhooks, identity and exports. Payout details are B07 continued.
- **B06u's open question:** a wrong bag factor now shows on the order (`qtyOrderedBase`) before anything is received. The factor is immutable and audited, and both the match and the receipt tolerance use base units. No new threat row is needed; row 19 is updated.

## Deferred

- **B07 continued:**
  - FR-PUR-001 to FR-PUR-004, FR-PUR-011, FR-PUR-013 (the data only) and FR-PUR-014;
  - FR-PUR-010's approved variance;
  - terms-based due dates;
  - per-role order limits (`iam.role_limit`);
  - PUR's `LocationUsageCheck` (ADR-0051).
- **B07 continued 2:** the whole storefront and `del.delivery_slot`.
- **B8:**
  - posting PUR's ◆ events (FR-PUR-015);
  - `bank_account_id` and `remittance_document_id` with their foreign keys;
  - order and payment numbers;
  - the order and remittance documents.
- **Owner dashboard:** the purchases tile still reads goods receipts. Supplier invoices do not change what "purchases" means there, and nothing was changed.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **918 passed** (27 new in `src/modules/pur/domain/`). |
| Integration | **859 passed**. New: `pur/purchase-to-pay` (20). Updated: the handler walk and the seed unit kinds. |
| Coverage, merged | 1,777 passed. Statements 93.2, branches 82.97 percent (gate 80). Every 100 percent gate holds, including the new `src/modules/pur/domain/**` at 100 percent. |
| Contract | **70 passed**. New: `b7/purchase-to-pay.contract.spec.ts` (3). The drift counts are now 282 and 348, and the request-schema map gains eleven writes. |
| Lint, typecheck, Redocly, `contract:generate --check` | Clean |
| End to end | CI only (not run locally) |

**Test first, honestly:**
- The domain specs were written before the domain code and seen red (missing modules).
- The integration test was written after the application layer, but before any of it ran. Its first run was red: 14 of 19 failed. That exposed two real bugs, which were fixed:
  - plpgsql trigger `CASE` branches named fields their table lacks;
  - header updates did not bump `version` for `touch_version`.
- The first full run failed only on the lists a new route or seed unit has to join: the handler walk and the seed unit kinds. I joined them and nothing was skipped.
- I saw no flaky test.

## Gate

**First half passed. The phase is split.** Each point was proved by a test on this machine:
- **Price:** an order for 20 at 5,500, received 20, invoiced 20 at 5,550 (0.91 percent) matches and is approved. At 5,600 (1.82 percent) the invoice mismatches with `PRICE_OUTSIDE_TOLERANCE`; approval is 422 `THREE_WAY_MATCH_FAILED`, and a payment allocation is 422 `THREE_WAY_MATCH_FAILED`. A direct SQL allocation is refused by the database (HK010). Once the invoice is corrected to 5,500 it matches, is approved and can be paid.
- **Quantity:** invoicing 22 against 20 received mismatches on quantity (`qtyVariance` 2.000). An invoice for goods never received mismatches. A second invoice for birds already invoiced mismatches.
- **Payment:** paying 110,000 across invoices of 60,000 and 50,000 allocates exactly, 60,001 is refused, and the payment needs a different approver.
- **Orders and receipts (FR-PUR-005 to FR-PUR-007):**
  - An order of 110,000 is approved on submit; 250,000 answers 202.
  - Receiving 12 of 20 leaves 8 outstanding, 9 more is refused, and 8 completes it.
  - Cancelling after a receipt is refused, and a short close records 5 outstanding.
- **Duplicate number:** a second invoice number from one supplier is refused, while the same number from another supplier is accepted.
- **Second half (checkout reserves and releases):** not built; it is B07 continued 2's gate.

## Notes for the frontend track

- The purchase order, supplier invoice and supplier payment screens can now use the real API.
- Show order quantities in the line's `uom`, and progress in `baseUom`.
- Map `matchReasons` codes to your own words.
- Show `outstandingPesewas`; never subtract on screen.
- `submitSupplierPayment` is always 202.
- Profiles, documents, requisitions and scores stay mock-only (B07 continued).
- The storefront follows in B07 continued 2.

## CI

The code commits were pushed together, so CI ran only on their head, `90bc0d7` (pull request #42). This report's own commit is the final head: a commit cannot name its own runs, so they are listed in the session's closing message, together with `main`'s `push` run on the merge commit.

Both runs on `90bc0d7` are green:
- run 43764542116, `push`, success;
- run 43764577005, `pull_request`, success.

## Next session

B07 continued, copied from `docs/prompts/session-openers.md` (written by this phase's split):

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B07-procurement-suppliers.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the PUR requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/pur.md
(its "As built in B7" note first), the PUR card in docs/MODULE_BOUNDARIES.md, ADR-0020, ADR-0022 and ADR-0044, and
A-164 and A-165 in docs/ASSUMPTIONS.md. Use docs/prompts/module-build-prompt.md as the recipe. Load hakorem-money,
hakorem-security-review (payout details, documents, approvals) and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B07 continued only, on branch b07b-supplier-register, branched from main: supplier profiles with
payment terms (and invoice due dates from them), categories supplied and payout details encrypted (ADR-0022),
decrypted only with a permission and audited, changed only through a SUPPLIER_PAYOUT_CHANGE approval by a different
person (FR-PUR-001, FR-PUR-002); supplier documents through the file store (FR-PUR-003); requisitions and their
conversion to a purchase order (FR-PUR-004); supplier credit notes against an invoice's uncredited amount, with a
supplier-return movement through INV where goods go back (FR-PUR-011); the approved variance that lets a mismatched
invoice be paid (FR-PUR-010); the data of the remittance advice (FR-PUR-013; rendering waits for B8); supplier
scores (FR-PUR-014). Write the permission, money and approval tests first; extend the seed; changelog and cold-read
summary for every contract change. Stop at the gate, write docs/sessions/B07b-supplier-register.md, and merge into
main when every run on the pull request is green.```
