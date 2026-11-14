# B02 — Foundation

Date: 2026-11-14 · Branch `b02-foundation` · Pull request #3, stacked on #2 (B1) and #1 (B0), none merged · Status: see Gate.

## Assumptions made this session (all open, all in `docs/ASSUMPTIONS.md`, dated 2026-11-14)

| ID | What was assumed, and why | Who confirms |
| --- | --- | --- |
| A-070 | MinIO no longer publishes container images; nothing could be pulled. B2 needs no object storage, so the stack is PostgreSQL and Redis only. B3 chooses the S3-compatible development store | B3, by ADR |
| A-071 | `pnpm setup` is a pnpm built-in that edits shell start-up files and never reaches a package script. The command is `pnpm run setup` (or `bash scripts/setup.sh`); `CLAUDE.md`, `ONBOARDING.md` and `BUILD_PROMPT.md` corrected | Owner |
| A-072 | Health reports the database and Redis only until the outbox, audit sealing, WAL archiving and reconciliation exist | B3 |
| A-073 | Setup refuses below 1.5 GB of Docker memory and only warns below 6 GB; this machine has 1.97 GB and runs the stack | Owner |
| A-074 | The "Added" error codes in `docs/API.md` are adopted per operation when its code is written, not by hand across 600 planned operations | Owner |
| A-075 | `db:seed` exists with its production refusals but no seed units: there are no module tables yet | Owner |
| A-076 | `multer` 2.5.0 and `handlebars` 4.7.10 pinned by overrides to clear high and critical advisories; the NestJS release with the multer fix is younger than the 14-day floor. Remove when 11.2.10 passes it | B3 |
| A-077 | The secret-scan findings in the B0 and B1 history are documentation and contract examples (and two earlier versions of them in this platform's own `hk_live_` and `whsec_` formats). Each example value is allowlisted in `.gitleaks.toml`; anything else fails | Owner |
| A-078 | PRs 1 and 2 are not merged, so B2 is stacked on B1's branch | Owner, by merging |
| A-079 | Sessions opened at the workspace root, as the openers say, do not load the sixteen skills; sessions opened in `backend/` do | Owner: where should sessions open? |

A-060 is now **confirmed by test** (Decisions).

## Contract changes

None. `contract/openapi.yaml` is byte-for-byte version 1.1.0. It is now generated (`pnpm contract:generate`): the 600 hand-written operations moved to `contract/planned/openapi.planned.yaml`, and the code documents none yet. The frontend needs to do nothing.

## Built

| Area | What |
| --- | --- |
| Kernel, first and test-first | `packages/kernel`: `Money` (bigint pesewas, 0 to 9,007,199,254,740,991), `Weight` (integer grams, NUMERIC(10,3)), `Quantity` (signed thousandths, NUMERIC(14,3)), `Rate` (exact percentage), `allocate` (largest remainder, ties by key), `Result`, UUIDv7, `Clock`. Tests written and run red before any implementation; 160 kernel tests; **100 percent statements, branches, functions and lines**, enforced |
| Workspace and lint | pnpm workspace, strict TypeScript 5.9, NestJS 11, exact pins, 14-day release-age floor. `pnpm lint`: boundary rule generated from `tooling/architecture.json`, cycles, no `number` arithmetic where `Money` is imported, no import outside the repository, no focused tests; 20 fixture files prove each rule still fires; test placement; schema names in migrations |
| Platform | Typed configuration (names the key, never the value, exit 78); Pino logs scrubbed of secrets and phone numbers, carrying correlation and trace ids; OpenTelemetry; correlation id middleware; one error envelope through one mapping; `GET /v1/health`; the unit of work (series locks before `BEGIN`, retry on 40001 and 40P01, typed error after five); Redis client |
| Database | Plain-SQL migration runner (up, down or forward fix, checksums, as `hk_owner`), the seven ADR-0024 roles, migration `0001_platform_create_schema` (schema, the four domains, `reject_change`, `touch_version`), the seed command, the grants, table-class and foreign-key checks |
| Contract | Generator, deterministic emitter, drift check, versioning check |
| Stack | `docker-compose.yml` (PostgreSQL 17.6, Redis 7.4.6, the API from its image), `infra/docker/api.Dockerfile`, `scripts/setup.sh`, `scripts/dev.sh`, `.env.example` with generated secrets |
| Tests | Vitest projects per layer, Testcontainers global setup with a template database cloned per file, `test/factories/factory.ts`, the four scripts plus `test:contract` and `test:coverage` |
| CI | `.github/workflows/ci.yml`: lint and type check; unit and integration with coverage; contract (drift, responses, Redocly, versioning); image build and Trivy; fresh-clone setup then e2e, smoke, rollback and a second setup; gitleaks, `pnpm audit --audit-level high`, Semgrep, and a self-test that the secret and audit gates fail on planted findings |

No module code.

## Decisions

- **ADR-0030** (new, Proposed): the migration runner, the contract generated from code plus the planned contract, exact kernel rates as bigints (the kernel imports nothing), template-database test isolation.
- **A-060 confirmed.** On PostgreSQL 17.6, a session-level advisory lock taken before `BEGIN` makes the second serializable transaction wait and then succeed; `pg_advisory_xact_lock` as the first statement fails with 40001. Both are integration tests under the ADR-0005 names.
- Versions: TypeScript 5.9.3 and NestJS 11.2.8 as the brief fixes; Vitest 4.1 and zod 4.6 because their 3.x lines carry high-severity advisories.
- The image installs production dependencies in a separate stage, drops npm and Corepack, and takes Alpine security fixes; Trivy finds no fixable high or critical vulnerability.
- `DB_POOL_MAX` defaults to 20, as `docs/OPERATIONS.md` says.

## Deferred

- **Prism mock check:** refused again by the permission classifier ("Code from External"). Left to the frontend's F2, as the opener says.
- **Worker:** no worker process yet; it arrives with the outbox dispatcher in B3 (ONBOARDING step 8 says API and worker).
- **Object storage:** A-070.
- **Seed data:** A-075.
- **Run 2 regression:** the 27 tasks that passed were not rerun after four descriptions changed.

## Tests

| Layer | Result (local, 2026-11-14) |
| --- | --- |
| Unit | 188 passed |
| Integration (Testcontainers) | 43 passed |
| Contract | 12 passed |
| End to end (stack from the image) | 3 passed |
| Smoke (against the local stack) | 1 passed |
| Coverage, unit and integration merged | 87.4 percent statements, 86.4 percent branches overall (gate 80); kernel 100 percent (gate 100) |
| Lint, type check | Clean; 20 of 20 fixtures fire as expected |
| Security | `pnpm audit --audit-level high` passes (5 moderate remain); Trivy exit 0; gitleaks over 46 commits: no leaks; Semgrep: 0 findings |

Named tests required of B2, by name: ADR-0028 tests 1, 2 and 4; ADR-0005 `a session-level advisory lock taken before BEGIN …`, `pg_advisory_xact_lock as the first statement …`, `the unit of work retries 40001 and 40P01 …`; `the platform.pesewas domain rejects negative and oversize values`; SEC-036 `grants only the privileges each role needs`; `hk_app cannot run DDL`; NFR-019 `one id appears in the response the log and the trace`; FR-API-001 `fails on an unversioned breaking change`; FR-API-002 `fails when the generated contract differs from the committed one`.

## Gate

**One-command setup on a clean machine.** Performed, not assumed:

1. Stopped the stack and deleted its volumes (`docker compose --profile app down --volumes`: `hakorem_hk_pgdata` and `hakorem_hk_redisdata` removed), deleted the built image, `node_modules` (root and kernel), `dist`, `coverage` and `.env`. Checked: none of them exist, no project volume, container or image is listed.
2. Ran `pnpm run setup`. Exit 0 in 54 seconds. Observed: the machine check warned that Docker has 1,972 MB; `.env` written with 8 generated secrets; PostgreSQL and Redis healthy; roles created; `0001_platform_create_schema` applied; the seed ran 0 units; the API image built and started; `GET /v1/health` returned `OK` with database 21 ms and Redis 1 ms.
3. Afterwards: all three containers healthy; e2e 3 of 3 and smoke 1 of 1 against the stack; `db:rollback` then `db:migrate` worked; a second `pnpm run setup` took 13 seconds, left `.env` unchanged and applied nothing.

Caveat: BuildKit's layer cache and the pulled base images survived the teardown, so the image build was warm. The CI `fresh-clone` job runs the same script on a runner with nothing cached.

**CI green: passed.** [Run 43537557972](https://github.com/officialjwise/hakorem_farms_backend/actions/runs/43537557972) on commit `1a316ef`, all six jobs successful, the whole pipeline in 74 seconds (NFR-016: under 12 minutes):

| Job | Result |
| --- | --- |
| lint and type check (NFR-018, NFR-022) | success |
| unit and integration with the coverage gate (NFR-015) | success |
| contract (FR-API-001, FR-API-002): drift check `up to date (0 operations from code, 600 planned)`, contract responses, Redocly valid | success |
| build and scan the image: Trivy, high and critical block | success |
| setup script brings the stack up on a clean checkout (NFR-017): no `node_modules`, `.env` or volumes; setup; health OK; e2e; smoke; rollback and migrate; setup again | success |
| secret scan, dependency audit, static analysis (SEC-034): no leaks; audit at high; Semgrep 0 findings; both gates fail on the planted secret and the vulnerable dependency | success |

The versioning check runs only on `pull_request` events, so it did not run here; it is covered by `test/contract/api/versioning.contract.spec.ts`.

**Finding: `pull_request` events start no run on this repository.** Opening pull request #3, and closing and reopening it, produced no workflow run and no Actions check suite, although Actions is enabled and the frontend repository's pull request runs work. A push does start a run, so the workflow also runs on pushes to `main` and to session branches (`b[0-9]*-*`). The owner may want to look at the repository's Actions settings; until then the push runs are the CI record, and they show on each pull request's commits.

## Notes for the frontend track

Nothing to pick up: the contract is unchanged at 1.1.0. From B3, operations move from the planned file into code one by one, without changing what the published file says unless the change is versioned and logged.

## Next session

B03 — Platform and the first vertical slice. Open a fresh Claude Code session **in `backend/`** if the owner agrees (A-079), otherwise at the workspace root, with:

```text
Read CLAUDE.md, docs/SHARED_BRIEF.md and the B3 section of docs/BUILD_PROMPT.md.
List docs/sessions/ and read only the most recent report (B02's).
Also read docs/prompts/session-openers.md section "B3", ADR-0006, ADR-0009, ADR-0010, ADR-0014, ADR-0016,
ADR-0017, ADR-0022, ADR-0030, docs/security/SECURITY_ARCHITECTURE.md and docs/data-model/platform.md and iam.md.
Do not read any other document unless this phase needs it.

Confirm in three lines: the phase, its scope, and its gate.
Before building: choose the S3-compatible development store that replaces MinIO (A-070) and record it in an ADR;
remove the multer override if @nestjs/platform-express 11.2.10 has passed the 14-day floor (A-076).
Then execute B03 only: authentication, authorisation with maker-checker, the audit trail, the outbox and dispatcher
with the worker, observability, storage and the ports, then the Product vertical slice through all four test layers,
moving each operation it implements from contract/planned/openapi.planned.yaml into code. Add the outbox, audit and
dead-letter checks to GET /v1/health. Stop at the gate and write docs/sessions/B03-platform-slice.md.
```
