# HaKorem Farms Platform: documentation index

Every document of the backend repository, with one line each. System-wide documents live here; frontend-specific documents live in the frontend repository. The documents are the source of truth: code that contradicts them is a bug in the code.

## Reading order for a new developer

1. [SHARED_BRIEF.md](SHARED_BRIEF.md): the business, the domain, the requirements and the rules. Binding on everything.
2. [../CLAUDE.md](../CLAUDE.md): the short version, the commands and the skills.
3. [ONBOARDING.md](ONBOARDING.md): clone to running in under thirty minutes.
4. [ARCHITECTURE.md](ARCHITECTURE.md): how the system fits together.
5. ADRs [0001](adr/0001-money-representation-and-rounding.md) to [0007](adr/0007-multi-location-from-day-one.md): the seven decisions that are most expensive to reverse.
6. [DOMAIN_MODEL.md](DOMAIN_MODEL.md), then [MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md).
7. [DATA_MODEL.md](DATA_MODEL.md), then the dictionary of the module you work on in [data-model/](data-model/).
8. [API.md](API.md) and the contract, [../contract/openapi.yaml](../contract/openapi.yaml).
9. [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md), [TEST_STRATEGY.md](TEST_STRATEGY.md), [security/SECURE_CODING_STANDARDS.md](security/SECURE_CODING_STANDARDS.md).
10. The latest report in [sessions/](sessions/), then the requirement block of your module in [SRS.md](SRS.md).

## Build process

| Document | What it holds |
| --- | --- |
| [SHARED_BRIEF.md](SHARED_BRIEF.md) | The common brief for the backend and frontend tracks, as issued |
| [BUILD_PROMPT.md](BUILD_PROMPT.md) | The backend build prompt: one section per session, amended for B9a, B9b and B13 |
| [prompts/README.md](prompts/README.md) | What each build prompt is for |
| [prompts/session-openers.md](prompts/session-openers.md) | The exact opening message for each remaining backend session |
| [prompts/module-build-prompt.md](prompts/module-build-prompt.md) | The reusable prompt for module sessions B4 to B12 |
| [prompts/SKILLS_VERIFICATION.md](prompts/SKILLS_VERIFICATION.md) | Whether each Claude Code skill fires on the task it is meant for |
| [sessions/](sessions/) | One handoff report per session; the next session reads the latest |

## Requirements

| Document | What it holds |
| --- | --- |
| [SRS.md](SRS.md) | Scope, actors, use cases, every numbered functional, security and non-functional requirement, and the traceability matrix |
| [UAT.md](UAT.md) | The seven acceptance scenarios, scripted for the owner to run without a developer |
| [GLOSSARY.md](GLOSSARY.md) | Livestock, processing, accounting and system terms, with the names used in code |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) | Every assumption made in place of an answer, dated, with who confirms it |
| [BACKLOG.md](BACKLOG.md) | What is deliberately out of scope for version one |

## Design

| Document | What it holds |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Context and container views, module map, request and event flow, sale posting, deployment, decision index |
| [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | Language, aggregates, invariants and events per module; stock lifecycle; order state machine |
| [MODULE_BOUNDARIES.md](MODULE_BOUNDARIES.md) | What each module owns and may import; published keys; ports; the lint rule |
| [DATA_MODEL.md](DATA_MODEL.md) | Conventions, schema index, entity relationship diagrams, rules the database enforces |
| [data-model/](data-model/) | One table dictionary per schema: every column, type, constraint and reason |
| [adr/](adr/) | Architecture decision records, from the [template](adr/0000-template.md) and 0001 onward |
| [OFFLINE_SYNC.md](OFFLINE_SYNC.md) | The offline data model, the queue, conflict rules and worked examples |

## Interface

| Document | What it holds |
| --- | --- |
| [../contract/openapi.yaml](../contract/openapi.yaml) | The OpenAPI 3.1 contract: the only interface between backend and frontend |
| [API.md](API.md) | Conventions, authentication, errors and their codes, idempotency, pagination, webhooks, per-module notes |
| [CONTRACT_CHANGELOG.md](CONTRACT_CHANGELOG.md) | Every change to the contract, newest first |

## Security and compliance

| Document | What it holds |
| --- | --- |
| [security/SECURITY_ARCHITECTURE.md](security/SECURITY_ARCHITECTURE.md) | Trust boundaries, authentication, authorisation, keys, encryption, secure defaults |
| [security/THREAT_MODEL.md](security/THREAT_MODEL.md) | STRIDE per boundary, attack trees, the abuse cases, residual risks |
| [security/DATA_CLASSIFICATION.md](security/DATA_CLASSIFICATION.md) | Classification levels and the handling rule for every data category |
| [security/SECURE_CODING_STANDARDS.md](security/SECURE_CODING_STANDARDS.md) | The rules a pull request is checked against, with correct and incorrect examples |
| [security/COMPLIANCE.md](security/COMPLIANCE.md) | Legal and tax obligations, checked against sources, with dates |

## Engineering

| Document | What it holds |
| --- | --- |
| [ENGINEERING_STANDARDS.md](ENGINEERING_STANDARDS.md) | Naming, layout, errors, logging, validation, commits, branches, review checklist |
| [TEST_STRATEGY.md](TEST_STRATEGY.md) | Test layers, naming, coverage gates, test data policy, required named tests |
| [ONBOARDING.md](ONBOARDING.md) | Prerequisites, setup, where to start reading, first-week tasks |

## Operations

| Document | What it holds |
| --- | --- |
| [OPERATIONS.md](OPERATIONS.md) | Environments, configuration reference, secrets, monitoring, alert thresholds, scheduled jobs, cost estimate |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Pipeline, migrations, zero-downtime switch, rollback, provisioning, release checklist |
| [DATA_MIGRATION.md](DATA_MIGRATION.md) | Opening balances, opening stock and animals, dry run and sign-off |
| [runbooks/](runbooks/README.md) | One runbook per failure mode: symptoms, diagnosis, fix, verification, escalation |
