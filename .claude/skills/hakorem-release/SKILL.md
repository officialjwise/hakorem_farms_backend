---
name: hakorem-release
description: "Use when preparing, versioning, tagging, approving, deploying, promoting or rolling back a release of the backend: the release checklist, changelog and release notes, version bump, `docs/CONTRACT_CHANGELOG.md` entry, production migration review and approval, smoke run against the new containers, rollback plan, software bill of materials, scan results, the load run before release, the sign-off, GitHub Actions deploy workflows, `infra/` deploy scripts, or the question \"is this ready to ship\". Writing the migration itself is hakorem-migration; writing the incident runbook is hakorem-runbook; a decision about the pipeline's shape is hakorem-adr."
---

# Release: nothing reaches production without a green pipeline and a human sign-off

Governing documents: `docs/DEPLOYMENT.md` (pipeline, environments, migration procedure, rollback, release checklist), `docs/OPERATIONS.md` (environments, alerts, cost), `docs/adr/0025-deployment-topology.md` (containers and deploy sequence), `docs/adr/0024-database-roles-and-privileges.md` (`hk_migrator`), `docs/SHARED_BRIEF.md` ("The pipeline", "Deployment to the Hostinger VPS", "Definition of done"), `docs/runbooks/` (rollback and restore). Builds never run on the server; CI builds one image per commit SHA.

## The pipeline in one view

1. Push to `main` runs lint, type check, unit, integration, contract diff and end-to-end tests, plus dependency audit, static analysis, secret scan and container image scan. A high-severity finding blocks the merge.
2. Green build produces an image tagged with the commit SHA and pushes it to the GitHub Container Registry; a software bill of materials is generated per release and kept with it.
3. The deploy job connects over SSH as the deploy user, pulls the image, and runs migrations in a one-shot container as `hk_migrator`. Production migrations wait for manual approval and have already run on staging.
4. A second `api` instance starts beside the old one; the smoke suite runs against it through an internal route.
5. Smoke passes: traffic switches, the old instance drains, the worker restarts on the new image. Smoke fails: the new instance is discarded, traffic never moved, the job exits non-zero and no human decision is awaited.
6. Migrations stay backward compatible for one release, so step 5 never needs a database rollback.

## Checklist before approving a release

1. **Scope and requirements.** Every change is traceable to a requirement id (`FR-<MOD>-nnn`) in a commit or pull request, committed as Conventional Commits, one concern per commit with its test. No unfinished-work markers, no commented-out code, no skipped test, no secret.
2. **All test layers green** on the release commit: unit, integration against real Postgres, contract (zero drift), end to end. Coverage gates hold (80 percent overall, 100 percent branch on pricing, ledger, valuation, distribution, kernel money).
3. **Migration review** (with hakorem-migration). Each migration in the release: expand-then-contract, backward compatible with the previous release, header states the tested rollback or the forward fix, class and grants match, ran on staging against realistic data, and takes no long exclusive lock on a hot table. No migration in this release removes something the running release still reads. Production application of migrations is approved by a named person.
4. **Contract.** The generated `contract/openapi.yaml` equals the committed file. A change has a version bump and an entry in `docs/CONTRACT_CHANGELOG.md`; a breaking change is named at the top of the release notes so the frontend track picks it up. Redocly lint passes with no errors or warnings.
5. **Changelog and notes.** Release notes list what changed for the owner in plain words, contract changes, migrations, new settings or permissions (a new permission is granted to no role until a migration adds it), and known limits. The version is tagged on the release commit.
6. **Security.** Scans clean; any change to auth, payments, exports, uploads, webhooks or permissions has its finding in the pull request (hakorem-security-review); the residual risk register in `docs/security/THREAT_MODEL.md` is reviewed at each release; new abuse paths appear on the daily exception report.
7. **Configuration and secrets.** New environment variables are in the typed configuration with a documented entry in `docs/OPERATIONS.md`, set in staging and production secrets files before deploy. Nothing secret in the image, repository or workflow. Staging and production keep separate databases, credentials and provider sandboxes.
8. **Smoke and health.** The smoke suite (read-only plus one safe write on the `is_test` branch, under 60 seconds) is current for any new critical flow. `GET /health` is green: database, WAL archive age, Redis, queue depth, outbox backlog, audit sealing lag, projection lag and last reconciliation outcomes.
9. **Load.** A k6 run against the non-functional targets was done for this release (read p95 under 300 ms, write p95 under 600 ms at 50 concurrent users) with the serialization retry rate recorded in `docs/OPERATIONS.md`; a heavy report running during counter sales did not break the POS target.
10. **Rollback plan written down.** State: what the previous image tag is; that the new instance is removed if smoke fails; how to point traffic back after a late discovery; which migrations are forward-only and what the forward fix is; who decides. Data is never rolled back by editing history; ledger and stock errors are corrected with reversing entries.
11. **Backups and recovery.** Last nightly base backup and WAL archive are healthy before deploy; the last restore drill date is within a quarter; nothing in this release lengthens the 4-hour recovery time.
12. **Docs updated in the same release.** `docs/API.md`, the relevant `docs/data-model/` dictionary, runbooks for any new failure mode (hakorem-runbook), ADRs for decisions made, `docs/ASSUMPTIONS.md` and `docs/BACKLOG.md`, and the session report.
13. **Window.** Deploy outside 06:00 to 20:00 Accra time unless it is zero-downtime and the owner agrees; never during an open shift reconciliation or a distribution run.
14. **Sign-off.** Owner or the named release approver confirms the checklist in the pull request. The release pull request description carries the completed checklist.

## Correct and incorrect

The filled-in checklist is an illustration of the form; its numbers are examples.

```markdown
### Release 1.4.0 checklist (hakorem-release)
- [x] Tests: unit, integration, contract (no drift), e2e green on 3f9c1ab
- [x] Migrations 0042, 0043 expand-only; rollback: 0043 reversible, 0042 forward fix documented in header; ran on staging 2026-11-12
- [x] Contract 1.4.0, additive; CONTRACT_CHANGELOG.md updated; no breaking change
- [x] Security: findings in PR #212; scans clean; SBOM attached
- [x] k6: read p95 212 ms, write p95 487 ms, serialization retries 0.4 percent
- [x] Rollback plan: previous image 9d2e7f0; smoke failure auto-discards new instance
- [x] Sign-off: owner, 2026-11-13
```

```markdown
<!-- WRONG -->
Release: looks good, merged to main, deploying now.
- built the image on the server, ran migrations by hand as postgres
- skipped smoke, "it's only a small change"
- DROP COLUMN legacy_ref in the same release the API stopped writing it
```

```bash
# RIGHT: the pipeline deploys; humans approve. WRONG: ssh in and `docker compose up -d --build` by hand.
git tag -a v1.4.0 -m "Release 1.4.0" 3f9c1ab && git push origin v1.4.0   # triggers the approved deploy workflow
```

## If the smoke suite fails or something is wrong after traffic moves

Follow the rollback runbook in `docs/runbooks/` (and `docs/DEPLOYMENT.md`). Do not edit data to hide a problem; preserve evidence first if money or stock may be affected, then hakorem-runbook to record what happened and what changed.
