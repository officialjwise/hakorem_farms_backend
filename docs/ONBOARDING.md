# HaKorem Farms Platform: Onboarding

From clone to a running system in under thirty minutes, and where to start reading afterwards. For engineers joining the backend, and for the Claude Code sessions that build it.

## Read this first: what exists today

**The commands in this document arrive in session B2.** Until B2 is merged, this repository holds documents and the API contract and nothing else: no `package.json`, no `src/`, no Docker files, no migrations. `pnpm run setup`, `pnpm dev` and every `pnpm test:*` command below will fail with "no package.json" if you run them now. That is correct, not a fault.

What you can run today, with only Node installed:

```bash
# from ~/Desktop/hakorem-farms/backend
npx @redocly/cli lint contract/openapi.yaml              # must print no errors and no warnings
npx @stoplight/prism-cli mock contract/openapi.yaml --port 4010   # the mock server (see section 6)
```

Everything else is reading. The reading order in section 8 is the real onboarding until B2 lands; section 4 describes what `pnpm run setup` will do when it does.

| Phase | Status on 2026-11-13 |
| --- | --- |
| B0 architecture, domain, data model, threat model, ADRs | Written |
| B1 documents, skills, `CLAUDE.md`, hand-written contract (version 1.0.0) | Written |
| B2 foundation: workspace, Docker, CI, migrations, kernel, test harness, `pnpm run setup` | Built 2026-11-14 (`docs/sessions/B02-foundation.md`); awaiting merge |
| B3 onward: platform and modules | Not started |

## 1. The thirty-minute path

Once B2 is merged, a new machine goes from nothing to a seeded, running API in about this time. Most of it is downloading images.

| Minutes | Step | Section |
| --- | --- | --- |
| 0 to 8 | Install the prerequisites, if they are not already there | 2 |
| 8 to 11 | Create the workspace folder and clone the two repositories | 3 |
| 11 to 22 | `pnpm run setup` (first run pulls images and installs packages) | 4 |
| 22 to 25 | Check the API answers; open the contract documentation | 5 |
| 25 to 30 | Run `pnpm test:unit`; run the mock server | 6, 7 |

A second run of `pnpm run setup` on the same machine takes under two minutes.

## 2. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | 22 LTS | Install from nodejs.org or with a version manager (fnm, nvm, Volta). `node --version` must start with `v22` |
| pnpm | The version pinned in `package.json` (`packageManager` field) | Installed through Corepack, which ships with Node. Do not `npm install -g pnpm`. Run `corepack enable` once; the first `pnpm` command then fetches the pinned version |
| Docker | Docker Desktop on macOS and Windows; Docker Engine with the Compose plugin on Linux. Compose v2 (`docker compose`, not `docker-compose`) | Give Docker at least 6 GB of memory (8 GB comfortable) and 15 GB of disk. The stack is PostgreSQL 17, Redis 7 and an S3-compatible store (MinIO) |
| Git | 2.40 or later | |

Operating systems:

- **macOS** (Apple silicon or Intel): Docker Desktop. Nothing special.
- **Linux**: Docker Engine and the Compose plugin from Docker's own repository (not the distribution's old package). Add your user to the `docker` group, then log out and in.
- **Windows 11 or 10 with WSL2.** The backend is developed inside WSL2, not in PowerShell or `cmd`:
  1. Install WSL2 with an Ubuntu 22.04 or later distribution.
  2. Install Docker Desktop and turn on "Use the WSL 2 based engine" and the integration for your Ubuntu distribution.
  3. Install Node 22, Git and Corepack inside Ubuntu, and run everything from an Ubuntu terminal.
  4. Keep the repositories on the Linux filesystem, in your Ubuntu home (`~/Desktop/hakorem-farms`), **not** under `/mnt/c/...`. File watching and database volumes are many times slower on the Windows mount.

Check everything at once:

```bash
node --version          # v22.x
corepack --version
docker --version && docker compose version
git --version
```

## 3. The workspace

Two repositories live side by side in one folder. The folder itself is not a repository and is never committed.

```text
~/Desktop/hakorem-farms/           working folder, not a repository
├── backend/                       github.com/officialjwise/hakorem_farms_backend
│   ├── .claude/skills/            the sixteen backend skills
│   ├── CLAUDE.md                  short rules; read it first
│   ├── contract/openapi.yaml      the interface; owned and published here
│   ├── docs/                      system of record: architecture, security, ADRs, session reports
│   ├── infra/                     Dockerfiles, compose, Caddy, deploy and backup scripts (from B2)
│   ├── src/                       the modular monolith (from B2)
│   └── test/                      integration, end to end, smoke, load (from B2)
└── frontend/                      github.com/officialjwise/hakorem_farms_frontend
```

