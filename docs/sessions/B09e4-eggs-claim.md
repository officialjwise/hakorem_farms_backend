# B09e continued 3: the claim from a receipt's rejected lines

Date: 2026-11-17 · Branch `b09e4-eggs-claim`, from `main` (`add9878`) · Pull request [#93](https://github.com/officialjwise/hakorem_farms_backend/pull/93) · Status: **gate passed**.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-17)

| ID | What | Who confirms |
| --- | --- | --- |
| A-272 | **The claim as built** (ADR-0076, proposed). See the eight points below. | Owner |

A-272's points:
- **(a) Settled once.** Either the approved invoice of the order settles it because it left the rejected goods out, or a credit note drafted from it settles it, against the approved invoice that charged them.
  - The match lets an invoice carry exactly the rejected quantity of the claims that no invoice settled.
  - Such a line's `orderValuePesewas` is its received part only.
- **(b) The value.** It is the delivered base quantity at the order price, through the order line's own conversion, rounded half-up once. Then comes `allocate` with ties to the accepted share, so the accepted share is half-up (ADR-0075's rounding) and the claim gets the rest. No amount is ever taken from a request.
- **(c) The credit note's lines.**
  - They are in the product's base unit, with the claimed value as the net and a unit price of 0.
  - A composite foreign key holds each line to its claim line.
  - The check `round(qty x price)` is lifted for these lines only.
  - A claim's credit note is never edited.
- **(d) Maker and checker.** The approver may not be the person who raised the claim, nor the person who posted the receipt. This is held in the handler and in the database.
- **(e) No new permission.** The claim uses `pur.supplier_invoice.create`, `.match` and `.read`.
- **(f) The receipt answers its claims** through `listGoodsReceiptClaims`, not through a field on `GoodsReceipt`.
- **(g) Scope.** One claim per receipt. Write-off, replacement and cancellation are not built (BL-076).
- **(h) The exception report's source** is `pur.SupplierClaimRaised` with `abuseCases: [34]`.

**No ADR conflict, and no existing posting changed.**
- ADR-0076 is **Proposed**, because it changes the three-way match (FR-PUR-009) for one new case: an invoice line carrying an open claim's rejected quantity.
- No posting rule, account, FIN code or event shape changed. Every journal posted before posts the same.
- The claim's arithmetic is ADR-0075's half-up.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09e continued 3 (`b09e4-eggs-claim`, from `main` at `add9878`).
2. **Scope:** the owner's decision 5's claim (CR-036), and CR-037, which only fixes examples.
3. **Gate:** as the opener states it.

## The double-credit question, settled first (A-271, ADR-0076)

**The trap.** An invoice is matched only up to the accepted quantity, and a credit note reduces an approved invoice. So a credit note drafted from a claim against an invoice that left the rejected eggs out would credit them twice. And an invoice that charged them could not be matched at all.

**The answer: the claim is settled once, by whichever document the supplier sends.**
- **The supplier invoiced only what was accepted.**
  - `settleSupplierClaim` with that invoice settles the claim.
  - It is refused with `CLAIM_INVOICED` if any live invoice holds more of the order line than was received.
- **The supplier invoiced everything.**
  - The three-way match now lets an invoice carry exactly the open claim's rejected quantity.
  - `draftSupplierClaimCreditNote` against that invoice drafts the credit note. It is refused with `CLAIM_NOT_INVOICED` if the supplier did not charge the rejected goods.
  - The credit note's approval settles the claim.
- **The ledger.**
  - The approved invoice clears 2010 only for the received part, so the rejected value waits on 5140.
  - The credit note's existing rule takes it off 5140 again.
  - FIN, its rules and the event's shape are untouched.

**Proved by both tests the parent asked for:**
- **The invoice charges all of the delivery.**
  - Charged one crate at 4,751 and credited 1,109: the supplier is owed **3,642**.
  - Charged three crates at 14,253 and credited 4,751: owed **9,502**.
  - In both, 2010 and 5140 are **0** over the delivery's journals.
- **The invoice charges only the accepted crates.**
  - Two crates at 9,502. The credit note is refused with `CLAIM_NOT_INVOICED`, and the claim is settled by the invoice. The supplier is owed **9,502**, and 2010 and 5140 are **0**.
  - A later invoice for the rejected crate mismatches with `QTY_EXCEEDS_RECEIVED`.

## Contract changes

