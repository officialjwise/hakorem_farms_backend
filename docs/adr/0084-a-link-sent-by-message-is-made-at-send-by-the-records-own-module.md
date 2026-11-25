# ADR-0084: A link sent by message is made at send by the record's own module, and the receipt SMS links the till's receipt

- **Status:** Proposed (the owner reviews A-349 and A-378; the parent session granted the POS part on 2026-11-24)
- **Date:** 2026-11-24
- **Session:** B11 continued 12 (lane B)
- **Deciders:** backend track; the parent session (the leave in POS); the owner reviews A-349 and A-378

## Context

ADR-0074 says a link sent to a customer by message is a link of its own. The outbox row names the record and never carries
a token. The worker that sends the message asks the owning module for a fresh token just before the provider call, so no
token is ever stored in clear. ADR-0096 queues every message once from the outbox, with its text rendered and frozen, and
sends it by a claiming worker. Three messages now need a link:

- the guest's tracking SMS (ORD's `trackOrder`);
- the receipt SMS of CR-033 point 3 (POS's `getPublicReceipt`, ADR-0083);
- the abandoned-cart reminder (FR-SHP-015, ADR-0026), which links to the shop's cart page.

A frozen text cannot hold a token made later. POS keeps only the hash of the till's token, so the server cannot resend that
link. The receipt shows the till's tenders and change, and only the till's link keeps them (`pos.receipt_link`). A sale
whose till token was refused keeps none.

## Options considered

**Where the link goes in the text.**
1. Render the link when the message is queued. The token would then sit in `ntf.message.rendered_body`, against ADR-0074.
2. Keep the `{{link}}` merge field unfilled in the stored text, and name the record's kind and id on the message. The
   sender fills the field with a link the owning module makes in its own short transaction, at each attempt.

**The receipt SMS's link.**
1. Reuse the till's link. Impossible: the server never holds the token.
2. Add a second row of the same table (`pos.receipt_link` with a new `source`). The revocation read (`linkOfSale`) would then
   find two rows per sale, which changes an existing POS function.
3. Add a table of message links, each bound to its sale's till link. The public read looks there only for a hash no till
   link holds (the parent session's leave, condition 2).

**A sale whose till token was refused.** Make a server receipt with tenders from PAY, or with none; or send nothing.

## Decision

Option 2 for the text, option 3 for the receipt, and send nothing for a refused sale (the parent session, 2026-11-24).

- **Messages.** `ntf.message.link_kind` (`TRACKING`, `RECEIPT`, `CART`, `DOCUMENT`) and `link_record_id` are set when a
  template's code carries a link (`domain/links.ts`) and its text has the placeholder. `ck_message_link_placeholder` holds
  that a message carries a link exactly when its text keeps `{{link}}`. `ntf.message_link_fixed()` keeps the link's kind and
  record from ever changing (HK004).
- **At send.** `MessageSender` reads the gates again first: the number, a STOP on a reminder or marketing message, a
  marketing message's consent, quiet hours. Then it asks `MessageLinks` for the link, in its own serializable transaction:
  - ORD's `OnlineOrders.reissueTrackingIn` gives a `trk_` token (thirty days).
  - POS's new `ReceiptLinks.issueMessageLinkIn` gives an `rcp_` token.
  - SHP's `AbandonedCarts.remindableIn` gives no token, and answers only whether the cart may still be reminded.

  The link is built under `RECEIPT_LINK_BASE_URL` (`/track/`, `/r/`, `/cart`) and goes into the text only on its way to the
  provider. Each attempt makes another link. A record with no link to give is `SUPPRESSED` `NO_LINK`. With no shop address
  configured, the message `FAILED`, visibly.
- **The receipt SMS (CR-033 point 3).** `ntf.link-messages` handles `ord.OrderCompleted` for a POS sale made offline at a
  till and synced. It queues `SALE_RECEIPT` once (`TRANSACTIONAL`) to the order's own contact, which is the `customerPhone`
  the till sent, read again at send. With no number, the message is `NO_ADDRESS`. A replayed sync (`DUPLICATE`) posts and
  publishes nothing, and a redelivered event meets `uq_message_idempotency`, so either way one SMS goes.
- **The message link (`pos.receipt_message_link`, LEDGER, migration 0340).** It keeps only the hash and is bound to its
  sale's till link (`receipt_link_id`). It expires with the till link (`ck_receipt_message_link_expiry`), and its hash is
  never a till link's hash (`ck_receipt_message_link_distinct`).
  - `PgReceiptLinkStore.liveLink` changes in one way only: when no till link has the hash, it looks for a message link. It
    answers the message link's till link, so the receipt is exactly the till's, and only while that till link is live.
  - Revoking the till link therefore revokes every message link of it, in the same transaction, with no row of its own.
  - A sale with no live till link (refused, never sent, expired or revoked) gets `NO_LINK` and no SMS (BL-118).
- **The tracking SMS.** `ord.OrderPlaced` for an `ONLINE` order queues `ORDER_TRACKING` to the order's contact.
- **Abandoned carts.** SHP's `abandoned-carts` job runs every ten minutes as the Scheduler. A cart qualifies when a
  customer holds it, it has lines, it is `ACTIVE`, it has been idle two hours by the application's clock, and its customer
  gave marketing consent (MDM's new `marketingConsentsIn`).
  - The job writes `shp.abandoned_cart_notice` once ever per cart (migration 0341) and publishes `shp.CartAbandoned` with
    only the cart, its customer, the notice and the idle time.
  - NTF queues `CART_REMINDER` (`MARKETING`) to the customer's own number: suppressed by a STOP, delayed by quiet hours, and
    `NO_CONSENT` without consent, which is checked again at send. The reminder names nothing of the cart.
  - A guest's cart is never reminded.
- **Detection.** `ntf.MessageSuppressed` (v1, additive reasons) is also published for `NO_LINK` (abuse case 60) and
  `NO_CONSENT` (abuse case 61), for B12's exception report.
- **Not built.** `SyncResultItem.receiptMessage` (CR-033 point 3, item 3): a replay is answered from the stored sync row,
  which keeps no message status, so the field would change POS's existing sync answer (BL-119).

## Consequences

- No token is ever in the outbox, the message row, an attempt, an audit row or a log. A database reader cannot open a
  receipt, a tracking link or a cart from NTF's tables.
- A message sent again gets another token. Each earlier one stays valid until it expires: thirty days for tracking, the
  till link's twelve months for a receipt.
- POS's till link answers exactly as before. Its existing tests pass unchanged, and NTF is now POS's one importer.
- A till whose token was refused gives its customer no SMS receipt until BL-118. The refusal is already on the exception
  report (abuse case 37), and its missing SMS is there too (abuse case 60).
- An abandoned-cart reminder reaches no one until a shopper's cart carries its customer (BL-120): the shop makes guest carts
  only (A-177).
- Binds `docs/data-model/ntf.md`, `pos.md` and `shp.md`, the NTF, POS and SHP cards, `docs/API.md` (NTF),
  `docs/security/THREAT_MODEL.md` (abuse cases 60, 61), and `docs/OPERATIONS.md` (the `abandoned-carts` job).

## Amendments

- **2026-11-25, B12f (the owner's decision of 2026-11-24, A-396, A-397): the receipt SMS for every till sale, as far as a till link exists.** The owner chose that every till sale where the buyer gave a phone number gets the receipt text, online or offline, amending A-349 (c). A synced sale gets it exactly as decided above. A live counter sale (`completeCounterSale`) still gets none, because its till makes no receipt link: the till's token travels only with `OfflineSale.receiptToken`, and POS keeps a till link only for a synced sale (ADR-0083, `ck_receipt_link_synced`). A text for it would have no link to give (`NO_LINK`, abuse case 60 on every live sale) or a receipt without the till's tenders (BL-118's objection). Giving a live sale its link changes POS's `completeCounterSale` and that rule, which waits for the parent session's leave (BL-133); NTF then drops `SALE_RECEIPT`'s offline-only condition. Tested in `test/integration/ntf/link-messages.integration.spec.ts` (a live sale with and without a phone, and its replay, send none; a synced sale one; a sale with no till link `NO_LINK`). The decision above is otherwise unchanged.

## Verification

- `src/modules/ntf/domain/links.spec.ts` (the 100 percent gate): the kinds, the placeholder kept, the link filled, the
  URLs, and a typed link still refused.
- `test/integration/ntf/link-messages.integration.spec.ts`:
  - The tracking SMS: once, to the guest's number, with a fresh token that opens the order. The order's id and a guess
    open nothing. Another token per attempt. A redelivery queues nothing.
  - The receipt SMS: one to the buyer's number, answering exactly the till's receipt. A replayed sync and a redelivery
    send one. No number sends nothing. A refused or absent till token gives `NO_LINK`, published with abuse case 60.
  - A STOP does not stop the receipt SMS.
  - Revoked, expired and unknown links answer the same 404 as a guess.
  - The database rules: the sale, the expiry, the distinct hash, unique, insert-only, the link fixed.
- `test/integration/shp/abandoned-cart.integration.spec.ts`: none under two hours; only consenting customers' carts, once;
  a STOP, a cart checked out since and withdrawn consent each send nothing (the last published with abuse case 61); quiet
  hours delay the reminder to 07:00; the text names nothing of the cart; the database rules.
- The POS receipt-link specs pass unchanged.
