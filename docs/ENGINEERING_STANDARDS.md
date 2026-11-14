# HaKorem Farms Platform: Engineering Standards

How code, SQL, commits, branches and pull requests are written in this repository. The architecture is in `docs/ARCHITECTURE.md` and the ADRs; this document is the daily practice that keeps the code in that shape. The security rules a pull request is checked against are in `docs/security/SECURE_CODING_STANDARDS.md` (rule ids `SC-nn`), and the test rules are in `docs/TEST_STRATEGY.md`. Where this document and an ADR disagree, the ADR wins and this document is corrected.

Stack: TypeScript 5 (strict), Node 22, NestJS 11, PostgreSQL 17, Drizzle with plain SQL migrations, Redis 7 with BullMQ, Vitest, Pino, OpenTelemetry, Sentry, pnpm.

## 1. Naming

### 1.1 Files and folders

| Thing | Rule | Example |
| --- | --- | --- |
| Folders | `kebab-case`, lower case | `stock-take/` |
| TypeScript files | `kebab-case.<role>.ts`, where `<role>` says what the file is | `post-stock-take-variance.command.ts`, `stock-unit.aggregate.ts`, `stock-movement.repository.ts`, `stock-movement.table.ts`, `stock.controller.ts`, `adjust-stock.schema.ts`, `stock-movement-posted.event.ts` |
| Roles in use | `.aggregate`, `.entity`, `.value-object`, `.domain-service`, `.command`, `.query`, `.handler`, `.port`, `.repository`, `.adapter`, `.table`, `.controller`, `.schema`, `.subscriber`, `.event`, `.module`, `.policy`, `.errors`, `.mapper` | |
| One public class or function per file | The file is named for it. A small group of closely related value types may share a file | |
| Tests | `<subject>.spec.ts` beside the code for unit tests; the other layers live under `test/` (`docs/TEST_STRATEGY.md`) | `money.spec.ts` |
| SQL migrations | `<sequence>_<schema>_<verb>_<subject>.sql`, sequence four digits | `0042_inv_add_stock_take_variance.sql` |
| Documents | `UPPER_SNAKE.md` for the system documents; ADRs `NNNN-kebab-title.md`; session reports `<ID>-<slug>.md` | `docs/sessions/B05-inventory-ledger.md` |

No `utils.ts`, `helpers.ts`, `common.ts` or `index.ts` barrel other than the module's public `index.ts` (ADR-0008). A function that is used by one module lives in that module; one used by many is a platform mechanism (ADR-0009) or kernel code.

### 1.2 Identifiers in code

| Thing | Rule | Example |
| --- | --- | --- |
| Classes, interfaces, types, enums | `PascalCase`. Interfaces have no `I` prefix | `StockUnit`, `PostStockTakeVarianceCommand` |
| Functions, methods, variables | `camelCase`, a verb for a function | `postVariance`, `resolvePrice` |
| Constants | `UPPER_SNAKE_CASE`, named; no magic numbers (`MAX_REPLAY_ATTEMPTS`, `SERIALIZATION_RETRY_LIMIT`) | |
| Booleans | Read as a question: `isFrozen`, `hasApproval` | |
| Commands | Imperative verb phrase plus `Command` | `PostStockTakeVarianceCommand` |
| Queries | `Get`, `List` or `Find` plus `Query` | `ListStockOnHandQuery` |
| Handlers | The command or query name with `Handler` | `PostStockTakeVarianceHandler` |
| Ports | The capability with `Port`; the adapter names the technology | `PaymentProviderPort`, `PaystackAdapter` |
| Repositories | Aggregate name plus `Repository` | `StockUnitRepository` |
| Errors | Reason plus `Error`, with a stable code | `InsufficientStockError`, code `INSUFFICIENT_STOCK` |
| Money, weight, quantity | Kernel types; names say the unit: `unitPricePesewas`, `weightKg` | |

### 1.3 Events

