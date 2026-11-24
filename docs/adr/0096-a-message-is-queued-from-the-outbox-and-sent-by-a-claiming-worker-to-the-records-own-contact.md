# ADR-0096: A message is queued from the outbox and sent by a claiming worker, to the record's own contact

- **Status:** Proposed (the owner reviews A-374)
- **Date:** 2026-11-24
- **Session:** B11 continued 10 (lane B)
- **Deciders:** backend track; the owner reviews A-374

## Context

NTF is the last module of the B11 chain. The shared brief puts every side effect through the outbox; ADR-0010 forbids an
outside call inside a business transaction and makes every asynchronous subscriber record its inbox row with its effect.
FR-NTF-003 asks for one message per source event and recipient, with a database key; FR-DEL-012 for the customer's
messages at dispatch, on the way and delivered; the owner (2026-11-23) for each message's delivery recorded per channel,
so a failed one shows as failed. The parent session's rules for this phase: a message goes only to the order's or
customer's own contact, read at send time through the owning module; a link sent by message gets its own token from the
sending worker (ADR-0074); a rate limit per recipient; a provider's delivery report verified, idempotent, and changing
nothing but the delivery status; no real provider, no key. `docs/data-model/ntf.md` planned `ntf.message.address_enc`, an
encrypted copy of the address used, NOT NULL.

## Options considered

1. **Send inside the outbox consumer.** One step, but the provider is called with the consumer's transaction open (a
   slow provider holds a serializable transaction and its locks), and a retried delivery cannot tell "sent, not yet
   recorded" from "never sent".
2. **Queue in the consumer, send by a worker that claims messages.** The consumer writes the message with its inbox row;
   a worker claims due messages with `FOR UPDATE SKIP LOCKED` and a lease, calls the provider with no transaction open
   and the message id as its idempotency key, and records the attempt only while its claim holds.
3. **As 2, sending through BullMQ jobs.** A queue per channel, but Redis would become a second record of what was sent;
   ADR-0010 keeps the database the record and Redis a signal.

For the address: (a) keep `address_enc`, a copy of the number taken at queue time; (b) keep no address, read the
record's own contact through its module when the message is queued and again when it is sent.

## Decision

Option 2, with address (b).

- **Queue.** `ntf.customer-messages` consumes `ord.OrderDispatched`, `ord.OrderCollected`, `del.DeliveryOnTheWay`,
  `del.DeliveryRescheduled`, `del.DeliveryCancelled` and `del.DeliveryCompleted`. It renders the active template version
  for the event's code (the message keeps the version) and writes one `ntf.message`, keyed
  `<event id>:<code>:<channel>:<order id>` under `uq_message_idempotency`, in the consumer's transaction with its inbox row.
- **Recipient.** The order's own contact, `Orders.messageContactsIn` (the number the order was placed with, else its
  delivery's recipient, as dispatch addressed it), read when queued and again when sent; a number in an event's payload
  is never used. No address is stored: the log keeps the number masked and an HMAC of it under a key derived from the
  lookup key, which counts what one number was sent for the hourly limit (ten; the rest `SUPPRESSED` `RATE_LIMITED`).
- **Send.** The worker's `message-send` job claims up to fifty due messages in one short transaction (a two-minute lease
  and a token), calls the channel port outside any transaction with the message id as the idempotency key, then writes
  the attempt and the new state in a second short transaction, only while its token still holds the claim. A worker that
  died leaves its claim to expire; the next one sends with the same key, so a provider that honours it delivers once.
  Three attempts with backoff and jitter, then `FAILED`; a permanent refusal fails at once; the first temporary failure
  in a pass opens the circuit and hands the rest back.
- **Reports.** `receiveMessagingWebhook` checks the HMAC-SHA256 over the raw body first, logs every request in
  `ntf.provider_report`, applies a report once by the provider's report id, and moves only a `SENT` message to
  `DELIVERED` or `FAILED`; the database freezes everything else a message is.
- **Templates.** A version is drafted by one person and activated by another (`ck_template_maker_checker`); its text
  never changes; a template names only its code's merge fields and carries no link of its own.
- **Links.** A message that carries a link (the tracking and receipt SMS, B11 continued 11) gets it from the sending
  worker just before the provider call (ADR-0074); the stored text never holds a token.

## Consequences

- A message exists exactly when its business change committed, is queued once whatever the outbox redelivers, and is
  sent once by however many workers run; a forged or replayed report changes nothing.
- A message's number is the record's own at the moment it is sent: a corrected contact is used; an order that has lost
  its number gives a `SUPPRESSED` `NO_ADDRESS` message, visible in the log. The log cannot show the full number of a past
  message, only its mask (`docs/data-model/ntf.md` updated: `address_enc` is not built, `address_hash` is).
- Exactly once past a worker's death depends on the provider honouring the idempotency key (A-374 (f)); B13 confirms the
  chosen provider does.
- Binds `docs/data-model/ntf.md`, `docs/API.md` (NTF), `docs/OPERATIONS.md` (the `message-send` job), the NTF card of
  `docs/MODULE_BOUNDARIES.md` and B11 continued 11 (every later message kind follows the same two steps).

## Verification

- `test/integration/ntf/customer-messages.integration.spec.ts`: each customer message once, to the order's own contact
  whatever an event carries; a redelivered event, a replayed handler and a duplicate row; a rolled-back change; two
  workers at once; a worker that died mid-send; the hourly limit; three temporary failures to `FAILED`, the retry; the
  database's rules on the log.
- `test/integration/ntf/templates-and-reports.integration.spec.ts`: versions, the second person, no link, the merge
  fields; the signed reports, their replay and what they may change.
- `src/modules/ntf/domain/*.spec.ts` at 100 percent.
