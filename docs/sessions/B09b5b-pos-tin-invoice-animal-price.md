# B09b continued 4b: the receipt link's revoke, the business buyer's TIN and an invoice paid at the till

Date: 2026-11-23 · Branch `b09b5b-pos-tin-invoice-animal-price`, from `main` (`905d92b`) · Lane A · Status: **phase split at its sub-domain boundary (A-285 (a)). The revoke, the buyer's name and TIN and the invoice paid at the till are built and their gate passed locally.** CR-052 (each animal's price in the offline pack) moves unchanged to **B09b continued 4c**, before B09c.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-285 (a) | **Split:** this phase builds the revoke, the buyer's name and TIN and the invoice paid at the till. CR-052 with the owner's price clarification moves unchanged to B09b continued 4c, before B09c (ADR-0026 Amendments). It is its own sub-domain and was not started. | Owner |
| A-285 (b) | **The revoke:** `revokeReceiptLink`, by a holder of `pos.shift.close.approve` at the sale's branch, with its step-up (the permission asks for one) and a reason. Once per link (a second is 422 `RECEIPT_LINK_ALREADY_REVOKED`), effective at once. A sale with no link and an unknown id give one 404. The database holds who may (migration 0297). | Owner |
| A-285 (c) | **The buyer:** an optional `buyer` (`name`, `tin`) on the counter sale and the queued sale.<br>- It is printed in BIL's existing `customer_name` and `customer_tin` snapshot (DC-25, E-1). It never comes with `customerId` and creates no customer: the walk-in party stays.<br>- The name is 1 to 160 characters with no control character.<br>- The TIN is a GRA TIN (one of P, C, G, Q, V and ten digits) or a Ghana Card PIN (`GHA-`, nine digits, a check digit). The database holds its form (migration 0298). The accountant confirms these forms against GRA's current list. | Owner, accountant |
| A-285 (d) | **The document:** the counter's document stays a `RECEIPT` (an `INVOICE` needs a customer account). The A4 receipt prints "Bill to" and the TIN, and its SHA-256 is the document's content hash. The built-in thermal template is unchanged: an administrator may add the buyer to it without a deployment, and BL-106 asks the owner about the default. | Owner |
| A-285 (e) | **Offline:** a synced sale is always recorded. A buyer that cannot be printed is left off the receipt, never printed unverified. The sale's result names `BUYER_DETAILS_REFUSED` (REVIEW), raised once, with the TIN masked. | Owner |
| A-285 (f) | **Where the TIN is written:** the document and its archived render (E-1), and the counter sale's stored idempotency answer for its life (the receipt as the cashier was shown it; the Cashier holds `bil.document.read`). BIL's ISSUE audit row and a refused sale's evidence carry it masked to its last four characters. No event, order or sync row carries it. | Owner |
| A-285 (g) | **The invoice at the till:** `payInvoiceAtTill`, online only, for an issued `INVOICE` of the till's branch.<br>- Cash only, in part or whole, never beyond what is outstanding, with change from what was handed over.<br>- On the cashier's own open shift, from the till's enrolled device.<br>- Judged by `tillTakesCash` (online only `ON_SHIFT`) and again by PAY's `writeIn` and POS's `TillCash` under the shift's lock (ADR-0077). PAY's `recordPayment` keeps refusing cash. | Owner |
| A-285 (h) | **Its permission:** `pos.sale.create`, the counter sale's. No new permission. | Owner |

**For the parent session to schedule:** B09b continued 4c (inserted, its opener in `docs/prompts/session-openers.md`), then B09c. CR-059 to CR-062 stay B12's. CR-057 point 1 still needs both lanes.

**ADR conflicts: none.** ADR-0077's one deciding function and its single PAY door are used unchanged; ADR-0083 gains an Amendment recording the revoke as built. **No new ADR** (ADR-0084 unused).

