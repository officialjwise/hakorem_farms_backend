# ADR-0014: Idempotency keys and external references are unique keys in the database

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief requires that every external call is idempotent and carries an idempotency key the database enforces as unique, and that idempotency keys, external payment references and webhook event ids are all unique keys, so a replay collides rather than duplicating. A weak mobile connection at the counter or on the road will retry requests as a matter of course.

## Options considered

1. **Idempotency in Redis with a time to live.** Fast, but not transactional with the business change, and lost if Redis is.
2. **Natural keys only.** Works where a natural key exists (a webhook event id) and nowhere else.
3. **A key table in PostgreSQL written in the business transaction, plus unique constraints on every natural external reference.**

## Decision

Option 3.

**Inbound requests**

- Every state-changing endpoint requires an `Idempotency-Key` header (a UUID). The contract declares it once and reuses it.
- `platform.idempotency_key` has a unique key on (`scope`, `key`), where scope is the principal and the operation. The row stores a hash of the request, and on completion the response status and body.
- The row is inserted as the first write of the business transaction. Outcomes:
  - no existing row: proceed, and store the response before commit;
  - existing completed row with the same request hash: return the stored response;
  - existing row with a different request hash: reject with a conflict error;
  - a concurrent duplicate hits the unique key, waits for the first transaction and then sees its result.
- Rows are kept for at least 72 hours, longer than the longest offline window, and then purged.
- Records created offline use their client-generated id as the key (ADR-0013). The two batch sync operations (`syncOfflineSales`, `syncDriverEvents`) therefore take no `Idempotency-Key` header: each record in the batch carries its own client id, and a resubmitted record returns its first outcome. The other operations without the header are login and token endpoints, inbound webhooks (which use the provider's event id), and POSTs that change nothing (price resolution, tax calculation, previews, signed links, status lookups). `docs/API.md` lists them.

**Inbound webhooks**

- `pay.webhook_event` has a unique key on (`provider`, `event_id`). A replayed event collides and is acknowledged without effect.
- Signature, timestamp window and amount re-verification are in `docs/security/SECURITY_ARCHITECTURE.md`.

**Outbound calls**

- Every outbound request to a provider carries an idempotency key derived from the outbox message id, so a retried delivery cannot charge, refund or send twice.
- `pay.payment.provider_reference`, `pay.refund.provider_reference` and `ntf.message.idempotency_key` are unique.

**Asynchronous consumers**

- `platform.inbox_message` has a primary key on (`consumer`, `message_id`) (ADR-0010).

## Consequences

- A retry at any layer is safe: the same request, the same webhook and the same outbox delivery each produce one effect.
- Clients must generate and keep a key per user action. The frontend's generated client and offline queue do this.
- The key table is written on every state-changing request. It is small, indexed by its unique key and purged by a scheduled job.
- Binds: `docs/data-model/platform.md`, `docs/API.md` (B1), the `hakorem-endpoint` skill.

## Verification

- B3: tests for each of the four outcomes above, including two concurrent identical requests producing one effect.
- B9a: every payment edge case in the brief: timeout after charge, webhook before API response, webhook twice, webhook for a missing order, refund failure after stock release.
