# ADR-0097: A message is routed by its trigger, the recipient's preferences and the number's opt-outs, and a reminder waits out quiet hours

- **Status:** Proposed (the owner reviews A-376)
- **Date:** 2026-11-24
- **Session:** B11 continued 11 (lane B)
- **Deciders:** backend track; the owner reviews A-376

## Context

ADR-0096 queues a message once from the outbox and sends it by a claiming worker, to the record's own contact. The SRS
asks next for triggers that map an event to a template and an order of channels, turned off without touching history
(FR-NTF-002); per-recipient channel preferences in order (FR-NTF-004); opt-outs recorded with their source, a STOP reply
among them, that stop reminders and marketing but never a transactional receipt (FR-NTF-005); quiet hours 21:00 to 07:00
Africa/Accra that delay non-urgent messages and never drop them, security codes and delivery-day messages exempt
(FR-NTF-006, SA-09); and in-app notifications per recipient with a read state (FR-NTF-008). The parent session's rules:
every new send path goes through the existing steps; a wrong recipient, an opted-out recipient and quiet hours are each
refused in a test; a transactional message the law or the owner requires is never blocked by a marketing opt-out. Without a
decision each consumer would judge these on its own, and the sender would send a reminder queued before a STOP.

## Options considered

1. **Judge preferences, opt-outs and quiet hours once, when the message is queued.** Simple, but a STOP that arrives
   after a reminder was queued for 07:00 would not stop it, and a manager's retry at night would send at night.
2. **Judge them when queued and again when sent.** One queue (`MessageQueue`) decides the channel and the time when the
   consumer queues; the sender reads the number, its opt-outs and the recipient's quiet hours again just before the call.
3. **Store the opt-out on the customer record (MDM).** One place, but a guest's number has no record, and an opt-out
   must outlive the record it came from.

For in-app notifications: (a) write the notification in the consumer; (b) queue a message on `IN_APP` like any other and
let the sender write the notification, so the log shows it and it is exactly once by the same keys.

## Decision

Option 2, with opt-outs kept on the number (not option 3), and in-app (b).

- **Triggers.** `ntf.trigger_rule` (MASTER, migration 0338): one live row per event type and template code
  (`uq_trigger_rule`), with the recipient kind and its channels in order; every message NTF sends is seeded with one. A
  trigger turned off queues nothing new; nothing already made changes. A change is the channels or on and off, at the
  version read; another template is refused (`TEMPLATE_FIXED`), as is a channel the recipient cannot have.
- **One queue.** `MessageQueue.queueIn` (application) is the only way a consumer writes a message: the trigger live; the
  recipient read through the record's module (the order's contact through ORD, a customer's number through MDM's
  `customerContactsIn`, a principal for the console); the channel from `routeMessage` (domain/routing.ts): the trigger's
  channels, the recipient's preferred ones first, less any turned off and, for `REMINDER` and `MARKETING`, any the number
  opted out of; then the first with an adapter. A reminder or marketing message with nothing left is `SUPPRESSED`
  (`OPTED_OUT`, `PREFERENCE_OFF`); a `TRANSACTIONAL` or `OPERATIONAL` one is never suppressed by either. One message per
  source event, template and record on whichever channel (the key, and a check for the same source in the consumer's
  serializable transaction).
- **Quiet hours.** A `REMINDER` or `MARKETING` message due between the recipient's own quiet hours (`ntf.preference`) or,
  without them, 21:00 and 07:00 Africa/Accra is written `DEFERRED_QUIET_HOURS` with `send_after` at their end, on the
  minute (`quietUntil`); the sender claims it then. Transactional and operational messages are never delayed.
- **At send.** The sender reads again the number, the opt-outs on it and the quiet hours: an opted-out reminder becomes
  `SUPPRESSED` `OPTED_OUT` and is never sent; one now in quiet hours is handed back `DEFERRED_QUIET_HOURS`.
- **Opt-outs.** `ntf.opt_out` (LEDGER): every instruction with the number's mask and keyed hash (the log's
  `AddressHasher`), the channel, the direction and its source; the latest per number and channel is the state. A signed
  reply to `receiveMessagingWebhook` whose first word is STOP (or STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT) records an
  opt-out of SMS in the webhook's transaction; START or UNSTOP an opt-in; once by the reply's id (`uq_provider_report_key`,
  `uq_opt_out_report`). A preference screen does not undo a STOP.
- **Preferences.** `ntf.preference` (MASTER): a customer's on the customer record its sign-in belongs to, staff's and
  investors' on their principal; replaced whole by the recipient alone, in order; quiet hours only on reminders and
  marketing (`ck_preference_quiet_category`).
- **In-app.** A message on `IN_APP` to a `STAFF` recipient carries its title (`rendered_subject`) and a console path
  (`link_path`, never a URL); the sender writes `ntf.in_app_notification` in the attempt's transaction
  (`uq_in_app_notification_message`). The recipient lists and marks only their own; another's is 404; read once
  (`ntf.in_app_notification_guard`).
- **This phase's senders through the queue:** the customer's messages (ADR-0096), the payment reminders from
  `whl.DunningNoticeDue` (the notice read through WHL's `Dunning.noticesIn`, never the event's copy; by the level's channels
  the trigger allows) and the returned death report from `liv.MortalityReturned` (the record read through LIV's
  `MortalityRecords.returnFactsIn`, to its own reporter). Every later sender (the document sends, the receipt and tracking
  SMS, abandoned carts: B11 continued 12) uses the same queue.

## Consequences

- A STOP stops the next reminder and one already waiting; a receipt or a delivery message still goes. A reminder is never
  sent at night; it is never dropped either. The log shows each decision (`OPTED_OUT`, `PREFERENCE_OFF`,
  `DEFERRED_QUIET_HOURS` with its time, `IN_APP`).
- A channel with no adapter yet (WhatsApp, email) is chosen only when nothing with an adapter is left, so such a message
  fails visibly; the fall-back to the next channel after three failures (FR-NTF-004's second sentence) waits for a second
  adapter (BL-117).
- Staff SMS is not offered (no staff number is kept); `ROLE` recipients are not resolved yet (no trigger uses one).
- Binds `docs/data-model/ntf.md`, `docs/API.md` (NTF), the NTF card of `docs/MODULE_BOUNDARIES.md`, abuse cases 57 to 59
  and B11 continued 12.

## Verification

- `src/modules/ntf/domain/routing.spec.ts` (100 percent): the categories an opt-out and quiet hours reach, `quietUntil`
  at 22:30, 06:59, 07:00 and a recipient's own window, the reply keywords, `routeMessage`, the preference and trigger
  rules.
- `test/integration/ntf/preferences-and-opt-outs.integration.spec.ts`: a reminder due at 22:30 sent at 07:00 once; a
  STOP recorded at once (signed, once, a forged one refused), the next reminder suppressed and a waiting one not sent, a
  START undoing it; a transactional message to an opted-out number sent; a customer's channel turned off and own quiet
  hours; a forged event's customer ignored; triggers listed, turned off and back, their rules; the database's rules.
- `test/integration/ntf/in-app-notifications.integration.spec.ts`: a returned death report to its reporter once, the
  unread count, marking once, another's 404, a forged event's reporter ignored, the database's rules.