- The event type string is `<module>.<AggregatePastTense>` with the lower-case module code and the aggregate and past participle in `PascalCase` (ADR-0010): `inv.StockMovementPosted`, `ord.SalesOrderConfirmed`, `pay.PaymentCleared`, `bil.BillingDocumentIssued`.
- The class is the same name without the module prefix, in `events.ts`: `StockMovementPosted`. Its `type` constant is the full string.
- An event name states a fact that has happened, never a command (`StockMovementPosted`, not `PostStockMovement`).
- A breaking change to a payload publishes a new `version` beside the old one for one release.

### 1.4 Permissions

`<module>.<resource>.<action>`, all lower case, words inside a resource joined with an underscore, as seeded in `iam.permission` (ADR-0017): `inv.adjustment.approve`, `pur.supplier_invoice.match`, `rpt.exceptions.read`, `del.delivery.read.assigned`.

- Actions come from a small vocabulary: `read`, `create`, `update`, `archive`, `approve`, `manage`, `post`, `pay`, `reprint`, plus a domain verb where it is the honest name (`confirm`, `dispatch`, `void`). A trailing qualifier (`.assigned`, `.own`) marks an ownership-limited form.
- A new permission is granted to no role until a migration adds it to one.
- The contract names it in `x-permission` on every staff operation; the code and the contract must agree.

### 1.5 Database

Per `docs/DATA_MODEL.md`: schema is the lower-case module code (or `platform`); tables and columns `snake_case`, singular; foreign key columns `<referenced_table>_id`; ids of other modules held without a key are `*_ref`; suffixes `_pesewas`, `_kg`, `_qty`, `_percent`, `_at`, `_on`, `_enc`, `_hash`, `_no`, `_code`; indexes `ix_<table>_<columns>`, unique `uq_…`, checks `ck_…`, foreign keys `fk_…`, exclusion `ex_…`. Enumerations are `TEXT` with a `CHECK`, upper snake values. Every table declares its class (ADR-0012) and its data category (`docs/security/DATA_CLASSIFICATION.md`) in the migration.

### 1.6 API

Per ADR-0029 and `contract/openapi.yaml`:

- JSON fields `camelCase`; paths `kebab-case`, plural nouns, versioned under `/v1`.
- Money is an integer in a field ending `Pesewas`, with `currency` on the object; cost and price are never the same field; totals come from the API.
- Weights, quantities, percentages, units and coordinates are decimal strings with fixed patterns.
- Enumerations are `UPPER_SNAKE_CASE`.
- Times are UTC RFC 3339; business dates are calendar dates in Africa/Accra.
- Every non-2xx response is the one error envelope, with a stable `UPPER_SNAKE_CASE` `code`.
- A business refusal is 422; a version mismatch or a reused idempotency key is 409; an action needing a second person is 202 `ApprovalPending`.
- Updates send the `version` they read. Lists use cursor pagination.
- Headers: `Idempotency-Key` on every state-changing request; `X-CSRF-Token` on cookie-authenticated ones; `X-Correlation-Id` on every response.

### 1.7 Other names

| Thing | Rule | Example |
| --- | --- | --- |
| Environment variables | `UPPER_SNAKE_CASE`, validated at boot | `DATABASE_URL`, `PAYSTACK_SECRET_KEY` |
| Settings keys | Dotted lower case in `platform.setting` | `tax.registered`, `cap.retention_rate` |
| Reason and movement codes | `UPPER_SNAKE_CASE`, a lookup table where behaviour hangs on them | `COUNT_CORRECTION` |
| Queues and jobs (BullMQ) | `<module>.<verb-noun>` in lower case | `doc.render-document` |
| Metrics | `hk_<module>_<thing>_<unit>` | `hk_outbox_oldest_age_seconds` |
| Log message | A lower-case sentence fragment stating what happened | `order confirmed` |

## 2. Folder layout per module (ADR-0008)