```bash
mkdir -p ~/Desktop/hakorem-farms && cd ~/Desktop/hakorem-farms
git clone https://github.com/officialjwise/hakorem_farms_backend.git  backend
git clone https://github.com/officialjwise/hakorem_farms_frontend.git frontend

git -C backend  remote -v    # must show hakorem_farms_backend
git -C frontend remote -v    # must show hakorem_farms_frontend
```

Rules of the workspace:

- **You work inside `backend/` and nowhere else.** Never edit, stage or commit anything in `frontend/`, even to fix an obvious typo. The frontend track has its own sessions. A Claude Code session is opened at the workspace root so it can read across, but it writes only inside the repository it belongs to.
- **You may read the frontend's documents, never its code.** The one file you read regularly is `../frontend/docs/CONTRACT_REQUESTS.md`, where the frontend asks for things the contract does not offer. You never edit it. From B4 onward, every module session starts by reading it (see section 9).
- **The contract is the only link between the two repositories.** The frontend copies `backend/contract/openapi.yaml` into its own tree with a script. There is no shared package and no cross-repository import.
- **Check `git remote -v` before you push**, every time. Pushing backend work to the frontend remote is the mistake this rule exists to prevent.

## 4. `pnpm run setup` (built in B2)

The command is `pnpm run setup`, not `pnpm setup`: `pnpm setup` is a built-in pnpm command that edits your shell start-up files (A-071). `bash scripts/setup.sh` does the same as `pnpm run setup`. Where B2 differs from the list below, the B2 report says so: there is no object store yet (A-070), no seed data yet (A-075), and no worker until B3.

One command takes a fresh clone to a running, seeded API. B2's gate is that this works on a clean machine, and a CI job repeats it from a fresh checkout on every pull request so the claim stays true. It will:

1. **Check the machine.** Node 22, Corepack, Git, a running Docker daemon, Compose v2, enough free memory and disk, and that none of the ports it needs is already in use. It stops with a message naming the missing thing and how to fix it, never with a stack trace.
2. **Enable Corepack** and fetch the pinned pnpm.
3. **Install packages** with `pnpm install --frozen-lockfile`.
4. **Create `.env`** from `.env.example`, generating development-only secrets (signing keys, cookie secrets, a local key-encryption key). It never overwrites an existing `.env`, and never writes a real secret anywhere that is committed.
5. **Start the stack** with `docker compose up --detach --wait`: PostgreSQL 17, Redis 7 and MinIO, and wait for each health check to pass.
6. **Create the database roles and run the migrations** (`pnpm db:migrate`), as the migration role, in order.
7. **Seed the farm** (`pnpm db:seed`): the Dodowa branch, the catalogue, price lists, tax scheme, chart of accounts, staff and roles, customers, suppliers, investors, stock and some trading history. The seed refuses to run against production and every seeded record is marked as seed. Each module session extends it, so later sessions inherit a realistic farm.
8. **Start the API and worker** and wait for `GET /v1/health` to answer.
9. **Print what to do next**: the API address, the seeded logins (development passwords only), and the commands in this document.

This list is the specification B2 builds to; the B2 session report records any difference and is authoritative once it exists.

If anything fails halfway, running `pnpm run setup` again is safe: each step checks before it acts.

To start again from nothing: `docker compose down --volumes`, delete `node_modules`, run `pnpm run setup`. That is also exactly what the gate check does.

## 5. Running the API

After B2:

```bash
pnpm dev          # API and worker with reload; Postgres, Redis and MinIO in Docker
```

- The API listens on `http://localhost:3000/v1` (the local server listed in the contract).
- `curl http://localhost:3000/v1/health` returns the health report.
- The contract documentation: `npx @redocly/cli preview-docs contract/openapi.yaml`.
- Every state-changing request needs an `Idempotency-Key` header, and cookie-authenticated ones need `X-CSRF-Token`. See `docs/API.md` and the login flow written in the B3 session report.
- Logs are JSON on standard output. Every response carries `X-Correlation-Id`; every error body repeats it. When something fails, start from that id.

Database commands (after B2):

```bash
pnpm db:migrate     # apply migrations (expand then contract)
pnpm db:rollback    # roll back the last migration, or follow its documented forward fix
pnpm db:seed        # reload the seeded farm; refuses to run against production
```

