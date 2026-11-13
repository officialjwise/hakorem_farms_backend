# Runbooks

One runbook per failure mode. Each has symptoms, diagnosis, the fix, verification and escalation. They are written to be followed at the worst moment of the week by someone who is calm but has not read them before, so they give commands and names rather than principles.

Other documents they rely on: `docs/OPERATIONS.md` (alerts, jobs, backups, configuration), `docs/DEPLOYMENT.md` (the server, the deploy and rollback scripts), `docs/OFFLINE_SYNC.md`, `docs/security/SECURITY_ARCHITECTURE.md` and `docs/security/THREAT_MODEL.md`.

## Index

| Runbook | Failure mode | Alerts that point to it | Who acts first |
| --- | --- | --- | --- |
| [`payment-provider-down.md`](payment-provider-down.md) | The payment provider (or the messaging providers) is unreachable, slow, rejecting our credentials, or not sending webhooks | Payment provider failure rate, PENDING payments with no webhook, notification send failure rate | Administrator, then the owner |
| [`database-failover.md`](database-failover.md) | PostgreSQL is down, full, out of memory or lost. There is one server, so "failover" means a restart or a restore | `database` check DOWN, disk, memory, connections | Administrator |
| [`restore-from-backup.md`](restore-from-backup.md) | Restoring the database to a new or existing server from the off-box backups, and the timed quarterly drill | WAL archive age, base backup age, monthly restore verification | Administrator |
| [`incident-response.md`](incident-response.md) | A suspected security incident, fraud, data exposure or tampering: evidence first, then containment, notification and recovery | Refresh token reuse, investor authorisation failure, webhook rejections, failed logins, certificate expiry, any `REJECTED_INTEGRITY` | Administrator and the owner together |
| [`reconciliation-break.md`](reconciliation-break.md) | A nightly job reports `DRIFT` or `FAILED`, or the payments module raises a reconciliation break | Reconciliation job outcome, trial balance, numbering, settlement | Accountant, with the administrator |
| [`queue-backlog.md`](queue-backlog.md) | The outbox, a queue, a projection or the CPU is behind, or a delivery is dead-lettered | Outbox backlog and age, dead letters, queue depth, projection lag, latency | Administrator |
| [`audit-chain-integrity.md`](audit-chain-integrity.md) | The audit sealer is behind, or the chain, a gap or an anchor does not verify | Audit sealing lag, chain verification, long transaction, clock offset | Administrator; the owner for any mismatch |
| [`stock-balance-drift.md`](stock-balance-drift.md) | The nightly recompute finds a stock balance or cost pool that does not equal the movement ledger | Stock balance drift rows | Storekeeper and administrator |
| [`offline-sync-conflicts.md`](offline-sync-conflicts.md) | Offline sales and driver records arrived with conflicts, gaps, rejections, or a device is stuck | Offline alerts; the daily exception report | Manager |

## Conventions

- **Severity.** Critical: money or stock is wrong, evidence may be at risk, or the counter cannot trade; act now, 24 hours a day. Warning: something needs a person today. Information: look at it in the daily routine.
- **Evidence first.** If there is any chance that a person did this on purpose, or that data was exposed, stop and open `incident-response.md` before correcting anything. Corrections destroy evidence.
- **Never correct silently.** A reconciliation job reports and never corrects. A stock balance is written only by the database trigger. Ledger, stock, audit and payment allocation rows are insert-only. A correction is a new, approved, reversing record.
- **Superuser is an event.** The database superuser is used only by an administrator over SSH. Every use is an entry in the incident log with the time, the person, the reason and the statement. Prefer the read-only `hk_report` or `hk_backup` roles for looking, and the application for changing.
- **Commands.** They assume you are the `deploy` user on the production server, in `/opt/hakorem`, and that `$ENV` is `hk-prod` (use `hk-staging` on staging). `docker compose -p $ENV ...` is shortened to `dc` below, and the active API service name is in `/opt/hakorem/state/production.active` (`api-blue` or `api-green`). The PostgreSQL image includes pgBackRest.

```bash
export ENV=hk-prod
alias dc='docker compose -p $ENV -f /opt/hakorem/compose/docker-compose.yml'
ACTIVE=$(cat /opt/hakorem/state/production.active)       # api-blue or api-green
curl -s https://api.hakoremfarms.com/v1/health | head -c 2000
```

- **The incident log.** A private, access-controlled document kept outside the repository (the administrator's password manager's secure notes, or the private document store) with one entry per incident: id (`INC-YYYYMMDD-n`), times in UTC, who did what, every superuser statement, every evidence file with its SHA-256, decisions and who made them. Create the entry before the first action.
- **Contacts** (roles, never numbers in this repository). The owner; the administrator on call and a backup; the accountant; the hosting provider's support; the payment provider's merchant support; the SMS, WhatsApp and email providers' support. The numbers are kept in the administrator's password manager and in a sealed envelope held by the owner, and are reviewed at each quarterly drill.
- **Tabletop exercise.** Each quarter, with the restore drill, one runbook is walked through aloud by the people who would use it, in a ten-minute exercise, and corrected where it was wrong.
- **Changing a runbook.** A new failure mode or a resolved incident updates the relevant runbook in the same pull request as its fix (the `hakorem-runbook` skill). A runbook with a heading and no steps under it is not finished.
- **Last reviewed.** Every runbook states the date of its last review at the top. A runbook not reviewed for a year is reviewed at the next drill.