**2.4.0, minor and additive.** The changelog entry and its cold-read line are written.
- **Six operations:**
  - `raiseSupplierClaim` (`POST /goods-receipts/{id}/claims`);
  - `listGoodsReceiptClaims` (`GET /goods-receipts/{id}/claims`);
  - `listSupplierClaims` and `getSupplierClaim`;
  - `draftSupplierClaimCreditNote` (`POST /supplier-claims/{id}/credit-note`);
  - `settleSupplierClaim` (`POST /supplier-claims/{id}/settle`).
- **New schemas:** `SupplierClaim`, `SupplierClaimLine`, `SupplierClaimPage`, `SupplierClaimRaise`, `SupplierClaimCreditNoteDraft`, `SupplierClaimSettle`.
- **New error code:** `SUPPLIER_CLAIM_INVALID`.
- **New fields:** `SupplierInvoice.supplierClaimId` and `SupplierInvoiceLine.supplierClaimLineId`. Both are required in the answer and null except on a claim's credit note.
- **Behaviour, recorded loudly:**
  - **The match:** an invoice line may carry, beyond what was received, exactly the rejected quantity of its order line's open claims.
  - **`approveRequest`:** on a claim's credit note it refuses the claim's maker and the receiver.
  - **`updateSupplierInvoice`:** it refuses a claim's credit note (`CLAIM_CREDIT_NOTE_FIXED`).
- **CR-037:** the role and permission examples name `ord.void.approve`.
- **Checks:**
  - `contract:generate`: 428 operations from code, 214 planned.
  - Redocly: clean.
  - `scripts/contract/versioning.ts` against `main`: `contract versioning: ok`.

## Built

| Area | What |
| --- | --- |
| Migration 0222 (platform) | The document type `SUPPLIER_CLAIM`, not numbered. The rollback is tested. |
| Migration 0223 (PUR) | <ul><li>New tables: `pur.supplier_claim` and `pur.supplier_claim_line`.</li><li>New columns: `supplier_invoice.supplier_claim_id`, and `supplier_invoice_line.supplier_claim_line_id` with its composite foreign key.</li><li>`ck_supplier_claim_line_split`: the split sums to the line.</li><li>The deferred total check (HK010).</li><li>`pur.supplier_claim_guard`: a claim starts OPEN, only the settlement changes, and the settling document must be the right one, approved by neither the claim's maker nor the receiver.</li><li>`pur.supplier_claim_credit_line_guard`.</li></ul> The rollback is tested by `bil/archive-link-rollback`, which now lists 0223 and 0222. |
| PUR domain | <ul><li>`claim.ts`: `claimLineValue`, `receivedPartValue`, `claimedPart`, `judgeClaimCredit`, `judgeClaimSettledByInvoice` and `judgeClaimCreditApprover`.</li><li>`three-way-match.ts`: `qtyClaimed`.</li></ul> |
| PUR application | <ul><li>`SupplierClaims`: raise, list, list for a receipt, get, draft a credit note, settle.</li><li>`SupplierInvoices`: the match reads the claimed quantities; `postingParts` values a claimed part at the received part only; `draftClaimCreditIn`; `settleClaimIn`; the credit note's approval settles its claim and refuses the claim's maker and the receiver.</li><li>`SupplierClaimStore` (Pg), and `orderLinesIn`.</li></ul> |
| INV | `GoodsReceipts.factsIn`, published through INV's `index.ts`. No table changed. |
| Events | `pur.SupplierClaimRaised` (not a ledger event): the receiver, the claim's maker, each line's reason and quantities, the claimed value and `abuseCases: [34]`. |
| Docs | <ul><li>ADR-0076 and A-272, BL-076 and the changelog.</li><li>`data-model/pur.md`, the PUR and INV cards, the API section and the error code.</li><li>FR-PUR-009 and FR-PUR-011 as built.</li><li>The event catalogue and the ADR index.</li><li>THREAT_MODEL abuse case 34 (`RECEIPT_CLAIM`) and residual risk R19.</li></ul> |

## The gate, proved by running it (`test/integration/pur/receipt-claims.integration.spec.ts`, 15 tests)

**Drafted from the rejected lines and their cost, split exactly with `allocate`.**
- **A crate at 4,751 with 7 of 30 eggs `CRACKED`:**
  - delivered `30.000`, accepted `23.000`, rejected `7.000` eggs;
  - the line is **4,751**, accepted **3,642**, claimed **1,109**.
- **One of three crates `BROKEN`, entered in crates:**
  - `90.000`, `60.000` and `30.000` eggs;
  - the line is **14,253**, accepted **9,502**, claimed **4,751**.