## 6. The mock server for the contract

The frontend builds screens against this while the backend is still being written, and you can use it to see what an endpoint's examples look like. It needs only Node, so it works today.

```bash
npx @stoplight/prism-cli mock contract/openapi.yaml --port 4010
```

- Responses are the examples in the contract. The contract was written so that every list has at least five realistic rows from one consistent seeded farm (Dodowa, goats G-0142 and G-0157, Royal Palm Hotel, the investors, and so on).
- The mock holds no state. A POST does not change what the next GET returns.
- The mock is a convenience for the frontend. **The backend is not built against it.** The backend is built against the documents, and the contract test (`pnpm test:contract`) checks that the running API matches the contract.
- `contract/openapi.yaml` is 3 MB. Do not open it whole in an editor or a Claude session. Find what you need with a search for the path or the operation id, or by querying it with a small script. The Redoc preview is the readable view.

When you change a contract operation: bump the version, add an entry to `docs/CONTRACT_CHANGELOG.md`, and name the change at the top of your session report. A breaking change needs a major version.

## 7. Tests

After B2, each script does exactly what its name says. Details and naming are in `docs/TEST_STRATEGY.md`.

```bash
pnpm test:unit          # pure domain rules, no containers; the whole suite in under a minute
pnpm test:integration   # a module through its public interface, against real PostgreSQL and Redis in Testcontainers
pnpm test:contract      # every response against contract/openapi.yaml, and the generated contract against the committed one
pnpm test:e2e           # whole business flows on the full stack in Docker Compose
pnpm test:smoke -- --base-url=https://api.staging.hakoremfarms.com   # critical paths on a deployed environment
pnpm lint && pnpm typecheck    # includes the module boundary rule; CI blocks on both
```

Three habits:

- **Write the failing test first** for anything touching money, stock, weight or permissions, and make it assert an exact integer.
- **No mocked database, ever.** Integration means the real engine in a container. Use the factory module for data, never a hand-written fixture.
- **A flaky test is a failing test.** Quarantine it with an issue; never add a retry loop.

## 8. Where to start reading

Read in this order. The first five take about three hours and are worth it before you write anything.

| # | Document | What you get | Time |
| --- | --- | --- | --- |
| 1 | `docs/SHARED_BRIEF.md` | The business, the hard constraints, the requirements, the definition of done, the session protocol and the seven acceptance scenarios. Binding on everything. It is long: read the Mission, Hard constraints, Domain model, Sessions and Definition of done sections fully and skim the rest | 45 min |
| 2 | `CLAUDE.md` | The one-page version: constraints, where things live, which skill fires when, commands and the three things that go wrong | 5 min |
| 3 | `docs/ARCHITECTURE.md` | The context and container views, module map, dependency rules, request flow, event flow, the two sale posting sequences, deployment topology, and the decision index | 40 min |
| 4 | ADRs 0001 to 0007 (`docs/adr/`) | Money and rounding; the stock movement ledger; the chart of accounts and posting matrix; pricing resolution; aggregate boundaries and isolation; audit tamper evidence; branch and location. The seven decisions that are most expensive to reverse | 60 min |
| 5 | `docs/DOMAIN_MODEL.md` | The ubiquitous language, aggregates, invariants (each marked database or domain), events, the stock and processing lifecycle, the order state machine | 45 min |
| 6 | `docs/MODULE_BOUNDARIES.md` | What each of the twenty-two modules owns, the layers, the published-key allow-list, the four ports and the lint rule | 30 min |
| 7 | `docs/DATA_MODEL.md` | Conventions, the schema index, the entity relationship diagrams and the rules the database enforces. Then `docs/data-model/<schema>.md` only for the schema you work on | 30 min |
| 8 | The module you work on | Its card in `MODULE_BOUNDARIES.md`, its section of `docs/DOMAIN_MODEL.md` section 5, its dictionary in `docs/data-model/`, its requirement block in `docs/SRS.md` (never the whole SRS), its ADRs, and the contract operations tagged with its name | as needed |

Keep these open beside you while you work:

- `docs/GLOSSARY.md` for the names. If a word in your code is not in the glossary or the domain model, it is probably a second name for something that already has one.
- `docs/ENGINEERING_STANDARDS.md` for naming, errors, logging and the review checklist.
- `docs/security/THREAT_MODEL.md` section 4, the eighteen abuse cases, if your module touches cash, stock, payments, exports or permissions.
- `docs/OFFLINE_SYNC.md` if your work touches the counter or the driver's phone.
- `docs/ASSUMPTIONS.md` and `docs/BACKLOG.md`, so you know what has been decided on someone's behalf and what has been deliberately left out.

