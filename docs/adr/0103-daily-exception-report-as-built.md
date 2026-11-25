# ADR-0103: The daily exception report as built: a projector over the outbox, a sweep of records, items keyed by their source

- **Status:** Proposed (the owner reviews A-390 to A-392)
- **Date:** 2026-11-24
- **Session:** B12 continued 3
- **Deciders:** backend track; the owner reviews A-390 to A-392

## Context

ADR-0026 puts the daily exception report in B12; ADR-0023 asks for a reporting schema fed by events, rebuildable, with
checkpoints, read under `hk_report`. FR-RPT-007 asks for an item kind for every abuse case 1 to 18, each item with its
abuse cases, actor, amount, subject document, summary and details; every phase since B7 named one or more sources for
it (events with `abuseCases`, the audit trail's refusals and exports, the stock exception queue, the reconciliation
breaks through `pay.pub_reconciliation_break`, PUR's order splitting rule). CR-059 asks for an item to be marked
reviewed with a note, a `reviewed` filter and five control kinds. Most sources are events; some are records with no
event (an audit row, a job run, a stock exception raised by a trigger, a split run that only PUR's rule can see).

## Options considered

1. **Compute the report on each request from every module's published views.** No projection, but every module would
   need a view for every source, the report would join across all of them, and an item would have no stable id to review.
2. **A projector over the outbox only.** Events are there already, but the records with no event would need new events
   in modules other teams own (the audit trail, the stock triggers, PUR's rule), or be missed.
3. **A projector over the outbox, plus a sweep of the record sources, both writing one projection keyed by source.**

## Decision

Option 3.

- **One projection, `rpt.exception_item`,** one row per thing to look at. Its `source_key` is the event id and the
  kind, or the record's own key (`break:<id>`, `stock-exception:<id>`, `audit:<id>`, `job-run:<id>`,
  `split:<maker>:<supplier>:<orders>`, `accrual-blocked:<financing>:<month>`, `checkout-holding:<address>:<day>`);
  its `id` is fixed by the key (an RFC 9562 version 8 UUID from md5, held by `ck_exception_item_id`), so a rebuild
  gives every item the same id. Written only by `SECURITY DEFINER` functions; the application roles and `hk_report`
  read it.
- **The projector** (`rpt.exception-items`, asynchronous, read committed) classifies each event through the pure
  `classify` in RPT's domain (100 percent covered), which selects the fields it keeps by name and removes any key that
  could carry contact or identity details. It keeps three small facts the report needs across events
  (`rpt.approval_fact`, `rpt.checkout_fact`, `rpt.payout_change_fact`) and raises from them a payment made within 24
  hours after its payee's payout details changed (SA-17, abuse cases 13 and 70) and an address that let three
  storefront checkouts end unpaid in a day with none completed (R18). It records `rpt.projection_checkpoint`. A
  rebuild empties the projection and replays the outbox in order through the platform's `OutboxHistory`; reviews are
  kept.
- **The sweep** (`exception-sweep`, every quarter hour for today and yesterday) reads, for an Africa/Accra day, the
  audit trail's `AUTHORISATION_FAILURE` and `EXPORT` events and the audit verification's unsuccessful runs (through the
  platform's `AuditFindings`), `inv.pub_stock_exception` (new), `pay.pub_reconciliation_break` and
  `PurchaseOrders.splitSuspectsIn`. A swept record never replaces an item an event raised for the same source (a break,
  a stock exception the till's sync named); an event's item replaces a swept one.
- **Kinds.** The twenty-two kinds of 1.0.0 keep their names; 2.48.0 adds the rest (66 in all), CR-059's five
  controls among them. A source's finer kind travels as `sourceKind`. A company-wide item (a supplier, a webhook, a
  permission) is kept at the head office branch.
- **Readers.** `rpt.exceptions.read` (Owner, Manager, Accountant) over whole-branch grants; an item about the investor
  books (capital, distributions, investor payout details, loans and grants) also needs `cap.capital.read` at its branch
  (the Owner and the Accountant), and is otherwise not shown and answers 404. The report is sent to the owner, not to the
  approvers.
- **Review.** `rpt.exceptions.review` (Owner, Manager) marks an item reviewed with a note, once (409 `ALREADY_REVIEWED`),
  never by the person the item names (422 `REVIEWER_IS_ACTOR`, and `ck_exception_review_not_own`); `rpt.exception_review`
  is insert-only.
- **Rates (FR-RPT-008).** A cashier's voids over their completed counter sales; a shift's over or short over its expected
  cash; a driver's hand-in variance over what was expected; approval pairs with the share of the maker's decisions
  (R1). The other tables count and total with no rate (A-390 (e), BL-130).

## Consequences

- A new source is a classifier entry and a test, or a sweep reader; no module changes its own tables for the report.
- Items appear as fast as the outbox delivers; swept items within a quarter hour.
- `classify` knows each publisher's payload by field name: a renamed field silently drops a detail, so each source has
  a payload fixture in `exceptions.spec.ts` and the integration spec writes each into the outbox.
- Shared modules gained, additively: `del.ProofFileReused` and the proof's two match flags (migration 0372,
  `FileStore.earlierWithSameContent`), `cap.FinancingAccrualBlocked` and `retentionRatePercent` on
  `cap.DistributionDeclared`, `amountPesewas` on `iam.ApprovalDecided`, `clientAddressHash` on `shp.CheckoutStarted`,
  `inv.pub_stock_exception`, and BL-108 in PAY (a mobile money success after failure raised as
  `PROVIDER_PAID_AFTER_FAILURE`, abuse case 73).
- Binds: `docs/data-model/rpt.md`, `docs/security/THREAT_MODEL.md` section 4, B13's abuse case tests.

## Verification

`src/modules/rpt/domain/exceptions.spec.ts` (every classifier, the sweep's records, the rates, 100 percent);
`test/integration/rpt/exception-report.integration.spec.ts` (every abuse case 1 to 18 and every later source on the
seeded farm, review, readers, rebuild, `hk_report`); `test/contract/b12c3/exceptions.contract.spec.ts`;
`test/integration/pay/payment-edge-cases.integration.spec.ts` (BL-108); `test/integration/del/van-returns.integration.spec.ts`
(the reused proof photograph).

## Amendments

- **2026-11-25, B12 continued 6 (A-400; the owner: "Count them, list only refusals").** A till sale's receipt text held
  back `NO_LINK` because the till sent no receipt token (`ntf.MessageSuppressed`, `SALE_RECEIPT`) raises no item. The
  projector keeps it as a fact, `rpt.unlinked_receipt_fact` (migration 0378, once per message, emptied with the rest on a
  rebuild), and the daily report gives one count line per branch and day, `countLines`
  (`TILL_SALES_WITHOUT_RECEIPT_TOKEN`, abuse case 60, contract 2.52.0). A sale whose token was sent and refused is left
  out of the count: its `RECEIPT_TOKEN_REFUSED` item stands, as the owner asked. No kind is renamed or removed;
  `MESSAGE_SUPPRESSED` still holds every other message held back. Tested in
  `test/integration/rpt/exception-report.integration.spec.ts` (five sales without a token and one refused show one line of
  5 and one item; a redelivered message counts once; a rebuild gives the same line).
