# ADR-0009: Platform mechanisms versus the twenty-two modules

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief lists twenty-two modules, including IAM, AUD, NTF, PAY, DOC and API. The build prompt's B3 section describes auth, authorization, audit, outbox, observability, storage, queue, notifications and payments as platform services that are cross-cutting and owned by no domain module, and asks for ports with one adapter each and no business logic. Read literally, the two statements give the same things two owners.

The build order adds a second pressure. Product images are needed in B4 and the storefront needs image variants by slot 8, but document generation arrives in B8. Receipts by SMS are a POS requirement in B9, but the notification module arrives in B11.

## Options considered

1. **Everything cross-cutting is platform; the six module codes disappear.** Loses the requirement namespaces and puts business rules (refund approval, notification preferences) into a layer that is supposed to have none.
2. **No platform layer; the six modules own everything.** Then low-level mechanisms (the outbox, the payment provider adapter) live in modules that depend on high-level ones, and cycles appear.
3. **Split by kind of thing.** Technical mechanisms with no business rules are platform. Business behaviour stays in the module with that code. IAM and AUD, which every module needs, are foundation modules at the bottom of the module stack.

## Decision

Option 3.

**Platform (`src/platform`, schema `platform`)** holds mechanisms only:

| Mechanism | What it provides |
| --- | --- |
| Unit of work | Transactions, isolation level, retry, series locks, ambient transaction context |
| Domain events and outbox | In-transaction dispatch, outbox table, dispatcher worker, inbox for idempotent consumers |
| Idempotency | The idempotency key store |
| Numbering and document registry | Gap-free series, `platform.business_document` |
| Settings store | Typed key-value settings, read by every module |
| File store | Upload validation, object storage port, signed URLs, access log, image variants |
| Ports with adapters | Payment provider, notification channel (SMS, WhatsApp, email), PDF renderer, queue |
| Observability | Correlation id, logging, tracing, metrics, health endpoint |

Platform code contains no approval thresholds, no account codes, no templates and no preferences.

**Foundation modules** sit directly above platform and may be imported by every other module:

- **IAM** owns identity, sessions, roles, grants, the policy engine and the maker-checker approval mechanism. B3's "auth" and "authorization" are the IAM module.
- **AUD** owns the audit trail (writer, sealer, verifier), audited administration of settings and number series, retention and data-subject requests. B3's "audit" is the audit-trail core of the AUD module.

**The other contested codes** keep their business behaviour and use the platform mechanism:

| Code | Uses platform | Owns as a module |
| --- | --- | --- |
| PAY | Payment provider port and adapter | Payments, allocation, refunds, webhook handling, reconciliation |
| NTF | Notification channel port and adapters | Templates, preferences, opt-out, quiet hours, message log, retries |
| DOC | File store, PDF renderer port | Document templates, rendering, the immutable archive, reprint |
| API | Outbox, idempotency | Integrations, outbound webhooks, API key administration, accounting export |

**Two consequences for build order**

- Product photographs (B4) and image variants use the platform file store directly, so they do not wait for DOC in B8.
- Modules never call NTF. They publish events; NTF subscribes when it arrives in B11 and from then on receipts, quotes and delivery updates are sent. The one exception is IAM, which sends one-time codes and password reset messages straight through the notification channel port, because those must not be stored in an outbox payload and are not subject to preferences or quiet hours.

## Consequences

- Every requirement in the brief keeps a single owning module code, and every table has one owner.
- Platform stays free of business rules, so it can be finished in B2 and B3 and left alone.
- SMS receipts for counter sales start working when NTF lands in B11, not in B9. This matches the schedule as written and is noted for the frontend track.
- Binds: `docs/MODULE_BOUNDARIES.md`, `docs/ARCHITECTURE.md`, the B3 session.

## Verification

- B3: the boundary lint rule forbids `src/platform` from importing any module.
- B3: a review check that no file under `src/platform` contains a permission code, an account code or a threshold.
