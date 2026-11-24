# B11 continued 11: notifications, second pass (lane B), split before the document sends and the receipt and tracking SMS

Date: 2026-11-24 · Branch `b11c11-notifications`, from `main` at `e7633cb` (#138, B11 continued 10) · Status: **phase split (A-377) at the opener's first sub-domain boundary: triggers, preferences, opt-outs (a STOP reply recorded at once), quiet hours and in-app notifications built to their own gate, passed locally; CI below. The document sends, the remittance advice, the receipt and tracking SMS, abandoned carts, a dunning level picking a listed template and each reminder's delivery on its notice, CR-039, the reused-photograph match and the UAT dry runs are B11 continued 12.**

Run as a fresh agent inside the 2026-11-15 overnight session: the parent session cannot issue /clear or /compact, so each phase starts in a new context that reads only this handoff from disk.

## Assumptions made this session (in `docs/ASSUMPTIONS.md`, dated 2026-11-24)

| ID | What | Who confirms |
| --- | --- | --- |
| A-376 | **NTF's second pass** (ADR-0097). (a) An opt-out or a turned-off channel suppresses `REMINDER` and `MARKETING` messages only; `TRANSACTIONAL` (receipts, dispatch, delivery, collection: what the law or the owner requires) and `OPERATIONAL` (to staff) are never suppressed, a preference only orders their channels. (b) Quiet hours delay reminders and marketing only, to 07:00 Africa/Accra or the recipient's own end, on the minute, never dropped; they are refused on a transactional preference; the sender checks opt-outs and quiet hours again at send (a reminder waiting for 07:00 when a STOP arrives is never sent). A channel with no adapter is chosen only when nothing with one is left, so it fails visibly (BL-117: the next channel after three failures waits for a second adapter). (c) Every message has a trigger, seeded (eleven); turned off it queues nothing new; changed by the Owner or the Manager, audited, no second person; its template is fixed; a reminder goes by the level's channels the trigger allows. (d) Opt-outs are kept on the number (mask and keyed hash), so a guest's STOP counts and it outlives the record; STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT opt out of SMS at once, START, UNSTOP opt in, once by the reply's id; a preference screen does not undo a STOP; the list is farm-wide for the Owner and the Manager; staff get no SMS (no staff number is kept). (e) In-app notifications are messages on `IN_APP` the sender writes, with a title and a console path; one's own only, another's 404, read once; `markNotificationRead` takes no idempotency key, as planned (idempotent by itself). (f) A customer's preferences are on the record its sign-in belongs to, staff's and investors' on their principal. (g) Reminders are written from WHL's notice and MDM's number, never the event's copy. | Owner |
| A-377 | **The split.** Built preferences, opt-outs, quiet hours, triggers and in-app notifications to their own gate, with the payment reminders and the returned death report as the first messages they act on (A-376, ADR-0097, migration 0338, contract 2.40.0); stopped before the document sends, the remittance advice, CR-033 point 3's receipt SMS, the tracking SMS, abandoned carts, a dunning level picking a listed template and each reminder's delivery on its notice, CR-039, the reused-photograph match and the UAT dry runs. **B11 continued 12** (`b11c12-notifications`), inserted before B12 (ADR-0026 Amendments, the openers file, the reference table, the lane B order, B12's reused-photograph line). A-349, A-378 and A-379 are left unused for it. | Parent session |

**For the parent session to schedule:** B11 continued 12 (its opener carries the rest in three sub-domains and how to split it), then the UAT scenario 2 corrections phase the parent inserts, then B12. **CR-039** (the shop's crate and single egg) and **CR-033 point 3** (the receipt SMS) are in B11 continued 12; neither is declined. **The receipt SMS needs the parent's leave in POS** (lane A's former files: the refused till token's fresh server-made link is POS's `ReceiptLinks`); B11 continued 12's opener says so.

**No ADR conflict, and no stop.** ADR-0096's two steps hold for every new message (one queue, `MessageQueue`; the claiming sender). **Shared modules, additive only:** MDM gains `MasterDataRefs.customerContactsIn`; LIV gains `MortalityRecords.returnFactsIn`; WHL (lane B's) gains `Dunning.noticesIn`. No existing function changed in a shared module; no change to POS, PAY, INV, BIL, IAM, DEL, ORD or FIN; no new permission (the seeded role matrix is unchanged).

Phase, scope and gate, as confirmed at the start:
1. **Phase:** B11 continued 11, lane B (`b11c11-notifications`, from `main` e7633cb).
2. **Scope:** the rest of NTF in the opener's three sub-domains, CR-039, the reused-photograph match and the UAT dry runs, splitting at a sub-domain boundary when the context will not reach the next gate.
3. **Gate (this part, sub-domain 1):** a wrong recipient, an opted-out recipient and quiet hours are each refused; a STOP is an opt-out at once; a transactional message is never stopped by an opt-out; a trigger turned off stops new messages; in-app notifications are each recipient's own. **Passed** (below). The receipt and tracking SMS, the document sends, a failed reminder on its channel and CR-039 are B11 continued 12's gate.

## Baseline (before any change, as the parent asked)

`pnpm test:coverage` on `main` at `e7633cb`, run on a clean copy of the commit: **354 files, 4,235 tests passed, none failed or skipped; statements 94.14 %, branches 83.78 %, functions 97.86 %, lines 97.18 %.** (A first attempt in the worktree was stopped by this session's own second Vitest removing the shared `coverage/.tmp`; it was rerun alone on a clean extract and is the figure above.)

## Contract changes

**2.40.0, minor, additive** (on top of 2.39.0; Redocly clean, no warnings; `contract:generate --check` up to date: 564 operations from code, 101 planned).
- **Into code, with their planned shapes:** `listNotificationTriggers`, `updateNotificationTrigger`, `listOptOuts`, `getMyNotificationPreferences`, `replaceMyNotificationPreferences`, `listMyNotifications`, `markNotificationRead`; each fragment carries its `x-error-codes`, its rules and examples of what the farm sends.
- **`InAppNotificationPage.unreadCount`** (new, required): the operation was never served before.
- **New refusals:** `PREFERENCES_INVALID` (`DUPLICATE_PREFERENCE`, `QUIET_HOURS_INCOMPLETE`, `QUIET_HOURS_EMPTY`, `QUIET_HOURS_NOT_DELAYED`), `TRIGGER_INVALID` (`NO_CHANNEL`, `DUPLICATE_CHANNEL`, `CHANNEL_NOT_FOR_RECIPIENT`, `TEMPLATE_FIXED`); `updateNotificationTrigger` 409 `VERSION_CONFLICT`.
- **`receiveMessagingWebhook`:** a reply `{"type": "inbound", "id", "from", "text"}` is applied once: STOP opts the number out of SMS, START back in; a reply without `id` or `from` is now logged malformed (it was logged ignored); still 200.
- **Behaviour on implemented operations, values already in the contract:** `listNotificationMessages` now shows `REMINDER` messages, `DEFERRED_QUIET_HOURS` with `sendAfter`, `IN_APP` messages to `STAFF`, and `OPTED_OUT` and `PREFERENCE_OFF`. An `IN_APP` template takes a `subject` (its title; `SUBJECT_EMAIL_ONLY` keeps its name). No field removed, retyped or made required on an implemented operation.

## Built

| Item | What |
| --- | --- |
| NTF domain (100 percent gate) | `routing.ts` (new): `suppressibleByOptOut`, `quietHoursApply`, `localMinuteOfDay`, `quietUntil` (Africa/Accra, the default or the recipient's own window, across midnight), `readReply` (STOP and START words), `routeMessage`, `judgePreferences`, `judgeTriggerUpdate`. `messages.ts`: `reminderMessageOf`, `mortalityReturnedOf`, `REMINDER_CODES`, the suppressed reasons `OPTED_OUT` and `PREFERENCE_OFF`. `templates.ts`: `PAYMENT_REMINDER_1` to `3` (REMINDER), `MORTALITY_RETURNED` (OPERATIONAL), `titled` (an in-app title). |
| NTF application | `MessageQueue` and `RecipientFacts` (new): the one queue every consumer writes through (trigger, recipient through its module, routing, the hourly limit, quiet hours, one message per source event, template and record). `CustomerMessages` now writes through it. `Reminders` (`ntf.reminders` on `whl.DunningNoticeDue`) and `StaffNotifications` (`ntf.staff-notifications` on `liv.MortalityReturned`). `MessageSender`: claims deferred messages when due, reads the number, opt-outs and quiet hours again at send (`SUPPRESSED` `OPTED_OUT`, handed back `DEFERRED_QUIET_HOURS`), writes an in-app notification for `IN_APP`; `SendPass.deferred`. `DeliveryReports`: STOP and START replies through `OptOuts.recordReplyIn`; a refused request names abuse cases 57 and 59. `Preferences`, `OptOuts`, `Triggers`, `InAppNotifications` (new). |
| NTF infrastructure and interface | `PgNtfStore` (triggers, preferences, opt-outs, in-app, the deferred claim); `TriggersController`, `OptOutsController`, `MyNotificationsController`; seven fragments; the module registers the two new consumers. |
| Shared reads (additive) | MDM `MasterDataRefs.customerContactsIn`; LIV `MortalityRecords.returnFactsIn`; WHL `Dunning.noticesIn` (with `DunningStore.noticesById`). |
| Schema | 0338 (NTF): `ntf.trigger_rule` (MASTER, `uq_trigger_rule`, eleven seeded), `ntf.preference` (MASTER, `uq_preference`, the quiet-hours checks), `ntf.opt_out` (LEDGER, `uq_opt_out_report`), `ntf.in_app_notification` (WORK, `uq_in_app_notification_message`, `ntf.in_app_notification_guard`); `ntf.message` gains `rendered_subject` and `link_path` and `ck_message_staff`; `ntf.message_guard()` replaced (written `DEFERRED_QUIET_HOURS` with `send_after`, which moves on as `QUEUED` does; subject and link frozen); `ck_template_subject_titled` replaces `ck_template_subject_email`; four templates seeded. Rolls back (the rollback walk runs it). |
| Docs | ADR-0097 (indexed); A-376, A-377; abuse case 59; BL-117; ADR-0026 Amendments; `data-model/ntf.md`; API.md (NTF); the NTF, MDM, LIV and WHL cards; the 2.40.0 changelog; the openers (B11 continued 11 built and split, B11 continued 12 inserted, the reference table, the lane B order, B12's reused-photograph line). |

## The gate, proved by running it

`test/integration/ntf/preferences-and-opt-outs.integration.spec.ts` (12 tests, new; the seeded farm with its trading day; three business customers at Dodowa with their own numbers, an account and an invoice of GHS 600.00 each, reminded through WHL's real dunning job at 7, 14 and 30 days; the SMS provider a test double; every figure read by SQL):
- **Preferences:** empty until set; replaced whole, in order, keyed (a replay answers the same), audited; the four refusals 422; a malformed time and a foreign field 400; staff keep theirs on their principal; a customer sign-in with no customer record 404; no session 401; a customer's session is refused the opt-out list and the triggers (401).
- **Quiet hours:** at 22:30 Africa/Accra the level-1 reminder is `DEFERRED_QUIET_HOURS` with `send_after` 07:00 the next day, its text exact (`... INV-... for GHS 600.00 is now 7 days overdue ...`), masked `+23324*****01`; the sender claims nothing at 22:30 or 06:59:59 and sends it once at 07:00 to the customer's own number. A customer's own window (09:00 to 11:00) holds a reminder at 10:00 until 11:00.
- **Preference off:** Kpone's REMINDER SMS turned off: its reminder `SUPPRESSED` `PREFERENCE_OFF`.
- **STOP:** an unsigned and a wrongly signed STOP are 401 and record nothing (two `ntf.DeliveryReportRejected` with `abuseCases [57, 59]`); a signed STOP is an opt-out at once (`OPT_OUT`, `REPLY_STOP`, masked, no number stored), its replay `REPLAYED` with no second row; listed for the Manager, refused to the Accountant, Sales, the Storekeeper and the Cashier (403); `hk_app` cannot update it (42501), the owner role neither (HK001).
- **At send:** Ada's reminder queued for 07:00 before her STOP is `SUPPRESSED` `OPTED_OUT` at 07:00, never sent; her level-2 reminder is suppressed when queued; a suppressed reminder cannot be retried (`MESSAGE_NOT_RETRYABLE` `SUPPRESSED`); her START brings level 3 back, sent.
- **Wrong recipient:** a forged `whl.DunningNoticeDue` naming another customer and another level is written from the notice WHL holds (Asantewaa, level 1) and sent to Asantewaa's number; an event for no notice sends nothing.
- **Transactional never stopped:** a guest's number that replied STOP still gets `DELIVERY_CANCELLED` (`QUEUED`, sent to it).
- **Triggers:** eleven listed in order to template readers, paged by cursor; the Storekeeper and the Cashier 403; Sales cannot change one (403); `CHANNEL_NOT_FOR_RECIPIENT`, `TEMPLATE_FIXED`, `NO_CHANNEL` 422; a stale version 409; turned off (keyed, audited) it queues nothing for a new event and leaves every earlier message; back on by email, with no email adapter, its message fails visibly (`FAILED`, `no adapter sends EMAIL`); the database refuses an unknown channel, no channel and a delete.
- **The database:** a deferred message without its time (HK004), quiet hours on a transactional preference and two recipients on one preference (23514).

`test/integration/ntf/in-app-notifications.integration.spec.ts` (5 tests, new; two farm hands' death reports sent back by the scan through LIV's real flow):
- One `IN_APP` message per returned report to its own reporter (`STAFF`, no address, the title, the console path, the reason in words); the sender writes four notifications and sends no SMS; a redelivered outbox and a second pass leave four of each.
- `listMyNotifications`: each farm hand's own only, newest first, `unreadCount` 3 and 1, paged; marking one of three read leaves two, once (a second call keeps the first `readAt`); `unreadOnly`.
- Another's notification is 404 to mark, for another farm hand and for the Manager; a random id 404; no session 401.
- A forged `liv.MortalityReturned` naming another reporter reaches the record's own reporter; an event for no record sends nothing.
- The database: only the read state changes, once (HK004); a message's link never changes (HK004).

Changed specs: `customer-messages` (12, the sender's pass counts `deferred`), `templates-and-reports` (8: the four new templates listed; a reply that is no instruction; the rejection names 57 and 59), the walks (`authorisation`, `no-id-is-a-key`: the seven operations; `markNotificationRead` listed as an operation on one's own record with its proof), `bil/archive-link-rollback` (the rollback walk passes 0338), the contract specs (the request schemas; 101 planned).

Unit: `ntf/domain/routing.spec.ts` (14, new) and the extended `templates.spec.ts` and `messages.spec.ts`: 36 tests, `src/modules/ntf/domain` 100 percent (statements, branches, functions, lines).

## Mutation checks (each applied alone, the spec run, the source restored)

| # | Mutation | Result |
| --- | --- | --- |
| M1 | The sender does not check the opt-outs again at send | red: 2 of 11 (preferences-and-opt-outs) |
| M2 | A trigger turned off still queues | red: 1 of 11 |
| M3 | A STOP reply records nothing (only START does) | red: 5 of 11 |
| M4 | The sender does not claim deferred messages | red: 2 of 11 |
| M5 | A notification is found by id whoever asks | red: 1 of 4 (in-app) |
| M6 | No quiet hours when queued | red: 2 of 11 |
| M7 | The in-app message goes to the event's reporter | red: 1 of 5 |
| M8 | The reminder goes to the event's customer | red: 2 of 12 |

## Test first, as it honestly happened

- `routing.spec.ts` was written first and run red (no module), then the domain; one branch was unreachable and removed. The template and message specs were extended with their code.
- The integration specs were written after the application layer, against the gate, then run: their first runs found two faults, both fixed before the gate: an update of a versioned row must move its version (the preference replacement and the trigger update, `touch_version`), and a customer's session on a staff route is 401, not 403 (the expectation was corrected). The mutation checks above prove each rule's test bites; a first M7 was a no-op and was replaced by a real wrong-recipient test.

## Security review (hakorem-security-review, SECURE_CODING_STANDARDS.md item by item)

Boundary crossed: TB2 back office (triggers, opt-out list), every realm's own account (preferences, in-app), the messaging provider's webhook (replies), the worker's sender, the database.
- **SC-01 input:** strict schemas (unknown fields 400), `HH:MM` times, channels and categories by enum; a reply's body is read only after its signature passes, field by field (E.164 `from`, an id, at most 1,600 characters of text).
- **SC-02 authorisation:** in the handlers, deny by default: `ntf.template.read` and `ntf.template.manage` for triggers, `ntf.message.read` for opt-outs; one's own preferences and notifications take no identifier but the caller's own, another's notification 404 (tested). Wrong roles refused in the specs and both walks.
- **SC-03, SC-04:** parameterised SQL; keyset paging by fixed columns.
- **SC-05 money:** no amount computed; the reminder prints WHL's integer pesewas with `formatCedis`.
- **SC-06 idempotency:** preference and trigger changes by their keys; a reply once by its id (`uq_provider_report_key`, `uq_opt_out_report`); a message once per source event, template and record; an in-app notification once per message; `markNotificationRead` idempotent by itself.
- **SC-07, SC-08:** no number stored (an opt-out keeps its mask and keyed hash); no secret in code, events or rows; the webhook secret drawn per test run.
- **SC-09 to SC-11:** CSRF and origin on every write; the console rate-limit group; the webhook the public group.
- **SC-12:** no upload. **SC-13 webhooks:** logged first, HMAC over the raw body in constant time, once by id; a reply changes only the number's opt-out.
- **SC-14:** no outside call inside a transaction (the in-app notification is written in the attempt's own short transaction; SMS outside any).
- **SC-15, SC-16:** no empty catch; stable codes with the correlation id.
- **SC-17 maker and checker:** not on the list for triggers or preferences (A-376 (c)); templates keep theirs.
- **SC-18:** no restricted field kept. **SC-19:** no user-supplied URL (an in-app link is a console path, checked by the database). **SC-20, SC-21:** no new dependency; no secret-shaped literal.
- **SC-22:** opt-outs insert-only (LEDGER). **SC-23:** consumers, preference and trigger changes serializable with the whole-command retry; the claim read committed with `SKIP LOCKED`.
- **SC-24:** preference and trigger changes audited with before and after.
- **The parent's abuse paths:** **a message or link to the wrong person** (the recipient read from WHL's notice, LIV's record and ORD's order, forged events tested for reminders and in-app); **an opt-out ignored** (suppressed when queued and again at send, never retried; tested); **a forged STOP** (401, nothing recorded, published with abuse cases 57 and 59; tested); **a reminder storm** (one per notice and level, the hourly limit, quiet hours; tested); **a document sent to the wrong party** and **an abandoned-cart message to someone who never consented**: B11 continued 12's (its opener binds both, the latter to `mdm.customer.marketing_consent`). New abuse case **59** (abuse case 60 is left for B11 continued 12). Its detection reaches B12's daily exception report through `ntf.DeliveryReportRejected` (`abuseCases: [57, 59]`), which B12 projects and tests on the report.
- **Residual:** a STOP from a stolen phone silences that number's reminders (the number's own START, or a support opt-in in a later phase, undoes it). Findings: none open.

## UAT dry runs

Not run: steps 1.11 to 1.16, scenario 5's driver case and scenario 2 from 2.12 are B11 continued 12's (its opener carries them, with reminders, STOP and quiet hours now in force).

## Reused photographs

Not recorded here; B11 continued 12's opener carries it, and B12's says B12 must if B11 continued 6 to 12 do not.

## Contract requests (the frontend's `main` at `43acd8f`, unchanged since B11 continued 6)

- **CR-039** (the shop's crate and single egg) and **CR-033 point 3** (the receipt SMS): B11 continued 12's, in its opener (not declined).
- **CR-063** was answered in 2.35.0; **CR-059 to CR-062** are B12's, in its opener. Older requests are answered in their phases. No request is left without a phase; none is new.

## Tests (this machine)

Run with Docker's Testcontainers; see CI below for the runs on the pushed commits.

| Layer | Result |
| --- | --- |
| Unit and integration, the whole suite (`pnpm test:coverage`, on `af35bcc`, after the last code change; only documents changed after it) | **4,269 passed, 357 files, none failed or skipped.** Coverage: statements 94.15 %, branches 83.90 %, functions 97.89 %, lines 97.20 % (baseline 94.14, 83.78, 97.86, 97.18). Every full-coverage gate held, `src/modules/ntf/domain` at 100 percent. |
| NTF alone | 37 integration tests (4 files) and 36 unit tests, all passing |
| The walks | `iam/authorisation` and `iam/no-id-is-a-key`: 27 passed |
| The rollback walk | `bil/archive-link-rollback`: passed, 0338 rolled back and applied again |
| Contract (`pnpm test:contract`) | 139 tests, 55 files, passed (after its first run found the two NTF request schemas missing from `b3/slice-and-login` and the planned count, now 101) |
| Lint (ESLint with module boundaries, fixtures, placement, schema names), typecheck, Redocly (no errors, no warnings), `contract:generate --check` | Clean (564 operations from code, 101 planned) |

## Deferred

- **To B11 continued 12** (its opener): the document sends and the remittance advice; CR-033 point 3's receipt SMS; the tracking SMS; abandoned carts; a dunning level picking a listed template and each reminder's delivery on its notice per channel; CR-039; the reused-photograph match; the UAT dry runs.
- **To B13:** the SMS provider's key and `SMS_WEBHOOK_SECRET`; the WhatsApp and email adapters, and with a second one the next channel after three failures (BL-117).
- **Not built:** `ROLE` recipients (no trigger uses one); staff SMS (no staff number kept).
- **Seed:** the four templates and eleven triggers come with migration 0338; no preference, opt-out or notification is seeded.

## Questions for the owner

1. **What an opt-out stops (A-376 (a)).** A STOP stops reminders and marketing on that channel; receipts, dispatch and delivery messages still go. Agreed?
2. **Quiet hours (A-376 (b)).** Reminders and marketing only wait for 07:00; delivery-day and receipt messages go at once, even at night. Agreed?
3. **The opt-out list (A-376 (d)).** The Owner and the Manager see every number's opt-outs, masked, whatever their branch. Agreed?

## Notes for the frontend track

- **2.40.0:** preferences (`getMyNotificationPreferences`, `replaceMyNotificationPreferences`: send the whole list in order; quiet hours only on reminders and marketing), in-app notifications (`listMyNotifications` with `unreadCount`, `markNotificationRead`, no idempotency key), triggers (`listNotificationTriggers`, `updateNotificationTrigger` at its `version`), opt-outs (`listOptOuts`, masked, `REPLY_STOP` and `REPLY_START`). The message log can now show `DEFERRED_QUIET_HOURS` with `sendAfter` (show it in Africa/Accra), `OPTED_OUT`, `PREFERENCE_OFF`, `REMINDER` and `IN_APP` to staff. A reminder level's picker reads `listNotificationTemplates?code=` for the `PAYMENT_REMINDER_*` codes (WHL's level picking one is B11 continued 12's).

## CI

A report cannot name the runs of the commit that adds it; every run on the final head is named in the session's closing message to the parent session, and the pull request merges only when each is green. `main` had not moved from `e7633cb` when the merge slot was taken, unless the pull request says otherwise.

## Next session

B11 continued 12 (`b11c12-notifications`, from `main`), exactly as `docs/prompts/session-openers.md` carries it:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (docs/sessions/B11c11-notifications.md,
B11 continued 11, which this phase continues).
Read ../frontend/docs/CONTRACT_REQUESTS.md as committed on the frontend's main (CLAUDE.md): implement what is
reasonable, record in the report what you declined and why, never edit that file and never open frontend source.
For this phase, read the NTF requirement block of docs/SRS.md (nothing else from the SRS), docs/data-model/ntf.md,
the NTF, ORD, POS, SHP, BIL, PUR, WHL and LIV cards in docs/MODULE_BOUNDARIES.md, and ADR-0010, ADR-0026 (the
abandoned-cart assignment), ADR-0062 (document sends), ADR-0074 (a link sent by message gets its own token from the
sending worker, never one stored in the outbox), ADR-0083, ADR-0096 and ADR-0097, and the abuse cases 37, 57, 58 and 59
in docs/security/THREAT_MODEL.md. Use docs/prompts/module-build-prompt.md as the recipe. Do not read any other document
unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Then execute B11 continued 12 only, on branch b11c12-notifications. B11 continued 10 and 11 built the NTF module
(ADR-0096, ADR-0097, A-374, A-376): build on it, never again. Every new message goes through `MessageQueue.queueIn`
(its trigger seeded by migration and live, its recipient read through the record's own module, its channel routed by the
preferences and the number's opt-outs, quiet hours for reminders and marketing) and is sent by the claiming worker
outside any transaction. A transactional message is never suppressed by an opt-out; a marketing message always is, and
an abandoned-cart message needs the customer's own marketing consent (`mdm.customer.marketing_consent`). The rest, in
this order:
1. The document sends (ADR-0062, A-204: sendBillingDocument and sendStatement, 202 through the outbox, a bil.reprint_log
   row with the channel, the archived bytes or a lasting link, never a new document; the remittance advice from
   pur.SupplierRemittanceReady, once per payment; a send reaches only the document's own customer or supplier and a
   failed send is retried without a second archive row; email is an adapter shape with a fake, the provider and key
   are B13's), CR-033 point 3 (the receipt SMS once when a counter sale with customerPhone syncs, with a fresh
   server-made token for a sale whose till token was refused, ADR-0074; the refused till token still opens nothing;
   POS's receipt links are lane A's former files: ask "main" before changing any existing POS function), the guest's
   SMS tracking link with its own long random token (a guessed token or the order's id answers 404;
   `OnlineOrders.reissueTrackingIn`) and abandoned-cart messaging (ADR-0026).
2. The owner, 2026-11-23 (from the frontend's F12 and F10n): a dunning level picks one of the reminder templates
   `listNotificationTemplates` lists (`PAYMENT_REMINDER_1` to `3`, seeded in 0338) instead of a typed code, and each
   reminder's delivery is recorded per channel (sent, delivered, failed) where WHL's dunning notice shows it, so a failed
   reminder shows as failed (NTF already sends them and logs each attempt). CR-039 at the shop (the crate and the single
   egg, each at its own price; CartLineAdd.uom; test-first with exact pesewas).
Run steps 1.11 to 1.16 of docs/UAT.md, the driver case in scenario 5 and scenario 2 from step 2.12 as a dry run and
record every difference (an order on account can now be dispatched; a crate's eggs can now be returned singly; the
customer's messages and reminders are now sent, a STOP is honoured and reminders wait out quiet hours).
For B12's reused photographs (the owner, 2026-11-23): `platform.stored_file` already keeps each upload's SHA-256; record
on the proof of delivery whether its photograph or signature matches an earlier upload (as liv.MortalityPhotoReused
does for a death photograph) and publish it for the exception report. If this phase does not, B12 must; say which in the
report.
Stop at the gate and write docs/sessions/B11c12-notifications.md.
```
