# Backend build prompt

Lives at `backend/docs/BUILD_PROMPT.md`. Every session reads `docs/SHARED_BRIEF.md` first, then only its own section below.

## How to run this prompt

You are the lead backend engineer on the HaKorem Farms Platform. You work inside `backend/` and nowhere else. The remote is `github.com/officialjwise/hakorem_farms_backend`, and nothing you write ever lands in the frontend repository.

Every session, in this order, before any other work:

1. Read `docs/SHARED_BRIEF.md`. It carries the business, the domain model, the requirements, the security architecture and the integrity rules, and it is binding on everything below.
2. Read only the section of this file for the session you are running.
3. List `docs/sessions/` and read only the most recent report.
4. Confirm in three lines what the phase is, what is in scope, and what its gate is. Then start work.

Four rules particular to this track:

- **You own the contract.** `contract/openapi.yaml` is the frontend's only view of this system. Never change it without bumping the version, adding an entry to `docs/CONTRACT_CHANGELOG.md`, and naming the change at the top of your session report.
- **Read the frontend's requests, never its code.** From B4 onward, start by reading `../frontend/docs/CONTRACT_REQUESTS.md` if it exists. Implement what is reasonable, and record in your report what you declined and why. Never edit that file and never open the frontend's source.
- **Test first on anything that matters.** Money, stock, weight and permissions are written test-first, with the test asserting an exact value.
- **Stop at the gate.** Do not begin the next phase however much context is left. The gate is the point of the phase.

B0 runs on Fable in plan mode and produces no application code. Every session after it runs normally.

## B0 — Architecture and design

Run this on Fable in plan mode. The output is documents only, and the gate is a human reading and approving the architecture and the data model.

Produce, in `docs/`:

- `ARCHITECTURE.md` — C4 context and container views, the module map, dependency rules, request flow, event flow, deployment topology. Mermaid diagrams inline so they version with the code.
- `DOMAIN_MODEL.md` — aggregates, entities, value objects, domain events, invariants, ubiquitous language. The eight domain points in the shared brief are hard requirements here, not suggestions.
- `DATA_MODEL.md` — the entity relationship diagram plus a table dictionary giving every column, its type, its constraints and the reason it exists.
- `MODULE_BOUNDARIES.md` — what each of the twenty-two modules owns, its public interface, what it may import, and the lint rule that will enforce it.
- `security/SECURITY_ARCHITECTURE.md` and `security/THREAT_MODEL.md` as the shared brief specifies, including the abuse case table with a control and a detection for every row.
- `adr/0000-template.md` plus one numbered ADR for each decision made in this session.
- `ASSUMPTIONS.md` and `BACKLOG.md`.

Seven decisions get settled here and recorded as ADRs, because each is expensive to reverse once code exists:

1. Money representation and the single rounding rule.
2. The stock movement table shape and how on-hand balances are materialised from it.
3. The chart of accounts, and which business event posts which entries.
4. The pricing resolution order, and what happens when nothing resolves.
5. Aggregate boundaries, and which operations need serializable isolation.
6. The audit log's tamper-evidence mechanism.
7. Multi-location from day one, even while the farm runs one location.

Write no application code, no migrations, no `package.json`, no Dockerfile. If you find yourself scaffolding, stop and go back to the document. Ask only if something in the shared brief genuinely contradicts itself; otherwise take the cheapest-to-reverse option, record it in `ASSUMPTIONS.md`, and carry on.

## B1 — Documents, skills and the contract

The gate is that the contract covers every screen the frontend has planned. That is the one hard dependency between the two tracks, so the contract ships first, before anything else in this session is polished.

### Write the contract first

Before the SRS, before the skills, before `CLAUDE.md`.

- Hand-write `contract/openapi.yaml` covering every endpoint implied by the functional requirements in the shared brief. All of them, even for modules you will not build until slot 13.
- Use OpenAPI 3.1, tag operations by module, and give every operation an `operationId` that will read well as a generated client method name.
- Define the shared envelopes once and reuse them: the error shape with its correlation id, pagination, the idempotency key header, money as an integer-pesewa field with an explicit currency, weight in kilograms to three decimal places.
- Examples matter more here than anywhere else, because the frontend builds whole screens against them. Give every list endpoint at least five realistic rows using Ghanaian names, real products from the catalogue and plausible prices. A thin example is a screen built on sand.
- Lint it with `npx @redocly/cli lint contract/openapi.yaml`, commit, push, and open your session report with the line that the frontend is unblocked.