```text
packages/kernel/                  Money, Weight, Quantity, allocate, ids (UUIDv7), Clock, Result. Imports nothing
src/platform/                     technical mechanisms, no business rules (ADR-0009). Imports only the kernel
src/modules/<code>/
  index.ts                        the public interface: the only runtime import other modules may use
  events.ts                       published event contracts, types only
  <code>.module.ts                NestJS module
  domain/                         aggregates, value objects, domain services. Pure
  application/                    commands, queries, handlers, ports
  infrastructure/                 Drizzle tables, repositories, adapters
  interface/                      controllers, request schemas, event subscribers
test/
  integration/<module>/           <subject>.integration.spec.ts
  contract/<module>/              <subject>.contract.spec.ts
  e2e/                            flows
  smoke/                          deployed-environment checks
  load/                           k6 scripts
  factories/                      test data builders
migrations/                       plain SQL
contract/openapi.yaml             the interface, generated from code
```

Rules (enforced by `eslint-plugin-boundaries` in `pnpm lint`; the full specification is `docs/MODULE_BOUNDARIES.md`):

1. A module imports another module only through that module's `index.ts`, and only if the other is in a lower layer. Any module may import another's `events.ts` with `import type` to subscribe.
2. `domain/` imports only `packages/kernel` and its own files. It never imports NestJS, Drizzle, `application/`, `infrastructure/` or `interface/`.
3. `application/` imports `domain/` and ports. `infrastructure/` and `interface/` import `application/` and `domain/`.
4. A module's code reads and writes only its own schema. A cross-module foreign key is allowed only as listed in ADR-0011 and `docs/MODULE_BOUNDARIES.md` section 5. Never join, select or insert into another module's tables, even through raw SQL. Ask the module through its `index.ts`, or subscribe to its events.
5. Nothing imports from the frontend repository and no path leaves `backend/`.
6. Import cycles are an error.

Build order inside a module is domain, then application, then infrastructure, then interface. The domain is tested first and without any framework.

## 3. Error handling

1. **Two kinds of failure.** A *business refusal* is expected: insufficient stock, a price that does not resolve, a closed period. It is returned as a typed `Result` from the domain and application layers, or thrown as a `BusinessRuleError` subclass at the edge of a handler, and mapped to 422 with a stable code. An *unexpected error* is a bug or an outage: it is logged with context and returned as 500 with the correlation id and a generic message.
2. **No empty catch blocks** (SC-15). A `catch` handles the error meaningfully or rethrows with context (`new XError('what failed', { cause: err, ...ids })`). It never returns a default to hide a failure. `catch` that only logs is allowed only where the caller does not need to know, and the line says why.
3. **Errors carry a code and the ids needed to act**, never secrets or personal data (SC-07, SC-08).
4. **One mapping point.** A global exception filter maps errors to the envelope (SC-16): `code`, a translated `message`, `correlationId`, `details` (field errors for validation). Nothing else writes an error response.
5. **Error codes are a catalogue** in `docs/API.md` and the contract. A new code is added to both in the same pull request.
6. **Idempotent replay is not an error.** A unique-key collision on an idempotency key, webhook event id or provider reference is handled as a replay (ADR-0014).
7. **Domain code never throws `Error` or strings.** It throws or returns typed errors.
8. **Database errors** are translated at the repository boundary: a constraint violation that the domain understands (`uq_…`, `ck_…`) becomes a typed error; anything else is wrapped and rethrown.
9. **Retries** exist only where they are designed: serialization failures in the unit of work (section 6), outbox delivery, provider calls with a circuit breaker. Do not add a retry loop around a test or a call to make it pass.

## 4. Logging

