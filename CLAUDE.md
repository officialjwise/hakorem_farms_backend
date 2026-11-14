# HaKorem Farms Platform: backend

A production system for a livestock, poultry, meat and fresh produce business in Ghana: trading, stock, money and investor reporting, through retail counter, wholesale, online store and request-for-quote channels. This repository is the modular monolith (NestJS, PostgreSQL 17, TypeScript) and the owner of the OpenAPI contract; the frontend lives in a separate repository, `../frontend`. The documents are the source of truth: code that contradicts them is a bug in the code, not a new decision.

## Hard constraints (full list: `docs/SHARED_BRIEF.md`)

- One modular monolith, one database, boundaries enforced by lint and by schema; no cross-module table access, no services, no mandatory broker.
- Two repositories joined only by `contract/openapi.yaml`; no shared package, no cross-repository import. **Never write anything under `../frontend`.**
- The backend owns the contract and never breaks it silently: version bump, `docs/CONTRACT_CHANGELOG.md` entry, note in the session report.
- Money is integer pesewas (`BIGINT`, never a float), rounded half-up once per line; weight is `NUMERIC(10,3)` kg with its source.
- Stock and the ledger are append-only; corrections are reversing rows; nothing financial is updated in place or hard-deleted.
- Rules live in the database (balanced journals, gap-free numbers, stock sign, unique idempotency keys), not only in code.
- Stock and ledger writes run at serializable isolation with retry; one business operation is one transaction; side effects go through the outbox.
- The counter keeps working offline; the server is authoritative and a synced sale is always recorded.
- Authorisation is checked in the domain layer, deny by default; maker and checker are never the same user.
- Every timestamp is `TIMESTAMPTZ` in UTC, shown in Africa/Accra. Every state-changing call carries an idempotency key.
- No secrets and no production data in this repository, in any seed, fixture or example.
- Correctness over features; stay in scope (new ideas go to `docs/BACKLOG.md`); every decision is an ADR in `docs/adr/`.

## Where things live

- `docs/README.md` is the index and the reading order. System of record: `docs/SRS.md`, `docs/ARCHITECTURE.md` (decision index in section 12), `docs/DOMAIN_MODEL.md`, `docs/DATA_MODEL.md` with `docs/data-model/<schema>.md`, `docs/MODULE_BOUNDARIES.md`.
- Decisions: `docs/adr/` (template `0000-template.md`, ADR-0001 to ADR-0029 and later). Assumptions: `docs/ASSUMPTIONS.md`. Parked work: `docs/BACKLOG.md`.
- Security: `docs/security/` (architecture, threat model, secure coding standards, data classification, compliance). Standards: `docs/ENGINEERING_STANDARDS.md`, `docs/TEST_STRATEGY.md`, `docs/API.md`, `docs/OFFLINE_SYNC.md`.
- Running it: `docs/OPERATIONS.md`, `docs/DEPLOYMENT.md`, `docs/runbooks/`, `docs/ONBOARDING.md`. Acceptance: `docs/UAT.md`. Terms: `docs/GLOSSARY.md`.
- The contract: `contract/openapi.yaml` (3 MB: grep it, never read it whole). Session handoffs: `docs/sessions/`. Build plan: `docs/BUILD_PROMPT.md` and `docs/adr/0026-session-schedule-amendment.md`.
- From B4 onward read `../frontend/docs/CONTRACT_REQUESTS.md` at the start of a session and implement or decline each request in the report. Never edit it, and never open frontend source.

## Session protocol

1. Read this file, `docs/SHARED_BRIEF.md`, your session's section of `docs/BUILD_PROMPT.md`, and only the latest report in `docs/sessions/`.
2. One phase per session. Confirm phase, scope and gate in three lines, then work that phase only and stop at the gate.
3. Write the failing test first for anything touching money, stock, weight or permissions; build domain, then application, infrastructure, interface.
4. End by writing `docs/sessions/<ID>-<slug>.md`: built, decided, assumed, deferred, contract changes, gate result, and the exact opening message for the next session.
5. Run `git remote -v` and confirm it shows `hakorem_farms_backend`, then commit (Conventional Commits, one concern each) and push before closing. Run `git add`, `git commit` and `git push` as three separate commands: the permission classifier refuses them chained with `&&` or `;`.

## Skills: read the one that fires before you write code

| Skill | Fires when |
| --- | --- |
| `hakorem-module` | Creating or restructuring a module, adding imports between modules, events or ports |
| `hakorem-money` | Any price, amount, tax, discount, total, split or arithmetic on pesewas |
| `hakorem-ledger` | Journal entries, chart of accounts, posting rules, periods, financial events |
| `hakorem-stock` | Stock movements, lots, weights, locations, reservations, holds, valuation |
| `hakorem-pricing` | The pricing engine, price lists, grades, bands, overrides, promotions, quotes |
| `hakorem-endpoint` | Adding or changing an endpoint, schema, error code, or the contract |
| `hakorem-migration` | Any SQL migration, table, constraint, trigger, grant or lookup seed |
| `hakorem-tests` | Writing, fixing or running any test; coverage; factories |
| `hakorem-security-review` | Auth, payments, webhooks, exports, uploads, permissions, new abuse paths |
| `hakorem-offline` | POS or driver features that must survive a dropped connection |
| `hakorem-documents` | Invoice, receipt, quote, statement, delivery note output and numbering |
| `hakorem-frontend` | A backend decision a screen depends on, or a request to build a screen (goes to `../frontend`) |
| `hakorem-adr` | A structural, dependency or contract decision; writing or indexing an ADR |
| `hakorem-runbook` | A new failure mode or a resolved incident |
| `hakorem-seed` | Demo, test or UAT data; seed scripts; factories with Ghanaian content |
| `hakorem-release` | Preparing, approving, deploying or rolling back a release |

## Commands

The `pnpm` scripts arrive in B2; until then only the contract lint runs.

```bash
pnpm setup                      # fresh clone to running API with seeded database, one command
pnpm dev                        # API and worker with Postgres and Redis in Docker
pnpm lint && pnpm typecheck     # includes the module boundary rule; CI blocks on both
pnpm test:unit                  # pure domain rules
pnpm test:integration           # modules against real Postgres and Redis in Testcontainers
pnpm test:contract              # responses against contract/openapi.yaml
pnpm test:e2e                   # whole flows on the full stack in Docker Compose
pnpm test:smoke                 # critical paths against a deployed environment, test branch only
pnpm db:migrate                 # apply plain SQL migrations (expand then contract)
pnpm db:rollback                # roll back the last migration, or follow its documented forward fix
pnpm db:seed                    # seeded farm; refuses to run against production
pnpm contract:generate          # regenerate openapi.yaml from code; CI fails on any diff
npx @redocly/cli lint contract/openapi.yaml    # no errors, no warnings
```

## The three things that most often go wrong

1. **Money as a float, or rounded twice.** Use the kernel `Money`, `Quantity` and `allocate`; round half-up once at the line anchor; split only with `allocate`; assert exact integers (`hakorem-money`).
2. **Reaching across a module boundary.** Import another module only through its `index.ts` from a lower layer, never join or select another module's tables, publish an event instead of calling up (`hakorem-module`).
3. **Updating or deleting a ledger row.** Stock movements, journal entries, audit events and payment allocations are insert-only; correct with a reversing row that references the original (`hakorem-stock`, `hakorem-ledger`).