`docs/README.md` indexes every document. The sixteen skills under `.claude/skills/` each fire on a kind of task and point to the document that governs it; `docs/prompts/SKILLS_VERIFICATION.md` records that they fire.

## 9. Sessions and handoff reports

The system is built in numbered sessions, one phase each. The plan is the table in `docs/adr/0026-session-schedule-amendment.md`: B0 and B1 are written; B2 foundation; B3 platform and the first vertical slice; B4 master data and pricing; B5 inventory; B6 livestock and processing; B7 procurement; B8 ledger and billing; **B9a** order core and payments; **B9b** point of sale, shifts and offline sync; B10 quotations, wholesale and credit; B11 fulfilment, delivery and notifications; B12 capital, costing, reporting and the public API; B13 hardening and deployment.

How a session runs (the protocol is in `docs/SHARED_BRIEF.md`, the opening messages are in `docs/prompts/session-openers.md`):

1. **Open at the workspace root** and read `CLAUDE.md`, `docs/SHARED_BRIEF.md`, and only your session's section of `docs/BUILD_PROMPT.md`. List `docs/sessions/` and read only the latest report. From B4 onward also read `../frontend/docs/CONTRACT_REQUESTS.md` if it exists.
2. **Confirm in three lines**: the phase, its scope, and its gate. If what you are about to build contradicts a document, say so and stop; do not code around it.
3. **Execute that session only.** One branch per session, named for it: `b05-inventory-ledger`, `b09a-order-core-payments`, `b09b-pos-shifts-offline`. Conventional Commits, one concern per commit, the test in the same commit as the code, and the requirement id in the message: `feat(inventory): post stock take variance (FR-INV-031)`.
4. **Stop at the gate.** The gate is the point of the phase. Do not begin the next phase however much context remains.
5. **Write the handoff report** at `docs/sessions/<ID>-<slug>.md` (ids `B02`, `B09a`, `B09b`, `B13`): contract changes first, then what was built, decided, assumed and deferred, the test numbers, the gate result, notes for the frontend track, and the **exact opening message for the next session**. It is the only thing the next session reads about this one. Write it even when the session went badly; especially then.
6. **Push before you close.** Run `git remote -v`, confirm `hakorem_farms_backend`, push the branch, open a pull request, and squash merge when CI is green. Unpushed work throws away its own handoff.

Start a fresh session the moment the phase is finished, context passes roughly sixty percent, the session re-reads a file it already read, or it starts summarising its own work instead of building. If a module is too large for one context, split at a module boundary and label the next session `B05 continued`. Never split in the middle of a module.

For B4 to B12, the reusable prompt is `docs/prompts/module-build-prompt.md`.

## 10. The three rules that most often go wrong

Every review comment so far, and every comment predicted for the build, is one of these.

### 1. Money is never a float

Money is an integer number of pesewas, in a field ending `_pesewas`, held in the kernel `Money` type. Rounding happens once, half-up, at the line. Any split uses `allocate` (largest remainder) so no pesewa is created or lost. A lint rule fails the build on arithmetic operators in files that import `Money`.

```ts
// Wrong: a float, and two roundings that can disagree with the total
const net = price * qty;               // 0.1 + 0.2 problems
const vat = Math.round(net * 0.15);
const nhil = Math.round(net * 0.025);

// Right: integers, one rounding, an exact split (names are illustrative; the kernel's API is fixed in B2)
const gross = Money.ofPesewas(45_900n);                     // GHS 459.00
const [net, vat, nhil, getfund] = taxCalculator.splitInclusive(gross, levies);
// 38_250, 5_738, 956, 956: they sum to 45_900 exactly
```

Test it with an exact value, including a rounding edge: GHS 459.00 tax-inclusive beef splits to net 382.50, VAT 57.38, NHIL 9.56 and GETFund 9.56.

### 2. Never reach across a module boundary

A module is used only through its published interface (`index.ts`) from a lower layer, or by reacting to its domain events. No module selects from, joins or writes another module's tables. The import-boundary lint rule and a check on foreign keys fail the build.

```ts
// Wrong: an order module reading the inventory table
const rows = await db.select().from(stockBalance).where(eq(stockBalance.productId, id));

// Right: ask inventory through its published port
const available = await inventory.getAvailable({ productId, locationId });
```

