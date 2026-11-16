# B07 continued 1b: credit notes, the approved variance, remittance data and supplier scores

Date: 2026-11-15 · Branch `b07b2-supplier-credit-scores`, from `main` (`7022fab`) · Pull request #45 · Status: **gate passed. The phase was not split.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-15)

| ID | What | Who confirms |
| --- | --- | --- |
| A-172 | **Credit notes and the approved variance, both waiting for a different person (ADR-0017), whatever the amount, with a fresh step-up.**<br>**(a) Credit notes:**<ul><li>A credit note reduces an **APPROVED** invoice of the same supplier.</li><li>The cap counts every live credit note (not cancelled, waiting included) and every live payment. It is held in the domain and the database (`ck_supplier_credit_note_cap`).</li><li>`submitSupplierCreditNote` (new) answers 202 `SUPPLIER_CREDIT_NOTE`.</li><li>The approver holds `pur.supplier_invoice.approve` (the Owner, the Accountant) and is neither the submitter nor the person who entered it.</li><li>Only on approval is the invoice credited, do goods go back, and does the ledger event go out.</li><li>An approved credit note is never cancelled.</li><li>A paid invoice is not credited (BL-059).</li></ul>**(b) Goods sent back:** on approval a line naming `returnFromLocationId` (and `returnStockUnitId`, with a `RETURN` reason) moves as INV's `SUPPLIER_RETURN` through `Stock.postIn`.<br>**(c) The variance:**<ul><li>`requestSupplierInvoiceVariance` (new) answers 202 `SUPPLIER_INVOICE_VARIANCE`.</li><li>It covers price and levy mismatches only, **never goods not received**. This is held in the domain and the database.</li><li>The approver holds the new `pur.supplier_invoice.variance_approve` (the Owner, the Manager). They are never the asker nor the person who entered the invoice (`INVOICE_MAKER_CANNOT_APPROVE`, `ck_supplier_invoice_variance`).</li><li>The approved invoice shows match `VARIANCE_APPROVED`.</li><li>A waiting document is frozen (422 `APPROVAL_PENDING`).</li></ul> | Owner (grants, approver roles); accountant (a, the rule for paid invoices) |
| A-173 | **Supplier scores, computed when asked for one calendar month, not stored (BL-060).**<ul><li>**Price:** against the farm's average for the product that month (the SRS reading, not the data model's order price).</li><li>**Lead time:** the share of receipts on or before the promised day (the order's expected date, else its date plus the supplier's lead time).</li><li>**Quality:** the accepted share at the gate.</li><li>**Rejection:** 100 less the share of accepted goods sent back on credit notes.</li><li>**Weights:** four integer settings (30, 25, 25, 20); the score divides by their sum.</li><li>A component without facts means no score.</li><li>Receipt facts are recorded in PUR's existing transactional `inv.GoodsReceiptPosted` subscriber, not in `inv.GoodsReceived` as the card planned.</li></ul> | Owner (definitions, weights) |
| A-174 | **The remittance advice data.**<ul><li>One `pur.supplier_remittance` row (LEDGER) per paid payment, written in the transaction that marks it paid: the invoices with gross, credits, amount and what was left.</li><li>`getSupplierPaymentRemittance` (new) reads it.</li><li>`pur.SupplierRemittanceReady` is published once.</li><li>Rendering waits for B8 and sending for B11.</li></ul> | Accountant |

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B07 continued 1b (`b07b2-supplier-credit-scores`, from `main`).
2. **Scope:**
   - FR-PUR-011: credit notes with the supplier-return movement and the ledger event.
   - FR-PUR-010: the approved variance.
   - FR-PUR-013: the remittance data.
   - FR-PUR-014: supplier scores with weights held as settings.
3. **Gate:**
   - A credit note cannot exceed the invoice's uncredited amount (11,000 against 110,000 leaves 99,000; a second 100,000 is refused), in the handler and the database, with a supplier-return movement.
   - An approved variance lets a mismatched invoice be paid, never by its maker.
   - A paid payment's remittance data is answered once.
   - The score matches 91.0.
   - Every write refuses the wrong role.