- **Pino** JSON logs through one shared logger. `console.log` and its siblings are banned by lint.
- **Correlation id.** Assigned in the first middleware (or taken from a valid incoming header), stored in `AsyncLocalStorage`, and attached automatically to every log line, every OpenTelemetry span, the audit event and every outbox message the request causes. A job or subscriber continues the id from the message's `correlation_id`.
- **Levels.** `error`: an unexpected failure that needs a person. `warn`: something degraded but handled (a retry, a fallback, a rejected webhook). `info`: a business event worth reading in a disputed-sale investigation. `debug`: development detail, off in production. Do not log inside tight loops.
- **Shape.** A message that states what happened, and a flat object of identifiers and outcomes: `log.info({ orderId, branchId, outcome: 'CONFIRMED' }, 'order confirmed')`.
- **Never log** (`docs/security/DATA_CLASSIFICATION.md`): passwords, tokens, cookies, one-time codes, API keys, key material, webhook secrets, request or response bodies, card data, payment identifiers, full phone numbers (the scrubber keeps the last three digits), names, addresses, emails, identity or tax numbers, bank or wallet details, rendered document content. A new sensitive field is added to the scrubber and to the scrubbing test (SC-08).
- **Audit is not logging.** A business action that must be provable is an audit event in the transaction (SC-24); a log line is not evidence.
- **Errors** are logged once, where they are handled, with `err` and the ids, not at every layer they pass through.
- Logs go to stdout, are shipped off the server, and are kept per `DATA_CLASSIFICATION.md` section 4.2 (DC-17).

## 5. Validation

Validation is layered, and each layer does a different job.

| Layer | What it checks | Where | Rule |
| --- | --- | --- | --- |
| Boundary | Shape, types, ranges, formats, unknown fields rejected | Request schema in `interface/`, once, producing a typed command (SC-01) | Handlers never see raw input |
| Domain | Business invariants: a price resolves, stock is sufficient, a period is open, a hold blocks a sale | Aggregates and domain services, pure | Returns typed refusals; no framework |
| Database | The rules that must hold even if code is bypassed: sign and size of money, balanced journals, gap-free numbers, unique idempotency keys, maker differs from checker, frozen documents | `CHECK`, `UNIQUE`, foreign keys, triggers | Application checks are in addition, never instead (`docs/security/SECURITY_ARCHITECTURE.md` principle 2) |

Also: weights and quantities are decimal strings at the boundary and kernel types inside; dates are parsed in Africa/Accra for business dates and UTC for instants; ids are UUIDs checked at the boundary; free text has a maximum length; a field the client must not set is not in the schema.

## 6. Transactions and the unit of work (ADR-0005)

1. **One business operation is one database transaction.** A sale that writes stock movements, a ledger entry, an invoice and a payment lands whole or not at all.
2. **Use the unit of work** (`uow.run(options, fn)`) in the outermost command handler. Repositories receive the transaction (`tx`) from the ambient context; they never open their own. No nested transactions.
3. **Declare the isolation level at the outermost handler**, because it cannot be raised after the first query. Stock movements, reservations and anything that publishes an event the ledger posts from run at `serializable` (sale completion, invoice issue, payment clearing, goods receipt, processing completion, mortality and adjustment posting, period lock and close, shift close, stock-take posting, credit-checked order confirmation, distribution posting). Everything else runs at `read committed`. The stock and ledger entry points assert the isolation level and refuse otherwise (SC-23).
4. **Document-number series locks** are session-level advisory locks taken by the unit of work before `BEGIN`, in sorted order, for the series the command declares, and released after commit or rollback. The number is allocated as the first write (ADR-0015). Never take `pg_advisory_xact_lock` as the first statement inside the transaction.
5. **Retry the whole command** on SQLSTATE 40001 and 40P01, up to five attempts with jittered backoff, then fail with a typed error. Therefore a command handler is **re-runnable**: it reads inside the transaction, has no side effect outside it, and never calls an external service (SC-14).
6. **Idempotency key first.** The first write of a state-changing transaction is the idempotency key row (SC-06).
7. **Aggregates carry `version`** and are saved with a version check; a mismatch is a 409. A serialised animal's stock unit row is locked `FOR UPDATE` before the sale.
8. **Keep to point reads** in posting transactions: primary-key and index lookups only, because a sequential scan under serializable takes a relation-level predicate lock.
9. **A transaction modifies one aggregate root per module.** A cross-module operation is one transaction orchestrated by the module that owns the operation, calling lower modules' public interfaces (commands down) and publishing events (events up).
10. **Statement and lock timeouts** are set; a report never runs on the transactional role (ADR-0023).
11. **The audit event is written in the same transaction** (SC-24).

