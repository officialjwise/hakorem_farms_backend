# B09a continued 2: the real Paystack sandbox run and CR-029

Date: 2026-11-16 · Branch `b09a3-orders-online`, from `main` (`7fd257d`) · Status: **gate passed for the part built; the phase split (A-219)** before the order endpoints. The remainder is **B09a continued 2b** (`b09a3b-orders-online`), inserted in `docs/prompts/session-openers.md` after B09t2 and before B09x.

Main was merged in twice: for B09t (`56d1bab`, the application clock, ADR-0067; its A-217 took the number this phase had used, so this phase's assumptions are **A-218** and **A-219**, and the two pushed code commits' messages still say A-217) and for the B09t2 schedule (`42c5976`). This phase adds no `now()` or fixed calendar date to business SQL, the seed or a test (ADR-0067's two rules); the one test SQL that set a timestamp takes the test clock.

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-16)

| ID | What | Who confirms |
| --- | --- | --- |
| A-218 | **The real Paystack sandbox run and what it changed.** (a) `pnpm test:sandbox` runs the real adapter against Paystack's test mode, never in CI; the key is injected by the network proxy and never seen; the first test refuses to go on unless Paystack answers from `domain: test`. (b) Eight differences, each fixed in the fake and, where it mattered, in the adapter; the serious one: **Paystack ignores `Idempotency-Key` on a refund**, so the adapter now carries the key in `merchant_note` and looks it up on the transaction's refunds before sending. A payer email on a reserved domain is refused at boot (only `.example` was observed refused; `.test`, `.invalid` and `.localhost` are refused too, as undeliverable). (c) The Settlements API returned an empty list on the test account; its shape is recorded; B09r reads a real one. (d) No webhook can reach this machine. | Owner (a, b), Accountant (c) |
| A-219 | **B09a continued 2 split after the sandbox run and CR-029.** Everything from ORD's permissions onward is B09a continued 2b, a separate sub-domain (orders), after B09t2 and before B09x. | Owner |
| A-064 | Status updated: run in this session (A-218). Card pre-authorisation and capture were not exercised (no caller uses them yet). | Owner |

Still open, proceeded on as stated: A-033, A-034, A-062, A-182 to A-207, A-209, A-211, A-213, A-214, A-216, A-218, A-219.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B09a continued 2 (`b09a3-orders-online`, from `main` at `7fd257d`).
2. **Scope:** first the real Paystack sandbox run (every edge case the fake proved, mobile money included, the Settlements API, every difference fixed in the fake and the adapter test-first); then the order endpoints, returns, voids, online placement, the dashboard's sales figures, the seed and CR-029.
3. **Gate:** as the opener states it. Because the whole phase could not reach its gate in one context, the session split at the payments and orders boundary (A-219) once the sandbox run and CR-029 were proved; the gate below is the one for the part built.

## Contract changes

**1.46.0, minor, additive; no existing shape changed, nothing a client sends made required.** `Cart` gains `checkoutId` (uuid or null, always sent), CR-029. Every cart example and `reorderMyOrder`'s carries `checkoutId: null`. No operation moves into code (402 from code, 233 planned). `contract:generate` is up to date and Redocly is clean, with no warnings. `docs/CONTRACT_CHANGELOG.md` and `docs/API.md` (SHP) record it. The sandbox run changed no shape.

## Built