### Then the SRS

Expand every bullet in the shared brief's functional requirements into numbered, testable requirements using the module prefixes, such as `FR-POS-014`. Each one needs an actor, a trigger, a rule, an observable outcome and acceptance criteria. Finish with the traceability matrix mapping requirements to modules and to the test that will prove them.

### Then the remaining documents, the skills and CLAUDE.md

Every file in the shared brief's documentation table, complete rather than outlined. Then the skills in `.claude/skills/`, verified by describing a triggering task in a fresh session and recording the result in `docs/prompts/SKILLS_VERIFICATION.md`. Then `CLAUDE.md`, kept short: what the project is, the hard constraints, where the documents live, which skill covers what, the commands for build, test and migrate, and the three things that most often go wrong.

If context runs short, that order is also the priority order. The contract and the SRS are what every later session depends on; the rest can move to a `B1 continued` session.

## B2 — Foundation

The gate is that a one-command setup works on a clean machine and CI is green.

- pnpm workspace, NestJS application, strict TypeScript, path aliases, and the import-boundary lint rule from `MODULE_BOUNDARIES.md` wired in and failing the build.
- `packages/kernel` before anything else: `Money`, `Weight`, `Quantity`, `Result`, UUIDv7 identifiers and a `Clock`. `Money` and `Weight` are the first code in the repository with tests, written before any framework code, at 100 percent branch coverage. Every rounding edge case gets its own named test.
- Typed configuration validated at boot, failing fast with a message that names the missing key rather than a stack trace.
- Postgres and Redis in `docker-compose.yml`, Drizzle migrations with a runner, and the expand-then-contract rule enforced by the migration skill.
- The error envelope, correlation id middleware, Pino JSON logging and OpenTelemetry tracing, all in place before the first feature so nothing is retrofitted.
- Test harness: Vitest, Testcontainers Postgres, a factory module for test data, and four scripts that each do exactly what their name says: `test:unit`, `test:integration`, `test:e2e`, `test:smoke`.
- GitHub Actions running lint, type check, unit, integration, contract diff and build, plus secret scanning and a dependency audit, with a high-severity finding blocking merge.
- `scripts/setup.sh` taking a fresh clone to a running API with a seeded database in one command.

Before claiming the gate, delete `node_modules` and the Docker volumes, run the setup script, and watch it come up. Then add a CI job that does the same thing from a fresh checkout, so the claim keeps being true.

## B3 — Platform and the first vertical slice

The gate is a slice that passes all four test layers and a frontend that can log in against the real API.

Build the platform services first. These are cross-cutting and owned by no domain module.

- **auth** — Argon2id hashing, short-lived access token with a rotating refresh token in an httpOnly `SameSite=Strict` cookie, TOTP for Owner, Manager and Accountant, device and session list, forced logout, lockout with exponential backoff, and no account enumeration in any error message.
- **authorization** — a policy engine called from the domain layer rather than the controller, deny by default, object-level ownership checks, and the seeded roles from the shared brief. Separation of duties is enforced here, not by convention.
- **audit** — an append-only writer and an interceptor recording actor, timestamp, IP, and before and after values. Revoke `UPDATE` and `DELETE` on the audit table from the application role, and hash-chain the rows.
- **outbox** — written in the same transaction as the business change, dispatched by a worker with backoff and a dead letter queue.
- **observability, storage, queue, notifications and payments** — ports with one adapter each and no business logic in any of them.

Then build one vertical slice end to end, Product create, read and list, through every layer: domain, application, infrastructure, interface, with unit, integration, contract and end-to-end tests, authorisation, audit and documentation. Keep it small and make it exemplary, because every module session after this one copies its shape.