- **The unit spec `claim.spec`, 18 tests:**
  - the exact half: 15 of 30 eggs at 4,751 gives 2,376 accepted and 2,375 claimed;
  - one below and one above a half;
  - one and a half crates at 7,127, rounded once;
  - zero and all;
  - the refusals.

**Never keyed by hand.**
- A body naming `claimedPesewas`, `lines` with a value, or `amountPesewas` is refused with 400 `VALIDATION_FAILED`, and no claim is written.
- The credit note's lines carry the claim's values: one crate's credit is a line of `7.000` eggs, net **1,109**, unit price 0, and gross **1,109**.

**Linked both ways.**
- The claim names its receipt, its order and its receiver.
- `listGoodsReceiptClaims` answers the claim.
- Once drafted, the claim shows its `creditNote`, and the credit note carries `supplierClaimId`.
- Once settled, the claim shows `settledBy`: the credit note, or the invoice.

**Moves no stock and posts nothing until the credit note is approved.**
- No movement and no journal names the claim, or the credit note while it is a draft.
- `pur.SupplierClaimRaised` is in the outbox once, with abuse case 34.

**On the supplier's account until settled.**
- `listSupplierClaims?supplierId=&status=OPEN` lists the claim until it is settled.
- A second credit note is refused with `CREDIT_NOTE_EXISTS`, and a second claim with `CLAIM_EXISTS`.

**The credit note keeps its approval, maker and checker apart.**
- **Three people:**
  - Kofi, the Storekeeper, receives the goods;
  - Yaw, an Accountant, raises the claim and drafts the credit note;
  - the Owner approves it.
- **The claim's maker refused:**
  - The Owner raises the claim and Yaw drafts and submits its credit note.
  - The Owner is refused with 422 `INVOICE_MAKER_CANNOT_APPROVE`: the credit note stays a DRAFT, the claim stays OPEN, and nothing is credited.
  - Efua, a second Accountant, approves it.
- **The database refuses** a settlement by a credit note the claim's maker approved (HK010). The test reopens the claim with triggers off, in a transaction that is rolled back.

**Inflated rejections reach the exception report's source.** `pur.SupplierClaimRaised` carries:
- the receiver and the claim's maker, who are not the same person;
- each line's reason and its accepted and rejected quantities;
- the claimed value;
- `abuseCases: [34]`.

THREAT_MODEL case 34 (`RECEIPT_CLAIM`) names it for B12.

**Every write refuses the wrong role, and every new read is authorised and in the identifier walk.**
- **The Storekeeper and the Cashier** are refused with 403 on every claim operation, and nothing is written.
- **The Owner of another branch:**
  - with a real claim id, or a real receipt id for its claims list, is refused with only the error envelope;
  - with a random id gets 404;
  - sees an empty list.
- **The generated walks** cover all six operations, with valid bodies in `test/support/routes.ts`:
  - `iam/authorisation`: the handler walk;
  - `iam/no-id-is-a-key`: the identifier walk.
- **The database refuses:**
  - a change to a claim line (HK001);
  - a change to a claim's content (HK004);
  - a settlement by an unapproved invoice (HK010);
  - a line whose split does not sum (23514).

**The trial balance still sums to 0 on the seeded day.**
- `fin/trial-balance` and `fin/posting-matrix` pass unchanged.
- The seed is unchanged, because raising a claim posts nothing.

## Mutation checks (each applied alone, the targeted spec run, the source restored with `git checkout`)

| # | Mutation | Result |
| --- | --- | --- |
| 1 | The claim's maker no longer refused as approver | red: 1 of 15 |
| 2 | The match ignores open claims | red: 5 of 15 |
| 3 | Settling by an invoice never checks what was invoiced | red: 3 of 15 |
| 4 | A credit note drafted whatever was invoiced | red: 1 of 15 |
| 5 | 2010 cleared at the whole invoiced quantity | red: 2 of 15 (2010 and 5140 off by the claimed value) |
| 6 | Ties in the split go to the rejected share | red: 1 of 16 (`claim.spec`) |
| 7 | The guard's approver condition removed from migration 0223 | **First green**, because the handler refuses first. A database test was added (`ad6b337`), and the mutation is then red: 1 of 15. |

## Test first, as it honestly happened