## Contract changes

**Version 1.30.0, minor. No existing field was removed, renamed or retyped. One refusal was lifted:** `createSupplierInvoice` with `kind: CREDIT_NOTE` now works.
- **Counts:** 299 operations from code, 335 planned, 634 published.
- **New operations:**
  - `submitSupplierCreditNote` (`POST /supplier-invoices/{id}/submit`)
  - `requestSupplierInvoiceVariance` (`POST /supplier-invoices/{id}/variance`)
  - `getSupplierPaymentRemittance` (`GET /supplier-payments/{id}/remittance`)
- **Moved from planned to code:** `listSupplierScores` (`periodStart` must be the first of a month).
- **New enumeration values in responses:** `SupplierInvoice.matchStatus` gains `VARIANCE_APPROVED`; `ApprovalKind` gains `SUPPLIER_CREDIT_NOTE` and `SUPPLIER_INVOICE_VARIANCE`.
- **New required response fields:**
  - `SupplierInvoice`: `creditedPesewas`, `approvalRequestId`, `varianceReason`, `returnReasonCode`.
  - `SupplierInvoiceLine`: `returnFromLocationId`, `returnStockUnitId`.
  - `SupplierScore`: `returnedPercent`, `components`, `weights`.
- **New schemas:** `SupplierRemittance`, `SupplierRemittanceLine`, `SupplierScoreComponents`, `SupplierScoreWeights`, `SupplierInvoiceVarianceRequest`.
- **New optional request fields:** the line's two return fields, `returnReasonCode`, and a `kind` filter on `listSupplierInvoices`.
- **`outstandingPesewas`:** now subtracts approved credits, and is 0 on a credit note.
- **New error codes:** `CREDIT_NOTE_EXCEEDS_INVOICE`, `VARIANCE_NOT_ALLOWED`, `INVOICE_MAKER_CANNOT_APPROVE`, `APPROVAL_PENDING`.
- **Checks:** the changelog entry and the cold-read summary are written. Redocly lint is clean with no warnings, and `contract:generate --check` is up to date.

## Built

| Area | What |
| --- | --- |
| Migrations | **0107:** credit notes and the variance.<ul><li>`credited_pesewas`, `approval_request_id`, `variance_reason`, `return_reason_code`; the line's return location and unit.</li><li>Constraints: `ck_supplier_credit_note_cap` (deferred, invoice row locked), `ck_supplier_invoice_credited`, `ck_supplier_invoice_credit_approved`, `ck_supplier_invoice_variance`, `pur.supplier_invoice_variance_cover`.</li><li>The new status paths, the allocation guard and settlement now count credits.</li><li>The lines of a waiting credit are frozen.</li></ul>**0108:** `pur.supplier_remittance` and `pur.supplier_receipt_line` (both LEDGER).<br>**0109:** `pur.supplier_invoice.variance_approve` and the two approval policies.<br>**0110:** the grant to the Owner and the Manager. |
| PUR domain (100 percent gate) | `credit-note.ts`, `variance.ts`, `remittance.ts`, `supplier-score.ts` (exact fractions; the shown text rounds half-up once), and `judgeAllocations` counting credits and `VARIANCE_APPROVED`. |
| PUR application | `SupplierInvoices`:<ul><li>Credit note create, update, submit and cancel.</li><li>The variance request.</li><li>Two IAM approval handlers. On approval the credit sends goods back through INV's `Stock.postIn` and publishes ◆`pur.SupplierCreditNoteApproved`; the variance publishes `pur.SupplierInvoiceMatched` with `varianceApprovalRequestId`.</li></ul>`SupplierPayments`: credits in the cap; the remittance written in the paid transaction, with its read.<br>`SupplierScores` (new): weights read from `Settings`.<br>`PurchaseOrders.received`: records the receipt facts. |
| AUD | The four weight settings are added to the catalogue, so `updateSetting` changes them. |
| Interface | Four routes, strict zod schemas, fragments; the IAM approval kinds list. |
| Seed | `farm-pur-credit.ts`: the seeded Accountant enters Kpone's 1,500 transport credit (KLT-CN-0031) and the seeded Owner approves it, so Kpone is owed 13,500. No stock moves, so the B5 hand count is unchanged. |
| Docs | A-172 to A-174; BL-059, BL-060; threat model case 28 and its line in B12's opener; changelog; `API.md` (section and codes); the `pur.md` as-built note; the PUR card; `DOMAIN_MODEL.md` 5.7; SRS traceability; ADR-0026 Amendments; the openers' table. |

