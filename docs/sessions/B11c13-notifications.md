# B11 continued 13: notifications, fourth pass (lane B): the document sends, the remittance advice, the reminders' delivery and CR-039

Date: 2026-11-24 · Branch `b11c13-notifications`, from `main` at `926386a` (#140, B11 continued 12) · Status: **gate passed locally; CI and the merge are named below and in the closing message.** This closes the B11 chain. The reused-photograph match is not built here: **B12 builds it** (its opener now says so, A-291).

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-288 | **The document sends and the remittance advice (ADR-0099).** (a) `bil.document.send` to the roles that reprint (Owner, Manager, Cashier); `sendStatement` keeps `whl.statement.create`. (b) A `doc_` link opens for thirty days and answers a five-minute signed link, logged under the Storefront. (c) A message whose document is not yet archived or scanned waits a minute at a time, no attempt spent. (d) The copy in `bil.reprint_log` carries the first channel asked; the message goes by the first the trigger allows (WhatsApp and email fail visibly until B13). (e) `recipient` is only checked, never stored or used; a document with no customer cannot be sent (BL-121). (f) **The parent's note said the remittance advice goes to an investor; the opener and the gate say the supplier, from `pur.SupplierRemittanceReady`. The supplier is built**; an investor's schedule is B12's. (g) Once per payment, whatever event names it. (h) A refused typed recipient rolls back and leaves no row. | Owner (a, b, d, e); parent session (f) |
| A-289 | **A dunning level's template and each reminder's delivery (the owner, 2026-11-23).** (a) Only `PAYMENT_REMINDER_1` to `3` (422 `TEMPLATE_NOT_A_REMINDER`); the field stays a string in the contract. (b) SENT when the provider took it, DELIVERED or FAILED as a signed report says, FAILED when every attempt failed; the latest per channel. (c) Recorded by NTF through WHL's `Dunning.recordDeliveryIn`, a command down. | Owner |
| A-290 | **CR-039.** (a) A product's online units are those MDM prices on the ONLINE channel, the sale unit first; a catch-weight pack, a banded animal and a one-unit product list one. (b) Each unit's availability is whole units of it. (c) `uom` left out is the sale unit; a unit not sold is 422 `UOM_NOT_SOLD`. (d) Two units of one product are two lines; reserved in the base unit. | Owner |
| A-291 | **Left to others.** (a) The reused-photograph match: B12. (b) The UAT dry runs were run at the desk against the code and its specs, not on a staged system. | Parent session |

**No ADR conflict, and no stop.** No split. **Shared modules, additive only:** MDM (`partyAddressesIn`, `isPartyAddress`), DOC (`issueLinkIn`, `attachmentOf`, `getSharedDocument`, `doc.document_link`), BIL (`sendBillingDocument`, `messageFactsIn`, `bil.DocumentSendRequested`, `bil.document.send`), PUR (`remittanceFactsIn`), the platform port (`OutgoingMessage.subject` and `attachments`; `RecipientNotDocumentPartyError`). Nothing changed in POS, IAM, PAY, INV, FIN, DEL or ORD. In NTF (mine), two existing behaviours moved, each tested: a message on a channel with no adapter now fails visibly before its address is judged (it was `NO_ADDRESS` first when it had no number; now an email to an order's contact fails `no adapter sends EMAIL`, as the existing spec expects), and the address is read by channel (an email for EMAIL).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 13, lane B (`b11c13-notifications`, from `main` 926386a).
2. **Scope:** the document sends and their document link, the remittance advice, a dunning level's listed template, each reminder's delivery per channel, CR-039, the reused-photograph match and the UAT dry runs.
3. **Gate:** a document send reaches only the document's own customer or supplier, and a failed send is retried without a second archive row; the remittance advice goes once per payment to its own supplier; a failed reminder shows as failed on its channel; CR-039's crate and single egg price exactly. **All four passed** (below).

## Baseline (before any change)

`pnpm test:coverage` on `main` at `926386a`, on a clean extract: **360 files, 4,287 tests passed, none failed or skipped. Statements 94.15 %, branches 83.94 %, functions 97.90 %, lines 97.21 %.**

## Contract changes

**2.42.0, minor** (the entry in `docs/CONTRACT_CHANGELOG.md`). **LOUD:**
- `DunningLevelInput.templateCode` is refused unless it is `PAYMENT_REMINDER_1` to `3` (422 `DUNNING_POLICY_INVALID` `TEMPLATE_NOT_A_REMINDER`); still a string.
- `MessageRecipient.kind` and `NotificationTrigger.recipientKind` gain `SUPPLIER`.
- `DocumentSendRequest.channels` gains `minItems: 1`, `maxItems: 3`, `uniqueItems` (the operations were planned until now).

**Additive:** `sendBillingDocument` and `sendStatement` move into code; `getSharedDocument` is new (`SharedDocument`); `DunningNotice.deliveries` (`DunningNoticeDelivery`); `CatalogueItem.sellingUnits`, `ProductDetail.sellingUnits` (`SellingUnit`); `CartLineAdd.uom`. 567 operations from code, 99 planned (666 in all). Redocly clean, no warnings; `contract:generate` up to date.

## Built

| Item | What |
| --- | --- |
| DOC (additive) | `doc.document_link` (LEDGER, 0342): a `doc_` token's hash, the archived rendering it opens, at most thirty days (`ck_document_link_expiry`). `Documents.issueLinkIn` (the latest rendering whose file passed the scan; `LINK_NOT_READY` while rendering), `attachmentOf` (the archived PDF, hash-checked), `openLink` behind the public `getSharedDocument` (`/shop/documents/{token}`, a five-minute signed link, logged; anything else one 404). |
| BIL (additive) | `sendBillingDocument`: a copy in `bil.reprint_log` with the first channel, ◇ `bil.DocumentSendRequested` (ids and channels), audited; `recipient` checked through MDM; `messageFactsIn`. Permission `bil.document.send` (0344, 0345). |
| WHL | `sendStatement` (◇ `whl.StatementSendRequested`), `Statements.messageFactsIn`; `judgeLevels`'s `TEMPLATE_NOT_A_REMINDER` and `ck_dunning_policy_template`; `whl.dunning_notice_delivery` (LEDGER, 0346), `Dunning.recordDeliveryIn`, `DunningNotice.deliveries`. |
| PUR, MDM (additive) | `SupplierPayments.remittanceFactsIn`; `MasterDataRefs.partyAddressesIn`, `isPartyAddress`. |
| NTF | `ntf.document-sends` on the three events (`DOCUMENT_SENT`, `REMITTANCE_ADVICE`, once per payment); recipient `SUPPLIER` (`ntf.message.supplier_id`), `record_id`, both fixed (0343); the address by channel (email masked `k***@example.com`); the sender's `WAIT` for a document not yet archived, the email's attachment; `ReminderDeliveries` from the sender and the signed webhook. Templates on SMS, WhatsApp and email and three triggers seeded. Domain (100 percent gate): `maskEmail`, `maskAnyAddress`, `normalisedAddress`, `documentWord`, `balanceLine`, `DOCUMENT_WAIT_MS`, the SUPPLIER recipient's channels. |
| SHP (CR-039) | `shp.product_listing.selling_units` (0347, through a redefined `shp.replace_product_listing`, now stamped by the application's clock), `CartLineAdd.uom`, `uq_cart_line_product_uom`; cart, checkout and placement price each line in its own unit; reservation in the base unit. |
| Docs | ADR-0099, indexed. A-288 to A-291. BL-121. Abuse cases 62 and 63. Data model (`doc`, `ntf`, `whl`, `shp`). The MDM, DOC, BIL, PUR, SHP, WHL and NTF cards. API.md (NTF). The 2.42.0 changelog. The openers: B11 continued 13 built; B12's reused-photograph line made definite. |

## The gate, proved by running it

`test/integration/ntf/document-sends.integration.spec.ts` (12 tests, new), over the seeded farm, every figure by SQL:
- **Only its own party.** An invoice to Tema Cold Store sent by the Cashier: one copy (`SMS`, copy 1), a replay adds none, one `DOCUMENT_SENT` message for Tema's record, no document, number or rendering made. It goes once to Tema's number with `.../d/doc_<43>`; the hash is the token's SHA-256, thirty days; the token is in no NTF, DOC, outbox, audit or key row. The token opens exactly the archive (the served bytes hash to the archived SHA-256); a guess, the document's id with and without hyphens, the archive's id, the number, another prefix and an altered token answer the same 404. Another customer's number, a stranger's email and a wrong number are 422 `RECIPIENT_NOT_DOCUMENT_PARTY` with nothing written; a walk-in receipt is `DOCUMENT_HAS_NO_PARTY`; Sales, the Storekeeper, the Driver and the Accountant are 403. The customer's own number typed the local way is accepted, and the audit holds neither it nor the email. A forged event naming another customer and number goes to Tema's own number.
- **Retried without a second archive row.** Three temporary failures, a new token each time, `FAILED`; the Cashier's retry is 403, the Manager's goes: `SENT`, attempt 4; archive rows, render jobs and copies unchanged; every token opens the one archive. Thirty-one days on, the last reads as a guess.
- **Email.** With no adapter it is `FAILED` `no adapter sends EMAIL` (masked `a***@temacoldstore.example`), no link made; retried with the fake, it carries the subject, the text with its link and the archived PDF (SHA-256 equal), with no second archive row.
- **Statement.** The seeded issued statement goes to Tema with a link that opens it; the wrong roles and a recipient not Tema's are refused; an unknown statement is 404.
- **The remittance advice once per payment to its own supplier.** The seeded transport invoice paid in cash (GHS 135.00): the message is queued at once for Kpone Livestock Traders (`SUPPLIER`), `HaKorem Farms paid Kpone Livestock Traders (SEED) GHS 135.00 on <date>. Remittance advice: {{link}}`. While its archive is not yet scanned the sender hands it back `QUEUED`, attempts 0, `the document is not archived yet`; after the scan it goes once to the supplier's number and its link opens the advice. A replayed mark-paid, a redelivered event and two forged events (another supplier on this advice; this supplier on another advice id) queue nothing: one message, to its own supplier.
- **The database.** A link over thirty days, of no length, or with a 16-byte hash is refused (23514); a duplicate hash (23505); `hk_app` cannot update (42501); the owner role cannot delete (HK001). A message's supplier and record never change (HK004).

`test/integration/ntf/reminder-deliveries.integration.spec.ts` (4 tests, new): **a failed reminder shows as failed on its channel.** Level 1 shows nothing until tried, then `SMS SENT`, then `SMS DELIVERED` on a signed report; Efua's shows `SMS FAILED` when reported undelivered; level 2 fails three times and shows `SMS FAILED`, then the Manager's retry shows `SMS SENT`; a level by email alone fails visibly on `EMAIL` and, retried with the fake, shows `EMAIL SENT`; the table is insert-only and once per message and status. `ageing-dunning` adds the refusal of a typed template (422 and 23514).

`test/integration/shp/selling-units.integration.spec.ts` (4 tests, new, written before the code): **CR-039 to the pesewa.** The big eggs list `CRATE` GHS 60.00 and `EGG` GHS 2.20 (30 eggs singly are GHS 66.00); a crate plus 3 eggs then another crate are two lines, 2 × 6,000 and 3 × 220, subtotal 12,660; 7 eggs reprice to 13,540; `TRAY`, `KG` and a unit on a catch-weight pack are 422 `UOM_NOT_SOLD`; a checkout of a crate and 3 eggs holds 33 eggs, `base_qty` 30 and 3, goods 6,660, and the placed order's lines are `CRATE` at 6,000 from the crate's entry and `EGG` at 220 from the egg's.

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The shop prices a line by the product's sale unit, ignoring the line's | red: 2 of 4 (selling-units) |
| M2 | NTF records only a SENT delivery on the notice | red: 3 of 4 (reminder-deliveries) |
| M3 | BIL skips the check that `recipient` is the customer's | red: 2 of 12 (document-sends) |
| M4 | A remittance advice is not held to once per payment | red: 1 of 12 (document-sends) |
| M5 | A document link opens whatever its expiry | red: 1 of 12 (document-sends) |

## Test first, as it honestly happened

- The domain specs (`parties`, `messages`, `dunning`) were written first and run red, then the code.
- The CR-039 spec was written before the code but first run after it, green; M1 then proved it bites.
- The document-sends and reminder-deliveries specs were written after the application layer, against the gate. Their first runs found only faults in the specs (a customer row updated without moving its version, sessions that expired across a month, a replay sent with a different body, upper-case report statuses) and one fault in the code: a forged second `pur.SupplierRemittanceReady` for the same advice would have queued a second message, now refused (`oncePerRecord`).
- Existing specs changed for the new seeded rows (templates and triggers lists), the walks (three new operations; `sendBillingDocument` and `sendStatement` need a valid body to reach the handler), the contract counts and the request schemas. No expectation was weakened, and no test was skipped.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundaries crossed: two staff writes, one public read by token (TB1), the outbox consumer, the sender, the webhook, the database.
- **SC-01 input:** strict zod bodies (`channels` 1 to 3, each once; `recipient` at most 254; `uom` a unit code); a token read only through `linkTokenHash`.
- **SC-02 authorisation:** in the handler, at the document's branch; wrong roles refused (tested); the walks list the three operations, and the identifier walk refuses another branch's Owner and a role without the permission with the same 403 for a real and a random id. `getSharedDocument` takes the token only; an id, a number or a guess is 404.
- **SC-03, SC-04:** parameterised SQL; the party table is chosen between two fixed statements.
- **SC-05 money:** amounts printed from integer pesewas by `formatCedis`; CR-039 prices by MDM's engine, asserted to the pesewa.
- **SC-06 idempotency:** both sends take a key (a replay logs no second copy); one message per event, template and record; one advice per payment.
- **SC-07, SC-08 tokens:** made at each attempt, only the hash stored, never in a row or a log (tested).
- **SC-12, SC-13:** no upload; the webhook is unchanged and still fails closed without its secret.
- **SC-14:** no outside call in a transaction: the link in its own short transaction, the attachment read outside, the provider called outside.
- **SC-22:** both new tables are LEDGER, insert-only (tested).
- **The parent's abuse paths:** a document or advice sent or opened by the wrong party (tested above; the advice can only be the payment's own supplier's, with that payment's figures); a link that opens another document (bound to one archived rendering; tested); a reminder at the wrong level (a level names only a reminder template, and WHL's levels are unchanged); a storm (one message per notice, three attempts, the hourly limit); a failed reminder shown as sent (tested).
- **New abuse cases:** **62** (a document sent to or opened by the wrong party) and **63** (a reminder that misleads or storms). Detection for B12: the send events with their maker, `ntf.MessageFailed`, `ntf.MessageSuppressed`, the link openings in `platform.file_access_log`. **Residual:** a refused typed recipient leaves no row (BL-121). Findings: none open.

## UAT dry runs (at the desk, A-291 (b))

Each step walked against the built code and the spec that proves it; differences from the script only.
- **1.11:** as scripted. **New since the script:** one tracking SMS goes to Ama at placement (B11 continued 12); the shop now also offers the single egg beside the crate (CR-039), each at its own price, which the script does not use.
- **1.12, 1.13:** as scripted (catch-weight re-pricing, invoice on the weighed quantity). The invoice can now be sent to the customer (`sendBillingDocument`) and opened by its link; the script has no step for it.
- **1.14:** as scripted; the "on the way" SMS is sent once to the order's own contact.
- **1.15:** as scripted. The proof of delivery does **not** yet record whether its photograph matches an earlier upload (B12).
- **1.16:** as scripted (the driver cannot reconcile his own cash).
- **Scenario 5, case 6 (the driver hands in less):** as scripted; the delivery SMS go as above. An order on account can now be dispatched, which the script's case does not use.
- **Scenario 2 from 2.12:** as scripted for the picks, the part dispatch and the invoice; the 8 goats stay reserved. **Differences:** the customer's messages now go (dispatch, delivery), each once; a STOP from Emmanuel's number would stop his payment reminders but not his receipts, and reminders wait out quiet hours; each reminder's delivery now shows on its notice (2.17 to 2.19 read the ageing, unchanged). A crate's eggs can now be returned singly, not used here. Step 2.15 names Kasoa as the delivery place: the script's own text, not seeded data.
- No figure in these steps differs from the script.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

- **CR-039** (the shop's crate and single egg): **built** in exactly the requested shape (`sellingUnits` on `CatalogueItem` and `ProductDetail`, each `uom`, `uomName`, `priceFromPesewas`, `priceToPesewas`, `availability`; `CartLineAdd.uom`; two cart lines; checkout and placement by the unit; stock reserved in the base unit).
- **CR-033 point 3 item 3** stays declined (BL-119, B11 continued 12's reason). **CR-059 to CR-062** are B12's, in its opener. Every other request is answered in its phase. No request is new, and none is left without a phase.

## Tests (this machine)

Run with Docker's Testcontainers. CI is below.

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, on `fcebdcc`, after the last code and spec change; only this report followed) | **4,323 passed, 363 files, none failed or skipped.** Coverage: statements 94.19 %, branches 83.98 %, functions 97.96 %, lines 97.28 % (baseline 94.15, 83.94, 97.90, 97.21). Every full-coverage gate held, `src/modules/ntf/domain`, `src/modules/mdm/domain/parties.ts` and `src/modules/shp/domain` at 100 percent. The first whole run, on `0b63cad`, failed one spec: `iam/authentication` lists the Cashier's permissions and did not yet name `bil.document.send` (granted by 0345). It was corrected in `fcebdcc` and the whole suite was run again (above). |
| The new specs | `document-sends` 12, `reminder-deliveries` 4, `selling-units` 4; the NTF, WHL, DOC, walk and rollback specs passing |
| Contract (`pnpm test:contract`) | 139 tests, 55 files, passed |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate` | Clean (567 operations from code, 99 planned) |

## Deferred

- **To B12:** the proof-of-delivery reused-photograph match (A-291 (a)); the exception report items for abuse cases 62 and 63.
- **BL-121:** a walk-in receipt by message, and refused sends kept for the exception report.
- **To B13:** the email and WhatsApp adapters and keys (BL-117 unchanged); until then such messages fail visibly.
- **Seed:** the templates and triggers come with migration 0343; no send, link or delivery is seeded.

## Questions for the owner

1. **Who sends a billing document (A-288 (a))?** The Owner, the Manager and the Cashier, as reprint. Should the Accountant and Sales too?
2. **A document link's life (A-288 (b))**: thirty days, as a tracking link. Longer for a statement?
3. **The remittance advice (A-288 (f))**: built for the supplier as the opener says; an investor's distribution schedule is B12's. Agreed?

## Notes for the frontend track

- **2.42.0.** Show `DunningNotice.deliveries` per channel (a failed one as failed); a dunning level picks one of `listNotificationTemplates?category=REMINDER`, never a typed code. The storefront must route `/d/<token>` to `getSharedDocument` and open its `url`. The shop reads `sellingUnits` and sends `CartLineAdd.uom` (CR-039; nothing behind a switch was built there). `MessageRecipient.kind` may be `SUPPLIER`.

## CI

A report cannot name the runs of the commit that adds it. Every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

The parent session inserts the UAT scenario 2 corrections phase before B12. B12 (`b12-capital-costing-reporting`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read the last report of each lane (docs/sessions/B11-fulfilment-delivery.md and
docs/sessions/B09c-card-payment.md, or the last report of either lane's own splits); B12 opens only when both lanes
have merged (owner, 2026-11-17).
Read ../frontend/docs/CONTRACT_REQUESTS.md if it exists: implement what is reasonable, record in the
report what you declined and why, never edit that file and never open frontend source.
For this phase, read the CAP, CST, RPT and API requirement blocks of docs/SRS.md (nothing else from
the SRS), docs/data-model/cap.md, cst.md, rpt.md and api.md, the CAP, CST, RPT and API cards in
docs/MODULE_BOUNDARIES.md, and ADR-0018, ADR-0023, ADR-0028 and ADR-0026 (the daily
exception report), and section 4 of docs/security/THREAT_MODEL.md (the eighteen abuse cases and the
exception kind each names). Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B12 only, on branch b12-capital-costing-reporting: investors, capital contributions and
withdrawals with approval, unit holdings with effective dates, distribution runs by unit-days with
largest-remainder allocation, the lifecycle draft to paid with step-up approval, loans and grants,
overhead allocation, cost object summaries, margin and loss facts, the reporting read model with its
projections and checkpoints, report definitions and schedules, the investor portal's read model, the
public API with keys and webhooks, and, as ADR-0026 proposes, the daily exception report:
GET /exceptions/daily-report, with an item kind for every one of the eighteen abuse cases, each item
carrying its abuse case numbers, actor, amount and subject document, so that B13 can assert it.
The exception report must include order splitting (abuse case 27, owner 2026-11-15, A-168): read
PUR's PurchaseOrders.splitSuspectsIn for the report's day and report each run with its maker, supplier,
orders and total; and the payout changes of case 13 from pur.SupplierPayoutChangeRequested and
pur.SupplierPayoutChanged, with SA-17's payment within 24 hours after a change.
It must include case 28 (B07 continued 1b, A-172): each invoice paid on an approved variance
(pur.SupplierInvoiceMatched or ExpenseInvoiceApproved with varianceApprovalRequestId) and each approved supplier
credit note (pur.SupplierCreditNoteApproved with its returned movements), with maker, approver and amount.
It must include PAY's breaks and reversals (the owner, 2026-11-16, B09a continued 1b): every reconciliation break of
every kind (from the provider sweep, from webhooks, from settlement and bank statement matching, and REFUND_FAILED)
read through the published view pay.pub_reconciliation_break, each with its kind, payment or reference, amount, age
and state; every payment mismatch found against Paystack among them; and each pay.PaymentReversalRequested (abuse
case 32) with its maker, amount and reason, beside pay.RefundRequested (case 12) and pay.WebhookRejected (case 5).
It must include case 2's reused death photographs (B06r, A-175): each liv.MortalityPhotoReused with the record,
the reporter and the earlier records whose photograph had the same bytes; and case 29 (A-176): every processing
reversal from prc.ProcessingOrderReversed with its value, the threshold copied onto it, the maker, the approver
when one was needed, and the reason. Residual risk R18 (B07 continued 2): count the storefront checkouts
started and expired per address a day from shp.CheckoutStarted and shp.CheckoutExpired, as an item when one
address holds stock repeatedly without placing an order.
It must include case 34, inflated rejections at the door (B09e continued 3, A-272, ADR-0076): a RECEIPT_CLAIM item for
each pur.SupplierClaimRaised, with the receipt, the receiver, the claim's maker, the supplier, the rejected quantity,
its reason and its value. And every exception source B9b, B09c and B11 add (their reports name each one), at least
each reused till receipt token (a possible till fault or tampering, owner 2026-11-17) and each supervisor's PIN
sign-out of a locked cashier (CR-032).
Write the five tests of ADR-0028 under the names the ADR gives them, and run scenario 4 of
docs/UAT.md as a dry run: the net profit for July to September 2026 in the seed is GHS 41,666.70 and
the hand calculation must match the run to the pesewa.
Coverage (NFR-015, docs/TEST_STRATEGY.md section 6): put the distribution rules under
src/modules/cap/domain/distribution/ and uncomment its 100 percent gate in vitest.config.mts before
the gate passes. Fill every branch it exposes; the gate does not pass on a lowered number.
The owner dashboard was pulled forward to B05x (A-149): keep getOwnerDashboard's shape, add its caching and the
NFR-023 performance budget, move its reads onto the hk_report connection, and remove `alerts` and
`exceptionsToday` from RPT's PENDING_FIGURES once the daily exception report answers them. runReport must implement
every report code listReportDefinitions lists, SALES_SUMMARY and PURCHASES included (CR-018), each matching its
contract example's columns.
The owner, 2026-11-16 (A-212 (a)): investor capital arrives through the investor module to the bank, never as cash.
The owner, 2026-11-23 (from the frontend's F12 and F10n): build CR-059 to CR-062. Grant the report and exception
report permissions to the Owner and the Manager (and the Accountant for the financial reports). Give each of these
controls its own exception type: cash drops (witnessed or not), reused photographs, quotes accepted in a staff session,
late cash after a shift closed, and negative stock after an offline sale. Add marking an exception reviewed with a note,
the egg report codes, the VAT return, and the statement and exception report exports. Notes:
- "quotes accepted in a staff session" is the possible staff acceptance of B10 continued 6 (the decision's address and
  browser matched against staff sessions active from the same address in the last 24 hours, never a cookie);
- "reused photographs" means a proof-of-delivery photograph or signature whose content hash matches an earlier upload
  (beside case 2's death photographs); none of B11 continued 6 to 13 recorded that match (B11 continued 13, A-291), so this phase must: record on the proof of delivery whether its photograph or signature matches an earlier upload's SHA-256 in `platform.stored_file` (as liv.MortalityPhotoReused does) and publish it;
- each existing exception kind keeps working, and any rename is LOUD.
Stop at the gate and write docs/sessions/B12-capital-costing-reporting.md.
```