If you need a fact from a higher layer, publish an event; do not call up. If you cannot tell which layer you are in, read the card in `docs/MODULE_BOUNDARIES.md` before writing the import.

### 3. Never update a ledger row

Stock movements, journal entries, audit events, payment allocations and every other `LEDGER` table are insert-only. The database refuses `UPDATE` and `DELETE`. A mistake is corrected by a reversing row that references the original, never by editing it, and on-hand stock is never a number someone typed: it is derived from movements.

```sql
-- Wrong
UPDATE inv.stock_movement SET qty_base = 3 WHERE id = $1;
UPDATE inv.stock_balance  SET on_hand_qty = 12 WHERE product_id = $1;

-- Right: a reversing movement, then the correct one; the balance follows by trigger
INSERT INTO inv.stock_movement (... reverses_movement_id ...) VALUES (... $1 ...);
```

The same applies to a posted document: it is frozen. Void it, credit it or reverse it; do not edit it.

## 11. First-week tasks

Tasks that work before B2 are marked **now**. The rest need B2.

| Day | Task | Done when |
| --- | --- | --- |
| 1 | **Now.** Install the prerequisites. Clone both repositories into the workspace and check both remotes. Lint the contract and start the mock server. `curl http://localhost:4010/health`, `/animals` and `/exceptions/daily-report` and read the answers | Lint is clean; the mock answers; you can name the three fields of the animal that tell you what it costs the farm and what it would sell for |
| 1 | After B2: `pnpm run setup`, `pnpm dev`, `curl http://localhost:3000/v1/health`, `pnpm test:unit`, then `docker compose down --volumes` and set up again | The second setup works with no help |
| 2 | **Now.** Read documents 1 to 5 in section 8 | You can explain, without looking, why stock has no quantity column, why the ledger subscribes instead of being called, and what a stock exception is |
| 3 | **Now.** Do two calculations by hand. First, GHS 459.00 tax-inclusive across VAT, NHIL and GETFund by largest remainder. Second, test 1 of `docs/adr/0028-investor-distribution-allocation.md`. Then find both in `contract/openapi.yaml` and in the UAT script and compare | Both calculations match the documents to the pesewa |
| 3 | After B2: break the boundary rule on purpose (import another module's internals) and watch `pnpm lint` fail; undo it. Do the same for a float in a file that imports `Money` | You have seen both rules fire |
| 4 | **Now.** Trace one flow on paper: a counter sale, from `POST /pos/sales` in the contract, through the sale posting sequence in `docs/ARCHITECTURE.md`, the events in `docs/DOMAIN_MODEL.md`, to the journal entries in the posting matrix of ADR-0003 | You can list, in order, every table that gains a row and every account that is debited or credited |
| 4 | **Now.** Read the module card and requirement block of the module you will work on, and the contract operations tagged for it | You can state its invariants, the events it publishes and subscribes to, and what it may import |
| 5 | **Now.** Read the latest report in `docs/sessions/` and `docs/prompts/module-build-prompt.md`. Pick one inaccuracy you found during the week (a stale cross-reference, an example that does not add up) and open a small documentation pull request for it | The pull request is reviewed; you know how a change moves from branch to merge |
| 5 | After B2: pick the smallest open item in your module's section of the SRS and write its failing test, with exact values, before any implementation | A red test, reviewed, committed on your session branch |

Ask in the pull request, not in private: a question that needed answering once will be asked again, and the answer belongs in a document.

## 12. If something does not work

| Symptom | First thing to check |
| --- | --- |
| `pnpm: command not found` | `corepack enable`, then open a new terminal |
| `pnpm run setup` reports a port in use | Another Postgres or Redis on the machine. Stop it, or change the port in `.env` as the message explains |
| Docker cannot start the database on Windows | The repository is under `/mnt/c`. Move it into the WSL home |
| Containers are killed or very slow | Docker's memory limit is below 6 GB. Raise it in Docker Desktop settings |
| `pnpm lint` fails with a boundary message | Read the card for the importing module in `docs/MODULE_BOUNDARIES.md`. The fix is almost never to change the rule |
| Redocly reports an error | You edited the contract. The contract is owned by the backend and must lint clean; revert or fix it, and do not hand-edit it after B2: regenerate it with `pnpm contract:generate` |
| A test needs a database and the run is fast and green | It is using a mock. That is not allowed. Use the Testcontainers fixture |
| Not sure whether a thing is in scope | It is probably in `docs/BACKLOG.md`, or it belongs there |