- **`claim.spec` (16 tests at first):** written before `claim.ts` and seen red (the module did not exist).
- **`three-way-match.spec`:** the three claim tests were written before the match changed. One was seen red: 30 eggs against 23 received with 7 claimed mismatched.
- **`receipt-claims` integration spec:** written after the application code but before the contract.
  - Its first run was red: 12 of 14 failed. The total-check trigger read a field the claim row does not have, and the settlement did not move the version.
  - It was green after those two fixes.
  - Mutations 1 to 7 prove it bites.
- **The first merged coverage run was red:** `src/modules/pur/domain` was at 99.26 percent of statements and 99.04 of branches, below its 100 percent gate. Two refusals were never tried. They were fixed in their own commit (`a0dcff1`), and the second run is below.
- **Changed expectations:**
  - `api/openapi-drift`: 636 operations become 642, with 428 in code.
  - `iam/authorisation`: the list of operations gains the six new ones.
  - `bil/archive-link-rollback`: the rollback walk lists 0223 and 0222.
  - No assertion was weakened and nothing was skipped.

## Decisions

- **ADR-0076** (Proposed): the claim is settled once, by the invoice or by a credit note.
- **No new permission, port or module import.** INV publishes `GoodsReceipts.factsIn`.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB2 (the back office: receiving, purchasing, approvals) and the database.
- **The standards, item by item:**
  - SC-01: strict zod bodies. Unknown fields, an amount included, are refused.
  - SC-02: authorised in the handler, at the claim's or the receipt's branch, denied by default. The wrong role and the other branch are tested.
  - SC-03 and SC-04: parameterised SQL only.
  - SC-05: kernel `Money`, `Quantity`, `halfUpDivide` and `allocate`; no number arithmetic (the lint rule holds).
  - SC-06: every write takes the idempotency key.
  - SC-07 and SC-08: no secret in the event or the audit; the event carries ids, quantities and pesewas only.
  - SC-14: no external call.
  - SC-15 and SC-16: no empty catch; the refusals carry stable codes.
  - SC-17: maker and checker are apart, in the handler and in `pur.supplier_claim_guard`.
  - SC-22: claim lines are never changed.
  - SC-23: serializable writes through `runPurchaseCommand`.
  - SC-24: create and settle are audited with before and after.
- **Not applicable, with reason:**
  - SC-09 to SC-11: the existing console route group and cookies, unchanged.
  - SC-12: no upload.
  - SC-13: no webhook.
  - SC-18: no restricted field.
  - SC-19: no outbound URL.
  - SC-20 and SC-21: the CI scans, see CI.
- **Abuse:** case 34 is added, with the exception kind `RECEIPT_CLAIM` and residual risk R19 (goods kept after a false rejection are detected, not prevented). The B12 report item itself is B12's; its source event is tested here.

## Deferred

- **BL-076:** a claim written off with approval, a replacement delivery named on the claim, and the cancellation of a claim raised in error. Today a replacement delivery raises the received quantity, so the invoice that charged the whole delivery then settles the claim through `settleSupplierClaim`.
- **B12:** the `RECEIPT_CLAIM` item on the daily exception report, reading `pur.SupplierClaimRaised`.

## Contract requests