Close the session by writing the exact login flow into your report, including the token lifetimes and the cookie attributes. The frontend track needs that to switch off its stub.

## B4 to B12 — The module sessions

These ten sessions all follow one recipe, so this section is the whole of their instruction. The table says what each covers and what has to be true before it closes.

> **Amended 2026-11-13 by `docs/adr/0026-session-schedule-amendment.md`, approved by the owner.** B9 is two sessions. B9a builds the order core (the sales order record, its state machine and sale posting) and payments, because POS and quotations both need the order record before B11. B9b builds POS, shifts and offline sync on top of it. B11 keeps order fulfilment. The ADR also assigns the online store, audit administration and the daily exception report, confirmed by the owner on 2026-11-13; read it before opening B7, B9a, B11, B12 or B13.

| Session | Modules | What proves it |
| --- | --- | --- |
| **B4** | Master data, pricing engine | A price resolves correctly for every band, channel and customer tier in the catalogue, and an unresolvable request becomes a quote rather than an error |
| **B5** | Inventory, stock movement ledger | On-hand derived from movements matches a hand count, stock cannot go negative outside the allowed movement types, and a lot traces in both directions |
| **B6** | Livestock, processing | A processing order consumes an animal and produces lots whose costs sum exactly to the input cost plus direct processing cost |
| **B7** | Procurement, suppliers | Three-way match blocks payment where receipt and supplier invoice disagree |
| **B8** | Ledger, billing, document generation | Trial balance sums to zero on a seeded trading day, an unbalanced journal is rejected by the database itself, and numbering stays gap-free under concurrent load |
| **B9a** | Order core, payments | Every payment edge case in the shared brief passes, and an order on any channel posts stock, document, payment and ledger in one transaction |
| **B9b** | POS, shifts, offline sync | Shift close reconciles, and 500 queued offline transactions sync exactly once |
| **B10** | Quotations, wholesale, credit control | Quote revisions are versioned, conversion to invoice preserves every link, and a credit limit blocks with an audited override |
| **B11** | Order fulfilment, delivery, notifications | A catch-weight order re-prices at pick, cash on delivery lands against the driver, and the outbox guarantees the customer notification |
| **B12** | Capital and investors, costing, reporting, public API | A distribution matches a hand calculation on weighted average shareholding and ties exactly to the ledger |

### The recipe every module session follows

1. Read that module's requirement block in the SRS, and nothing else from the SRS.
2. Read `../frontend/docs/CONTRACT_REQUESTS.md` and decide what to honour.
3. Write the failing tests first for every rule involving money, stock, weight or permission.
4. Build domain, then application, then infrastructure, then interface. In that order, never the reverse.
5. Wire audit, authorisation and the outbox. A module without all three is not finished.
6. Regenerate the OpenAPI specification, diff it against the committed contract, and version anything that moved.
7. Write the module's section of `docs/API.md` and any ADR this session produced.
8. Run all four test layers, commit, push, write the session report.

Three rules catch the failures that actually happen:

- **No business rule in a controller.** If a test has to call an HTTP endpoint to exercise a calculation, the calculation is in the wrong layer.
- **No reaching across modules.** A module that needs another's data takes it through the published interface or a domain event, never a direct query and never a join across module tables.
- **Each session extends the seed script**, so later sessions inherit a realistic farm with stock, history and customers rather than an empty database.

If a session's modules prove too large for one context, split at a module boundary and label the next one `B5 continued`. Never split in the middle of a module.

## B13 — Hardening, smoke suite and deploy

The gate is every non-functional target met and evidenced on the live VPS.

