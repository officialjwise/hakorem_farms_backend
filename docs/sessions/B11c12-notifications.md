# B11 continued 12: notifications, third pass (lane B), split after the messages that carry a link

Date: 2026-11-24 · Branch `b11c12-notifications`, from `main` at `5562101` (#139, B11 continued 11) · Status: **phase split (A-379), after a sub-domain built to its part of the gate.** Built and passing locally (CI below):
- the guest's tracking SMS;
- the receipt SMS (CR-033 point 3, built with the parent session's leave in POS);
- abandoned-cart recovery.

Each link is made at send by the record's own module. **B11 continued 13 builds the rest:**
- the document sends and the remittance advice;
- a dunning level picking a listed template, and each reminder's delivery on its notice;
- CR-039;
- the reused-photograph match;
- the UAT dry runs.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-349 | **The messages that carry a link, and the receipt SMS** (ADR-0084; the parent session's leave in POS). (a) A link is made at send by the record's own module, in the sender's own transaction, a new one for each attempt. The stored text keeps `{{link}}` unfilled, so no token is ever in the outbox, the message, an attempt, an audit row or a log. A record that gives no link is `SUPPRESSED` `NO_LINK` (abuse case 60). With no shop address, the message fails visibly. (b) Links go under `RECEIPT_LINK_BASE_URL`: `/track/<token>`, `/r/<token>`, `/cart`. The frontend routes `/track/` and `/cart`. (c) The receipt SMS goes only for a counter sale a till made and synced, once, to the `customerPhone` the till sent, read again at send. It is transactional: never stopped by a STOP, still rate-limited. A live counter sale sends none. (d) The SMS link is an `rcp_` token bound to the sale's till link (`pos.receipt_message_link`). It answers exactly the till's receipt, expires with it and is revoked with it. A sale whose till token was refused, or which sent none, gets no SMS (BL-118). (e) `SyncResultItem.receiptMessage` is not added (BL-119). (f) The tracking SMS goes when an online order is placed. | Owner (b, c, d); parent session (the POS leave) |
| A-378 | **Abandoned-cart recovery** (FR-SHP-015). (a) Only a customer's cart is reminded, and only with that customer's own `marketing_consent_at`, read by the sweep, when queued and when sent. A guest's cart never is; the shop makes guest carts only, so nobody is reached until BL-120. (b) Idle means `ACTIVE`, with a line, unchanged for two hours by the application's clock; the sweep runs every ten minutes, at most 200 carts a run. (c) One reminder per cart, ever; the cart keeps its status and is not reserved. (d) It is marketing: a STOP stops it and quiet hours delay it. It gives the first name and nothing of the cart. Its link is the shop's cart page, with no token, made only while the cart may still be reminded. (e) A reminder suppressed for consent is published with abuse case 61. | Owner |
| A-379 | **The split.** Built the link messages and abandoned carts to their part of the gate (migrations 0339 to 0341, contract 2.41.0). Stopped before the document sends, which need a document link of their own (a new public read by token in DOC), and before the remittance advice, which waits for its archive after commit. Each needed more room than was left to reach its gate. **B11 continued 13** (`b11c13-notifications`) is inserted before B12 and closes the B11 chain. | Parent session |

**For the parent session to schedule:**
- **B11 continued 13** carries:
  - the document sends;
  - the remittance advice;
  - the reminders' templates and delivery;
  - **CR-039** (not declined);
  - the reused-photograph match;
  - the UAT dry runs.

  Then comes the UAT scenario 2 corrections phase the parent inserts, then B12.
- **CR-033 point 3** is built, except item 3, `SyncResultItem.receiptMessage`, which is declined for now (BL-119, reason below).

**No ADR conflict, and no stop.** The POS work stayed inside the parent session's leave (its message of 2026-11-24, option 2 with five conditions; each is listed under Security). **Shared modules, additive only:**
- MDM gains `MasterDataRefs.marketingConsentsIn`.
- POS gains `ReceiptLinks.issueMessageLinkIn`, `pos.receipt_message_link` and the one permitted change to `liveLink`.
- Nothing changed in PAY, INV, BIL, IAM, DEL, ORD, FIN, DOC or WHL.
- No new permission or operation.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 12, lane B (`b11c12-notifications`, from `main` 5562101).
2. **Scope:** the document sends, the remittance advice, the receipt and tracking SMS, abandoned carts, the reminders' templates and delivery, CR-039, the reused-photograph match and the UAT dry runs. Split at a sub-domain boundary if the context will not reach the gate.
3. **Gate:**
   - The receipt SMS and the tracking SMS go once, only to the record's own contact, each with a fresh token from the sending worker; a guessed token or the order's id answers 404. **Passed.**
   - A document send reaches only its own party, and a failed send is retried without a second archive row: **B11 continued 13.**
   - A failed reminder shows as failed: **B11 continued 13.**
   - CR-039 prices exactly: **B11 continued 13.**

## Baseline (before any change, as the parent asked)

`pnpm test:coverage` on `main` at `5562101`, run on a clean extract of the commit: **357 files, 4,269 tests passed, none failed or skipped. Statements 94.15 %, branches 83.90 %, functions 97.89 %, lines 97.20 %.**

A first run in the worktree was polluted by this session's own edits made while it ran: the same tests passed, but the figures were not the commit's. It was rerun alone on the extract, which gave the figures above.

## Contract changes

**2.41.0, minor, behaviour on implemented operations.** No operation, field, parameter or status code was added, removed or retyped. Redocly is clean with no warnings, and `contract:generate --check` is up to date (564 operations from code, 101 planned).
- **LOUD:**
  - `suppressedReason` in the message log may now be `NO_LINK` or `NO_CONSENT`.
  - A link-carrying message's text shows `{{link}}`.
- **Descriptions:**
  - `trackOrder`: the tracking SMS.
  - `getPublicReceipt`: the receipt SMS and its own `rcp_` link, which answers the same body as the till's.
  - `listNotificationMessages`: the two reasons and the placeholder.
- **Event:** `ntf.MessageSuppressed` v1 is also published for `NO_LINK` (abuse case 60) and `NO_CONSENT` (abuse case 61).
- **Not added:** `SyncResultItem.receiptMessage` (BL-119).

## Built

| Item | What |
| --- | --- |
| NTF domain (100 percent gate) | `links.ts` (new): the four link kinds, `LINK_PLACEHOLDER`, `linkKindOf`, `linkDataOf`, `withLink` and `linkUrl`. `templates.ts`: `ORDER_TRACKING`, `SALE_RECEIPT` (TRANSACTIONAL), `CART_REMINDER` (MARKETING), and `DOCUMENT_SENT` and `REMITTANCE_ADVICE` (codes only, for B11 continued 13), each with its link kind. `messages.ts`: the suppressed reasons `NO_LINK` and `NO_CONSENT`. |
| NTF application | `MessageQueue`:<ul><li>renders a linked message with its placeholder kept, naming the link's kind and record;</li><li>refuses a marketing message without consent (`NO_CONSENT`, published).</li></ul>`MessageSender`:<ul><li>reads consent again at send;</li><li>makes the link through `MessageLinks` in its own short transaction at each attempt;</li><li>fills it in only for the provider;</li><li>gives `NO_LINK` when the module gives none, published;</li><li>fails visibly with no shop address.</li></ul>`MessageLinks` (new). `LinkMessages` (new, `ntf.link-messages`) on `ord.OrderPlaced` (online), `ord.OrderCompleted` (a synced till sale) and `shp.CartAbandoned`. |
| POS (the parent session's leave) | `ReceiptLinks.issueMessageLinkIn`, exported through `index.ts` and the module. `PgReceiptLinkStore`: `liveTillLinkOfSale` and `insertMessageLink`, plus the one change to `liveLink`: when no till link has the hash, it reads the message link's live till link. |
| SHP | `AbandonedCarts` (new): `run` (the `abandoned-carts` job) and `remindableIn`. The store gains `idleCustomerCarts`, `remindableCart` and `insertAbandonedCartNotice`. ◆ `shp.CartAbandoned` (cart, customer, notice, idle time). The worker runs the job every ten minutes. |
| MDM (additive) | `MasterDataRefs.marketingConsentsIn` (with `consentingCustomers` in its store). |
| Schema | **0339 (NTF):**<ul><li>`ntf.message.link_kind` and `link_record_id`, with `ck_message_link_kind`, `ck_message_link` and `ck_message_link_placeholder`;</li><li>`ntf.message_link_fixed()` (HK004);</li><li>`ck_message_suppressed_reason` gains `NO_LINK` and `NO_CONSENT`;</li><li>three templates and three triggers.</li></ul>**0340 (POS):** `pos.receipt_message_link` (LEDGER, insert only), with `pos.receipt_message_link_guard` (HK010: `ck_receipt_message_link_sale`, `_expiry`, `_distinct`).<br>**0341 (SHP):** `shp.abandoned_cart_notice` (LEDGER, `uq_abandoned_cart_notice`, `ck_abandoned_cart_notice_sequence`), with `shp.abandoned_cart_notice_guard` (HK010, a customer's cart only).<br>Each migration rolls back (the rollback walk runs them). |
| Docs | ADR-0084, indexed. A-349, A-378, A-379. BL-118 to BL-120. Abuse cases 60 and 61. The data model (`ntf`, `pos`, `shp`). The NTF, POS and SHP cards. API.md (NTF). OPERATIONS.md (`abandoned-carts`). The 2.41.0 changelog. ADR-0026 Amendments. The openers file: B11 continued 12 built and split, B11 continued 13 inserted, the reference table, the lane B order, B12's reused-photograph line. |

## The gate, proved by running it

`test/integration/ntf/link-messages.integration.spec.ts` (9 tests, new). It runs over the seeded farm, with a till T2 enrolled and a shift open, a guest's online order of a crate of big eggs, and the SMS provider as a test double. Every figure is read by SQL.

**Tracking:**
- The placement is replayed with its key. `ORDER_TRACKING` is queued once, and its text ends `Follow it here: {{link}}` (masked `+23320*****67`). No `trk_` appears in any outbox payload.
- The sender sends it once, to `+233201234567`, with `https://shop.hakorem.test/track/trk_<43>`, and one new hash is stored.
- That token opens `trackOrder` (200). The token's text appears in no NTF, ORD, POS, audit or outbox row.
- A guessed token, the order's id with and without hyphens, and an id-made token each answer the same 404.
- A retried message gets another token, and both open the order. A redelivered event queues nothing more.

**Receipt:**
- A sale of two crates, cash GHS 120.00 with GHS 150.00 handed over, with `customerPhone` and a till token, syncs. `SALE_RECEIPT` is queued (`... receipt RCT-... for GHS 120.00, sale SO-... Your receipt: {{link}}`).
- One SMS goes to `+233244000101` with `.../r/rcp_<43>`.
- Its read answers **exactly the till token's body** (total 12,000, change 3,000). The till's own read is unchanged.
- The stored hash is the token's SHA-256, and its expiry equals the till link's.
- The sale's id with and without hyphens, its receipt number and its order number each answer the same 404 as a guess.

**Once:**
- A replayed sync is `DUPLICATE`. A redelivered event and two sender passes give one message and one SMS, from one `ord.OrderCompleted`.

**No number, no link:**
- A sale with no number is `NO_ADDRESS`, with no SMS.
- A sale whose till token was refused (`RECEIPT_TOKEN_REFUSED`), and a sale with no till token, are each `NO_LINK`. No SMS goes, no message link exists, and each is published `ntf.MessageSuppressed` `NO_LINK` with `abuseCases [60]`.

**Transactional:**
- After a signed STOP on the buyer's number, the next sale's receipt SMS is still sent to it.

**Revocation and expiry:**
- The Manager, with step-up, revokes the till link. The SMS link and the till link then each answer exactly the guessed-token 404.
- Twelve months on, an unrevoked SMS link answers the same.

**The database:**
- A message link of another sale's till link, with a different expiry, or with a till link's hash, is refused (HK010). A duplicate hash is refused (23505).
- `hk_app` cannot update it (42501), and the owner role cannot delete it (HK001).
- A message's link record, its text and its link kind never change (HK004).

`test/integration/shp/abandoned-cart.integration.spec.ts` (4 tests, new; FR-SHP-015). It runs at 10:00 Accra, with five carts of one crate, four held by customers made through `createCustomer` and one a guest's.

**The sweep:**
- At one hour idle, nothing is reminded.
- At three hours, only the three consenting customers' carts are reminded. A second sweep reminds nothing.
- Three notices are written. The event's keys are only `cartId`, `customerId`, `idleSince` and `noticeId`. The cart stays `ACTIVE`.

**Sent once:**
- Yaw replies STOP and his reminder is `OPTED_OUT`. Kofi's cart is checked out before sending and his is `NO_LINK`. Esi (no consent) and the guest get no message at all.
- Akua's reminder is `MARKETING`, `QUEUED` and sent once to `+233244100301`: `HaKorem Farms: Akua, your cart is still saved. Finish your order here: https://shop.hakorem.test/cart Reply STOP to stop these messages.` It contains no egg, crate or amount.

**Consent and quiet hours:**
- At 22:30 Accra the reminders are `DEFERRED_QUIET_HOURS` until 07:00 the next day.
- Ama withdraws consent meanwhile, so hers is `NO_CONSENT` at 07:00 and published with `abuseCases [61]`. Abena's is sent.

**The database:**
- A second notice for a cart (23505), a second sequence (23514) and a guest's cart (HK010) are refused. `hk_app` cannot update (42501), and the owner role cannot delete (HK001).

**Changed specs:**
- `templates-and-reports` and `preferences-and-opt-outs`: the three new seeded templates and triggers are listed.
- `customer-messages`: the `ORDER_TRACKING` trigger is turned off for that file, which counts the fulfilment and delivery messages alone. The tracking SMS is proved in `link-messages`.
- `test/support/ntf.ts`: the harness's sender is given the app's `MessageLinks`.
- `test/support/offline.ts`: `tillSale` takes `customerPhone`.

The POS receipt-link specs (`receipt-link`, `receipt-link-revoke`) pass **unchanged**.

Unit: `ntf/domain/links.spec.ts` (5, new).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The sender sends the text without the link it made | red: 4 of 9 (link-messages) |
| M2 | The sender does not read the marketing consent again at send | red: 1 of 4 (abandoned-cart) |
| M3 | A message link opens whatever its till link's expiry and revocation | red: 1 of 9 (link-messages) |
| M4 | The sweep reminds a customer without consent | red: 3 of 4 (abandoned-cart) |

## Test first, as it honestly happened

- `links.spec.ts` was written first and run red (no module), then the domain.
- The integration specs were written after the application layer, against the gate, then run. Their first runs found only faults in the specs themselves:
  - a too-narrow order-number pattern (`SO-2026-DDW-...`);
  - a hand-failed message that did not move its version;
  - an outbox redelivery that did not clear `delivered_at`;
  - the cart's idle time, stamped by the database's own clock (`platform.touch_version`), which the spec now sets with the row triggers held for that one statement.
- The existing NTF specs then failed on the new seeded rows and the new tracking SMS, and were corrected as above. No expectation was weakened, and no test was skipped.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundaries crossed: the outbox consumer, the worker's sender, POS's public receipt read (TB1), the scheduler's sweep, and the database.

- **SC-01 input:** nothing new comes in by HTTP. A token is read by the existing `receiptTokenHash` and `linkTokenHash`.
- **SC-02 authorisation:** no new operation. `issueMessageLinkIn`, `reissueTrackingIn` and `remindableIn` are internal, called only by the sender running as the Scheduler (`MessageSender.run` refuses anything but a SYSTEM principal; the sweep likewise). The public reads are unchanged: the token alone, and a guess, an id or a number gets 404. No wrong-role test is possible for a function with no caller role. The walks (`iam/authorisation`, `iam/no-id-is-a-key`) pass, with no new route to list.
- **SC-03, SC-04:** parameterised SQL.
- **SC-05 money:** the receipt SMS prints ORD's integer pesewas through `formatCedis`; nothing is computed.
- **SC-06 idempotency:** one message per event, template and record (`uq_message_idempotency`). One notice per cart (`uq_abandoned_cart_notice`). A replayed sync publishes nothing.
- **SC-07, SC-08 secrets and tokens:** a token is made at send, answered once to the sender and put only into the provider's text. Only its hash is stored. The specs prove no NTF, POS, ORD, audit or outbox row holds the token's text.
- **SC-12, SC-13:** no upload, no new webhook.
- **SC-14:** no outside call inside a transaction. The link is made in its own short transaction before the provider call.
- **SC-17:** not applicable.
- **SC-22:** both new tables are LEDGER, insert only.
- **SC-23:** the sweep and the link-making run at serializable isolation.
- **The parent session's five conditions for POS:**
  1. The new table and `issueMessageLinkIn` are exported through `index.ts`.
  2. `liveLink` changed only to look in the message links when no till link has the hash. The till-hash path is unchanged, and every existing receipt-link test passes untouched. A message link answers exactly its till link's receipt and is revoked with it in the same transaction. Expired, revoked, another sale's and unknown hashes each answer the same 404.
  3. A sale with no till link gets no SMS: `NO_LINK`, published, BL-118.
  4. `receiptMessage` is declined (BL-119).
  5. The token is made at send and never stored. The SMS goes only to the sale's number read at send. It is transactional and rate-limited. A replay sends one.
- **The parent's abuse paths:**
  - **a receipt SMS sent twice or to a number not given on the sale:** tested, once per event, to the order's own contact at send;
  - **an abandoned-cart message without consent:** tested at the sweep, at queue and at send;
  - **a reminder storm:** the hourly limit per number applies to every new message;
  - **a document sent to the wrong party** and **a remittance advice showing another investor's figures:** B11 continued 13 (not built here).
- **New abuse cases:** **60** (a link sent by message to the wrong person or for the wrong record) and **61** (a marketing message without consent). Both reach B12's exception report through `ntf.MessageSuppressed` (`abuseCases [60]` or `[61]`).
- **Residual:** a till that sent, as its own token, a token copied from a customer's SMS would bind it to a new sale, and the till path answers first. This needs a staff till and a customer's phone; such a till token is still only a till token, and the message link of the first sale stops answering. Recorded under abuse case 60. Findings: none open.

## UAT dry runs

Not run. Steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 are B11 continued 13's, in its opener.

## Reused photographs

Not recorded here. B11 continued 13's opener carries the match, and B12's opener says B12 must do it if B11 continued 6 to 13 do not.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

- **CR-033 point 3** (the receipt SMS): **built.** One SMS per synced sale with the buyer's number, with a link of its own that answers the till's receipt. **Item 3, `SyncResultItem.receiptMessage`, is declined for now:**
  - The sync answers before NTF queues the message.
  - A replay (`DUPLICATE`) is answered from the stored `pos.sale_sync` row, which keeps no message status.
  - The field would therefore change POS's existing sync answer, which the parent session's leave allows only if it can be decided cleanly inside the sync's transaction.
  - It is parked as BL-119. The till should keep promising no SMS state.
- **CR-039** (the shop's crate and single egg): **B11 continued 13's**, in its opener (not declined).
- **CR-059 to CR-062** are B12's, in its opener. **CR-063** was answered in 2.35.0. Older requests are answered in their phases. No request is new, and none is left without a phase.

## Tests (this machine)

Run with Docker's Testcontainers. CI is below.

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, on `28fc8de`, after the last code and spec change; only this report followed) | **4,287 passed, 360 files, none failed or skipped.** Coverage: statements 94.15 %, branches 83.93 %, functions 97.90 %, lines 97.21 % (baseline 94.15, 83.90, 97.89, 97.20). Every full-coverage gate held, `src/modules/ntf/domain` at 100 percent. The first whole run, on `dbe1a75`, failed one spec: the rollback walk (`bil/archive-link-rollback`) lists the migrations it rolls back and did not yet name 0339 to 0341. It was corrected in `28fc8de` and the whole suite was run again (above). |
| NTF alone, with the abandoned carts | 50 integration tests (6 files) passing; the NTF domain unit specs passing |
| The POS receipt-link specs | `receipt-link` and `receipt-link-revoke`: passing, unchanged |
| Contract (`pnpm test:contract`) | 139 tests, 55 files, passed |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate --check` | Clean (564 operations from code, 101 planned) |

## Deferred

- **To B11 continued 13** (its opener):
  - the document sends (a document link in DOC, `sendBillingDocument`, `sendStatement`) and the remittance advice;
  - a dunning level picking a listed template, and each reminder's delivery per channel;
  - CR-039;
  - the reused-photograph match;
  - the UAT dry runs.
- **BL-118:** a server-made receipt, with PAY's tenders, for a sale whose till token was refused.
- **BL-119:** `SyncResultItem.receiptMessage`.
- **BL-120:** a signed-in shopper's cart carrying its customer, and a guest's recovery consent.
- **To B13:** the SMS provider's key and the email and WhatsApp adapters (BL-117 unchanged).
- **Seed:** the three templates and triggers come with migration 0339. No cart, notice or message link is seeded.

## Questions for the owner

1. **A receipt by SMS for a sale whose till token was refused (BL-118).** Today such a sale gets none, because only the till's link keeps how the buyer paid. Should a later phase send a server receipt with the payments the server recorded?
2. **Abandoned carts (A-378).** Only a signed-in customer's cart, with that customer's own marketing consent, once, with nothing of the cart named. A guest's cart never, even if the guest left a number and ticked recovery. Agreed?
3. **The links' paths (A-349 (b)).** `/track/<token>` and `/cart` under the shop's address, beside the receipt's `/r/<token>`. Agreed, or should the storefront name them?

## Notes for the frontend track

- **2.41.0** changes no shape. The message log may show `NO_LINK` and `NO_CONSENT` as `suppressedReason`, and a link-carrying message's text shows `{{link}}`; show it as "(link)".
- The storefront must route `/track/<token>` to `trackOrder` and `/cart` to the signed-in cart. `/r/<token>` already works, and an SMS's `rcp_` token (47 characters) opens it like the till's.
- The till must still promise no SMS state (`receiptMessage` is not in the contract).

## CI

A report cannot name the runs of the commit that adds it. Every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green. The push run on `28fc8de`, before this report, was **45348656125 (push), green**, every job included: the three shards took 4.9, 4.8 and 4.5 minutes against their 12-minute limit, and the contract job 4.0 minutes. `main` had not moved from `5562101` when the merge slot was taken, unless the pull request says otherwise.

## Next session

B11 continued 13 (`b11c13-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c12-notifications.md,
B11 continued 12, which this phase continues).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the NTF requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/ntf.md,
doc.md and pur.md, the NTF, BIL, WHL, PUR, DOC and DEL cards in docs/MODULE_BOUNDARIES.md, and ADR-0062 (document
sends), ADR-0074, ADR-0084, ADR-0096 and ADR-0097, and the abuse cases 57 to 61 in docs/security/THREAT_MODEL.md. Use
docs/prompts/module-build-prompt.md as the recipe. Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 13 only, on branch b11c13-notifications. B11 continued 10 to 12 built the NTF module
(ADR-0096, ADR-0097, ADR-0084): build on it, never again. Every new message goes through `MessageQueue.queueIn` (its
trigger seeded by migration and live, its recipient read through the record's own module) and is sent by the claiming
worker outside any transaction; a link it carries is made at send through `MessageLinks` by the record's own module,
never stored. The rest, in this order:
1. The document sends (ADR-0062, A-204): sendBillingDocument (BIL) and sendStatement (WHL), 202 through the outbox,
   a bil.reprint_log row with the channel for a billing document, never a new document; the link a document send
   carries is a document link of its own (DOC: the archived document, a fresh token at each attempt stored only as
   its hash, read by a new public operation by the token alone; a guessed token or the document's id answers 404), or
   for email the archived bytes through an adapter shape with a fake (the provider and key are B13's; with no email
   adapter a message fails visibly). `DocumentSendRequest.recipient` may name only the document's own party's number
   or address (else 422). The remittance advice from pur.SupplierRemittanceReady, once per payment, to the supplier's
   own contact through PUR or MDM; its archive is made after the paying transaction, so a send before it exists waits
   and retries, never fails for good. A failed send is retried without a second archive row.
2. The owner, 2026-11-23 (from the frontend's F12 and F10n): a dunning level picks one of the reminder templates
   `listNotificationTemplates` lists (`PAYMENT_REMINDER_1` to `3`, seeded in 0338) instead of a typed code, and each
   reminder's delivery is recorded per channel (sent, delivered, failed) where WHL's dunning notice shows it, so a failed
   reminder shows as failed (NTF already sends them and logs each attempt). CR-039 at the shop (the crate and the single
   egg, each at its own price; CartLineAdd.uom; test-first with exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference (an order on account can now be dispatched; a crate's eggs can now be returned singly; the
customer's messages and reminders are now sent, a STOP is honoured and reminders wait out quiet hours; the tracking and
receipt SMS go once each).
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c13-notifications.md.
```