## 7. Events and the outbox (ADR-0010)

- A module publishes a domain event when something has happened, from the aggregate's result, through the unit of work. Publishing inserts into `platform.outbox_message` in the same transaction.
- **Transactional subscribers** run in the publisher's transaction and may roll it back. Only three kinds are allowed: ledger posting, a module keeping its own aggregate consistent with a lower module's fact, and exact trigger-style projections. Anything else is asynchronous.
- **Asynchronous subscribers** (notifications, outbound webhooks, reporting read models, costing projections, search, document rendering) receive the message from the dispatcher at least once. Each records `(consumer, message_id)` in `platform.inbox_message` in the same transaction as its effect, so redelivery is a no-op.
- **Envelope:** `id`, `type`, `version`, `occurred_at`, `recorded_at`, `actor_id`, `branch_id`, `correlation_id`, `causation_id`, `subject_type`, `subject_id`, `payload`. The payload carries what a subscriber needs so it never calls back. Never secrets; personal data only as far as the subscriber needs it.
- **No external call inside a business transaction.** Request it through the outbox; a worker performs it with a timeout, bounded retry with jitter and a circuit breaker.
- Delivery is ordered per subject. A failing consumer is retried with backoff and ends `DEAD` after the configured attempts, which the health endpoint reports.
- A module must not publish an event it does not own, and must not subscribe to anything but `events.ts` contracts.

## 8. Money, time and identifiers

- Money is integer pesewas in the kernel `Money` type. Never `number` for money, quantity or weight in a file that imports `Money` (lint). Percentages are decimals from strings. Round half-up once at the line anchor; split only with `allocate` (SC-05, ADR-0001).
- Time comes from the kernel `Clock`, never `new Date()` or `Date.now()` in domain or application code, so tests control it. Instants are UTC; business dates are calendar dates in Africa/Accra.
- Identifiers are UUIDv7 from the kernel (ADR-0013). Offline clients generate their own.
- No magic numbers: a threshold, limit or timeout is a named constant or a setting.

## 9. Configuration, secrets and text

