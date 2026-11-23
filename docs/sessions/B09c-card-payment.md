# B09c: card payment

Date: 2026-11-23 · Branch `b09c-card-payment`, from `main` (`241ce5d`) · Lane A · Status: **gate passed locally; the pull request merges only when every run on its head is green (below).** Lane A's phases end here; the next phase in order is B11 continued 2 (lane B).

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made or decided this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-23)

| ID | What | Who confirms |
| --- | --- | --- |
| A-287 (a) | **The flow:** only the shop's `placeOrder` takes a card (the parent session's leave in SHP's `checkouts.ts`). The payment is written PENDING with our reference in the placement's transaction; once it has committed, Paystack's hosted page is opened **synchronously after commit, exactly where the mobile money charge is sent** (no outbox), channels `card` only, the order's estimate in GHS from the server, the farm's mailbox. No card number, expiry or security code ever reaches the API (a request naming one is 400). Staff-taken card payments and card at the counter are not built (BL-109). | Owner |
| A-287 (b) | **The page's address** is handed out only when it is exactly `https://checkout.paystack.com/<access code>`, else 503 and never stored (no open redirect); kept once on the charge. The return address is `PAYSTACK_CARD_CALLBACK_URL` from configuration (https, no query), never from a request. | Owner |
| A-287 (c) | **Waiting:** Paystack answers an unpaid page `abandoned` at once and a declined card `failed` while the page takes another card, so a card charge answered either way waits until 30 minutes after its order's 15-minute window, then fails; the order stops waiting with its hold, as for mobile money. | Owner |
| A-287 (d) | **A page that cannot be opened** (down, timed out, another host) leaves the order PLACED and the payment PENDING with 503; a replay with the same key opens it or answers the stored page, never under a new reference. A page made but whose answer was lost cannot be fetched again (Paystack refuses a second initialise as a duplicate): nobody holds it, so the payment fails with its grace. | Owner |
| A-287 (e) | **Money:** exact pesewas both ways (GH₵55.00 is 5,500 sent and read back). Dr 1120 against Paystack, Cr 2200 at clearing; Cr 1120 on a refund, by the existing `TENDER` determination for `CARD` (migration 0167). No account added. | Accountant |
| A-287 (f) | **Abuse case 45:** a card paid after its payment failed (`PROVIDER_PAID_AFTER_FAILURE`) and a chargeback Paystack confirms by lookup (`PROVIDER_DISPUTE_OPENED`) are URGENT breaks, nothing posted. The same for mobile money is BL-108. | Owner, accountant |
| A-287 (g) | **Webhooks:** the signature is now checked over the raw bytes **before** the body is parsed, for every provider payment, and a refused body keeps nothing (`payload` `{}`; before, its readable fields were kept). A replayed event is logged with no effect and is not on the exception report (Paystack's own retries are the common case). No card detail is kept, logged or published. | Owner |
| A-287 (h) | **The sandbox differences** (below), each matched by the fake. A paid card, its refund and a real dispute were not run against the sandbox: no card number is ever sent from here. | Owner |
| A-232 (b) | **Superseded** (2026-11-23): a card is no longer refused at placement. | Owner |
| A-286 (f) | **BL-107 built:** a sale made online naming `OFFLINE_PACK_PRICE` is refused `VARIANCE_REASON_INVALID` in `sale-posting.ts`. | Owner |

**For the parent session to schedule:** BL-108 (a mobile money success after its payment failed raises nothing today; PAY outside the card provider, small, additive). BL-109 (card at the counter) is a new decision for the owner. A paid card and its refund against the real sandbox need a person to pay a page by hand (`PAYSTACK_SANDBOX_CARD_REFERENCE`, below).

**ADR conflicts: none.** ADR-0063's one clearing path, webhook order and refund rule are used unchanged; its "signature first" is now honoured before parsing too. ADR-0010: the page is opened after commit. **No new ADR** (ADR-0084 unused). No phase split.

**Contract 2.30.0 (above main's 2.29.0), additive, LOUD on two points:** `placeOrder` by `CARD` places the order and answers the hosted page in `payment.redirectUrl` (`CARD_NOT_AVAILABLE` deprecated, no longer answered); `ReconciliationBreak.kind` gains `PROVIDER_PAID_AFTER_FAILURE` and `PROVIDER_DISPUTE_OPENED`. No field removed, retyped or made required.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09c (`b09c-card-payment`, from `main` `241ce5d`), lane A, the last of lane A.
2. **Scope:** card as an online payment through the existing Paystack port (the hosted page), every B09a continued edge case test-first against the fake, the card cases in the on-demand sandbox suite, BL-107 if small.
3. **Gate:** an online order paid by card through the port with every edge case proved; card details never touch the servers or logs; `pnpm test:sandbox` runs the card cases against Paystack's test mode and reports each difference.

## Built

| Area | What |
| --- | --- |
| Data | `0311_pay_card_hosted_page`: `pay.provider_transaction.page_url` (Paystack's checkout host only, a card charge only, written once while open: `trg_provider_transaction_page`), `ck_provider_transaction_card_network`; two break kinds. |
| PAY domain | `domain/card.ts` (100 percent gate): `judgeCardAnswer` (waits on abandoned or failed until the page's grace ends), `paidAfterFailure`, `cardPageUrl` (the open-redirect check). `CARD_PAGE_GRACE_MS` 30 minutes. `charge.dispute.create` handled. |
| Provider port | `lookupDispute` (`GET /dispute/:id`); `readWebhook` reads a dispute (only its id, reference, amount, currency and status). `initiate` was already there. |
| PAY application | `ProviderPayments.cardChargeIn` (the payment PENDING in the caller's transaction, as `chargeIn`), `openCardPage` (after commit; the page kept once; a replay answers it; 503 and PENDING on any failure); `settleIn` judges a card by its rule and raises a card paid after failure; `PaymentWebhooks` checks the signature before parsing and handles a dispute with its lookup. Configuration `PAYSTACK_CARD_CALLBACK_URL`. |
| SHP (leave) | `checkouts.ts` placeOrder only: CARD no longer refused; `cardChargeIn` in the transaction where mobile money calls `chargeIn`; `openCardPage` after commit where mobile money calls `sendCharge`; `redirectUrl` filled, on a replay too. Mobile money and COD untouched. |
| ORD (leave) | `sale-posting.ts`: `OFFLINE_PACK_PRICE` refused online (BL-107). |
| Fake | `/transaction/initialize` (abandoned at once, duplicate refused, a page on `checkout.paystack.com`), `payCard`, `declineCard`, disputes and their webhook; card details in a webhook made up at random each run. |
| Sandbox | Five card cases (below); a paid card's two run only with `PAYSTACK_SANDBOX_CARD_REFERENCE`. |
| Docs | A-287, A-232 (b) superseded, A-286 (f); BL-107 built, BL-108, BL-109; abuse cases 45 and 46; `data-model/pay.md`; API.md (PAY, the shop, section 13); DATA_CLASSIFICATION (card data); the provider-down runbook; the changelog. |

## The gate, proved by running it

**Unit:** `pay/domain/card.spec.ts` (12 tests) written first and seen red (no module), then green at 100 percent statements, branches, functions and lines; `webhook.spec.ts` gains the dispute case, seen red first.

**Integration:** `test/integration/pay/card-payments.integration.spec.ts` (26 tests), written first and seen red (23 of 26 failing: the card was refused). Two crates of big eggs online are 12,000; one crate 6,000.
- **GH₵55.00 both ways:** the adapter opens a card page for `5500` and reads the paid card back as 5,500n in GHS.
- **Placement:** 201 with the page on `checkout.paystack.com`; the payment CARD, PENDING, `UNVERIFIED`, 12,000, no phone; the charge CARD, no network, the page's address on it; Paystack asked once for `12000` GHS, `channels: ['card']`, the farm's mailbox and the configured return address; a replay answers the same page and opens none; a card number in the body is 400; a card on COD terms is `PAYMENT_METHOD_MISMATCH`.
- **Paid on the page:** the webhook's lookup clears it once, Dr 1120 Paystack 12,000, Cr 2200 12,000, the order CONFIRMED; a second delivery is `REPLAYED`; a later sweep changes nothing; one journal; trial balance 0.
- **No card detail kept:** by SQL over `pay.webhook_event`, `platform.outbox_message`, `platform.audit_event`, `platform.idempotency_key`, `pay.payment` and `pay.provider_transaction`, and every log line: no authorisation code, signature, card holder, no `bin`, `last4`, `exp_month`, `exp_year` or `authorization` field, no customer email.
- **The page could not be opened:** Paystack down: 503, the order PLACED, the payment PENDING, the charge INITIATED with no page; the replay opens it under the same reference. Timed out after Paystack opened it: 503, the replay 503 (a duplicate), one reference only; the hold cancels the order at 16 minutes, the payment is still PENDING inside the grace, FAILED at 46 minutes, nothing posted. A page on another host: 503, never handed out or stored.
- **Webhook before the answer:** the order is confirmed and the payment cleared once; the answer shows `CLEARED` with no page, and the page is not stored.
- **Declined, then a second card:** the sweep waits; the second card clears once and confirms the order.
- **Timeout after the charge (no webhook):** the sweep's lookup clears once (`PROVIDER_LOOKUP`).
- **Amount mismatch:** a webhook amount differing from Paystack's record is `REJECTED_AMOUNT`, nothing changed; Paystack confirming 5,999 of 6,000, or 6,000 in USD, holds the payment PENDING with `PROVIDER_AMOUNT_DIFFERS`.
- **Unknown reference:** logged `IGNORED_UNKNOWN_REFERENCE` with a `PROVIDER_REFERENCE_UNKNOWN` break, nothing posted.
- **Late webhook:** paid after the hold cancelled the order: cleared as an unmatched deposit with `UNMATCHED_PAYMENT`, the order stays CANCELLED; trial balance 0.
- **Paid after failure:** FAILED at 46 minutes, then paid: the payment stays FAILED, one `PROVIDER_PAID_AFTER_FAILURE` break, URGENT, abuse case 45 on its event, nothing posted; delivered again, nothing more.
- **Forged webhook:** 401; the stored row keeps `payload` `{}` and no reference.
- **Chargeback:** a dispute Paystack confirms raises one `PROVIDER_DISPUTE_OPENED` break, URGENT, abuse case 45; delivered again `REPLAYED`; the bin and last four Paystack sends are not kept; a dispute whose payload amount differs from the lookup is `REJECTED_AMOUNT`, no break.
- **Refund:** the unmatched card deposit refunded to the card through Paystack, approved by another person with step-up; the first answer is lost (timeout), the retry finds it by its note: one refund at Paystack against the original transaction, `ref <refund id>`; PAID; Dr 2200 6,000, Cr 1120 Paystack 6,000, once; trial balance 0.
- **The database's rules, by direct SQL as `hk_app`:** a page changed or cleared once written (HK004), written at insert (HK004), a network on a card (23514), another host or plain http (23514), a page on a mobile money charge (23514); a page written once on an open card charge passes.

**BL-107:** `pos/counter-sale` gains one test, seen red (the sale was taken), then green: `OFFLINE_PACK_PRICE` on an online counter sale within every limit is 422 `VARIANCE_REASON_INVALID`, nothing recorded.

## Mutations

Each applied alone, the card spec run, the source restored byte for byte (`cmp`).

| # | Mutation | Result |
| --- | --- | --- |
| M1 | a card judged by the mobile money rule | red: 4 of 26 |
| M2 | the page's address handed out unchecked | red: 1 of 26 |
| M3 | a card paid after failure not raised | red: 1 of 26 |
| M4 | a forged webhook's body kept as evidence (parsed before the signature) | red: 1 of 26 |

## The sandbox (`pnpm test:sandbox`, Paystack's test mode, the key the proxy injects; never in CI)

**17 of 17 passed** (12 earlier, 5 card cases). api.paystack.co answered; no 401 or 403. What test mode answered, each matched by the fake:
1. An initialised card page verifies **`abandoned` at once**, `gateway_response` `The transaction was not completed`, `channel` `card`, `amount` and `requested_amount` 5,500 for GH₵55.00, currency GHS. This is why a card waits on `abandoned` (A-287 (c)); judged as mobile money, a card would fail 30 seconds after its page opened.
2. The page is on `https://checkout.paystack.com/<access code>`.
3. A second initialise with the same reference is 400 `Duplicate Transaction Reference`, `code: duplicate_reference`: a lost answer's page cannot be fetched again (A-287 (d)).
4. A refund of the unpaid page is refused (400, not retryable).
5. `GET /dispute` answers a list (empty on the test account); an unknown dispute is 404 `Dispute not found`, `code: not_found`, read as `NOT_FOUND`.
6. **Not run:** a paid card, its refund, and a real dispute. A card is typed only into Paystack's own page and this suite never sends a card number, so a paid card needs a person: open the page the suite logs (`card page to pay by hand` in `PAYSTACK_SANDBOX_LOG`), pay it with one of Paystack's test cards, then run `PAYSTACK_SANDBOX_CARD_REFERENCE=<reference> pnpm test:sandbox` (two more cases: verify for exactly its amount in GHS with no card field read, and a part refund once per key). A dispute cannot be raised in test mode from here; B13's smoke run delivers a real webhook (A-218 (d)).

## Contract requests (the frontend's `main` at `66b1be7`, unchanged since the last report)

No request names a card. Every request is as the last report left it: CR-033 point 3 B11's; CR-059 to CR-062 RPT's, B12; CR-057 point 1 both lanes, still to schedule (lane B's B11 continued 2 opener carries the hand-in at a till); everything else answered in earlier phases.

## Security review (hakorem-security-review)

The same finding is in the pull request body.
- **Boundary:** TB1 the public storefront (placeOrder), TB5 the payment webhooks, the database.
- **Standards, item by item:**
  - **Identity, sessions, CSRF, CORS:** unchanged (placeOrder is public and keyed by the guest cookie, as before).
  - **Authorisation:** no new operation or permission. The placement authorises as before; `cardChargeIn` and `openCardPage` authorise nothing, like `chargeIn`; the webhook acts as its system principal.
  - **Input:** the request schema is unchanged and rejects unknown fields, so a card number is 400 (tested). The amount and currency come from the order; the return address from configuration.
  - **Money paths:** a card clears only from Paystack's own lookup for exactly the amount in GHS (`trg_payment_provider_confirmed` unchanged); no endpoint takes "paid"; the page is opened outside any transaction; a retry reuses the reference.
  - **Webhooks, in order:** signature over the raw bytes before parsing (fixed); window; once by event id; our reference; lookup; then clearing with its posting. A dispute follows the same order with its own lookup.
  - **Open redirect:** the page's address is checked against Paystack's checkout host, in code and by a database check.
  - **Data protection, logging:** no card data is received from a browser, stored, logged or published; Paystack's card fields are dropped before storage (tested by SQL and over the log lines).
  - **Rate limiting:** placeOrder keeps its `checkout` group, which fails closed.
  - **Database:** one column and two checks on a DOCUMENT table, one trigger, two enumeration values; grants unchanged.
  - **Secrets:** no key in the repository; the sandbox key is injected by the proxy; the fake's key and every card detail are made at runtime.
  - **Secure defaults:** a card payment is PENDING until Paystack confirms it.
- **Findings:**
  - [fixed] a refused webhook's body was parsed and its fields kept before the signature check: now checked first and nothing kept.
  - [accepted, recorded] a page whose answer was lost cannot be fetched again; it fails with its grace (A-287 (d)).
  - [accepted, recorded] a replayed webhook is logged, not reported (A-287 (g)).
  - [parked] the same paid-after-failure for mobile money (BL-108).
- **Abuse cases:**
  - New 45 (card money outside the order's flow: paid after failure, chargeback, forged events). `RECONCILIATION_BREAK` URGENT with abuse case 45; `WEBHOOK_REJECTED` for a forgery (abuse case 5). Tested in `card-payments`.
  - New 46 (a card refund sent elsewhere): Paystack refunds against the original transaction only, maker and checker, a payout by hand by someone else. `REFUND` and `REFUND_FAILED`. Tested in `card-payments` and `refunds`.
- **Not applicable, with reason:** no upload, export, login or new permission.

## Deferred

- BL-108, BL-109 (above).
- A paid card, its refund and a real dispute against the sandbox: a person pays a page by hand (above); a real webhook in B13.
- ORD's `price-overrides.ts` (lane B's) still takes an approval request naming `OFFLINE_PACK_PRICE`; the sale it approves is refused at posting (BL-107 as built).
- BL-100 to BL-106, BL-082 and BL-087 to BL-089 stand.

## Tests

On this machine, after the code commits (no rebase was needed: main had not moved from `241ce5d`).

| Layer | Result |
| --- | --- |
| Unit | 164 files, 1,927 tests passed, coverage gates met (`pay/domain` 100 percent, `card.ts` among it). |
| Integration | **Full suite, once, at `c989070`** (every code, contract and docs commit): 172 files, 2,093 tests, **1 failed**: `bil/archive-link-rollback`'s fixed list of the migrations it rolls back, stale since 0311 is the newest. A stale expectation, not a flake: fixed in its own `test(bil)` commit, after which that spec passes (and proves 0311's `migrate:down`). Nothing was re-run to turn red green. The new and changed specs: card payments 26, counter sale 13, online orders and the PAY folder (185 with them, all passed). |
| Contract | 55 files, 138 tests passed; `contract:generate` up to date; Redocly clean; the versioning script against main's 2.29.0: ok. |
| Sandbox | 17 of 17 passed (above). |
| Lint (boundaries, fixtures, placement, schema names), typecheck | Clean. |
| End to end, setup, the image, the scans, coverage | Run in CI (below). |

## Notes for the frontend track

- **2.30.0:** offer card at checkout on PREPAID terms. `placeOrder` with `{ "paymentMethod": "CARD" }` answers 201 with `payment.redirectUrl` on `https://checkout.paystack.com/`: send the browser there (a full navigation, not an iframe). Paystack returns the customer to the shop's return page; then poll `trackOrder` (or the order) until CONFIRMED, exactly as after a mobile money prompt. Never collect a card number, expiry or CVV in the shop: the API refuses them.
- A 503 on placement by card means the order is placed but the page did not open: retry the same request with the same `Idempotency-Key`.
- A declined card can be retried on the same Paystack page while the order waits (15 minutes, the checkout's hold).
- The exception queue may now show `PROVIDER_PAID_AFTER_FAILURE` and `PROVIDER_DISPUTE_OPENED`.

## CI

- **Merge slot:** taken at 15:56Z. `main` was still `241ce5d` (lane B idle), so there was nothing to rebase: migration 0311 sits above main's 0310 and the contract's 2.30.0 above main's 2.29.0 (the versioning script against main's contract: ok). The branch was pushed plainly, with no force.
- **Pull request #128.**
  - **`56dbad2`** (every code, contract and docs commit; the head before this report):
    - push run 45210918605: **success**;
    - pull_request run 45210992294: **success**.
  - In the pull_request run every job passed: lint and type check; contract; the setup script; the image build and scan; the secret scan, dependency audit and static analysis; unit and integration shards 1, 2 and 3 of 3; and the merged coverage gate. Nothing was re-run.
  - **The final head** carries this report. Its runs (push and pull_request) are named in the closing message to the parent session. The pull request merges only when every one is green.

## Next session

B11 continued 2 (lane B), the next phase in order: lane A's phases end with B09c. Copied from `docs/prompts/session-openers.md` on `main` (unchanged by this phase).

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B10c6-margin-staff-acceptance-storekeeper.md),
and the "Deferred" section of docs/sessions/B11b-dispatch-delivery.md (B11 continued, which this phase continues).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the ORD (fulfilment), DEL and NTF requirement blocks of docs/SRS.md (nothing else
from the SRS), docs/data-model/ord.md, del.md and ntf.md, the ORD, DEL, NTF and PAY cards in
docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0021, ADR-0026 (the abandoned-cart assignment), ADR-0074 (a link
sent by message gets its own token from the sending worker, never one stored in the outbox), ADR-0075 (the egg cost
rule's running-total rounding), ADR-0077 (cash through a till only through its open shift), ADR-0091 and ADR-0092 (dispatch
loads the vehicle; the driver's cash is a payment held by the driver), and the abuse cases 6, 43 and 44 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 2 only, on branch b11c-driver-run-returns-notifications. B11 built picking and packing (2.25.0,
A-332 to A-336); B11 continued built dispatch of a whole delivery order (the document on the weighed quantity, the
deposits allocated, a lighter total refunded, the cash due fixed, the goods onto the vehicle), the delivery, the driver's
own reads and the proof with the cash collected held by the driver on 1020 (2.27.0, A-337 to A-341, ADR-0092): build on
them, never again. The rest, in this order:
1. The driver's run and cash. Routes (createRoute, getRoute, listRoutes, reorderRouteStops, startRoute, getMyRoute; CR-057
   point 2, what a driver with no run gets), the drivers' list for dispatch (CR-056 item 4) and `del.route.*` for the
   Manager and the Owner; assignDelivery and reassignment, audited (FR-DEL-004); markOnTheWay; recordFailedDelivery,
   returnDeliveryToStock (from the vehicle to the returns hold, with the credit note and refund as applicable),
   rescheduleDelivery and cancelDelivery; delivery slot booking against capacity under a row lock, zone cut-offs and
   rescheduling (FR-DEL-001 to FR-DEL-003; the slot table and generation exist from B7, ADR-0026); CR-055, a part
   delivery (`ProofOfDeliveryCreate.lines` and `returnedReasonCode`: the rest back to stock or kept for a reattempt,
   the document credited for what came back, the cash due fixed again); the driver's offline sync (syncDriverEvents,
   idempotent by client id, CR-057 point 3: a DUPLICATE answers the first outcome); the driver's cash summary and the
   driver cash reconciliation by someone else (FR-DEL-010, 6900 for a variance, `DRIVER_VARIANCE` for B12); CR-057, the
   hand-in at a till shift: the parent session gives leave for one additive POS operation and its tests, which takes
   the cash only through the existing deciding function (tillTakesCash, ADR-0077 with the owner's late-entry amendment)
   onto the receiving cashier's own open shift, never a second cash path, each collection (a `pay.payment` held by the
   driver) handed in exactly once, its cash counted at that shift's close (A-212 (a)); test it with exact pesewas,
   including a short hand-in. Lane A's payInvoiceAtTill (#124, A-285 (g)) is the nearest pattern: reuse its shift check,
   never copy it. PAY's `Payment.driver` (BL-096). Partial fulfilment and backorders (FR-ORD-012) with the delivery fee
   once, on the first dispatch, never again (UAT scenario 2's rule, A-331 (b), steps 2.12 and 2.13, test with exact
   pesewas); an order on account dispatched with its due date from the customer's terms (WHL, through a port: ORD sits
   below WHL; A-338 (a)); collectFulfilment (a collection order handed over and paid at the till); the checkout's
   store-credit choice for a lighter total (ADR-0021, A-338 (c)); a delivered order completed once later settled
   (BL-097); cracked eggs written off on the pick (CR-054 point 1, through INV's adjustment path and its approval).
2. Returns of eggs (owner, 2026-11-18, ORD, test-first with exact pesewas): a return is refunded at the price actually
   paid on that sale line, never the current price list. Part of a crate returned as single eggs (five cracked eggs) is
   refunded pro rata at the crate's price per egg, never at the single-egg price, with the running-total rounding of the
   egg cost rule (ADR-0075, half-up, never half-to-even): each return's refund is round(paid x cumulative returned / per
   crate) less round(paid x previously returned / per crate), so the pieces always add up. Tests by SQL: a GH₵55.00 crate
   (5,500 pesewas) with five eggs returned refunds exactly 917 (5,500 x 5 / 30 = 916.67, half-up); a crate returned one
   egg at a time, all 30, refunds exactly 5,500 in total, never more; a mutation using the single-egg price, or rounding
   each egg on its own, turns a test red. Lane A's B09b continued 2 adds to createReturn's description that a line is
   returned in its sold unit; extend it to a part of a crate returned as single eggs.
3. Notifications (NTF): through the outbox (SMS, WhatsApp, email, in-app) with templates, triggers, preferences, opt-out,
   quiet hours, the message log and retry: the customer's messages from `ord.OrderDispatched` (one, with the weights and
   the final total, FR-ORD-011), the on-the-way and delivered messages (FR-DEL-012, once per event and recipient),
   abandoned-cart messaging (ADR-0026), the death report sent back by the malware scan (B06r, A-175: liv.MortalityReturned
   names the reporter and the reason), the document sends (ADR-0062, A-204: sendBillingDocument and sendStatement, 202
   through the outbox, a bil.reprint_log row with the channel, the archived bytes or a lasting link, never a new
   document; the remittance advice from pur.SupplierRemittanceReady, once per payment; a send reaches only the document's
   own customer or supplier and a failed send is retried without a second archive row), CR-033 point 3 (the receipt SMS
   once when a counter sale with customerPhone syncs, with a fresh server-made token for a sale whose till token was
   refused, ADR-0074; the refused till token still opens nothing), and the guest's SMS tracking link with its own long
   random token (a guessed token or the order's id answers 404). CR-039 at the shop (the crate and the single egg, each
   at its own price; CartLineAdd.uom; test-first with exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference. CR-056's Storekeeper order read was built in B10 continued 6 (A-335 decided, the owner
2026-11-23): its own narrower read, never `ord.order.read`.
The owner, 2026-11-23 (decisions 1 and 2, on A-337 and A-338):
- A-337 is approved, plus: a run cannot be closed while goods remain on the van. Every item is delivered, returned to
  stock or written off with a reason, and anything unaccounted for goes on the driver variance report. Test the refusal
  to close a run with goods still on the van, each of the three ways out, and the variance line.
- A-338: a guest's order gets a receipt: approved. Dispatch on credit terms is NOT deferred past launch: wholesale
  credit buyers are the main delivery customers. Build it here: the credit check runs at dispatch (WHL's credit control
  through a port, ORD sitting below WHL), and the invoice is issued from the quantities actually dispatched, with its
  due date from the customer's terms; remove `CREDIT_DISPATCH_NOT_AVAILABLE` LOUD.
The owner, 2026-11-23 (from the frontend's F12 and F10n, with notifications): list the message templates so a reminder
level picks one instead of typing a code, and record each reminder's delivery per channel (sent, delivered, failed), so
a failed reminder shows as failed.
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c-driver-run-returns-notifications.md.
```