| Area | What |
| --- | --- |
| Sandbox suite | `test/sandbox/paystack.sandbox.spec.ts`, 12 tests. It runs through the Vitest project `sandbox`, which exists only with `PAYSTACK_SANDBOX=1`. `pnpm test:sandbox` sets that and `NODE_USE_ENV_PROXY=1`, so CI and every other command neither run nor skip it. Raw answers go to `PAYSTACK_SANDBOX_LOG`, outside the repository, with key-like strings removed. The test placement check knows the new layer, and TEST_STRATEGY sections 3.6, 4 and 5 document it. |
| PAY adapter | `PaystackPaymentProvider.refund` is idempotent by itself. It writes the key as `merchant_note: ref <key>`. Before every `POST /refund` it verifies the transaction and reads `GET /refund?transaction=<numeric id>`, at most 5 pages of 100. A refund carrying that note is answered as the refund already made. |
| Configuration | `PAYSTACK_PAYER_EMAIL` on a reserved domain is refused at boot (OPERATIONS section 3 says so). |
| Fake | `test/support/fake-paystack.ts` now behaves as the sandbox did. It refuses a `.example` email. The MTN test number (local or E.164) pays at once; other numbers stay `pay_offline`. A duplicate reference returns its `code`. The list is newest first, and an empty one has `pageCount` 0. The `Idempotency-Key` on a refund is ignored, as Paystack ignores it. `GET /refund?transaction=` is answered. A refund beyond what is left, or of an unpaid transaction, is refused. A `timeout` behaviour creates the refund and then answers late. The tests' payer email is `payments@example.com`. |
| SHP | CR-029: `CartView.checkoutId` comes from `ShpStore.openCheckoutOf`, the one live checkout of the cart (`uq_checkout_session_live`). It is filled only while the cart's status is `CHECKOUT`. |
| Docs | A-218, A-219, and A-064's status. ADR-0026 Amendments. ADR-0063 gains a verification note: the refund's idempotency key is honoured by the adapter's note lookup; the decision itself stands. TEST_STRATEGY sections 3.6, 4, 5 and 10.7. OPERATIONS (the payer email). API.md (SHP). CONTRACT_CHANGELOG. The openers: B09a continued 2 is marked split, and B09a continued 2b is inserted before B09x. B09x now reads B09a continued 2b's report. |

## The sandbox run: what Paystack actually answered

All of these were run on 2026-11-16 with the owner's test key, through the real adapter (and raw `fetch` where the adapter reads less). Every transaction answered `domain: "test"`. All 12 tests passed on the final run.

| Edge case | What Paystack returned | Against the documentation and the fake |
| --- | --- | --- |
| Initialise (`POST /transaction/initialize`) | 200, `authorization_url` on `checkout.paystack.com`, `access_code`. An unpaid one verifies as `status: abandoned`, `paid_at: null`, `gateway_response: "The transaction was not completed"`, `channel: card` | The fake has no initialise; no caller uses it yet. The adapter reads it correctly (`ABANDONED`). |
| Payer email `payments@farm.example` | 400 `Invalid Email Address Passed`, on initialise and on `/charge` | **Not documented; the fake accepted it.** The config now refuses reserved domains at boot, and the fake refuses `.example`. `payments@example.com` is accepted. |
| Mobile money charge, MTN test number `0551234987` | 200, `message: "Charge attempted"`, `data` is the whole transaction: `status: success`, `paid_at` set, `gateway_response: Approved`, `fees: 488` on 25,000, `authorization.mobile_money_number` | **The documentation describes `pay_offline` while the customer approves; test mode pays at once. The fake always answered `pay_offline`.** The fake now pays the test number at once. Our flow still records the charge PENDING and clears it only by the lookup: a new integration test proves this. |
| The same number as `+233551234987` (E.164, as the counter sends it) | Paid at once; the stored number is `0551234987` | Paystack normalises E.164 numbers; the fake now does the same. |
| A retry with a reference already used | 400 `Duplicate Transaction Reference`, `code: duplicate_reference`, `type: validation_error`, `meta.nextStep` | Matches the adapter's reading (PENDING, never a second charge). One transaction holds the reference. |
| A timeout (a 1 ms adapter) then a retry with the same reference | The first call never reached Paystack (`UNAVAILABLE`, retryable); the retry was paid once (`SUCCESS`), with one transaction | As designed. The "answer lost after the charge" case is the duplicate case above. |
| Verify an unknown reference | 400 `Transaction reference not found.` | Read as `NOT_FOUND`. The fake now uses the same message, with its full stop. |
| The transaction list the sweep reads (`GET /transaction?from&to&page&perPage`) | Newest first; `meta: { total, total_volume, skipped, perPage, page, pageCount }`; an empty list has `pageCount: 0`. Every row carries `fees` | **The fake listed oldest first, with `pageCount` at least 1.** The fake now matches. The adapter's `hasMore` was already right for both orders. |
| Refund, partial, with `Idempotency-Key` | 200 `Refund has been queued for processing`, `status: pending`. **The same key twice made two refunds** (two ids, each 5,000) | **The fake de-duplicated on the key, so this was hidden.** On a timeout, the retry would have refunded twice. Fixed in the adapter (the note lookup), proved red and then green. Against the sandbox, the same key twice now returns one refund id, and the transaction lists exactly one refund carrying the note. |
| Read a refund (`GET /refund/:id`) | `status: pending`, `amount`, `deducted_amount`, `merchant_note`, `transaction` (numeric), `transaction_reference`, `refund_type: Partial`, `refund_channel: "Original Payment"`, `refunded_at: null`, `retriable: false` | The adapter reads `pending` correctly. No sandbox refund reached `processed` during the run. |
| List a transaction's refunds | `GET /refund?transaction=<reference>` answers an **empty list**; `GET /refund?transaction=<numeric id>` lists them | The adapter uses the numeric id from verify. |
| A refund beyond what is left | 400 `Total refund amount cannot exceed original transaction amount` | Refused, not retryable. The fake now caps the same way. |
| A refund of an unpaid (abandoned) transaction | 400 `This transaction failed` | Refused, not retryable. |
| Settlements: `GET /settlement?perPage=5&page=1` | 200 `Settlements retrieved`, `data: []`, `meta: { total: 0, skipped: 0, perPage: 5, page: 1, pageCount: 0 }` | **The test account holds no settlement.** Whether the API covers what the matching needs (our reference, amount, fee, settlement date and id, bank payout) cannot be judged from an empty answer. Paystack documents `id`, `status`, `total_amount`, `effective_amount`, `total_fees`, `settlement_date` and `createdAt`, none of them seen here. B09r reads one real settlement. |
| `GET /settlement/1/transactions` | 404 `Settlement not found`, `code: not_found` | This is the shape of an unknown settlement. |
| Webhooks | Not received: no webhook can reach this container. | The signature scheme (HMAC-SHA512 of the raw body with the secret key) is checked against the documentation only. The key is never in this process, so a captured payload could not have been verified here either. B13's smoke suite delivers a real one. The webhook-ordered edge cases (webhook before the API answer, twice, for a missing order, late, forged, stale) stay proved against the fake. |

