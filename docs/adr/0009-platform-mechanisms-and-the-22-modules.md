# ADR-0009: Platform mechanisms versus the twenty-two modules

- **Status:** Proposed (awaiting B0 gate)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief lists twenty-two modules, including IAM, AUD, NTF, PAY, DOC and API. The build prompt's B3 section describes auth, authorization, audit, outbox, observability, storage, queue, notifications and payments as platform services that are cross-cutting and owned by no domain module, and asks for ports with one adapter each and no business logic. Read literally, the two statements give the same things two owners.

Two further pressures shape the answer.

- **A cycle.** Identity must write audit rows for every login and grant change. Audit administration (viewing the log, approving a deletion request) must check permissions and use approvals, which belong to identity. If the audit trail and identity are both modules, each imports the other.
- **Build order.** Product images are needed in B4 and the storefront needs image variants by slot 8, but document generation arrives in B8. Receipts by SMS are a POS requirement in B9, but the notification module arrives in B11.

## Options considered

1. **Everything cross-cutting is platform; the six module codes disappear.** Loses the requirement namespaces and puts business rules (refund approval, notification preferences) into a layer that is supposed to have none.
2. **No platform layer; the six modules own everything.** Then low-level mechanisms (the outbox, the audit writer, the payment provider adapter) live in modules that depend on higher ones, and cycles appear.
3. **Split by kind of thing.** Technical mechanisms with no business rules are platform. Business behaviour stays in the module with that code.

## Decision

Option 3.

**Platform (`src/platform`, schema `platform`)** holds mechanisms only:

| Mechanism | What it provides |
| --- | --- |
| Unit of work | Transactions, isolation level, retry, series locks, ambient transaction context |
| Actor context | The authenticated principal, session, IP address and correlation id of the current request, set by IAM's guard and readable everywhere |
| Audit trail | The audit writer and interceptor, per-subject encryption keys, the sealer, the verifier, the anchor (ADR-0006, ADR-0022) |
| Domain events and outbox | In-transaction dispatch, outbox table, dispatcher worker, inbox for idempotent consumers |
| Idempotency | The idempotency key store |
| Numbering and document registry | Gap-free series, `platform.business_document` |
| Settings store | Typed key-value settings, read by every module |
| File store | Upload validation, object storage port, signed URLs, access log, image variants |
| Ports with adapters | Payment provider, notification channel (SMS, WhatsApp, email), PDF renderer, queue |
| Observability | Logging, tracing, metrics, health endpoint |

Platform code contains no permission codes, no approval thresholds, no account codes, no templates and no preferences. It does not decide who may do something; it records, stores, sends and locks.

**How the contested codes divide**

| Code | Platform mechanism (built in B2 and B3) | Module (business behaviour) |
| --- | --- | --- |
| IAM | Actor context | Everything else: accounts, credentials, sessions, roles, grants, the policy engine, maker-checker approvals. B3's "auth" and "authorization" are the IAM module, the lowest module in the stack |
| AUD | The audit trail | Viewing and searching the audit log, audited administration of settings, feature flags, number series and the business profile, retention policy, data-subject requests |
| PAY | Payment provider port and adapter | Payments, allocation, refunds, webhook handling, reconciliation |
| NTF | Notification channel port and adapters | Templates, preferences, opt-out, quiet hours, message log, retries |
| DOC | File store, PDF renderer port | Document templates, rendering, the immutable archive, reprint |
| API | Outbox, idempotency | Integrations, outbound webhooks, API key administration, accounting export |

This removes the cycle: IAM writes audit rows through the platform audit trail, and the AUD module sits above IAM and uses its policy engine and approvals.

**Two consequences for build order**

- Product photographs (B4) and image variants use the platform file store directly, so they do not wait for DOC in B8.
- Modules never call NTF. They publish events; NTF subscribes when it arrives in B11, and from then on receipts, quotes and delivery updates are sent. The one exception is IAM, which sends one-time codes and password reset messages straight through the notification channel port, because those must not be stored in an outbox payload and are not subject to preferences or quiet hours.

## Consequences

- Every requirement in the brief keeps a single owning module code, and every table has one owner. The audit trail tables are in the `platform` schema, not `aud`.
- Platform stays free of business rules, so it can be finished in B2 and B3 and left alone.
- SMS receipts for counter sales start working when NTF lands in B11, not in B9. This matches the schedule as written and is noted for the frontend track.
- Binds: `docs/MODULE_BOUNDARIES.md`, `docs/ARCHITECTURE.md`, the B3 session.

## Verification

- B3: the boundary lint rule forbids `src/platform` from importing any module.
- B3: a review check that no file under `src/platform` contains a permission code, an account code or a threshold.
