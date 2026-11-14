# Runbook: restore from backup

Last reviewed: 2026-11-13. Severity: Critical for a real restore; a scheduled exercise for the quarterly drill. Objectives: **recovery point 15 minutes, recovery time 4 hours.** Related: ADR-0025, ADR-0022, `docs/OPERATIONS.md` section 9 (backups, the drill log format), `docs/DEPLOYMENT.md` section 11 (provisioning), `docs/runbooks/database-failover.md`.

An untested backup is not a backup. This runbook is used three ways:

| Mode | When | Where | Writes to production? |
| --- | --- | --- | --- |
| **REAL** | The production database is lost or corrupt | A new server (or the repaired old one), then DNS | Yes: it becomes production |
| **DRILL** | Each quarter, timed | A temporary cluster on the staging server | No |
| **MONTHLY-VERIFY** | First of each month, 03:00, automatic (`backup-verify`) | A scratch cluster on staging, destroyed by the job | No |

## What is backed up, and with what

| Item | Where | Needed to restore |
| --- | --- | --- |
| WAL archive and nightly base backups (pgBackRest, encrypted on the server), 30 days | Backups bucket | The backup encryption key, the bucket credentials |
| Nightly logical dump (`pg_dump -Fc`, encrypted with the same key), 30 days | Backups bucket | The same |
| Encrypted columns and audit personal data | Inside the database, wrapped by the KEK | **The key-encryption key `KEK_V<n>` for every version in use** |
| Documents and images | Object storage (not in the database backup) | The bucket credentials |
| Audit anchors | Anchor bucket with object lock | Read access; the published anchor public key in `docs/` |
| Compose file, Caddyfile, scripts | `backend/infra/` in GitHub | Repository access |

**The two keys that cannot be recreated:** the backup encryption key (without it no backup can be read) and the KEK (without it every encrypted value is unreadable). Both have sealed paper copies held by the owner (OPERATIONS section 4). The restore needs the secrets file's other values too, kept in the administrator's password manager.

## Timing record

Start a timer. Record the time at each point; copy the values into the drill log (OPERATIONS section 9.6) at the end. **Objective: T7 minus T0 under 4 hours.**

| Point | What happened | Time (UTC) |
| --- | --- | --- |
| T0 | The scenario is declared (or the drill starts) | |
| T1 | The target server is reachable and Docker is ready | |
| T2 | Backups are listed, the right backup chosen, keys in place | |
| T3 | The base backup is restored | |
| T4 | WAL replayed to the target; PostgreSQL accepts connections | |
| T5 | The application is started; health is `OK` or `DEGRADED` with reasons | |
| T6 | Restore verification (below) passed | |
| T7 | The smoke suite passed; traffic switched (REAL) or the drill declared complete | |
| Recovery point achieved | Minutes between the last known transaction before the scenario and the last one restored | |

## Before you start