## Decisions

- **The approval mechanism.** The credit note's approval and the variance both use IAM's mechanism (ADR-0017).
  - Approving a credit note is a new operation, `submitSupplierCreditNote`.
  - `approveSupplierInvoice` keeps its 200-only meaning and refuses a credit note with `CREDIT_NOTE_NEEDS_APPROVAL`.
- **No ADR conflict.** There is no new ADR or port. PUR already imports INV (layer 5), and `Stock` is in INV's public interface.

## Contract requests

The frontend's `main` lists CR-001 to CR-021 (fetched 2026-11-15).
- **CR-021** (tag lookup for the Farm hand): **declined here**. The owner placed it in B06r's opener, the next phase.
- **CR-020** (a named in-review example on `listStockTakeLines`, examples only): **declined here** because it is an INV contract example outside this phase's scope (PUR). It is small and additive, and the next phase that touches INV examples, or the owner, can place it.
- **CR-019:** parked for B07 continued 2, as the owner placed it.
- **CR-005:** standing decline.
- The rest were answered in earlier phases.

## Security review (hakorem-security-review)

Written into the pull request. `docs/security/SECURE_CODING_STANDARDS.md` was run item by item.
- **Boundary:** TB2, the back office, and the database.
- **SC-01 input:** strict zod schemas.
- **SC-02 authorisation:** deny by default in each handler; the handler walk covers the four routes.
- **SC-03, SC-04:** parameterised SQL only.
- **SC-05 money:** integer pesewas; the score uses exact fractions.
- **SC-06:** every write takes an idempotency key.
- **SC-07, SC-08:** no secrets in logs.
- **SC-12, SC-13, SC-19:** not applicable (no upload, webhook or outbound URL).
- **SC-14:** no external call inside a transaction.
- **SC-15, SC-16:** database refusals map to stable codes.
- **SC-17 maker and checker:** IAM's check, plus the bar on the document's maker in the domain and on the row.
- **SC-22 to SC-24:** stock moves only through INV at serializable isolation; the new tables are LEDGER.
- **Abuse case 28 (new): an inflated price or a fake credit note waved through.** The controls are tested. The events carry the facts B12's exception report needs; its opener says so.

## Deferred

- **B8:** postings of ◆`pur.SupplierCreditNoteApproved` and the variance; the remittance document (`remittanceDocumentId`); a refund for a credit after payment (BL-059).
- **B11:** sending the remittance advice.
- **B12:** exception items for case 28.
- **BL-060:** storing monthly scores.
- **Owner dashboard:** the purchases tile still reads goods receipts; credit notes do not change what "purchases" means.
- **Receipt facts:** receipts posted before migration 0108 have none, which matters only on a database older than this migration.

## Tests (this machine, 2026-11-15)

| Layer | Result |
| --- | --- |
| Unit | **977 passed** (29 new across `credit-note`, `variance`, `remittance`, `supplier-score` and `purchasing`). |
| Integration | **909 passed**.<br>New: `pur/supplier-credit-variance` (14) and `pur/supplier-scores` (3).<br>Updated: the handler walk (four routes) and the seed unit kinds. |
| Coverage, merged | 1,886 passed. Statements 93.39, branches 82.90 percent (gate 80). Every 100 percent gate holds, `src/modules/pur/domain/**` included (245 of 245 statements, 185 of 185 branches). |
| Contract | **73 passed**.<br>New: `b7/credit-scores.contract.spec.ts`.<br>Updated: drift counts (634, 335), the request-schema map, and B7's list (the seeded credit note). |
| Lint, typecheck, Redocly, `contract:generate --check` | Clean |
| End to end | CI only |