I fetched the frontend's `main` at `439e1db` at the start and again before writing this report. It holds CR-001 to CR-037.
- **CR-036 (a claim from a receipt's rejected lines): implemented in 2.4.0.**
  - **Point 1:** `raiseSupplierClaim` takes one step, one line per rejected line, with its quantity, its reason and the server's value from the order price.
  - **Point 2:** the claim is linked both ways (`listGoodsReceiptClaims`; `purchaseOrder`, `goodsReceipt`, `creditNote`, `settledBy`).
  - **Point 3:** the claim moves no stock and stays `OPEN` on the supplier's account (`listSupplierClaims?status=OPEN`) until settled. It is settled by a credit note or by the invoice that left the goods out. A write-off with approval is not built (BL-076), and a replacement delivery settles through the invoice.
  - **Point 4:** the claim is its own document, and the credit note drafted from it names it (`supplierClaimId`, `supplierClaimLineId`). Its lines are quantities that never entered stock, at their claimed value.
- **CR-037 (examples only): implemented in 2.4.0.** The examples say `ord.void.approve`, which requires step-up.
- **Requests that stay with later phases:**
  - CR-031, CR-032 and CR-033 (points 1 and 2) stay with B9b, the next phase.
  - CR-033 point 3 stays with B11.
  - CR-018 stays with B12.
- **Everything else:** answered in earlier phases. Nothing small is left open for this phase's modules.

## Tests (this machine, 2026-11-17)

| Layer | Result |
| --- | --- |
| Unit and integration, merged (`pnpm test:coverage`) | **3,166 passed**, 259 files, exit 0. Statements 94.21 percent, branches 84.55 (the gate is 80), functions 97.69, lines 96.86. Every 100 percent gate held, `src/modules/pur/domain/**` included. **The first merged run was red** on that gate (99.26 and 99.04), fixed in `a0dcff1`. |
| Contract (`pnpm test:contract`) | **119 passed**, 45 files, including the new `b9/supplier-claims`. **The first full run was red:** `b3/slice-and-login` found `draftSupplierClaimCreditNote`'s request example with no route schema registered in the test. It was fixed in `6ea331e`, and the second run is the one above. |
| Lint (including the module boundaries and the schema-name check), typecheck, Redocly, `contract:generate --check`, versioning against `main` | Clean. |
| End to end, setup, and the last migration rolled back and applied again | Run in CI. |

Nothing was re-run to turn red into green. Each red run above was a real gap, fixed in its own commit, and the next run is a new run on the fixed code.

## Gate

**Passed.** Every item of the opener's gate is proved above:
- the claim drafts the credit note from the rejected lines at the split cost, never keyed, and an amount sent is refused;
- the claim is linked both ways;
- it moves no stock and posts nothing until approval;
- it stays on the supplier's account until settled;
- maker and checker are apart, mutation-checked;
- inflated rejections reach the exception report's source;
- every write refuses the wrong role, and every new read is in the walks;
- the trial balance still sums to 0.

## Notes for the frontend track

- **2.4.0 is additive.**
  - A receiving screen offers "Raise a claim" on a posted receipt with rejected lines: `raiseSupplierClaim` with an optional note. Show the claim's lines: delivered, accepted and claimed quantities in the base unit, and the values.
  - The claims screen lists `listSupplierClaims?status=OPEN` per supplier.
  - When the supplier's invoice arrives and is approved:
    - if it left the rejected goods out, `settleSupplierClaim`;
    - if it charged them, `draftSupplierClaimCreditNote` with the supplier's credit note number and date, then the usual submit and approval.
  - `CLAIM_INVOICED` and `CLAIM_NOT_INVOICED` tell the screen to use the other action.
- **A claim's credit note line** has `unitPricePesewas` 0 and `supplierClaimLineId` set. Show its net, not a price.
- **The approver** of a claim's credit note cannot be the person who raised the claim or received the goods (`INVOICE_MAKER_CANNOT_APPROVE`).
- **CR-037:** the role examples say `ord.void.approve`.

## CI

- **`6ea331e`** (the code and docs head, with `main` merged in at `a42538d`, pull request #92):
  - Run **44164547524 (push)** **succeeded**.
  - Run **44164640519 (pull_request)** **succeeded**. Its jobs:
    - lint and type check;
    - unit and integration with the coverage gate;
    - contract;
    - the setup script with end to end, smoke, and the last migration rolled back and applied again;
    - the image build and scan;
    - the secret scan, the dependency audit (the owner's live waiver only) and static analysis.
  - Nothing was re-run.
- **This report's own commit:** its runs are named in the session's closing message, because a report cannot name the runs of the commit that adds it. The pull request merges only when every run on its head is green.

## Next session

B9b, copied from `docs/prompts/session-openers.md` (unchanged by this phase except that it reads this report; it carries the owner's reused-token rule merged from `main` in pull request #92).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09e4-eggs-claim.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, and
ADR-0015, ADR-0027, ADR-0074 (the receipt link's token) and the abuse cases 4, 10, 11 and 17 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline skill. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b only, on branch b09b-pos-shifts-offline: registers and device enrolment, shifts with
the opening float, cash movements and cash drops, X and Z reports, blind close with supervisor sign-off
and over/short posting, held sales, the offline pack, and offline sync: exactly-once by client UUIDv7,
the gap-free device counter, provisional references, occurred-at and recorded-at, cash-only tenders
offline, the stock exception instead of a refusal, price override bounds re-checked at sync. Write
the five conflict tests ADR-0027 names (animal sold elsewhere, animal on hold, countable stock gone
negative, sale in a locked period, missing device counter) and the 500-transaction test with the network
disabled. Run scenario 6 of docs/UAT.md as a dry run and record any difference.
Check that counter sales reach the owner dashboard's sales figures and the getSalesTodayTile and getSalesSeries
tiles B9a made live (B05x, A-149): a seeded counter sale appears in today's sales by channel POS, test-first.
The owner's two additions to A-200 (2026-11-16), each test-first:
(1) An offline sale synced later is issued at its occurred_at, the time it happened at the till, not the sync time:
that is the real transaction time, not a backdate. Extend Billing.issueIn additively to take that time for a synced
sale only, mark the document as synced from offline (a field the receipt and the document read show), and bound how
old an offline sale may be (a setting, conservative default, recorded in ASSUMPTIONS.md): a sale outside the bound is
still recorded, never refused (a synced sale is always recorded), and reaches the exception report; a sale whose
period has since locked posts on the first open date, flagged, keeping its occurred_at (ADR-0027 point 6).
(2) A business buyer at the counter may have their name and TIN printed on the VAT invoice without opening a customer
account, so they can reclaim the input tax: optional buyer name and TIN on the counter sale and the billing document,
validated in format, printed on the invoice, and never creating a customer; the walk-in party stays.
The owner, 2026-11-16 (A-212 (a)): cash enters only through a till shift. Build a customer paying an invoice at the till
inside the shift, counted at close, and refuse any cash payment outside an open shift, test-first.
The frontend's CR-031 and CR-032 (planned in contract 1.45.0 by B09a continued 1d): fill OfflineProduct.taxInclusive
from each product's price list, SyncResultItem.grossPesewas (null when nothing was recorded) and its currency, and the
pack's CASH_MOVEMENT reason codes; decide CR-032 point 2, the offline PIN verifier (an operation that sets a till
PIN and the salted verifier the device stores, or a statement in OFFLINE_SYNC.md that the device derives it from the
PIN typed at an online sign-in), record it as an ADR and answer it in the report.
The owner's rules for the till PIN (CR-032, 2026-11-17), which the frontend already enforces on the device and the server
must match, each test-first: a PIN verifier is PBKDF2-SHA256 with at least 600,000 iterations and a random salt of at
least 16 bytes per person, never weaker (refuse a weaker verifier, and test the parameters); at most five wrong tries,
enforced on the server too (counted at sync for offline attempts and at any online check, then locked); signing out a
locked cashier requires a supervisor's PIN, is audited, and reaches the daily exception report's source (B12). The PIN
never authenticates to the server and is never the only control (CR-032 point 5).
CR-033 points 1 and 2 (owner's rule, 2026-11-16: every sale produces a digital receipt, by SMS or a link, and a printer
is optional): a public receipt read with no session, by an unguessable token, answering the official number, the sale
reference, the lines, the tenders, the change and the business's details (read through AUD's `BusinessProfiles`, B09x continued), and "being recorded" until the sale has
synced. No QR code (owner, 2026-11-17: the TOTP enrolment QR is the only QR in the system): the link reaches the
customer by SMS. The token is its own long random value (owner, 2026-11-17: no ID is ever a key), generated by the till
from a cryptographically secure source when the sale is made, so the link exists offline, and sent with the sale at
sync; never the sale's client id. Record the choice as an ADR with hakorem-security-review. Rate-limit the read, expose
no other customer's data, and test that a guessed token, another sale's token or the sale's own id answers 404. The SMS on sync (point 3) is B11's.
The receipt token (owner, 2026-11-17, ADR-0074 Amendments): at least 128 random bits from a secure generator (the `rcp_`
token's 32 bytes meet it), base64url, made by the till offline and sent with the sale at sync; the server stores only
its hash, unique, valid for 12 months, and revocable. The public receipt read takes the token and nothing else. Test
that a sale UUID, a document number or a SKU opens no receipt, and that a token reused for a second sale is refused at
sync (the second sale is still recorded; only its link is refused, and the refusal reaches the exception source).
A reused token (owner, 2026-11-17): a 128-bit token cannot repeat by chance, so every reuse goes to the exception
report's source as a possible till fault or tampering, naming the device, the shift, the cashier and both sales,
whatever the reason; and the second sale is marked as needing a fresh server-made link, which B11's receipt SMS sends
(ADR-0074: a link sent by message gets its own token from the worker, never stored in clear). Test that the reuse
reaches the exception source exactly once per refused sale, and that a replayed sync adds no second entry. If the
sale carried no customer phone, say how the customer still gets a working receipt, the most conservative choice
recorded as an assumption.
Stop at the gate and write docs/sessions/B09b-pos-shifts-offline.md.
```