1. **Open the incident log entry** (REAL) or the drill record. Note who is doing it and who is observing.
2. **Get the keys.** The backup encryption key and the KEK from the administrator's password manager; if that is unavailable, the owner brings the sealed envelopes. In a drill, open the sealed copy for the KEK **at least once a year** and decrypt a sample value with it, to prove the paper copy is readable, then reseal and sign the flap again.
3. **Decide the target time.** Default is "latest", which replays all archived WAL. A point-in-time target is used when the damage was a bad change at a known time: choose a time just before it (UTC). Write the reason down.
4. **REAL: preserve the failed server** if it is still reachable (see below), and make sure it cannot take traffic.
5. **Choose the target.** REAL: a new KVM 4 (provision it exactly as `docs/DEPLOYMENT.md` section 11 up to and including 11.8). DRILL: the staging server, restoring into a **separate temporary cluster** (`/srv/restore-drill`, its own container and port bound to `127.0.0.1` only, not the staging application's database). Access is limited to the administrator and the staging application is not pointed at it.

## Preserve the failed server (REAL, if it is reachable)

Do this only if the old server still responds. It protects evidence and a possible second recovery.

```bash
# stop writers first, keep everything else as it is
dc stop worker $ACTIVE
# take an offline copy of the data directory (can be large; do it to a volume with space or stream to the backups bucket)
tar -C /var/lib/docker/volumes -czf /root/pgdata-$(date -u +%Y%m%dT%H%M%SZ).tgz $(docker volume ls -q | grep postgres)
sha256sum /root/pgdata-*.tgz | tee -a /root/evidence.sha256
```

Then power the server off or block it from DNS. Do not delete it until the incident is closed.

## Restore to a new server

All commands on the target server as the `deploy` user in `/opt/hakorem` unless noted. `dc` is the alias in `docs/runbooks/README.md`.

1. **Provision** the server (T1 when Docker works): DEPLOYMENT 11.1 to 11.8. Put the secrets in `/etc/hakorem/production/secrets.env` and `config.env`, including `BACKUP_ENCRYPTION_KEY`, `S3_BACKUP_*`, every `KEK_V<n>` and `DATABASE_URL_*` passwords (the roles' passwords must equal the values stored in the secrets file; the roles themselves come back with the database). Copy `backend/infra/` into place.
2. **Look at what exists.** Start only the PostgreSQL image's tools, with an **empty** data directory:
   ```bash
   dc run --rm --no-deps postgres pgbackrest --stanza=hakorem info
   ```
   The `info` output lists each base backup (full or incremental) with its time and size, and the WAL range. Choose the base backup that precedes the target time. If the stanza is not found, create the configuration (`/etc/pgbackrest/pgbackrest.conf`) with the same repository settings (S3 endpoint, bucket, `repo1-cipher-type=aes-256-cbc`, `repo1-cipher-pass` from the backup key); the stanza itself exists in the repository.
3. **Restore** (T3 when it finishes). For the latest state:
   ```bash
   dc run --rm --no-deps postgres pgbackrest --stanza=hakorem --delta restore
   ```
   For a point in time:
   ```bash
   dc run --rm --no-deps postgres pgbackrest --stanza=hakorem --delta \
     --type=time --target="2026-11-13 09:12:00+00" --target-action=promote restore
   ```
   The restore writes the recovery configuration so that PostgreSQL replays WAL on start.
4. **Start PostgreSQL** and watch recovery: `dc up -d postgres; dc logs -f postgres`. It prints each WAL segment it replays and then `database system is ready to accept connections` (T4). Check `dc exec postgres psql -U postgres -d hakorem -Atc "select pg_is_in_recovery()"` is `f` (recovery finished and it promoted).
5. **Note the last restored transaction.** `select max(recorded_at) from platform.audit_event;` and `select max(occurred_at) from inv.stock_movement;`. The difference between this and the time of the failure is the data loss for the incident log (objective: 15 minutes at most).
6. **Do not run migrations yet.** First read the schema version from the migration history table that the migration runner keeps (the last three applied migrations, with their file names). If the image you are about to run is newer than the restored schema, run the migrator (`DEPLOYMENT.md` section 4.2) only after verification below. Start with the image whose SHA matches the restored schema (`/opt/hakorem/state/production.current` from the old server, or the release record).
7. **Start the application** in order: `dc up -d redis clamav`, then `dc up -d api-blue`, then `dc up -d worker caddy storefront`. The first API start with the new data directory reads `KEK_V<n>`: if it fails to decrypt, a key is missing.
8. **Rebuild Redis state.** Redis is not a system of record. It starts empty. The dispatcher reads the outbox table and rebuilds its queues; sessions and rate-limit counters restart (users may need to log in again; refresh tokens are in the database and still valid).
9. **Re-establish backups on the new server** immediately: `pgbackrest --stanza=hakorem check`, then a full backup: `dc exec postgres pgbackrest --stanza=hakorem --type=full backup`. A restore creates a new timeline; archiving continues on it.

## Restore verification (T6)

Run these before any traffic returns. A failure is a stop.

| # | Check | How | Expected |
| --- | --- | --- | --- |
| 1 | Schema version | The migration history table | Equals the release being run |
| 2 | Roles and grants | `\du` and the schema test, or `select rolname from pg_roles where rolname like 'hk_%'` | Seven roles present |
| 3 | Audit chain | `audit-verify` run by hand, or `GET /audit/integrity` | Chain verifies from `seq` 1 to the head; no gaps |
| 4 | Anchor comparison | Latest anchor in the anchor bucket against the restored chain head | The restored head is at or beyond the anchor. If it is **before** the anchor, events anchored off-box were lost: record the range and tell the owner |
| 5 | Trial balance | `GET /finance/trial-balance` or the `trial-balance-check` job | Zero difference |
| 6 | Stock | `stock-balance-recompute` run by hand | No drift |
| 7 | Numbering | `numbering-check` | Dense series, no orphans |
| 8 | Encrypted values | Decrypt a sample: open a supplier's masked payout detail as the accountant, or run the KEK sample test | Readable; proves the KEK is the right one |
| 9 | Last data | `max(recorded_at)` of `platform.audit_event`, `inv.stock_movement`, `pay.payment` | Within the recovery point of the failure |
| 10 | Files | Open a recent signed document URL | Served |
| 11 | Health | `GET /v1/health` | `OK` or `DEGRADED` with a recorded reason |

Then **T7**: the smoke suite against the new server (`pnpm test:smoke -- --base-url=https://<new address or internal URL>/v1`) on the test branch.

## Switch traffic (REAL)

1. Point `api`, `app`, `media` and the apex DNS records at the new server (TTL 300). Caddy on the new server obtains certificates once the names resolve; allow a few minutes. Test with `curl --resolve api.hakoremfarms.com:443:<new ip> https://api.hakoremfarms.com/v1/health` before the DNS change propagates.
2. Tell the shop supervisor that counters will sync.
3. Update the secrets, the CI key and the deploy host entry so that the pipeline now deploys to the new server (`docs/DEPLOYMENT.md` section 6.2).
4. Keep the old server isolated until the incident is closed (evidence), then destroy it per `DEPLOYMENT.md` section 11.11.

## Restoring one table or a few rows (not a full restore)

When only some data was damaged and the rest is good, do not roll the whole database back.

1. Restore the nightly logical dump into a scratch database on staging or a temporary container: `gpg --batch --decrypt ... | pg_restore -d scratch --no-owner`, then read the rows you need.
2. Apply the correction **through the application as new, approved records** (reversing entries, adjustments), never by copying rows into ledger tables. Ledger, stock, audit and allocation tables are insert-only; a "restored" row would break the chain and the numbering.
3. Master data (a price list, a product) can be recreated through the console from the scratch copy.

## The quarterly drill (DRILL)

1. Schedule it for the first full week of February, May, August and November, outside 06:00 to 20:00, and tell the owner.
2. Declare T0. Restore the latest backups into the temporary cluster on staging (steps 2 to 5 above, with `--pg1-path=/srv/restore-drill` and a different port), start a **temporary** API from the production image against it on `127.0.0.1` for verification only, run the verification table, and the smoke suite against that instance. The staging application keeps using its own database.
3. Test the KEK from its **sealed paper copy**: type it in, decrypt a sample, and compare the result.
4. Fill in the timing table and write one entry in `docs/OPERATIONS.md` section 9.6.
5. **Destroy the restored cluster**: stop the container, delete its volume and directory, run `shred` on any decrypted dump files, and revoke the temporary credentials. Record the deletion in the drill entry. The cluster held production data and must not outlive the drill.
6. If the total exceeds 4 hours, or any verification fails, open a finding with an owner and a date, and correct this runbook.

## After a real restore

- Post-incident review within five working days: cause, timeline from the timing table, data loss, what was reconstructed and how, what to change.
- Write the entry in the drill log with type `REAL`.
- Re-read the daily exception report for the restored period; run the nightly jobs by hand once.
- If the old server's disk is readable and the restored database lost committed data, compare it offline in a scratch environment; do not merge it back.

## Escalation

| When | Who |
| --- | --- |
| A backup cannot be read, or a key is missing | Owner (sealed copies); this is the most serious finding the drill can make |
| The restore passes 3 hours | Owner, to decide what to tell the shop; the hosting provider's support |
| Verification step 3 or 4 fails | `incident-response.md` and `audit-chain-integrity.md`: do not bring traffic back until the owner has decided |