**Test first, honestly:**
- **Domain specs:** written before the domain code and seen red (missing modules; two allocation cases failing).
- **Integration tests:** written after the application layer, before it ran. The first run had 2 of 14 red, both mistakes in the test itself (a direct update without a version bump; a wrong column name), fixed in the test.
- **Mutation check:** with the cap in `pur.supplier_credit_note_cap` disabled, the direct-insert test went red (3 failures), then the cap was restored.
- **Flaky tests:** I saw none. Nothing was skipped or loosened.

## Gate

**Passed.** Proved in `test/integration/pur/supplier-credit-variance.integration.spec.ts` and `supplier-scores.integration.spec.ts`:
- **Credit cap:**
  - A credit of 11,000 (two broilers at 5,500) against Awutu's 110,000 invoice is entered as a DRAFT.
  - A second credit of 100,000 is 422 `CREDIT_NOTE_EXCEEDS_INVOICE`, and so is a payment of 99,001.
  - A direct SQL credit past the cap is refused at commit (HK010 `ck_supplier_credit_note_cap`).
  - Submitted, the credit answers 202; its maker approving it is 422 `MAKER_CANNOT_CHECK`. Once the Owner approves, the invoice is `creditedPesewas` 11,000 with 99,000 outstanding.
  - One `SUPPLIER_RETURN` movement of 2.000 from the pens' lot is posted with `RETURN_QUALITY`, with one ◆ event and INV's `inv.SupplierReturnIssued`.
  - A payment of 99,000 settles the invoice (PAID).
  - The database refuses a self-approved credit (23514) and a credited amount written by hand.
- **Variance:**
  - 20 at 5,600 is MISMATCH and its payment is refused.
  - The variance answers 202. While it waits, the invoice refuses being matched again (`APPROVAL_PENDING`).
  - The Manager approves it: the invoice is APPROVED with `VARIANCE_APPROVED`, the line keeps `PRICE_OUTSIDE_TOLERANCE`, the event names the request, and a payment of 112,000 is accepted.
  - The person who entered the invoice approving is `INVOICE_MAKER_CANNOT_APPROVE`; the asker approving is `MAKER_CANNOT_CHECK`.
  - 22 invoiced against 20 received is `VARIANCE_NOT_ALLOWED` (`QTY_EXCEEDS_RECEIVED`), and the database refuses it directly (HK010 `ck_supplier_invoice_variance_cover`).
  - A rejected variance leaves the invoice MISMATCH.
- **Remittance:**
  - The paid payment's remittance lists invoice gross 110,000, credited 11,000, amount 99,000 and outstanding 0, with the reference.
  - A replay answers the same and a second marking is refused: there is one row and one `pur.SupplierRemittanceReady`.
  - The database refuses a second row (23505), any change, and a row for an unpaid payment (HK010). An unpaid payment answers 404.
- **Scores:**
  - The SRS case, components 90, 80, 100 and 95, gives 91.00 (unit test).
  - Over the API: Akuse scores 93.12 (price 80.41, lead time 100, quality 100, rejection 95) and Somanya 73.75 (price 100, late 0, quality 95, rejection 100), each by hand.
  - With the price weight set to 0 by the Owner, Akuse scores 98.57.
- **Wrong roles:** credit notes, submission and variance are refused to the Storekeeper, Manager, Cashier, Sales, Driver, Farm hand and Investor; scores and remittance to the Storekeeper, Cashier, Sales, Driver, Farm hand and Investor; variance approval to the Accountant. Each refusal leaves no row.

## Notes for the frontend track

- **Credit notes:** `createSupplierInvoice` with `kind: CREDIT_NOTE` and `originalInvoiceId`, then `submitSupplierCreditNote` (202).
  - Show `creditedPesewas` and `outstandingPesewas` from the API.
  - `returnFromLocationId` on a line sends goods back on approval.
