# Runbook: database failover (single server)

Last reviewed: 2026-11-13. Severity: Critical. Related: ADR-0025, ADR-0024, `docs/OPERATIONS.md` sections 7 and 9, `docs/runbooks/restore-from-backup.md`, `docs/OFFLINE_SYNC.md`.

## What "failover" means here

There is **one PostgreSQL server**: one container on one VPS. There is no standby, no replica and no automatic failover. This is a deliberate choice for cost and simplicity (ADR-0025), with a recorded residual risk: availability of 99.5 percent a month allows about 3.6 hours of downtime, and the recovery time objective is 4 hours.

So in this system a "failover" is one of two things:

1. **A restart in place.** The container or the process crashed, ran out of memory or disk, or the server rebooted. PostgreSQL recovers itself from its own write-ahead log when it restarts. Nothing is lost that was committed.
2. **A restore onto a new server.** The disk, the server or the data directory is lost or corrupted beyond repair. The database is rebuilt from the off-box base backup and WAL archive (`restore-from-backup.md`), losing at most the last 15 minutes of commits (the recovery point objective).

The counter keeps selling offline for up to 8 hours while the database is unavailable (ADR-0027), and syncs when it returns. The API returns 503 `SERVICE_UNAVAILABLE` and the health endpoint reports `database` as `DOWN`.

## Symptoms

- Alert: `database` check `DOWN`; availability probe failing; HTTP 5xx above 5 percent; disk above 85 percent; memory below 8 percent or a container killed for memory; database connections above 95 percent.
- Staff see "service unavailable"; the console shows its offline banner; payments webhooks fail (the provider retries).
- `dc ps` shows `postgres` as `Exited`, `Restarting` or `unhealthy`.

## Step 0: stay safe

- **Do not delete files in the data directory, in `pg_wal`, or the Docker volumes.** Do not run `docker compose down -v`, `docker volume rm`, `docker system prune --volumes`, or `pg_resetwal`. Each can destroy the only copy of committed data.
- Write the start time and every command in the incident log. Any use of the superuser is an entry.
- If there is any sign of intrusion (unknown processes, unknown logins, tampered files), stop and use `incident-response.md`: capture evidence before restarting.

## Diagnosis

```bash
dc ps                                           # which containers are up
dc logs --tail 200 postgres                    # why it stopped
df -h /var/lib/docker /                         # disk
free -m; dmesg -T | tail -30                    # memory pressure, OOM kills
docker inspect --format '{{.State.OOMKilled}} {{.State.ExitCode}}' $(dc ps -q postgres)
dc exec postgres pg_isready -U postgres         # accepting connections?
```

Decide which case it is:

| Evidence | Case |
| --- | --- |
| The log ends with `database system was interrupted` or `PANIC` followed by a restart, exit code 137, or `OOMKilled true` | A. Crash or out of memory |
| `No space left on device`, `could not write to file`, disk at 100 percent | B. Disk full |
| `too many connections`, many connections from one role | C. Connections exhausted |
| The server does not answer SSH, or the disk is unreadable, or files are corrupt (`invalid page`, `could not read block`, checksum failures) | D. Server or storage loss or corruption |
| The server is up but the data directory is empty or does not match | D |

## Fix

### A. Crash or out of memory

1. If the container is restarting by itself, let it. PostgreSQL replays WAL on start; for a busy database this takes seconds to a few minutes. Watch `dc logs -f postgres` until it prints `database system is ready to accept connections`.
2. If it is not restarting: `dc up -d postgres`.
3. If it was killed for memory, find the cause before it happens again: a report query running without its statement timeout, a runaway worker, too many connections. Check `SELECT pid, usename, state, now() - xact_start AS xact_age, left(query, 120) FROM pg_stat_activity ORDER BY xact_start NULLS LAST;`. Stop the worker if it is the cause (`dc stop worker`), then restart it later with a lower `REPORT_CONCURRENCY`. Check the container limit (OPERATIONS section 2) against `shared_buffers` and `max_connections`.
4. When PostgreSQL is accepting connections, start the rest in this order: `dc up -d redis`, then the API (`dc up -d $ACTIVE`), then `dc up -d worker`. Verification below.

### B. Disk full

When the disk fills, PostgreSQL stops writing and will not start cleanly. The usual cause is WAL piling up because **archiving to object storage is failing**, so segments cannot be recycled.

