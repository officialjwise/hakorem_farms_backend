# ADR-0099: A document sent by message carries a document link made by DOC at send, and a reminder's delivery is recorded on its notice

- **Status:** Proposed (the owner reviews A-288 to A-290)
- **Date:** 2026-11-24
- **Session:** B11 continued 13 (lane B)
- **Deciders:** backend track; the owner reviews A-288 to A-290

## Context

ADR-0062 left `sendBillingDocument` and `sendStatement` planned until NTF existed, and the remittance advice archived but
unsent. ADR-0074 and ADR-0084 say a link sent by message is a link of its own, made at send by the record's own module and
stored only as its hash. ADR-0096 and ADR-0097 give every message one queue, one claiming sender, the record's own contact
read at queue and at send, the per-recipient limit and the opt-outs. Three more things were asked:

- a document send that reaches only the document's own customer or supplier, retried without a second archive row;
- the remittance advice once per payment to its own supplier, although its archive is made after the paying transaction;
- the owner, 2026-11-23: a dunning level picks a listed reminder template, and each reminder's delivery shows per channel on
  WHL's dunning notice, so a failed reminder shows as failed. WHL (layer 10) cannot read NTF (layer 11).

CR-039 asks for the shop to sell a product in more than one unit, each at its own price, as the till does since CR-038.

## Options considered

**The document's link.**
1. A signed URL to the stored file, put into the message. It would be a credential in the outbox or the message row, and it
   would expire with the signing key's lifetime, not the message's.
2. A document link of its own in DOC: a `doc_` token at each attempt, its hash stored with the archived rendering it opens,
   read by a new public operation by the token alone, which answers a short-lived signed link to that rendering.

**A send before the archive exists.** Fail the message; or make the sender wait without spending an attempt.

**The reminder's delivery.** WHL reads NTF's log (refused: an upward read); NTF publishes and WHL consumes (an upward
event); or NTF calls down into WHL's `Dunning` in its own transaction (commands down, ADR-0010).

**CR-039.** Work a single egg's price out from the crate's (refused by CR-038 and the owner); or price each unit by its
own entry through MDM's `sellingUnitsIn`, already used by the till.

## Decision

Option 2 for the link, wait for the archive, a command down for the delivery, each unit by its own entry.

- **Sends.** `sendBillingDocument` (`bil.document.send`, the roles that reprint) and `sendStatement` (`whl.statement.create`)
  answer 202. BIL logs a copy in `bil.reprint_log` with the first channel asked; neither renders or numbers anything.
  `recipient`, if given, must be an address the document's own party holds (MDM's `isPartyAddress`), else 422
  `RECIPIENT_NOT_DOCUMENT_PARTY`; it is never stored and never the address. A document with no customer is
  `DOCUMENT_HAS_NO_PARTY`. `bil.DocumentSendRequested` and `whl.StatementSendRequested` carry ids and channels only.
- **The remittance advice.** NTF's `ntf.document-sends` consumes `pur.SupplierRemittanceReady`, reads the advice from PUR
  (`SupplierPayments.remittanceFactsIn`), never the event's copy, and queues `REMITTANCE_ADVICE` to the payment's own
  supplier (`recipient_kind` `SUPPLIER`, `ntf.message.supplier_id`), once per payment whatever event names it
  (`oncePerRecord`).