- Configuration is typed, validated at boot, and fails with the name of the missing key (SC-07). Business settings live in `platform.setting`, edited through the audited administration. Secrets never do.
- Every user-facing string from the API (error messages, templates, document labels) goes through the translation layer. English ships first. No string concatenation for sentences.
- No placeholder markers (the shared brief's no-placeholder rule), no commented-out code, no skipped test, no hard-coded secret in a merged change. A deferred idea goes to `docs/BACKLOG.md` with a pointer.

## 10. Commits

Conventional Commits, one concern per commit, with the test in the same commit as the code it covers.

```text
<type>(<scope>): <imperative summary, lower case, no full stop> (<requirement id>)

<body: why, not what, when it is not obvious>

<footer: refs, breaking change>
```

Example: `feat(inventory): post stock take variance (FR-INV-031)`.

- **Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. A database change is `feat`, `fix` or `refactor` with scope `db` or the module.
- **Scope** is the module's name or a cross-cutting area:

| Module code | Scope | Module code | Scope |
| --- | --- | --- | --- |
| `iam` | `iam` | `ord` | `orders` |
| `mdm` | `master-data` | `del` | `delivery` |
| `liv` | `livestock` | `bil` | `billing` |
| `inv` | `inventory` | `pay` | `payments` |
| `prc` | `processing` | `fin` | `finance` |
| `pur` | `purchasing` | `cap` | `capital` |
| `pos` | `pos` | `cst` | `costing` |
| `whl` | `wholesale` | `rpt` | `reporting` |
| `quo` | `quotes` | `ntf` | `notifications` |
| `shp` | `shop` | `doc` | `documents` |
| `aud` | `audit` | `api` | `integrations` |

Cross-cutting scopes: `platform`, `kernel`, `contract`, `db`, `infra`, `ci`, `deps`, `security`, `test`, `docs`.

- **Requirement id:** every `feat` and `fix` that implements or repairs a requirement names it, `FR-<MODULE>-<nnn>` or `NFR-<nnn>`, from `docs/SRS.md`. A commit with no requirement (a refactor, a dependency bump) says why in the body.
- **Breaking contract change:** the footer says `BREAKING CHANGE:`, the contract version is bumped and `docs/CONTRACT_CHANGELOG.md` has an entry (CLAUDE.md).
- **Never commit** a failing or skipped test without an issue referenced in the message; `.env`, a key, a dump of real data or anything under `infra/secrets/`; generated files that CI regenerates, except `contract/openapi.yaml`, which is committed and compared.
- Commit before pushing; push before a session ends. Run `git remote -v` first and confirm the remote is `hakorem_farms_backend`.

## 11. Branches, pull requests and merging

- **One branch per session**, named for it: `<session id in lower case, two digits, optional letter>-<slug>`: `b05-inventory-ledger`, `b09a-order-core-payments`, `b09b-pos-offline-sync`. A continued session is `b05b-…`. A small fix after merge is `fix/<slug>`; a documentation-only change `docs/<slug>`.
- **One pull request per branch**, opened at the end of the session (or earlier as a draft). The title is a Conventional Commit line; the squash commit message is the title and body. The description answers: what was built, the requirement ids, the contract change (version and changelog line), the tests that prove it, the data classification and security answers (`DATA_CLASSIFICATION.md` section 6), the migrations and whether they are expand or contract, and any deferred item.
- **CI must be green** before merge: lint (including the boundary rule), type check, unit, integration, contract, build, end to end, then the security scans. A high-severity finding blocks.
- **Squash merge** into `main`; no merge commits and no force pushes to `main`. Delete the branch after merge. `main` is protected: a reviewer's approval and green CI are required, and an author does not approve their own pull request.
- **Pipeline after merge** (`docs/BUILD_PROMPT.md`): `main` builds the image tagged by commit SHA, deploys to staging and runs the smoke suite; production deploy is a manual approval step on the same workflow.
- **Session report** `docs/sessions/<ID>-<slug>.md` is part of the pull request.

## 12. Migrations

Plain SQL, reviewed like code, run by the one-shot migration container as `hk_migrator` (the application role has no DDL in any environment).

1. **One schema per file.** A migration touches one schema (ADR-0008) and, for a table, declares its class and data category in a comment. A change spanning schemas is several files in sequence.
2. **Expand, then contract.** One release must run against the previous schema. Expand: add nullable columns, new tables, new indexes, new constraints as `NOT VALID` then `VALIDATE`. Deploy code that works with both. Contract, in a **later release**: drop the old column or constraint once nothing reads it. Never rename or drop in the same release as the code that stops using it.
3. **No destructive step without a documented path back.** Every migration has a tested rollback (`db:rollback`) or a documented forward fix in a header comment (`-- forward-fix: …`). A drop of data is contract-phase only and has a backup note.
4. **Never edit an applied migration.** A change is a new file.
5. **Constraints and triggers live in the migration**, not only in code: balanced journals, gap-free numbering, stock sign, unique idempotency keys, frozen documents, maker differs from checker. A new `LEDGER` table also gets the update, delete and truncate triggers.
6. **Grants follow the table class** (ADR-0012, ADR-0024), written in the migration. The schema test compares class to privileges.
7. **Lookup seeds** (`LOOKUP` tables: permissions, movement types, document types, posting event types) are inserted by migration. A migration that seeds business-looking data is marked as seed and is refused in production.
8. **Indexes on large tables** use `CREATE INDEX CONCURRENTLY` in their own file, because it cannot run in a transaction.
9. **Backfills** run in batches outside the DDL transaction and are idempotent.
10. **Types:** `TIMESTAMPTZ` only; money as `platform.pesewas`; no `VARCHAR(n)`; enumerations as `TEXT` with `CHECK`.
11. **Test the upgrade:** the integration suite applies the previous release's schema, then the new migrations, then runs the new code (`docs/TEST_STRATEGY.md`).
12. Production migrations wait for manual approval after running on staging. Staging and production never share a database.

## 13. Review checklist

A reviewer works through this list. Anything that fails blocks the merge; the comment cites the id. `SC-nn` refers to `docs/security/SECURE_CODING_STANDARDS.md`.

**Scope and process**

- [ ] The pull request is one concern, one session, and names its requirement ids.
- [ ] The commit messages follow section 10; the test is in the same commit as the code.
- [ ] No placeholder markers, commented-out code, skipped test, hard-coded secret or magic number.
- [ ] The documentation changed in the same pull request: the relevant `docs/` file, the API description, an ADR if a decision was made, and `docs/CONTRACT_CHANGELOG.md` for a contract change.
- [ ] The contract regenerated with no unexplained diff; `x-permission` present on every staff operation; money fields follow ADR-0029.

**Structure**

- [ ] The lint boundary rule passes; no other module's table is touched; imports go through `index.ts`.
- [ ] Domain code is pure: no NestJS, no Drizzle, no clock, no I/O.
- [ ] Names follow section 1; events are `<module>.<Name>` in past tense; permissions follow `<module>.<resource>.<action>`.

**Correctness and money**

- [ ] No `number` for money, quantity or weight; rounding once at the anchor; splits through `allocate` (SC-05).
- [ ] Every money, stock, weight, tax or permission calculation has a test asserting an exact value, including a rounding edge case.
- [ ] Stock and ledger tables are never updated or deleted; corrections are reversing rows (SC-22).
- [ ] Rules that must hold are also in the database.

**Transactions and events**

- [ ] The isolation level is declared at the outermost handler; the command is re-runnable (SC-23).
- [ ] No external call inside a transaction; side effects go through the outbox (SC-14).
- [ ] The idempotency key is the first write; external references are unique (SC-06).
- [ ] The audit event is in the transaction (SC-24).
- [ ] Subscribers record the inbox row.

**Security**

- [ ] Schema at the boundary, typed command inward (SC-01).
- [ ] The handler authorises with permission, branch and owner; a test proves the wrong role is refused (SC-02).
- [ ] No string-built SQL, no dynamic identifiers (SC-03, SC-04).
- [ ] Maker-checker where the action moves value quietly (SC-17).
- [ ] Restricted fields encrypted; no plaintext in a response, log, event or audit payload (SC-07, SC-08, SC-18).
- [ ] Webhooks verified in order; uploads sniffed, scanned and served by signed URL; user-supplied URLs checked (SC-12, SC-13, SC-19).
- [ ] Cookies, CSRF, CORS and rate limits as the endpoint needs (SC-09 to SC-11).
- [ ] New dependency justified; scans pass; no secret in the diff (SC-20, SC-21).
- [ ] The data-classification questions in `docs/security/DATA_CLASSIFICATION.md` section 6 are answered.

**Errors and logs**

- [ ] No empty `catch`; errors rethrown with context or handled (SC-15).
- [ ] Error responses use the envelope with a correlation id and no internals (SC-16).
- [ ] Log lines carry ids and outcomes only; nothing from the never-log list.

**Tests**

- [ ] The layers that apply are present: unit, integration against real PostgreSQL and Redis, contract, end to end where a flow crosses modules, smoke where the flow is critical (`docs/TEST_STRATEGY.md`).
- [ ] The error paths are tested, not only the happy path; the failing test existed before the fix.
- [ ] No mocked database; data from factories; no production data.
- [ ] No new flaky test; no retry loop added to make a test pass.

**Migrations**

- [ ] One schema per file; class and data category declared; grants follow the class.
- [ ] Expand now, contract later; a rollback or forward fix is documented and tested.
- [ ] The upgrade test passes from the previous release.

## 14. Definition of done

A piece of work is done when the review checklist passes, CI is green, the requirement id is in the commit or pull request, the audit trail records the action with actor, time and before and after values, the OpenAPI contract matches the committed file or the change is versioned and logged, the session report is written, and the work is pushed to `hakorem_farms_backend` (shared brief, "Definition of done").