1. **Do not delete WAL files.** Find what is using space: `du -xh --max-depth=2 /var/lib/docker | sort -h | tail -20`; `dc exec postgres du -sh /var/lib/postgresql/data/pg_wal`; `docker system df`.
2. **Free space that is safe to free:** old images (`docker image prune -a --filter "until=168h"` keeps recent ones; always keep the current and previous release images, see `/opt/hakorem/state/`), rotated container logs (`journalctl --vacuum-size=200M`; Docker's own logs are limited to 250 MB per container), `/var/log/caddy` rotated files older than 30 days, Prometheus data older than the retention. This normally frees several GB and is enough to start PostgreSQL.
3. **Fix the archive** so WAL can flow again: `dc exec postgres pgbackrest --stanza=hakorem check`. If it fails, the cause is the bucket credentials (`S3_BACKUP_*`), the network, the bucket quota, or the encryption key. Correct it; the archive command retries and the backlog drains. Watch `pg_wal` shrink and `hk_wal_archive_age_seconds` fall.
4. Start PostgreSQL if it is down (`dc up -d postgres`) and then the application as in case A.
5. If the volume is genuinely too small for the data, upgrade the plan or add storage in the hosting panel, then grow the filesystem, with a fresh base backup taken first. Record the capacity decision in `docs/OPERATIONS.md`.

At 92 percent used, act at once even if the database is still up: stop the worker to stop the heaviest writer, free space as above, and find the cause.

### C. Connections exhausted

1. `SELECT usename, state, count(*) FROM pg_stat_activity GROUP BY 1,2 ORDER BY 3 DESC;`
2. A lot of `idle in transaction`: a handler is holding a transaction open. The `idle_in_transaction_session_timeout` of 10 seconds should be killing them; if not, check the setting. Terminate stuck sessions only with `pg_terminate_backend(pid)` for those clearly idle in transaction for more than 60 seconds, and log each.
3. If the API's pool is the cause (a slow query), restart the API instance through the zero-downtime procedure rather than killing it mid-request. Raise `max_connections` only after checking memory.

### D. Server or storage loss, or corruption: restore

1. **Decide quickly, but not recklessly.** If the server is unreachable and the hosting provider's status or support gives no recovery within 30 minutes, **start the restore to a new server in parallel** while the old one is still being investigated. The recovery time objective is 4 hours and a restore takes most of it.
2. **Prevent two writers.** Before the new database goes live, make sure the old server cannot accept traffic: power it off from the hosting panel, or remove its DNS records. Two production databases accepting writes is worse than an outage.
3. **Follow `restore-from-backup.md`** from "Restore to a new server". It provisions the server per `docs/DEPLOYMENT.md` section 11, restores the latest base backup and WAL to the latest recovery point, starts the application and verifies it.
4. **Switch DNS** to the new server's address. This is why the DNS TTL is kept at 3600 at most and lowered to 300 during a planned move (`docs/DEPLOYMENT.md` section 10). In an emergency, set TTL to 300 immediately and expect up to the old TTL before everyone follows.
5. **Corruption on a server that is still up** (checksum errors, `invalid page`): stop writes (`dc stop worker`, then the API), take an immediate copy of the data directory for evidence (`restore-from-backup.md`, "Preserve the failed server"), and restore a clean copy rather than continuing on a corrupt one.

## After the database is back

1. **Devices will sync.** Counters that sold offline now send their queues (`POST /pos/sync`, 500 per batch). The duplicate rule makes it safe. Expect a burst of load; `offline-sync-conflicts.md` explains what the manager reviews afterwards.
2. **If a restore lost the last minutes of commits** (case D): what was committed in that window is gone. Reconstruct from other records, in this order:
   - Orders and payments: the payment provider's transaction list for the window. Webhooks the provider could not deliver may be retried by the provider for a while, and will appear as unmatched payments; treat them as in `reconciliation-break.md`.
   - Counter sales: the printed provisional and official receipts, and devices that still hold queued records.
   - Stock: the next nightly recompute and a stock take of high-value locations.
   - Audit: the restored chain head against the latest off-box anchor (`audit-chain-integrity.md`): if the anchor is **ahead** of the restored head, events that were sealed and anchored were lost, and that is recorded in the incident log and told to the owner.
   Record the exact window and what was reconstructed.
3. **Take a base backup now**, and confirm WAL archiving continues on the new timeline (`pgbackrest --stanza=hakorem check`, `info`).
4. Run the nightly reconciliation jobs by hand once, and read the daily exception report.
5. If it was a hardware or provider failure, ask the provider for the cause in writing. If it was capacity, change the plan or the limits and record it.
6. Add the event to `docs/OPERATIONS.md` section 9.6 if it was a restore, with its timings.

## Verification

```bash
curl -s https://api.hakoremfarms.com/v1/health | jq '{status, checks: [.checks[] | select(.status != "OK")]}'
dc exec postgres psql -U postgres -d hakorem -Atc "select pg_is_in_recovery(), now(), (select max(finished_at) from platform.job_run);"
dc exec postgres pgbackrest --stanza=hakorem check
```

- `status` is `OK`, or `DEGRADED` for a stated reason that is already in the incident log.
- `pg_is_in_recovery()` is `f`.
- The audit sealing lag is falling, the outbox backlog is draining, the smoke suite passes (`pnpm test:smoke -- --base-url=https://api.hakoremfarms.com/v1`, against the test branch only), and the WAL archive age is under 5 minutes.
- A counter test: one test sale on the test branch, then voided.

## Escalation

| When | Who |
| --- | --- |
| Database unavailable more than 15 minutes | Owner (so the shop supervisor can plan for offline mode) |
| Restore started | Owner and the backup administrator; the hosting provider's support in parallel |
| Total time approaching 3 hours | Owner: decide whether to keep going on the plan or to accept a longer outage, and tell the shop |
| Any sign of intrusion or deliberate damage | `incident-response.md` |
| Recovery objective exceeded | A finding with an owner and a date, recorded in `docs/OPERATIONS.md` |