A note for B09r: `fees` (pesewas) is on every verify and list row. `pay.provider_transaction.fee_pesewas` exists but the adapter does not read it yet. It could give the settlement matching its fee per transaction.

Nothing secret was written anywhere. The log of raw answers stayed in the session's scratch folder. The run created only test-mode transactions (12,345, 25,000, 15,000 and 1,000 pesewas) and partial refunds against them.

## The gate, proved by running it

- **The sandbox run:** `pnpm test:sandbox`, 12 of 12 passed against Paystack's test mode on the final run, after the adapter's refund fix. Every difference is listed above and fixed in the fake. Where it mattered, it is fixed in the adapter, test-first.
- **The double refund, test-first:** `test/integration/pay/refunds.integration.spec.ts` › *finds a part refund Paystack made while its answer timed out by the note it carries, and never sends it twice*. Against the corrected fake, before the adapter fix, it was **red**: two refunds of 3,000 at Paystack for one refund. With the fix it is green: one refund, `PROCESSING` with that refund's id, one `POST /refund`, then `PAID` posting **Dr 2200 3,000 Tema, Cr 1120 3,000 Paystack** once. The fix was then disabled on purpose: red again with two refunds. Restored: green.
- **The payer email, test-first:** `app-config.spec.ts` › *refuses a payer mailbox on a reserved domain at boot* ran red and then green.
- **The immediate success:** `payment-edge-cases.integration.spec.ts` › *a charge Paystack answers paid at once … stays PENDING until a lookup confirms its amount, and clears once*. The charge is `PENDING` with provider status `SUCCESS`, and nothing is posted. The sweep clears it by lookup, and a second sweep posts nothing more (one `pay.PaymentCleared`). This was green on its first run: the application was already conservative.
- **CR-029, test-first:** `storefront-checkout.integration.spec.ts`, three new tests, all three red and then green:
  - `checkoutId` is null on an active cart.
  - At checkout it is each cart's own checkout, two carts at once never naming each other's, and `getCheckout` opens it from the cart; another guest gets 404.
  - It is null after a completion (`COMPLETED` and `CONVERTED`, set directly by SQL until `placeOrder` exists; B09a continued 2b proves it through `placeOrder`) and after an abandoned cart.
  - It is null again after the 15-minute expiry gives the cart back.
  - The B7 contract spec checks the cart at checkout against the schema.
