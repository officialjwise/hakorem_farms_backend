# B11 continued 10: notifications, first pass (lane B), split before preferences, the document sends and the reminders

Date: 2026-11-24 · Branch `b11c10-notifications`, from `main` at `f7e961d` (#137, B11 continued 9) · Status: **phase split (A-375) at a sub-domain boundary of NTF: the module with templates, the message log, the provider's delivery reports, the sender and the customer's messages built to their own gate, passed locally; CI below. Preferences, opt-outs, quiet hours, triggers, in-app notifications, the document sends, the receipt and tracking SMS, the reminders, CR-039, the reused-photograph match and the UAT dry runs are B11 continued 11.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-374 | **NTF's first pass** (ADR-0096). (a) Two steps: an outbox consumer queues one message per event, template, channel and order (`uq_message_idempotency`); the worker's `message-send` job claims due messages under a lease, calls the provider outside any transaction with the message id as its idempotency key, records the attempt only while its claim holds; three attempts with backoff, then `FAILED`; a manager's retry. (b) **No address is stored** (`address_enc` not built): the number is the order's own contact (else its delivery's recipient), read through ORD when queued and again when sent, never from an event; the log keeps it masked (`+23324*****56`) and an HMAC of it for the hourly limit (ten; the rest `SUPPRESSED` `RATE_LIMITED`); no number gives `SUPPRESSED` `NO_ADDRESS`. (c) Templates: a code NTF sends, its own category, only its merge fields, no link typed in; drafted by one person and activated by another (database-held); the Owner and the Manager draft and activate, the Accountant and Sales read. (d) Only SMS, through the `generic-http` adapter; delivery reports at `receiveMessagingWebhook` as `GENERIC_HTTP` (added to the enum), HMAC-SHA256 under `SMS_WEBHOOK_SECRET` (optional: without it every report is 401; B13 supplies it); the other providers 404; a STOP reply logged `IGNORED` until B11 continued 11. (e) Seven customer templates seeded active in English; delivery-day messages are exempt from quiet hours. (f) Exactly once past a worker's death rests on the provider honouring the idempotency key; B13 confirms. | Owner |
| A-375 | **The split.** The NTF module with templates, the message log, delivery reports, the sender and the customer's messages built to their own gate; stopped before preferences, opt-outs, quiet hours, triggers, in-app notifications, the document sends, the remittance advice, abandoned carts, the returned death report, the receipt and tracking SMS, the reminder templates, CR-039, the reused-photograph match and the UAT dry runs. **B11 continued 11** (`b11c11-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order, B12's reused-photograph line). | Parent session |