**Contract 2.26.0, additive:** `revokeReceiptLink` and `payInvoiceAtTill` are new; `CounterSale.buyer` and `OfflineSale.buyer` (`CounterSaleBuyer`) are new and optional; an offline sale may name `BUYER_DETAILS_REFUSED`. No existing shape changed.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09b continued 4b (`b09b5b-pos-tin-invoice-animal-price`, from `main` `905d92b`), lane A.
2. **Scope:** the receipt link's revoke, the buyer's name and TIN on the VAT invoice, an invoice paid in cash at the till, and CR-052. CR-052 was split off before it was started (A-285 (a)).
3. **Gate:** the buyer's name and TIN on the VAT invoice, never creating a customer; an invoice paid in cash at the till inside the shift and counted at close, and cash outside an open shift refused; the receipt link revoked by a supervisor and then reading nothing. The animal's price in the pack moved to B09b continued 4c.

## Built

| Area | What |
| --- | --- |
| Data | `0297_pos_receipt_link_revocation_guard`: `pos.receipt_link_revocation_guard` (`ck_receipt_link_revocation_supervisor`).<br>`0298_bil_customer_tin_format`: `ck_billing_document_customer_tin_format`. No table or column changes. |
| BIL (shared, additive) | `domain/buyer.ts` (100 percent gate): `buyerVerdict`, `isGhanaTin`, `maskTin`.<br>`Billing.issueIn` takes an optional `buyerName` with `customerTin` (refused with a customer, `BUYER_WITH_CUSTOMER`; a TIN alone must be of a Ghana form).<br>The ISSUE audit row masks the TIN. |
| ORD (the parent session's leave, additive) | `SaleRequest.buyer`, passed to both `issueIn` calls. |
| POS | `ReceiptLinks.revoke` (`revokeReceiptLink`, `ReceiptsController`).<br>`CounterSales` and `OfflineSync` judge the buyer; `BUYER_DETAILS_REFUSED`; a refused sale's evidence masks the TIN.<br>`TillInvoicePayments` (`payInvoiceAtTill`, `TillInvoicesController`) with `domain/till-invoice.ts` (100 percent gate). |
| Contract | 2.26.0 (above), with `ReceiptLinkRevocation`, `TillInvoicePaymentCreate`, `TillInvoicePayment` and `CounterSaleBuyer`. |
| Docs | A-285; BL-106; abuse case 38; ADR-0083 Amendments; ADR-0026 Amendments; the openers (B09b continued 4c, and B09c reading its report); the data model (pos, bil); the POS, BIL and ORD cards; API.md; OFFLINE_SYNC 4.5, 4.6 and section 8; DATA_CLASSIFICATION E-1; the changelog. |

## The gate, proved by running it

**The revoke:** `test/integration/pos/receipt-link-revoke.integration.spec.ts` (5 tests), written first and seen red (5 failing: no route, no guard).
- A manager of the branch, with step-up, revokes with a reason. The answer is exact, the row by SQL names the manager, the reason and the time, and the audit row has the reason and no token.
- The link then reads 404 with the same body as a guessed token.
- A replay answers the same; a second revoke is 422 `RECEIPT_LINK_ALREADY_REVOKED`; still one row.
- A blank or missing reason is 400; a sale with no link and a random id answer the same 404.
- **Refused, nothing written, the link still reads:** the cashier who sold it, a manager of another branch, no session, and a stale step-up (`STEP_UP_REQUIRED`).
- **The database refuses** a revocation by the cashier (`ck_receipt_link_revocation_supervisor`) and takes one by the manager.
- `receipt-link.integration.spec.ts`'s direct revocation now names a manager, as the guard requires (16 tests pass).

**The buyer's name and TIN:** `src/modules/bil/domain/buyer.spec.ts` (4 tests) was written first and seen red, then green at 100 percent. `test/integration/pos/buyer-tin.integration.spec.ts` (7 tests):
- **Online, a company's GRA TIN:** the receipt's view, `bil.billing_document` by SQL (customer null, name and TIN as printed), the order's customer null, the customer count unchanged, and every customer journal line on the walk-in party.
- **Rendered by the worker:** the archived A4 PDF contains `Bill to: Adom Catering Services` and `TIN C0000000042`. Its SHA-256 equals the archive's hash and the document's `content_hash`. The render data carries both.
- **The TIN** is in no audit row unmasked, no outbox message, no order and no sync row. BIL's ISSUE audit shows `*******0042`.
- **An individual's Ghana Card PIN** is printed the same way.
- **Refused before anything is posted** (the footprint of orders, documents, payments, movements, journals and customers is unchanged): a short TIN, a malformed card PIN, a blank name, a buyer beside a customer (422, each naming its field), and a buyer with no TIN (400).
- **The database** refuses a TIN of another form, lower case or too long (`ck_billing_document_customer_tin_format`, the freeze trigger off in a rolled-back transaction so only the check is left).
- **Offline:**
  - a valid buyer is printed, with no customer created and the walk-in party used;
  - a bad TIN gives `APPLIED_WITH_EXCEPTION` with `BUYER_DETAILS_REFUSED`, its receipt issued with no buyer, its 6,000 cash recorded, one outbox entry (REVIEW, the TIN masked), and a replay adds nothing;
  - a tampered sale's evidence carries the TIN masked.
- **The existing counter sale and offline sync suites, untouched**, pass: the whole POS and BIL folders, 28 files, 273 tests, with one stale expectation (below).

**The invoice at the till:** `src/modules/pos/domain/till-invoice.spec.ts` (3 tests) was written first and seen red, then green at 100 percent. `test/integration/pos/till-invoice.integration.spec.ts` (5 tests), every figure by SQL:
- **Part of an invoice of 42,560:** 20,001 paid with 50,000 handed over. The answer gives change 29,999 and 22,559 outstanding.
  - `pay.payment`: CASH, 20,001, CLEARED, on the shift and the till, the invoice's customer, no order, not a late entry.
  - One allocation of 20,001 to the invoice, whose outstanding falls to 22,559.
  - 1000 on the till +20,001 and 1200 on the customer −20,001 over the payment's journals.
  - A replay answers the same with one allocation.
- **Refused, nothing recorded:** 22,560 (`AMOUNT_EXCEEDS_OUTSTANDING`), 9,999 handed over for 10,000 (`TENDERED_BELOW_AMOUNT`), nothing (`AMOUNT_NOT_POSITIVE`), a receipt (`NOT_AN_INVOICE`), an unknown document (404).
- **Refused, nothing recorded:** the Accountant (403), another cashier on this shift (403), no device credential (401) and no session.
- **PAY's `recordPayment`** refuses cash for the invoice (`TENDER_NOT_AVAILABLE`), with or without the shift.
- **Counted at the close:**
  - while the shift is CLOSING, a payment is 422 `SHIFT_NOT_OPEN`;
  - the supervisor signs off EXACT at float 20,000 + 20,001 = 40,001 (`pos.shift` by SQL);
  - the till's 1000 returns to 0;
  - once CLOSED, a payment is 422 `SHIFT_NOT_OPEN` and nothing is recorded.

## Mutations

Each mutation was applied alone, its spec run, and the source restored byte for byte (`cmp`). These cover the integration specs that were written after the code; the unit specs were seen red first.

| # | Mutation | Result |
| --- | --- | --- |
| M1 | BIL's ISSUE audit with the TIN unmasked | red: 2 of 7 (buyer-tin) |
| M2 | an offline buyer passed through unjudged | red: 1 of 7 (the sync fails on BIL's refusal) |
| M3 | the counter sale without its `BUYER_WITH_CUSTOMER` check | red: 1 of 7 (BIL's backstop answers another code) |
| M4 | `payInvoiceAtTill` without its `tillTakesCash` check | red: 1 of 5 (PAY still refuses, with another code) |
| M5 | `payInvoiceAtTill` without its own-cashier check | red: 1 of 5 (PAY's `TillCash` still refuses, 422 not 403) |

M4 and M5 also show the second line: with POS's check gone, PAY's `writeIn` still refuses the cash.

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since the last report)

- **CR-052:** moved with its owner's clarification to B09b continued 4c (A-285 (a)). It is named at the top for scheduling.
- **CR-033 point 3** (the SMS and `receiptMessage`): B11's, as before. The revoke here makes the reissue B11's server-made link.
- **CR-059 to CR-062:** RPT's, B12. B12 adds `BUYER_DETAILS_REFUSED` and `RECEIPT_TOKEN_REFUSED` as kinds on the report.
- **CR-057 point 1:** both lanes, still to schedule.
- Everything else was answered in earlier phases.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB2 (the back office: the revoke), TB3 (the till: the counter sale, the sync and the invoice payment), the database.
- **Authorisation:**
  - **The revoke:** `pos.shift.close.approve` at the sale's branch, checked in the handler, with its step-up. The database holds it too. Refused for the cashier, another branch's manager and no session (tested). The id walk lists the new operation, and the authorisation walk refuses a user with no grant.
  - **The invoice payment:** `pos.sale.create` at the till's branch and location, the shift the caller's own, the device enrolled on that till, and PAY's `TillShiftCheck` under the shift's lock (ADR-0077). Refused for the wrong role, another cashier, no device and no session (tested).
- **A revoked link answers 404 exactly as a guessed one** (the same body, tested). A sale with no link and an unknown id are one 404 too.
- **The TIN** (DATA_CLASSIFICATION DC-25, exception E-1, Restricted):
  - printed on the document and its archive only;
  - masked in BIL's ISSUE audit row and in a refused sale's evidence;
  - in no event, order or sync row (tested by SQL);
  - in the counter sale's stored idempotency answer as the cashier was shown it, which E-1 allows (the Cashier holds `bil.document.read`), recorded as A-285 (f);
  - not added to the log scrubber's key list, because the business profile's own `tin` is published in events and the publisher refuses a sensitive key. The masking is done where the TIN is written instead;
  - never on the public receipt (no customer data, unchanged);
  - every TIN in the tests is invented and obviously so (zeros, never the seeded farm's own).
- **Cash at the till** (abuse cases 4, 10 and 17, and new abuse case 38):
  - cash only (abuse case 4: no "paid" on the cashier's word for mobile money or card, which still go through the provider);
  - online only, on the cashier's own open shift, counted at the blind close, so a shortfall is `SHIFT_OVER_SHORT` (abuse case 17);
  - nothing reaches the device counter or the queue (abuse case 10 is unchanged);
  - PAY's `recordPayment` still refuses cash, so there is no second path.
- **Database:** two guards, no new table. The grants schema test is unchanged.
- **Findings:**
  - [accepted, recorded] the TIN in the idempotency answer (A-285 (f));
  - [accepted, recorded] the forms of TIN are the accountant's to confirm (A-285 (c));
  - [deferred, backlog] the thermal template (BL-106).
- **Not applicable, with reason:** no upload, webhook, export or outbound call; cookies, CSRF and CORS are unchanged (both writes take the CSRF token).

## Deferred

- B09b continued 4c (CR-052).
- B11: the receipt SMS, and the server-made link for a refused or revoked sale.
- BL-106 (the thermal template).
- BL-100 to BL-105, BL-082 and BL-087 to BL-089 stand.

## Tests

On this machine. `main` had not moved from `905d92b`, so no rebase was needed and none was made.

| Layer | Result |
| --- | --- |
| Unit | 158 files, 1,867 tests passed. `bil/domain/buyer.ts` and `pos/domain/till-invoice.ts` are under new 100 percent gates and met them. |
| Integration | **Full suite, once, at `359d72d`** (the code of the final head; only a contract test and this report came after): 167 files, 2,028 tests passed. Before it, the POS and BIL folders, on the working tree that became the buyer commit `e3f23cc`: 28 files, 274 tests, 1 failed. That was a stale expectation, not a flake: `bil/archive-link-rollback`'s list of migrations rolled back, which now starts at 0298 (and so also proves the `migrate:down` of 0298 and 0297). It was fixed in the `feat(pos)` buyer commit. Nothing was re-run to turn red green. The new specs: revoke 5, buyer 7, till invoice 5. |
| Contract | First run at `359d72d`: 54 files, 135 tests, **1 failed**. `b3/slice-and-login`'s request-schema walk did not yet name the two new operations' request schemas. This was a missing test entry, fixed in its own `test(contract)` commit (`7eab14e`). The whole suite then passed: 54 files, 135 tests. The drift count is now 657 operations, 518 in code. `contract:generate` is up to date, and Redocly is clean. |
| Lint (boundaries, fixtures, placement, schema names), typecheck | Clean. Gitleaks over the branch's commits, with the repository's config: no leaks. |
| End to end, setup, the image, the scans, coverage | Run in CI (below). |

## Notes for the frontend track

- **2.26.0:**
  - **The till's business buyer:** send `buyer` (`name`, `tin`) on the sale, never with `customerId`. Online, show the field the 422 names. Offline, `BUYER_DETAILS_REFUSED` means the receipt went out without them, so say so to the cashier.
  - **An invoice paid at the till:** `payInvoiceAtTill` on the cashier's own open shift, with the device credential. Show `changeDuePesewas` and `outstandingPesewas`.
  - **The back office's revoke:** `revokeReceiptLink` with a reason. It needs step-up.

## CI

- **Merge slot:** taken at 09:03Z. `main` was still `905d92b` (lane B idle), so there was nothing to rebase or renumber. Migrations 0297 and 0298 sit above main's 0296, and contract 2.26.0 above 2.25.0. The branch was pushed once, plainly, with no force.
- **Pull request #124.**
  - **`7eab14e`** (every code, contract and docs commit; the head before this report):
    - push run 45143670728: **success**;
    - pull_request run 45143734836: **success**.
  - In each of the two runs every job passed: lint and type check; contract; the setup script; the image build and scan; the secret scan, dependency audit and static analysis; unit and integration shards 1, 2 and 3 of 3; and the merged coverage gate.
  - **The final head** carries this report. Its runs (push and pull_request, with the three shards and the merged gate) are named in the closing message to the parent session. The pull request merges only when every one is green.

## Next session

B09b continued 4c, copied from `docs/prompts/session-openers.md`.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md (the B9b row).
List docs/sessions/ and read only the most recent report (docs/sessions/B09b5b-pos-tin-invoice-animal-price.md).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the POS requirement block of docs/SRS.md (nothing else from the SRS),
docs/data-model/pos.md, the POS card in docs/MODULE_BOUNDARIES.md, docs/OFFLINE_SYNC.md, ADR-0004 (the pricing walk),
A-277, A-278 (h) and A-285, and the abuse cases 3 and 11 in docs/security/THREAT_MODEL.md.
Read the hakorem-offline and hakorem-pricing skills. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09b continued 4c only, on branch b09b5c-pos-animal-price, branched from main.
CR-052 (the owner, 2026-11-18, from the frontend's F10l; low priority, BL-080 scheduled here, A-277 (f)): the offline
pack gives each sellable animal priced by grade or weight its price, so the till can sell it: the price is resolved
by the pricing engine from that animal's own latest weight and grade, never derived; it carries the weight's date and
source; the server re-prices at sync, as every synced sale is; an animal with no weight or no grade stays priceless and
is answered as such; exact pesewas tests. The owner's clarification on prices (2026-11-18) with it: an animal whose
weight changed between the pack and the sale posts the price charged, the server's price from the latest weight is
worked out only to compare, and the difference is flagged (REVIEW within the cashier's limit, URGENT beyond it), with
exact pesewas by SQL over the order line and the journal lines. Say in syncOfflineSales how an animal re-weighed at
the sale is priced if its weight moved it to another band (CR-052's question).
Stop at the gate and write docs/sessions/B09b5c-pos-animal-price.md.
```