- **Kept green:** every `pay` integration spec (5 files, 87 tests, with the fake's new behaviour), the SHP specs and the B7 and B9 contract specs.

## Decisions

- No new ADR. The refund's idempotency key (ADR-0063) is unchanged as a decision. It is now honoured by the adapter's note lookup, because Paystack ignores the header (an ADR-0063 verification note). No ADR is contradicted, so nothing stopped the session.
- The split (A-219, ADR-0026 Amendments): the sandbox run is the payments sub-domain; everything else in the opener is orders. B09a continued 2b takes all of it unchanged, except CR-029, which is built. It also proves `checkoutId` null after `placeOrder` completes a checkout.

## Deferred

- To B09a continued 2b: ORD's permissions and grants; the order endpoints with voids and cancellation; returns; price override approvals; `issueProforma`; online placement and payment; the dashboard's sales figures and the two tiles; the seeded trading day; CR-029's completion through `placeOrder`.
- To B09r: one real settlement read from the Settlements API, and reading `fees` into `fee_pesewas`.
- To B13: a real webhook delivered to the deployed endpoint (already in its opener).

## Contract requests

I fetched the frontend's `main` on 2026-11-16 at `382a820`. It lists CR-001 to CR-033; one is new since the last report (CR-033).
- **CR-029 (`Cart.checkoutId`): implemented** in 1.46.0, as the owner placed it.
- **CR-033 (a digital receipt opened from a link, a public read by an unguessable token, made on the till offline, and the SMS sent once on sync): not built here; named for the parent to schedule.** It is larger than additive examples. It needs a new anonymous endpoint, a token design that works offline (the sale's client UUIDv7, or a signed token), its abuse review (enumeration, rate limit, the data a public page may show) and an SMS on sync through NTF. It belongs with B9b's sync, with NTF's send in B11 if the SMS cannot wait. This is not a decline on merit.
- CR-013 (the dashboard's sales figures) moves with the remainder to B09a continued 2b. CR-031 and CR-032 stay with B9b. CR-005, CR-023, CR-027 and CR-028 stay with B09x. The others were answered in earlier phases.

## Tests (this machine, 2026-11-16)

| Layer | Result |
| --- | --- |
| Unit | **1,398 passed** (new: the payer email rule in `platform/config/app-config.spec.ts`) |
| Integration | **1,361 passed** before main was merged in, **1,369** after (new: 1 in `pay/refunds`, 1 in `pay/payment-edge-cases`, 3 in `shp/storefront-checkout`; `platform/adapters`'s refund test rewritten) |
| Coverage, merged (`pnpm test:coverage`) | **2,759 passed** before main was merged in; **2,767 passed** after (B09t's tests added), 222 files, exit 0 both times. Statements 93.56 percent, branches 83.32 percent (gate 80). Every 100 percent gate held, including `src/modules/pay/domain/**` and `src/modules/shp/domain/**` |
| Contract | **95 passed** (the B7 storefront spec now also checks a cart at checkout). `contract:generate` is up to date (402 from code, 233 planned); Redocly is clean, with no warnings |
| Sandbox (`pnpm test:sandbox`, on demand, against Paystack's test mode) | **12 passed** on the final run |
| Lint, typecheck | Clean. Locally, eslint was run with `.claude/**` ignored, and the test placement check reported problems only inside the parent session's worktree under `.claude/worktrees/`; CI has no such folder |
| End to end | CI only |

**A red run, recorded:** the first full run (`pnpm test:coverage`) had one failure, `platform/adapters.integration.spec.ts` › *sends a refund with the idempotency key, so a retried refund cannot pay twice*. That test scripted one answer for one `POST /refund`, and its premise (the header alone prevents a double refund) is what the sandbox disproved. It was rewritten to assert the verify, the refund list and a single POST carrying the note, and that a retry sends nothing more (its own commit). The second full run was green. It was a stale test, not a flaky one, and nothing was re-run to turn it green.

**Test first, as it honestly happened:**
- The adapter's refund fix was red first, for the right reason: two refunds. Its first draft of the test failed on its own expectation, a full refund that Paystack's cap (now in the fake) refused on the second send. That is also a real wrong outcome, the refund marked failed while the money was refunded. The test was changed to a part refund, which shows the double payment.
- The config rule and CR-029 were red first.
- The immediate-success test was green at once.
- Tests changed on purpose because this phase made them stale:
  - `refunds.integration.spec.ts` counts only `POST /refund` calls, because the adapter now also reads `GET /refund`.
  - `app-config.spec.ts`'s payer email is now `payments@example.com`.
  - `schema-names.spec.ts` lists the new layer suffix.
- No flaky test was seen. Nothing was skipped, loosened or retried, and no database rule was weakened.

## Gate

**Passed for the part built; the phase split (A-219).**
- Every provider-side edge case the fake proved ran against Paystack's real test mode, mobile money included: initialise, charge, verify, the sweep's list, refunds, and a timeout retry reusing our reference.
- Every difference from the documentation and from the fake is reported above and fixed in the fake. The one that could pay a refund twice is fixed in the adapter, test-first.
- The Settlements API's answer is recorded: empty on the test account.
- Webhooks cannot reach this machine, and the report says so.
- CR-029 is built and proved.
- The rest of the opener's gate (orders, voids, returns, dashboard) is B09a continued 2b's.

## Notes for the frontend track

- Contract 1.46.0: a cart at checkout carries `checkoutId`. A second tab or device opens that checkout with `getCheckout` instead of waiting for the hold to lapse. It is null in every other status.
- CR-033 is named for scheduling (above).

## CI

- **`59c3bee`** (the code and documents, before main was merged in; the pull request #70 was opened on it): run **43968562894 (push)**, completed, success. No `pull_request` run was listed for that commit.
- **`7f76715`** (main merged in twice, for B09t and the B09t2 schedule): run **43970614101 (push)**, completed, success; run **43970625882 (pull_request**, which also compares the contract with `main`), completed, success.
- A commit cannot name its own runs, so the push and pull_request runs on the final head (this report's commit) are named in the session's closing message. The pull request is merged with a merge commit only once every run on its head is green. No run on this branch was red, and nothing was re-run.

## Next session

B09t2, copied from `docs/prompts/session-openers.md`. The parent session inserted it right after this phase, urgent before 2026-12-01. B09a continued 2b (the orders remainder of this phase) follows it, then B09x.

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report, then docs/sessions/B09t-clock-sweep.md (its findings and
"still failing" list), ADR-0067 and A-217. Load hakorem-seed, hakorem-tests and hakorem-migration.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B09t2 only, on branch b09t2-dates-from-clock, branched from main:
1. The seeded egg lot EGG-BIG-2026-1110 expires on 2026-12-01 (src/seed/farm-inv.ts:78), so sale-posting,
   storefront-checkout and order-payment-rules fail from 2026-12-02. Make every seeded expiry, best-before, due and
   valid-from/to date relative to the seed's clock, keeping each test's exact amounts; search the whole seed and test
   support for other fixed dates and fix them the same way.
2. fin/financial-statements "reads a locked period with lines from its balances" pins November 2026: build its period
   from the test clock so it holds in any month.
3. src/modules/pay/application/refunds.ts:222 compares a payout date with the refund's database-defaulted created_at:
   write the refund's created_at from the application clock (or compare against an application-written instant),
   test-first with a ManualClock across midnight.
4. file-store's signed links fail under a forced clock because the object store container checks them against its own
   clock: record it in the report as a container artifact, not a defect.
Prove each fix with the forced-clock sweep (the scratch method of B09t: shift each test file's clock; never commit it)
failing before and passing after.
Stop at the gate, write docs/sessions/B09t2-dates-from-clock.md, and merge into main when every run on the pull
request is green.
```
