# ADR-0010: Commands flow down, events flow up, side effects go through the outbox

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires that a sale which writes stock movements, a ledger entry, an invoice and a payment lands whole or not at all, that modules talk through published interfaces and domain events inside the process, and that every side effect (notifications, webhooks, search indexing) is written to an outbox in the same transaction and dispatched by a worker, so that a sale and its receipt cannot disagree. No broker is mandatory in version one.

## Options considered

1. **Everything through asynchronous events.** Loose coupling, but stock, invoice and payment would become eventually consistent, which the brief forbids.
2. **Everything through direct calls.** Atomic, but every module must know every consumer, and modules built early must be reopened whenever a later one arrives.
3. **Direct calls downward for work the caller needs done, events upward for everything that reacts.** Events have two delivery modes: inside the transaction for consistency-critical subscribers, and through the outbox for the rest.

## Decision

Option 3.

**Commands down.** A module calls a lower-layer module's public interface when it needs that module to do something as part of its own operation. The call joins the caller's transaction through the ambient transaction context. Example: completing a sale, the order module calls inventory to issue stock, billing to issue the document, and payments to record the tenders.

**Events up.** A module publishes a domain event when something has happened. Publishing does two things in the current transaction:

1. Runs every **transactional subscriber** synchronously. If one throws, the transaction rolls back. Only three kinds of subscriber may be transactional: ledger posting (ADR-0003), a module keeping its own aggregate consistent with a lower module's fact (livestock marking an animal slaughtered when inventory consumes it), and trigger-style projections that must be exact.
2. Writes the event to `platform.outbox_message`.

After commit, the dispatcher worker delivers each outbox message to every **asynchronous subscriber** (notifications, outbound webhooks, reporting read models, costing projections, search), at least once. Each subscriber records the message id in `platform.inbox_message` in the same transaction as its own effect, so a redelivery is a no-op.

**Event envelope**

`id` (UUIDv7), `type` (`<module>.<AggregatePastTense>`, for example `inv.StockMovementPosted`), `version`, `occurred_at`, `recorded_at`, `actor_id`, `branch_id`, `correlation_id`, `causation_id`, `subject_type`, `subject_id`, `payload`.

Events carry the data a subscriber needs, including recipient references and rendering data for notifications, so subscribers do not call back for it. Events never carry secrets, and personal data is limited to what the subscriber needs.

**Rules**

- No external call (payment provider, SMS, email, object storage write of a rendered document) happens inside a business transaction. It is requested through the outbox and performed by a worker with a timeout, bounded retry with jitter, and a circuit breaker.
- Outbox delivery state lives in `platform.outbox_delivery`, one row per message and consumer, with attempts, next attempt time and a `DEAD` status that is the dead letter queue.
- The dispatcher orders delivery per subject, so a consumer sees one aggregate's events in order.
- Event contracts are versioned. A breaking change is a new version published alongside the old one for one release.
- BullMQ on Redis carries the work signals. The outbox table is the durable record: if Redis is lost, the dispatcher rebuilds its queue from undelivered rows.

**Orchestration ownership**

The module that owns the business operation opens the transaction and orchestrates. For a sale on any channel that is the order module (ADR-0026). For a processing run it is the processing module. Lower modules never call upward; they publish.

## Consequences

- A sale is atomic across stock, billing, payment and ledger, with no distributed transaction.
- Modules can be added later as subscribers without editing the publisher.
- A transactional subscriber makes the publisher's transaction fail when the subscriber fails. This is intended for the ledger and is why the list of permitted transactional subscribers is short.
- The health endpoint reports outbox backlog and the oldest undelivered message, as the brief requires.
- Binds: `docs/ARCHITECTURE.md` event flow, `docs/data-model/platform.md`, the B3 outbox build.

## Verification

- B3: a test that a business change and its outbox row commit or roll back together.
- B3: a test that a redelivered message produces no second effect.
- B3: a test that a failing asynchronous subscriber is retried with backoff and ends in `DEAD` after the configured attempts, with the health endpoint reporting it.
- B8: a test that a ledger posting failure rolls back the originating stock movement.