**For the parent session to schedule:** B11 continued 11 (its opener carries the rest of NTF in three sub-domains and how to split it), then the UAT scenario 2 corrections phase the parent inserts, then B12. **CR-039** (SHP's crate and single egg at the shop) is in B11 continued 11, as the opener ordered for this phase; it is not declined.

**No ADR conflict, and no stop.** ADR-0010 applied as written (NTF is an asynchronous outbox consumer; no outside call inside a business transaction). ADR-0074: no message in this pass carries a link; the opener for B11 continued 11 binds the tracking and receipt SMS to it. The one divergence from a document is `docs/data-model/ntf.md`'s `address_enc`, not built on the parent's rule that the contact is read at send time through the owning module (ADR-0096 records it, the dictionary is updated). **Shared modules, additive only:** ORD gains `Orders.messageContactsIn` (a new read; no existing function changed); `src/platform/config` gains the optional `SMS_WEBHOOK_SECRET`; IAM gains seed rows only (four permissions, their grants, the messaging webhook's SYSTEM principal), as every module's permissions are seeded. No change to POS, PAY, INV, BIL, DEL or FIN.

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 10, lane B (`b11c10-notifications`, from `main` f7e961d).
2. **Scope:** the opener's notifications (a new module) with CR-039, CR-033 point 3, the reused-photograph match and the UAT dry runs, splitting at the opener's sub-domain boundary when the context will not reach the next gate.
3. **Gate (this part):** the outbox's customer messages (dispatch, on the way, delivered, rescheduled, cancelled, part delivered, collected) are sent, each once, only to the order's own contact; a failed message shows as failed. **Passed** (below). The receipt and tracking SMS and a failed reminder are B11 continued 11's gate.

## Contract changes

**2.39.0, minor, additive** (on top of 2.38.0; Redocly clean, no warnings; `contract:generate`: 557 operations from code, 108 planned).
- **Into code, with their planned shapes:** `listNotificationTemplates`, `getNotificationTemplate`, `createNotificationTemplate`, `activateNotificationTemplate`, `previewNotificationTemplate`, `listNotificationMessages`, `getNotificationMessage`, `retryNotificationMessage`, `receiveMessagingWebhook`; each fragment carries its `x-error-codes` and its rules.
- **New refusals:** `TEMPLATE_INVALID` (`UNKNOWN_TEMPLATE_CODE`, `CATEGORY_MISMATCH`, `UNKNOWN_MERGE_FIELD`, `LINK_NOT_ALLOWED`, `SUBJECT_EMAIL_ONLY`, `SUBJECT_REQUIRED`, `EMPTY_BODY`, `TOO_LONG`), `TEMPLATE_NOT_ACTIVATABLE` (`OWN_DRAFT`, `NOT_DRAFT`), `MESSAGE_NOT_RETRYABLE` (`NOT_FAILED`, `SUPPRESSED`).
- **`receiveMessagingWebhook`:** `provider` gains `GENERIC_HTTP`, the only one served; its example is a delivery report.
- **New permissions:** `ntf.template.read`, `ntf.template.manage`, `ntf.message.read`, `ntf.message.retry` (the seeded role matrix shows them).
- No existing field removed, retyped or made required. Seven NTF operations stay planned.

## Built

| Item | What |
| --- | --- |
| NTF domain (100 percent gate, new) | `templates.ts`: the codes NTF sends with their merge fields and samples, `judgeTemplate` (code, category, merge fields, no link typed in, subject on email only), `render`, `preview`, `smsSegments` (GSM 7-bit and UCS-2). `messages.ts`: `customerMessageOf` (each event's message from what it carries, never its phone), `maskAddress`, `messageKey`, the hourly limit, `retryDelayMs`, `afterAttempt`, `afterReport`, `judgeRetry`. |
| NTF application | `Templates` (list, get, draft a version, activate by a second person retiring the one it replaces, preview); `CustomerMessages` (the outbox consumer `ntf.customer-messages`); `MessageSender` (the claiming sender, the circuit, `ntf.MessageFailed`); `MessageLog` (list and read at the message's branch, retry); `DeliveryReports` (the signed webhook, `ntf.DeliveryReportRejected`). `ntf.MessageSuppressed` for the hourly limit. |
| NTF infrastructure and interface | `PgNtfStore`; three controllers, nine fragments; `NtfModule` registers the consumer; the worker's `message-send` job every 15 s (`src/worker-app.ts`). |
| ORD (additive) | `Orders.messageContactsIn`: the order's own contact, else its delivery's recipient. |
| Schema | 0335 (NTF): `ntf.template` (MASTER), `ntf.message` (DOCUMENT), `ntf.message_attempt` and `ntf.provider_report` (LEDGER), `ntf.template_guard()`, `ntf.message_guard()`, `ck_template_maker_checker`, `uq_message_idempotency`, `uq_provider_report_key`; the seven customer templates seeded. 0336 and 0337 (IAM seed rows): four permissions, their grants, the messaging webhook's principal. Each rolls back (the rollback walk runs them). |
| Config | `SMS_WEBHOOK_SECRET` (optional; documented in OPERATIONS and `.env.example`). |
| Docs | ADR-0096 (indexed); A-374, A-375; abuse cases 57 and 58; ADR-0026 Amendments; `data-model/ntf.md`; API.md (NTF); OPERATIONS (the `message-send` job); the 2.39.0 changelog; the openers (B11 continued 10 built and split, B11 continued 11 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/ntf/customer-messages.integration.spec.ts` (12 tests, new, over the seeded farm; a guest's crate of big eggs ordered with the number 0201234567 and the delivery recipient's 0244512876; the SMS provider a test double that delivers once per idempotency key; every figure read by SQL):
- **Dispatch:** one `ORDER_DISPATCHED` message, its text built from the event (the order and delivery numbers, the crate, the final total and the cash due on delivery as `formatCedis` writes them), masked `+23320*****67`, keyed `<event>:ORDER_DISPATCHED:SMS:<order>`; the sender sends it once to `+233201234567`, the order's own contact (not the delivery's recipient), attempt 1 `ACCEPTED`; a second pass claims nothing.
- **Exactly once:** the outbox delivery reset to `PENDING` and redelivered, the consumer's handler run again past the inbox, and a duplicate row straight into the table (`uq_message_idempotency`, 23505) all leave one message and one SMS.
- **The order's own contact only:** an event naming the order with a forged `contactPhone` is sent to the order's number; an event for an order that does not exist queues nothing.
- **A change that rolls back** (publish, then throw) leaves no outbox row and no message.
- **On the way and delivered** through the real run (route, start, on the way, proof with its photograph): one `DELIVERY_ON_THE_WAY` and one `DELIVERY_COMPLETED`, each sent once to the same number.
- **Collected, rescheduled, cancelled, part delivered:** one message each with its exact text (`GHS 1,379.00`, `GHS 379.00`, the slot, `GHS 880.00` and `GHS 60.00`), to the order's number. The collected, rescheduled and cancelled events are published as ORD and DEL publish them; the part delivery's `del.DeliveryCompleted` is handed to the consumer directly, because publishing it runs ORD's transactional posting (the real part delivery publishes it, B11 continued 6).
- **Two workers at once:** six messages, two senders in parallel, each message sent once (keys equal to the message ids), attempts 1.
- **A worker that dies mid-send:** its send reaches the provider and never answers; a second sender claims nothing while the lease holds; after it expires the next sender sends with the same key; the provider delivered one; the late answer finds its claim lost and changes nothing (attempts 1, one attempt row).
- **The hourly limit:** eleven messages in an hour to one number: ten `QUEUED`, one `SUPPRESSED` `RATE_LIMITED` with `ntf.MessageSuppressed` (`abuseCases: [58]`).
- **A failed message shows as failed:** three temporary failures (the circuit opens after the first in each pass; backoff 30 s, then 60 s) end `FAILED` with three `TEMPORARY_FAILURE` attempts and `ntf.MessageFailed`; `listNotificationMessages?status=FAILED` shows it (masked, the contact's name, the attempts, no number); the Storekeeper, Sales and the Driver are refused the retry and the read (403), Sales the log; the Manager's retry queues it (replayed by its key, audited), a second retry `NOT_FAILED`, a suppressed message `SUPPRESSED`; the next send makes it `SENT` with attempts 4. A permanent refusal is `FAILED` at once.
- **The database:** a message's order, text, status backwards and attempts refused (`ntf.message_guard`, HK004), an attempt never updated (42501 for `hk_app`, HK001 for the owner), a message never deleted, a row written `SENT` refused.

`test/integration/ntf/templates-and-reports.integration.spec.ts` (8 tests, new):
- **Templates:** the seven seeded active, listed by the Accountant and read by Sales, paged by cursor; the Storekeeper, the Cashier and the Driver 403; `{{totl}}`, a typed `https://` link, an unknown code and a subject on an SMS 422, an unknown field 400; Sales, the Accountant and the others cannot draft. The Manager drafts version 2 (replayed by its key), Sales previews it (`GHS 940.00` from the samples, 129 characters, one SMS part); the Manager cannot activate their own draft (`OWN_DRAFT`), the Owner does, version 1 retired, audited with the text and the drafter; a message made before keeps version 1, the next uses version 2; the database refuses a text change, a retired version back to active, and an activation by its drafter (`ck_template_maker_checker`).
- **Delivery reports:** unsigned, wrongly signed and malformed-signature reports 401, logged `REJECTED_SIGNATURE` and published (`abuseCases: [57]`), nothing changed; `HUBTEL` 404; a signed `DELIVERED` report moves the message to `DELIVERED` and changes only `status`, `delivered_at` and the row's version and update stamp, whatever else the body carries; its replay is `REPLAYED`, a later `UNDELIVERED` `NO_CHANGE`; an `UNDELIVERED` report fails a sent message (`ntf.MessageFailed`, listed as `FAILED`); an unknown message, a STOP reply and an unreadable body are logged and acknowledged; no number in the log; the log insert-only.

Unit: `ntf/domain/templates.spec.ts` and `ntf/domain/messages.spec.ts` (19 tests, 100 percent of `src/modules/ntf/domain`, now a gate in `vitest.config.mts`).

The walks: `authorisation.integration.spec.ts` (the nine operations declare their permissions, the wrong roles refused) and `no-id-is-a-key.integration.spec.ts` (every NTF operation that takes an identifier walked; `receiveMessagingWebhook` listed as public with its proof).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The delivery's recipient before the order's own contact | red: 6 of 12 (customer-messages) |
| M2 | No `ON CONFLICT` on the message key | red: 1 of 12 |
| M3 | A live claim taken over (no lease check) | red: 2 of 12 |
| M4 | The drafter activates their own version | red: 2 of 8 (templates-and-reports) |
| M5 | No signature check on the webhook | red: 3 of 8 |
| M6 | No permission on the retry | red: 2 of 12 |
| M7 | A report moves any status | red: 1 of 8 |
| M8 | No hourly limit | red: 3 of 12 |

## Test first, as it honestly happened

- The domain tests were written with the domain and run red first (one rule failed and was corrected: an unknown code no longer reports its fields too).
- The integration specs were written against the gate after the application layer, then run: their first runs found five faults, all fixed before the gate: every update of a versioned row must move its version (`touch_version`); a synthetic `del.DeliveryCompleted` runs ORD's posting, so the part delivery is handed to the consumer directly; the tests' many messages to one number met the hourly limit (each test now opens its own hour); the sender's events need the Scheduler's context, which the worker gives (the harness gives it too); the owner role, not `hk_app`, sees the ledger trigger. The mutation checks above prove each rule's test bites.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundary crossed: TB2 back office (templates, the message log), the messaging provider's webhook (public, like TB5's payment webhooks), the worker's outbound SMS, the database.
- **SC-01 input:** strict schemas; codes and merge-field names by pattern; unknown fields 400; the webhook's body is not parsed before its signature passes, then read field by field.
- **SC-02 authorisation:** in the handlers, deny by default: `ntf.template.read`, `ntf.template.manage`, `ntf.message.read` and `ntf.message.retry` (the message at its branch; a list shows only the branches the grants reach); wrong roles refused in both specs and the walk. The webhook acts as its own SYSTEM principal with no grant.
- **SC-03, SC-04:** parameterised SQL only; the sort is the shared keyset.
- **SC-05 money:** no amount is computed; the texts print the events' integer pesewas with `formatCedis`.
- **SC-06 idempotency:** drafts, activations and retries by their keys; a message by `uq_message_idempotency`; a report by `uq_provider_report_key`; the provider by the message id.
- **SC-07, SC-08:** no secret in an event, log or row; the webhook secret only in config (drawn per test run, never written); the sender logs the message id, not the number; the log keeps a mask and a keyed hash, the report log a SHA-256 of the body.
- **SC-09 to SC-11:** staff writes with CSRF and origin (the preview too); the console rate-limit group; the webhook the public group.
- **SC-12:** no upload. **SC-13 (webhooks, in order):** every request logged first, the HMAC over the raw body in constant time, unique by the provider's report id; the report's own claim never trusted beyond moving a `SENT` message's delivery status (no timestamp window: a replayed old report cannot change anything but that status, and is logged `REPLAYED`).
- **SC-14:** no outside call inside any transaction: the provider is called between the claim's and the record's transactions.
- **SC-15, SC-16:** no empty catch; refusals carry stable codes and the correlation id.
- **SC-17 maker and checker:** a template version is never activated by its drafter (application and `ck_template_maker_checker`).
- **SC-18:** no restricted field kept: the number is not stored. **SC-19:** no user-supplied outbound URL (links are refused in templates). **SC-20, SC-21:** no new dependency; no secret-shaped literal.
- **SC-22:** attempts and reports insert-only (LEDGER). **SC-23:** the consumer, the record of an attempt, activation and retry at serializable with the whole-command retry; the claim at read committed with `SKIP LOCKED`.
- **SC-24:** draft, activation (with the text and the drafter) and retry audited.
- **The parent's abuse paths:** **a message or link sent to the wrong person** (the order's own contact read through ORD at queue and at send, a forged payload tested; no link in this pass); **a forged delivery report** (signature first, applied once, status only; tested); **a reminder storm** (one per event, the claim, three attempts, the hourly limit; tested); **a template edited to carry a phishing link** (no typed link, two people, the text frozen and audited; tested). New abuse cases **57** and **58**; their events carry the case numbers for B12's daily exception report (`ntf.DeliveryReportRejected`, `ntf.MessageSuppressed`, `ntf.MessageFailed`), which B12 projects and tests on the report.
- **Residual:** a template may still name a wrong phone number to pay in plain words (not a link); the second person and the audit are the control. Findings: none open.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 are B11 continued 11's (its opener carries them, with this phase's messages now sent).

## Reused photographs

Not recorded here; B11 continued 11's opener carries it, and B12's says B12 must if B11 continued 6 to 11 do not.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

- **CR-039** (the crate and the single egg at the shop) and **CR-033 point 3** (the receipt SMS): B11 continued 11's, in its opener (not declined).
- **CR-063** was answered in 2.35.0; **CR-059 to CR-062** are B12's, in its opener. Older requests are answered in their phases. No request is left without a phase.

## Tests (this machine)

Run with Docker's Testcontainers; see CI below for the runs on the pushed commits. `main` had not moved from `f7e961d` when the merge slot was taken, so no rebase or renumbering was needed.

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, on `0e813c9`) | **4,234 passed, 1 failed, 354 files, none skipped.** The one failure was `bil/archive-link-rollback` (its list of the migrations it rolls back on the way to 0155 lacked 0335 to 0337; the migrations themselves rolled back and applied again). CI's push and pull_request runs on `0e813c9` (45327177331, 45327219671) failed on the same test in shard 1, every other job green. Fixed in its own commit (`test(bil)`), the spec then passing alone; nothing retried or skipped. Coverage is judged by CI's merged coverage gate on the final head (a failing run prints none locally). |
| NTF alone | 20 integration tests (2 files) and 19 unit tests, all passing; `src/modules/ntf/domain` 100 percent (statements, branches, functions, lines), now a full-coverage gate |
| The walks | `iam/authorisation` and `iam/no-id-is-a-key`: 27 passed |
| Contract (`pnpm test:contract`) | 139 tests, 55 files: passed after two fixes found by its first run (the NTF request schemas registered in `b3/slice-and-login`, the planned count in `api/openapi-drift` now 108); both specs re-run and passing |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate --check` | Clean (557 operations from code, 108 planned) |

## Deferred

- **To B11 continued 11** (its opener): preferences, opt-outs (a STOP reply recorded), quiet hours, triggers, in-app notifications; the document sends and the remittance advice; CR-033 point 3's receipt SMS; the tracking SMS; abandoned carts; the returned death report; the reminder templates and their delivery per channel; CR-039; the reused-photograph match; the UAT dry runs.
- **To B13:** the SMS provider's key and `SMS_WEBHOOK_SECRET`, and confirming the provider honours the idempotency key (A-374 (f)); the WhatsApp and email adapters behind the same port.
- **Seed:** the seven templates come with migration 0335; no message is seeded (the worker sends them as the farm trades).

## Questions for the owner

1. **The customer's number (A-374 (b)).** A message goes to the number the order was placed with, else its delivery's recipient, read when it is sent; the log keeps only a mask. Agreed, or should a delivery message go to the recipient at the door when the two differ?
2. **The hourly limit (A-374 (b)).** Ten messages an hour to one number, the rest suppressed and reported. Agreed?
3. **Templates (A-374 (c)).** The Manager or the Owner drafts, the other activates; no link may be typed into a template. Agreed?

## Notes for the frontend track

- **2.39.0:** the message log is real: `listNotificationMessages` (filter `status=FAILED` for the failed ones), `getNotificationMessage`, `retryNotificationMessage` (only `FAILED`; `SUPPRESSED` never). Show `addressMasked` as given, never a number. Templates: `listNotificationTemplates` for a reminder level's picker (codes and versions; the reminder codes arrive in B11 continued 11), `previewNotificationTemplate` before saving, `createNotificationTemplate` makes a draft, `activateNotificationTemplate` must be done by someone else (`OWN_DRAFT`); say a link cannot be typed (`LINK_NOT_ALLOWED`: the server adds links).

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green.

## Next session

B11 continued 11 (`b11c11-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c10-notifications.md,
B11 continued 10, which this phase continues).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the NTF requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/ntf.md,
the NTF, ORD, POS, SHP, BIL, PUR, WHL and LIV cards in docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0026 (the
abandoned-cart assignment), ADR-0062 (document sends), ADR-0074 (a link sent by message gets its own token from the
sending worker, never one stored in the outbox), ADR-0083 and ADR-0096, and the abuse cases 37, 57 and 58 in
docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document
unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 11 only, on branch b11c11-notifications. B11 continued 10 built the NTF module (templates,
the message log, delivery reports, the `message-send` job, the customer's messages; ADR-0096, A-374): build on it,
never again. Every new message follows ADR-0096's two steps (queued once by an outbox consumer, keyed by its event,
template, channel and record; sent by the claiming worker outside any transaction) and goes only to the record's own
contact read through its module. The rest, in this order:
1. Preferences, opt-outs and quiet hours (FR-NTF-004 to FR-NTF-006): `getMyNotificationPreferences`,
   `replaceMyNotificationPreferences`, `listOptOuts`, a STOP reply to `receiveMessagingWebhook` recorded as an opt-out at
   once (it is logged IGNORED today), reminders and marketing suppressed on an opted-out channel while transactional
   messages are not, a reminder due in quiet hours sent at 07:00 Africa/Accra; triggers (`listNotificationTriggers`,
   `updateNotificationTrigger`) and in-app notifications (`listMyNotifications`, `markNotificationRead`).
2. The document sends (ADR-0062, A-204: sendBillingDocument and sendStatement, 202 through the outbox, a bil.reprint_log
   row with the channel, the archived bytes or a lasting link, never a new document; the remittance advice from
   pur.SupplierRemittanceReady, once per payment; a send reaches only the document's own customer or supplier and a
   failed send is retried without a second archive row), CR-033 point 3 (the receipt SMS once when a counter sale with
   customerPhone syncs, with a fresh server-made token for a sale whose till token was refused, ADR-0074; the refused
   till token still opens nothing), the guest's SMS tracking link with its own long random token (a guessed token or
   the order's id answers 404; `OnlineOrders.reissueTrackingIn`), abandoned-cart messaging (ADR-0026) and the death
   report sent back by the malware scan (B06r, A-175: liv.MortalityReturned names the reporter and the reason).
3. The owner, 2026-11-23 (from the frontend's F12 and F10n): the reminder templates (`PAYMENT_REMINDER_*`), listed by
   `listNotificationTemplates` so a reminder level picks one instead of typing a code, WHL's dunning sending through
   them, and each reminder's delivery recorded per channel (sent, delivered, failed), so a failed reminder shows as
   failed. CR-039 at the shop (the crate and the single egg, each at its own price; CartLineAdd.uom; test-first with
   exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference (an order on account can now be dispatched; a crate's eggs can now be returned singly; the
customer's messages are now sent).
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c11-notifications.md.
```