- **The link.** `Documents.issueLinkIn` makes the token for the latest archived rendering whose file has passed the scan;
  `doc.document_link` (LEDGER, migration 0342) keeps its hash and an expiry of at most thirty days. `getSharedDocument`
  (`/shop/documents/{token}`, public, rate-limited) answers a five-minute signed link to exactly that rendering, logged under
  the Storefront; anything else is one 404. The message text keeps `{{link}}` (`/d/<token>` under the shop's address).
- **Waiting.** While the document is still rendering or unscanned, the sender hands the message back `QUEUED` a minute later
  with no attempt spent (`DOCUMENT_WAIT_MS`), so it never fails for want of its archive.
- **Email.** `OutgoingMessage` gains `subject` and `attachments`; an email that carries a document attaches the archived PDF,
  hash-checked (`Documents.attachmentOf`), beside its link. No email adapter is wired: such a message fails visibly
  (`no adapter sends EMAIL`) until B13 (BL-117). A channel with no adapter fails before an address is judged.
- **Reminders.** `judgeLevels` refuses a template that is not `PAYMENT_REMINDER_1` to `3` (`TEMPLATE_NOT_A_REMINDER`), held
  by `ck_dunning_policy_template` on live levels. NTF's `ReminderDeliveries` calls `Dunning.recordDeliveryIn` when the sender
  sends or fails a reminder and when a signed report says delivered or failed, in the same transaction;
  `whl.dunning_notice_delivery` (LEDGER, migration 0346) keeps each, once per message and status, and `DunningNotice.deliveries`
  shows the latest per channel. `ntf.message.record_id` names the notice (or the send, or the advice) the message is about.
- **CR-039.** `shp.product_listing.selling_units` (migration 0347) lists each unit MDM prices on the ONLINE channel, the sale
  unit first; `CartLineAdd.uom` names one; a cart line is one per product and unit (`uq_cart_line_product_uom`); the cart,
  the checkout and ORD's placement price each line in its own unit, and the checkout reserves in the base unit.

## Consequences

- No document token is ever in the outbox, a message, an attempt, an audit row or a log; a database reader cannot open a
  document from NTF's or DOC's tables. Each attempt makes another token; each earlier one stays valid for its thirty days.
- A failed send is retried by `retryNotificationMessage` with no second archive row, render job or copy.
- A document goes only to its own party's address as MDM holds it when sent; a typed recipient can only be refused.
- WHL's dunning notice shows what NTF did, without WHL reading NTF. A notice shows nothing until NTF has tried it.
- A refused typed recipient rolls back with its request and leaves no row (abuse case 62's residual, for B12 to decide).
- The proof-of-delivery reused-photograph match is not built here: B12 builds it (its opener says so).
- Binds `docs/data-model/doc.md`, `ntf.md`, `whl.md`, `shp.md`; the DOC, BIL, WHL, PUR, MDM, NTF and SHP cards;
  `docs/API.md`; `docs/security/THREAT_MODEL.md` (abuse cases 62 and 63).

## Verification

- `test/integration/ntf/document-sends.integration.spec.ts`: a send logs one copy and queues one message for the document's
  own customer; it goes once to the customer's number with a `doc_` token stored only as its hash; the token opens exactly
  the archive (the served bytes hash to its SHA-256); a guess, the document's id, the archive's id and its number answer the
  same 404; a typed recipient not the customer's, a walk-in receipt and the wrong roles are refused and send nothing; a
  forged event goes to the document's own customer; an email fails with no adapter and, retried, carries the archived PDF;
  three failed attempts then a retry send it with no second archive row; the statement; the remittance advice waits while
  unscanned, then goes once to its supplier, and a replay, a redelivery and two forged events add nothing; expiry; the
  database rules.
- `test/integration/ntf/reminder-deliveries.integration.spec.ts`: nothing until tried, then SENT, then DELIVERED; FAILED
  after three attempts and as reported; SENT after a retry; an email reminder fails visibly on EMAIL, then is sent by the
  fake; insert-only and unique.
- `test/integration/shp/selling-units.integration.spec.ts`: the crate at GHS 60.00 and the egg at GHS 2.20 listed, carted
  as two lines, checked out (33 eggs reserved) and placed, each in its own unit, to the pesewa; a unit not sold refused.
- `src/modules/mdm/domain/parties.spec.ts`, `src/modules/ntf/domain/messages.spec.ts`, `src/modules/whl/domain/dunning.spec.ts`.