- **The variance:** on a MISMATCH caused by price or a levy, offer "ask for a variance" (`requestSupplierInvoiceVariance`, a reason). Show `VARIANCE_APPROVED` as "approved on a variance".
- **The approvals inbox:** it must show the two new kinds. Do not offer the approval to whoever entered the document (`INVOICE_MAKER_CANNOT_APPROVE`).
- **Remittance:** `getSupplierPaymentRemittance` after a payment is paid.
- **Scores:** `listSupplierScores?periodStart=YYYY-MM-01` answers the components and weights; show the components beside the score.

## CI

CI ran on `4f8aa4f`, the pushed head before this report (pull request #45), and was green:
- run 43783493971, `push`, success;
- run 43783526640, `pull_request`, success.

 A commit cannot name its own runs, so the runs on the final head (this report's commit) and `main`'s `push` run on the merge commit are listed in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green.

## Next session

B06r, copied from `docs/prompts/session-openers.md` (unchanged by this phase).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report.
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read FR-PRC-011 of docs/SRS.md (nothing else from the SRS), docs/data-model/prc.md (the reversal),
ADR-0048 (the pattern to copy), A-139, A-153 and A-162 in docs/ASSUMPTIONS.md, and src/modules/inv/application/
stock-exceptions.ts and stock-adjustments.ts as the approval pattern. Load hakorem-stock, hakorem-money and
hakorem-security-review. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Also, before the reversal (owner, 2026-11-15, the frontend's F6 and CR-021):
- CR-021: a cost-free exact tag lookup for the Farm hand (ADR-0052), for example getCareAnimalByTag or an exact
  `tagNo` filter on listCareAnimals, documented as exact, refusing the wrong role.
- Death reports: the farm hand is the maker; they report, upload the photograph and submit, and a manager
  approves. Today the role holds no platform.file.upload, so a report at or above the threshold dead-ends. A farm
  hand may upload EVIDENCE files and nothing else: if the file store cannot restrict upload by purpose, build that
  check (in the application layer, deny by default, with a test that a farm hand's PRODUCT_IMAGE or any other
  purpose is refused) rather than falling back to a broader grant. Below the direct write-off threshold a farm hand must
  not write stock off alone: their submission waits for a supervisor's confirmation (a role that may post a
  write-off) instead of posting at once; other makers keep the direct write-off below the threshold. Maker is
  never the checker. Test-first, including the full farm hand path and a refusal for each wrong role.
- Scan state: a death report may be submitted while its photograph is still PENDING, so nobody waits at the pen;
  approval is refused until the file is CLEAN; if the scan rejects the file (infected or unscannable), the report
  goes back to its maker with a reason. Test all three.
- Reused photographs: every stored file already has its sha256 (migration 0033). If an EVIDENCE photograph with
  the same sha256 is attached to a second death report, it goes on the exception report: build the detection as
  an LIV published view (ADR-0011) or event the daily exception report (B12) reads, with a test, and a line in
  B12's opener. A byte hash catches the same file twice, not a re-saved or cropped copy: say so, and park
  perceptual matching in docs/BACKLOG.md. State it in the contract too: uploadFile's EVIDENCE description and the
  death report operations say that the client should open the camera directly for death evidence (the owner's
  frontend rule, 2026-11-15) as a deterrent, that the server cannot tell a camera photo from a gallery one, and
  that a reused photograph is matched by exact bytes only.
- Record the role matrix change in A-158 as the owner's decision.
Then execute B06r only, on branch b06r-processing-reversal-approval, branched from main: cancelling a COMPLETED
processing order (A-162 as built: Owner and Manager, its own reversal document, refused once an output is sold)
now follows ADR-0048. At or above the adjustment threshold (copied onto the document, never read live) it
answers 202 ApprovalPending and posts only on a different approver's approval with step-up; below it, a reason
is required and the reversal is recorded where the daily exception report (B12) will read it, through a
published view or event, with a line added to B12's opener. Refuse it outright, in the domain and in the
database, once any pack or output it produced has been sold or moved, because putting the carcass back would
hide the stock that left. Each rule test-first, including a mutation check that the database refusal stands
on its own. Stop at the gate, write docs/sessions/B06r-processing-reversal-approval.md, and merge into main when
every run on the pull request is green.
```