- **Load.** Run k6 against every target in the shared brief's non-functional table and record the actual numbers in `docs/OPERATIONS.md`. A missed target is either fixed or renegotiated in writing. It is never quietly skipped.
- **Security.** Turn every abuse case in the threat model into a test. Each one is either blocked outright or lands on the daily exception report with enough detail to act on.
- **Exception report coverage** (added by the owner on 2026-11-13). For every abuse case, also confirm that the attempt lands on the daily exception report, not only that the control blocks it: run the attempt, then read `GET /exceptions/daily-report` and assert an item of the kind the threat model names, carrying that case's number in `abuseCases`, with the actor, amount and subject document. A case that is blocked but leaves no trace on the report is a failing test. Run an OWASP ZAP baseline against staging, and clear every high-severity dependency and image finding.
- **Smoke suite.** This is the deployment gate, so it has to be fast and safe to run against production repeatedly: health endpoint, login, catalogue read, create and void a sale in a dedicated smoke location, a payment webhook with a bad signature rejected, one document generated, and the trial balance endpoint answering. Under 60 seconds, exits non-zero on any failure.
- **Runbooks.** One per failure mode in `docs/runbooks/`: payment provider down, database failover, restore from backup, reconciliation break, queue backlog, incident response.
- **Data migration.** `docs/DATA_MIGRATION.md` plus the import scripts and a dry-run mode that validates without writing.
- **Deploy.** Provision as the shared brief's deployment section specifies. Staging first, then the full UAT run on staging, then production. Run the restore drill and write down how long it actually took.

Finish by running the seven acceptance scenarios from the shared brief against staging, with someone non-technical driving wherever that is possible. Anything they cannot complete without you is not finished.

## Commands, CI and pushing

Every script does exactly what its name says, with no hidden steps. Build them in B2 and keep them working.

```bash
pnpm run setup              # fresh clone to a running, seeded API
pnpm dev                # API with reload, Postgres and Redis in Docker
pnpm test:unit          # fast, no containers
pnpm test:integration   # Testcontainers Postgres and Redis
pnpm test:contract      # generated spec against contract/openapi.yaml
pnpm test:e2e           # full stack in Docker Compose
pnpm test:smoke -- --base-url=https://api.hakoremfarms.com
pnpm db:migrate | db:rollback | db:seed
pnpm contract:generate  # writes contract/openapi.yaml from code; CI fails on any diff
```

On every pull request CI runs lint, type check, unit, integration, contract, build, end to end, then the security scans. On `main` it runs the same set, builds the image, deploys to staging and runs smoke. Production deploy is a manual approval step on that same workflow, never a separate script someone runs by hand.

### Committing and pushing

- Conventional Commits, one concern per commit, the test in the same commit as the code it covers.
- Reference the requirement id: `feat(inventory): post stock take variance (FR-INV-031)`.
- A branch per session, named for it: `b05-inventory-ledger`. Open a pull request at the end of the session and squash merge once CI is green.
- Push before the session ends, every time. Run `git remote -v` first and confirm you are pushing to `hakorem_farms_backend`.
- Never commit `.env`, a key, a dump of real data, or anything under `infra/secrets/`.

## The session report

Write this at `docs/sessions/<ID>-<slug>.md` before the session ends, every time. It is the only thing the next session reads about this one.

```markdown
# B05 — Inventory and stock ledger
Date: 2026-11-20 · Status: gate passed

## Contract changes
Version 1.3.0. Added POST /stock-takes and GET /stock/on-hand.
No breaking changes. See CONTRACT_CHANGELOG.md.

## Built
- Stock movement ledger, append-only, with reason codes
- On-hand materialised view plus the nightly recompute job
- Stock take workflow with variance posting

## Decisions
- Weighted average cost held per product per location (ADR-0014)

## Assumptions
- Negative stock is allowed only for movement type CORRECTION, pending your confirmation

## Deferred
- Reorder point alerts moved to B11, they need the notification module

## Tests
unit 412 passed · integration 86 passed · contract clean · e2e 9 passed
coverage 84% overall, 100% branch on the ledger

## Gate
On-hand derived from movements matched a hand count of the seeded farm. Passed.

## Notes for the frontend track
Stock take endpoints are live against the real API.
The reservation endpoint they requested lands in B11, not here.

## Next session
B06 — Livestock and processing. Open it with:
"Read CLAUDE.md, docs/SHARED_BRIEF.md and the B4 to B12 section of
docs/BUILD_PROMPT.md. Read docs/sessions/B05-inventory-ledger.md.
Execute B06 only. Stop at the gate."
```

The last two sections are the ones that get skipped and the ones that make the next session cheap. Write them even when the session went badly, especially then.
