# HaKorem Farms Platform: Operations

How the system is run: environments, every configuration variable, secrets, monitoring, alert thresholds, scheduled jobs, backups and the restore drill log, and the running cost. The deploy procedure is in `docs/DEPLOYMENT.md`; the response to each failure is in `docs/runbooks/`.

Decisions behind this document: ADR-0025 (topology), ADR-0022 (keys), ADR-0024 (database roles), ADR-0006 (audit chain and anchors), ADR-0010 (outbox), ADR-0015 (numbering), and the non-functional targets in `docs/SHARED_BRIEF.md`.

The numbers in this document are design values chosen in B1. Where B13 measures something on the live server, the measured figure is written into section 12 and the design value is corrected here in the same pull request. Nothing in this repository holds a real secret; every example value below is made up.

## 1. Environments

| | Local | CI | Staging | Production |
| --- | --- | --- | --- | --- |
| Purpose | Development | Automated tests | Rehearsal of every release; UAT; restore drill; ZAP baseline | The business |
| Where | The developer's machine, Docker Compose | GitHub Actions runners | Hostinger KVM 2, United Kingdom or the Netherlands | Hostinger KVM 4, United Kingdom or the Netherlands |
| Started by | `pnpm setup`, then `pnpm dev` | The workflow | The pipeline on every merge to `main` | The pipeline, after manual approval |
| Compose project | `hk-local` | Testcontainers, no compose project | `hk-staging` | `hk-prod` |
| Database | Local PostgreSQL 17 container, seeded farm | Ephemeral container per run | Own PostgreSQL, seeded demo farm, never production data | Own PostgreSQL, the real farm |
| Redis | Container | Container | Container | Container |
| Object storage | MinIO container | MinIO container | Provider bucket set `*-staging` | Provider bucket set `*-prod` |
| Payment provider | Paystack test keys, or the in-process fake | Fake | Paystack test (sandbox) keys | Paystack live keys |
| Messaging | `MESSAGING_MODE=capture`: messages are written to the message log, nothing is sent | `capture` | `sandbox`: a provider test route, or `capture` | `live` |
| Sentry | Off | Off | Project environment `staging` | Project environment `production` |
| Secrets | `.env` from `.env.example`, throwaway values, never committed | Workflow-scoped test values | `/etc/hakorem/staging/secrets.env`, its own values | `/etc/hakorem/production/secrets.env`, its own values |
| Test branch | Seeded | Seeded | Seeded (the second branch flagged as test, A-049) | Exists, flagged as test, used only by the smoke suite; its own number series, so it never consumes a real number (ADR-0007) |
| Seeds | `pnpm db:seed` | Fixtures | `pnpm db:seed` (demo data only) | `pnpm db:seed` refuses to run (`APP_ENV=production`). Production data enters through the opening balance process only (`docs/DATA_MIGRATION.md`) |
| Domains | `localhost:3000` (API), `localhost:5173` (console), `localhost:3001` (storefront) | none | `api.staging.hakoremfarms.com`, `app.staging.hakoremfarms.com`, `staging.hakoremfarms.com` | `api.hakoremfarms.com`, `app.hakoremfarms.com`, `hakoremfarms.com` |

Rules that hold in every environment:

- No production data is copied into any other environment, seed or fixture. The one exception is the restore drill (section 9.5), which restores production backups into an isolated, temporary database on the staging server and destroys it after the drill.
- Staging and production share nothing: servers, databases, secrets, provider credentials, keys and buckets are separate.
- The application role cannot run DDL in any environment (ADR-0024). Migrations run in a one-shot container as `hk_migrator`.
- Time is UTC on every server. Business time is Africa/Accra from the application clock; Africa/Accra is UTC+0 all year, so cron times in this document are the same as UTC.

## 2. Server sizing and layout

**Production (KVM 4: 4 vCPU, 16 GB RAM, 200 GB NVMe).** Memory budget, set as container limits in the compose file:

| Component | Limit | Notes |
| --- | --- | --- |
| `postgres` | 6 GB | `shared_buffers` 3 GB, `effective_cache_size` 9 GB, `work_mem` 16 MB, `max_connections` 100, `wal_level=replica`, `archive_mode=on`, `idle_in_transaction_session_timeout` 10 s |
| `api` | 1 GB, two instances during a deploy | Node `--max-old-space-size=768` |
| `worker` | 1.5 GB | Includes the headless browser that renders PDF documents |
| `storefront` | 768 MB | |
| `redis` | 512 MB | `maxmemory 400mb`, `maxmemory-policy noeviction`, append-only file on. Queue keys must never be evicted |
| `clamav` | 1.5 GB | The malware scanner the worker calls for uploads (security architecture, file uploads). Added here: ADR-0025's container table does not list it |
| `prometheus`, `alertmanager`, `node-exporter`, `postgres-exporter`, `redis-exporter` | 800 MB together | Prometheus retention 15 days |
| `caddy` | 128 MB | |
| Operating system and Docker | about 1 GB | |
| **Total** | **about 14.2 GB** of 16 GB | |

Disk (200 GB): PostgreSQL data, a local WAL buffer of up to 10 GB while archiving, images (about 10 GB with two versions kept), logs (about 5 GB), Prometheus (about 5 GB). The five-year capacity target in the brief (2 million movements, 150,000 orders, ten million ledger lines) is a few tens of gigabytes of data.

**Staging (KVM 2: 2 vCPU, 8 GB RAM, 100 GB NVMe)** runs the same compose file with smaller limits and no Prometheus retention beyond 3 days. KVM 1 cannot hold the full stack with the scanner and a second database cluster for the restore drill, so KVM 2 is the staging size.

**Builds never run on either server** (CPU throttling, and a build must not compete with the counter). CI builds the image and pushes it.

Networks (ADR-0025): `edge` (Caddy, storefront, API) and `data` (API, worker, PostgreSQL, Redis, ClamAV, monitoring). PostgreSQL and Redis are never published on a host port, and `ufw` allows 22, 80 and 443 only.

## 3. Configuration reference

Configuration is typed and validated at boot (B2). A missing or malformed required variable stops the process with a message that names the variable, never a stack trace. A CI test compares the keys of `.env.example` with this table and fails on any difference, so this document cannot drift.

Conventions. **Required**: Yes (every environment), Prod (staging and production, optional locally), Opt (optional with the stated default). **Secret** values are marked `[secret]`; the example column gives only the shape and is never a real value. Business settings that an administrator changes at run time (tax, approval thresholds, offline limits, retention) are not environment variables; they live in `platform.setting` and are edited through the audited administration endpoints.

### 3.1 Core

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `NODE_ENV` | Runtime mode | Yes | `production` |
| `APP_ENV` | Which environment this is; `pnpm db:seed` refuses `production` | Yes | `staging` |
| `APP_ROLE` | Entry point: `api` or `worker` (set by compose) | Yes | `api` |
| `APP_VERSION` | Release version shown by the health endpoint and tagged on Sentry releases; set by the pipeline | Prod | `1.0.0+9f3c2a1` |
| `GIT_SHA` | Commit of the image | Prod | `9f3c2a1d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c` |
| `PORT` | API listen port | Opt, `3000` | `3000` |
| `LOG_LEVEL` | Pino level | Opt, `info` | `info` |
| `TZ` | Process time zone. Always UTC; business time comes from the clock | Opt, `UTC` | `UTC` |
| `BUSINESS_TIMEZONE` | Zone for business dates and cron | Opt, `Africa/Accra` | `Africa/Accra` |
| `TRUST_PROXY_HOPS` | Proxies to trust for the client address (Caddy is one) | Opt, `1` | `1` |
| `PUBLIC_API_URL` | The API's public origin, used for links and cookie checks | Yes | `https://api.hakoremfarms.com` |
| `PUBLIC_APP_URL` | The console's origin | Yes | `https://app.hakoremfarms.com` |
| `PUBLIC_STOREFRONT_URL` | The storefront's origin, used in customer messages and links | Yes | `https://hakoremfarms.com` |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allow-list; never a wildcard | Yes | `https://app.hakoremfarms.com,https://hakoremfarms.com` |
| `REQUEST_BODY_LIMIT_BYTES` | Default body limit | Opt, `1048576` | `1048576` |
| `SYNC_BODY_LIMIT_BYTES` | Body limit for `/pos/sync` and `/driver/sync` | Opt, `5242880` | `5242880` |
| `UPLOAD_MAX_BYTES_IMAGE` | Upload cap for images | Opt, `8388608` | `8388608` |
| `UPLOAD_MAX_BYTES_DOCUMENT` | Upload cap for PDF and spreadsheets | Opt, `15728640` | `15728640` |
| `SEED_ALLOWED` | Must be `false` in production | Opt, `false` | `false` |
| `SMOKE_BRANCH_CODE` | Code of the test branch the smoke suite trades on | Prod | `TST` |

### 3.2 Database and Redis

Each process uses its own database role (ADR-0024) and a bounded pool. There is no transaction-mode pooler between the application and PostgreSQL.

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `DATABASE_URL_APP` `[secret]` | Connection for the API as `hk_app` | Yes | `postgres://hk_app:<password>@postgres:5432/hakorem` |
| `DATABASE_URL_WORKER` `[secret]` | Connection for the worker as `hk_worker` | Yes | `postgres://hk_worker:<password>@postgres:5432/hakorem` |
| `DATABASE_URL_SEALER` `[secret]` | Audit sealer as `hk_sealer` | Yes | `postgres://hk_sealer:<password>@postgres:5432/hakorem` |
| `DATABASE_URL_REPORT` `[secret]` | Report queries as `hk_report` | Yes | `postgres://hk_report:<password>@postgres:5432/hakorem` |
| `DATABASE_URL_MIGRATOR` `[secret]` | Migration container only, as `hk_migrator`. Not present in the API or worker environment | Deploy | `postgres://hk_migrator:<password>@postgres:5432/hakorem` |
| `DATABASE_URL_BACKUP` `[secret]` | Backup container as `hk_backup` | Prod | `postgres://hk_backup:<password>@postgres:5432/hakorem` |
| `POSTGRES_PASSWORD` `[secret]` | The database superuser, set when the data directory is first created. Used only by the administrator over SSH | Prod | `<random 32 characters>` |
| `DB_POOL_MAX` | Connections per process: API 20, worker 10 | Opt, `20` | `20` |
| `DB_STATEMENT_TIMEOUT_MS` | Statement timeout for `hk_app` | Opt, `15000` | `15000` |
| `DB_REPORT_STATEMENT_TIMEOUT_MS` | Statement timeout for `hk_report` | Opt, `30000` | `30000` |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | Kills a transaction left open (a long transaction delays audit sealing) | Opt, `10000` | `10000` |
| `DB_SERIALIZATION_RETRIES` | Re-runs of a serializable handler (ADR-0005) | Opt, `5` | `5` |
| `REDIS_URL` `[secret]` | BullMQ, rate limits, caches | Yes | `redis://:<password>@redis:6379/0` |

### 3.3 Authentication

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `AUTH_ACCESS_TTL_SECONDS` | Access token lifetime (design 10 minutes) | Opt, `600` | `600` |
| `AUTH_STAFF_REFRESH_IDLE_SECONDS` | Staff refresh idle lifetime (design 12 hours) | Opt, `43200` | `43200` |
| `AUTH_STAFF_REFRESH_ABSOLUTE_SECONDS` | Staff refresh absolute lifetime (design 7 days) | Opt, `604800` | `604800` |
| `AUTH_CUSTOMER_REFRESH_IDLE_SECONDS` | Customer and investor idle lifetime (design 30 days) | Opt, `2592000` | `2592000` |
| `AUTH_CUSTOMER_REFRESH_ABSOLUTE_SECONDS` | Customer and investor absolute lifetime (design 90 days) | Opt, `7776000` | `7776000` |
| `AUTH_STEP_UP_TTL_SECONDS` | How long a TOTP step-up counts | Opt, `300` | `300` |
| `AUTH_CHALLENGE_TTL_SECONDS` | Challenge token between login steps | Opt, `300` | `300` |
| `AUTH_TOTP_ISSUER` | Name shown in the authenticator app | Opt, `HaKorem Farms` | `HaKorem Farms` |
| `ARGON2_MEMORY_KIB` | Argon2id memory, tuned to about 250 ms on production | Opt, `65536` | `65536` |
| `ARGON2_ITERATIONS` | Argon2id time cost | Opt, `3` | `3` |
| `ARGON2_PARALLELISM` | Argon2id parallelism | Opt, `1` | `1` |
| `JWT_ACTIVE_KEY_ID` | The key id used to sign new access tokens | Yes | `2026-q4` |
| `JWT_SIGNING_KEYS` `[secret]` | JSON map of key id to EdDSA private key (PEM). Old ids stay until their tokens expire | Yes | `{"2026-q4":"-----BEGIN PRIVATE KEY-----..."}` |
| `JWT_PUBLIC_KEYS` | JSON map of key id to public key, so a new key is published before it signs | Yes | `{"2026-q4":"-----BEGIN PUBLIC KEY-----..."}` |
| `HIBP_ENABLED` | Breached-password range query (k-anonymity); falls back to a bundled list if unreachable | Opt, `true` | `true` |
| `HIBP_BASE_URL` | Range endpoint | Opt | `https://api.pwnedpasswords.com/range` |

### 3.4 Encryption keys

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `KEK_ACTIVE_VERSION` | Version of the key-encryption key used to wrap new data keys | Yes | `2` |
| `KEK_V1`, `KEK_V2`, ... `[secret]` | Key-encryption keys by version; old versions stay to decrypt old data. Base64 of 32 random bytes | Yes | `KEK_V2=<base64, 44 characters>` |
| `LOOKUP_HMAC_KEY` `[secret]` | HMAC-SHA-256 key for equality-lookup hashes of encrypted fields | Yes | `<base64, 44 characters>` |
| `AUDIT_ANCHOR_SIGNING_KEY` `[secret]` | Ed25519 private key that signs audit anchors. Present in the worker's environment only | Prod (worker) | `-----BEGIN PRIVATE KEY-----...` |
| `AUDIT_ANCHOR_KEY_ID` | Id of that key; the public key is published in `docs/` | Prod (worker) | `anchor-2026` |
| `BACKUP_ENCRYPTION_KEY` `[secret]` | Encrypts backups and WAL archives before upload. Distinct from every other key | Prod (backup) | `<random 48 characters>` |

### 3.5 Object storage

All buckets are S3-compatible. Credentials are separate per purpose so that a leak of one cannot touch the others.

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `S3_ENDPOINT` | Service endpoint. MinIO locally | Yes | `https://s3.eu-central-1.example-provider.com` |
| `S3_REGION` | Region name | Yes | `eu-central-1` |
| `S3_FORCE_PATH_STYLE` | `true` for MinIO | Opt, `false` | `false` |
| `S3_ACCESS_KEY_ID` `[secret]` | Application access to the media and documents buckets | Yes | `<20 characters>` |
| `S3_SECRET_ACCESS_KEY` `[secret]` | Its secret | Yes | `<40 characters>` |
| `S3_BUCKET_PUBLIC_MEDIA` | Product image variants, served from a separate origin | Yes | `hakorem-prod-media` |
| `S3_BUCKET_PRIVATE` | Documents, proofs, supplier and investor files; signed URLs only | Yes | `hakorem-prod-private` |
| `S3_ANCHOR_ACCESS_KEY_ID` `[secret]`, `S3_ANCHOR_SECRET_ACCESS_KEY` `[secret]` | Credentials that can write to the anchor bucket and cannot delete | Prod (worker) | `<shape as above>` |
| `S3_BUCKET_ANCHORS` | Audit anchors, with object lock | Prod | `hakorem-prod-anchors` |
| `S3_BACKUP_ACCESS_KEY_ID` `[secret]`, `S3_BACKUP_SECRET_ACCESS_KEY` `[secret]` | Backup writer, bucket-scoped | Prod | `<shape as above>` |
| `S3_BUCKET_BACKUPS` | WAL archive, base backups and logical dumps | Prod | `hakorem-prod-backups` |
| `S3_BUCKET_LOGS` | Daily log archive (section 5) | Prod | `hakorem-prod-logs` |
| `PUBLIC_MEDIA_BASE_URL` | Origin that serves public media | Yes | `https://media.hakoremfarms.com` |
| `SIGNED_URL_TTL_SECONDS` | Lifetime of a signed download URL | Opt, `300` | `300` |
| `MALWARE_SCAN_MODE` | `clamd` or `stub` (`stub` only in local and CI) | Yes | `clamd` |
| `CLAMAV_HOST`, `CLAMAV_PORT` | The scanner | Prod | `clamav`, `3310` |

### 3.5.1 Public media origin

Public media are served from a separate origin so that user-uploaded content never shares an origin with the console (security architecture). In year one this is `media.hakoremfarms.com` pointing to the public media bucket through Caddy's reverse proxy with a cache, or directly to the bucket's public endpoint with a CNAME, whichever the provider supports. The DNS records are in `docs/DEPLOYMENT.md`.

### 3.6 Payments and messaging

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `PAYMENT_PROVIDER` | Adapter in use | Yes | `paystack` |
| `PAYSTACK_BASE_URL` | Provider API | Opt | `https://api.paystack.co` |
| `PAYSTACK_SECRET_KEY` `[secret]` | Server key; also verifies webhook signatures. Test key in staging, live key in production | Yes | `sk_live_<random>` or `sk_test_<random>` |
| `PAYMENT_HTTP_TIMEOUT_MS` | Timeout on every provider call (breaker and retry wrap it) | Opt, `10000` | `10000` |
| `PAYMENT_WEBHOOK_SOURCE_ALLOWLIST` | Provider address ranges, comma-separated CIDRs, used for rate limiting and alerts. Signature, not address, is the authentication | Opt | `203.0.113.0/24` |
| `MESSAGING_MODE` | `live`, `sandbox` or `capture` | Yes | `live` |
| `SMS_PROVIDER` | SMS adapter | Prod | `generic-http` |
| `SMS_BASE_URL` | SMS provider API | Prod | `https://sms.example-provider.com/v1` |
| `SMS_API_KEY` `[secret]` | SMS credential | Prod | `<random 32 characters>` |
| `SMS_SENDER_ID` | Registered sender name | Prod | `HaKorem` |
| `SMS_WEBHOOK_SECRET` `[secret]` | Verifies delivery receipts and STOP replies | Prod | `<random 32 characters>` |
| `WHATSAPP_ACCESS_TOKEN` `[secret]` | WhatsApp Business token | Prod | `<long token>` |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID` | Sender identifiers | Prod | `100000000000001` |
| `WHATSAPP_APP_SECRET` `[secret]` | Verifies inbound webhooks | Prod | `<random 32 characters>` |
| `WHATSAPP_VERIFY_TOKEN` `[secret]` | Webhook registration handshake | Prod | `<random 24 characters>` |
| `EMAIL_PROVIDER` | `smtp` | Prod | `smtp` |
| `EMAIL_SMTP_URL` `[secret]` | Transactional email | Prod | `smtps://<user>:<password>@smtp.example-provider.com:465` |
| `EMAIL_FROM` | Sender address | Prod | `HaKorem Farms <no-reply@hakoremfarms.com>` |

### 3.7 Observability, metrics and alerts

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `SENTRY_DSN` `[secret]` | Error reporting. Separate projects for `hakorem-api` and `hakorem-worker` | Prod | `https://<key>@<org>.ingest.sentry.io/<id>` |
| `SENTRY_ENVIRONMENT` | `staging` or `production` | Prod | `production` |
| `SENTRY_TRACES_SAMPLE_RATE` | Share of requests traced into Sentry | Opt, `0.1` | `0.1` |
| `OTEL_SERVICE_NAME` | Service name on spans | Opt | `hakorem-api` |
| `OTEL_TRACES_SAMPLER_ARG` | OpenTelemetry sampling ratio | Opt, `0.1` | `0.1` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | A separate trace backend, if one is added. In year one spans go to Sentry through its OpenTelemetry integration and this stays empty | Opt | `https://otlp.example-provider.com` |
| `OTEL_EXPORTER_OTLP_HEADERS` `[secret]` | Credential for that backend | Opt | `authorization=Bearer <token>` |
| `METRICS_ENABLED` | Expose Prometheus metrics | Opt, `true` | `true` |
| `METRICS_PORT` | Internal metrics port; never routed by Caddy | Opt, `9464` | `9464` |
| `ALERT_EMAIL_TO` | Alertmanager recipients, comma-separated | Prod | `owner@example.com,ops@example.com` |
| `ALERT_SMTP_URL` `[secret]` | Alertmanager's mail relay | Prod | `smtps://<user>:<password>@smtp.example-provider.com:465` |
| `ALERT_SMS_WEBHOOK_URL` `[secret]` | Where critical alerts are sent as SMS to the owner and the on-call person | Prod | `https://sms.example-provider.com/v1/send?token=<token>` |
| `UPTIME_MONITOR_PING_URL` | Heartbeat URL the nightly jobs call, so a silent scheduler is noticed outside the server | Opt | `https://uptime.example-provider.com/ping/<id>` |

### 3.8 Worker and scheduler

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `WORKER_CONCURRENCY` | Parallel jobs per queue | Opt, `5` | `5` |
| `SCHEDULER_ENABLED` | Exactly one worker instance runs the scheduler | Opt, `true` | `true` |
| `AUDIT_SEALER_ENABLED` | Exactly one process seals the audit chain | Opt, `true` | `true` |
| `AUDIT_SEAL_INTERVAL_MS` | How often the sealer looks for unsealed events | Opt, `1000` | `1000` |
| `OUTBOX_POLL_INTERVAL_MS` | Outbox polling when Redis signalling is unavailable | Opt, `1000` | `1000` |
| `OUTBOX_MAX_ATTEMPTS` | Attempts before a delivery is `DEAD` (the outbound webhook schedule in `docs/API.md` is fixed at 8) | Opt, `10` | `10` |
| `OUTBOX_BACKOFF_MAX_MS` | Ceiling of the exponential backoff | Opt, `3600000` | `3600000` |
| `REPORT_CONCURRENCY` | Parallel report runs | Opt, `2` | `2` |
| `PDF_RENDER_CONCURRENCY` | Parallel PDF renders | Opt, `2` | `2` |
| `HEALTH_CACHE_SECONDS` | Cache of the health computation, so probes cannot load the database | Opt, `5` | `5` |

### 3.9 Deployment and compose variables

These are read by the compose file and the deploy script, not by the application.

| Variable | Purpose | Required | Example |
| --- | --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `hk-staging` or `hk-prod` | Deploy | `hk-prod` |
| `IMAGE_API` | The backend image, by commit SHA | Deploy | `ghcr.io/<owner>/hakorem-backend:9f3c2a1` |
| `IMAGE_STOREFRONT` | The storefront image | Deploy | `ghcr.io/<owner>/hakorem-storefront:4be1d07` |
| `CONSOLE_STATIC_DIR` | Directory of the console's static build that Caddy serves | Deploy | `/opt/hakorem/console/current` |
| `DOMAIN_API`, `DOMAIN_APP`, `DOMAIN_APEX`, `DOMAIN_MEDIA` | Hostnames Caddy serves | Deploy | `api.hakoremfarms.com` |
| `ACME_EMAIL` | Contact for certificate issuance | Deploy | `ops@example.com` |
| `PGBACKREST_STANZA` | Backup stanza name | Prod | `hakorem` |

## 4. Secrets handling

Principles (ADR-0022, ADR-0025, security architecture, sections 6 and 11):

- **One file per server**, `/etc/hakorem/<environment>/secrets.env`, mode `0600`, owner `deploy`. The compose file injects it as environment variables with `env_file`. Non-secret configuration is in `/etc/hakorem/<environment>/config.env` (mode `0644`).
- **No secret is ever** in either repository, in an image, in a workflow file, in `platform.setting`, in a log, in an example file or in a message. Example files hold names only. Secret scanning runs on every pull request; a hit blocks the merge.
- **GitHub holds only** the CI deploy SSH key and the registry token (the built-in workflow token). It holds no application secret, database password or provider key. The environment protection rules require manual approval for production.
- **Staging and production have different values for every secret.** A secret copied between them is a defect.
- **Access.** Only the administrator reads the file over SSH. The deploy user is in the `docker` group, which is equivalent to root on the host; this is an accepted risk of the single-server design, limited by the key-only SSH rule and by the forced command on the CI key (`docs/DEPLOYMENT.md`).
- **Redaction.** The logger's scrubber removes tokens, passwords, cookies, key material and payment identifiers, and masks phone numbers to the last three digits (ADR-0022).

| Secret | Held in | Who can read | Rotation | How to rotate |
| --- | --- | --- | --- | --- |
| Key-encryption key (`KEK_V<n>`) | Secrets file; sealed offline copy with the owner | Administrator; the owner holds the sealed copy | Yearly, and on staff departure | Add `KEK_V<n+1>`, set `KEK_ACTIVE_VERSION`, restart, run the re-wrap job (`rewrap-data-keys`). It re-wraps data keys and touches no data rows. Keep old versions until the job reports zero rows on the old version, then archive them in the sealed copy |
| Per-subject data keys | Database, wrapped by the KEK | The application, per permission | On re-encryption jobs | Background re-encryption job; old values stay readable until rewritten |
| Lookup hashing key | Secrets file | Administrator | Only with a re-hash job | Add the new key, run the re-hash job, switch |
| Token signing key | Secrets file | Administrator | Quarterly, with overlapping key ids | Publish the new public key in `JWT_PUBLIC_KEYS`, deploy, then set `JWT_ACTIVE_KEY_ID`, deploy, and drop the old key after the longest access lifetime has passed |
| Audit anchor signing key | Secrets file of the worker only; the public key is published in `docs/` | Administrator | Yearly | Generate a pair, publish the public key with its id and start date, set `AUDIT_ANCHOR_KEY_ID`, deploy. Old anchors stay verifiable with the old public key |
| Database role passwords | Secrets file; each role has its own | Administrator | On staff departure, and yearly | `ALTER ROLE ... PASSWORD` as the superuser, update the file, deploy |
| Provider keys and webhook secrets | Secrets file | Administrator | On the provider's schedule and on suspicion | Create the new key in the provider's dashboard, update the file, deploy, revoke the old key |
| Backup encryption key | Secrets file; sealed offline copy with the owner | Administrator; owner holds the sealed copy | Yearly | New backups use the new key; backups made under the old key stay restorable only with it, so the old key is kept in the sealed copy for the full 30-day retention plus a year |
| Outbound webhook signing secrets | Database, encrypted with the KEK, shown once to the integrator | Application only | By the integrator, on request | Section 14 of `docs/API.md` |
| CI deploy SSH key | GitHub Actions secret | Repository administrators | When anyone leaves the project | New key pair, replace the line in `authorized_keys`, replace the secret |

**Sealed offline copies.** The KEK and the backup encryption key are each printed on paper, sealed in an envelope signed across the flap and kept by the owner in a safe place that is not the server, not the office with the server, and not the bank-card wallet. Losing the KEK loses every encrypted value; losing the backup key loses every backup. The restore drill proves that both can be brought back (B13).

## 5. Logs and traces

- **Format.** Pino JSON on standard output. Fields: `time` (UTC), `level`, `msg`, `correlationId`, `traceId`, `spanId`, `actorId`, `branchId`, `module`, `route`, `status`, `durationMs`. Request and response bodies are not logged. The scrubber runs before any line leaves the process.
- **On the box.** Docker's `json-file` driver with `max-size` 50 MB and `max-file` 5 per container, so each container keeps about 250 MB of recent output, which is a few days at normal volume. Caddy writes JSON access logs to its own rotated files, kept 30 days.
- **Off the box.** A host cron job (`log-archive`, daily at 03:30) writes each container's last 24 hours to a compressed file under `s3://<logs bucket>/YYYY/MM/DD/<container>.log.gz`, with a bucket lifecycle of 90 days. This is what the incident runbook preserves and what lets a past incident be investigated after the on-box files have rolled over.
- **Correlation.** The correlation id is in the response, every log line, every span, the audit event and every outbox message caused by the request. A support call starts with the id: search the logs, then `GET /audit/events?...` for the audit trail, then the order or document.
- **Traces.** OpenTelemetry spans for HTTP, database and outbound calls, sampled at 10 percent and exported through the Sentry SDK in year one.
- **Sentry.** Unhandled errors only, with the release set to `APP_VERSION`, no request bodies, and the scrubber as `beforeSend`. A new issue in production emails the alert list; a spike (more than 20 events of one issue in 10 minutes) pages as critical.

## 6. Monitoring

Three layers: the health endpoint, Prometheus metrics with alert rules, and an external uptime monitor.

### 6.1 The health endpoint

`GET /v1/health` is public and cheap (computed at most every `HEALTH_CACHE_SECONDS`). It returns `status` (`OK`, `DEGRADED`, `DOWN`) and a list of checks, each with its own status, the observed value and a detail. It returns 503 when any check is `DOWN`. The deploy pipeline reads it: `DEGRADED` passes with a warning, `DOWN` fails the gate.

| Check | `DEGRADED` when | `DOWN` when |
| --- | --- | --- |
| `database` | Query takes more than 200 ms | Cannot connect, or the query takes more than 2 s |
| `wal_archive_age` | Last archived WAL segment older than 5 minutes | Older than 15 minutes (the recovery point objective) |
| `redis` | Latency over 50 ms | Cannot connect |
| `queue_depth` | Waiting jobs over 1,000 | Over 10,000 |
| `outbox_backlog` | Oldest undelivered message older than 60 seconds | Older than 15 minutes |
| `dead_letters` | One or more `DEAD` deliveries | 50 or more |
| `audit_sealing_lag` | Oldest unsealed event older than 60 seconds | Older than 15 minutes |
| `projection_lag` | Over 60 seconds | Over 30 minutes |
| `last_stock_recompute`, `last_trial_balance_check`, `last_subledger_reconcile`, `last_settlement_match`, `last_numbering_check`, `last_audit_verify`, `last_projection_compare` | Last outcome `DRIFT` or `FAILED` | No successful run in 36 hours |

These are the levels at which the system cannot be trusted to operate. The alerts in section 7 fire earlier, so a person is told before the health endpoint goes `DOWN`.

### 6.2 Prometheus metrics

Prometheus scrapes `api:9464` and `worker:9464` on the `data` network every 15 seconds, plus `node-exporter`, `postgres-exporter` and `redis-exporter`. Names (prefix `hk_`):

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `hk_http_requests_total` | counter | `method`, `route`, `status` | Requests |
| `hk_http_request_duration_seconds` | histogram | `method`, `route`, `status` | Latency. `route` is the template (`/orders/{id}`), never the URL |
| `hk_serialization_retries_total` | counter | `operation` | Serializable retries (ADR-0005) |
| `hk_idempotency_replays_total`, `hk_idempotency_conflicts_total` | counter | | Replays served and key reuse refused |
| `hk_outbox_pending` | gauge | `consumer` | Undelivered messages |
| `hk_outbox_oldest_pending_seconds` | gauge | | Age of the oldest |
| `hk_outbox_dead` | gauge | `consumer` | `DEAD` deliveries |
| `hk_queue_waiting`, `hk_queue_failed` | gauge | `queue` | BullMQ depth |
| `hk_audit_unsealed_events`, `hk_audit_sealing_lag_seconds` | gauge | | Sealer position |
| `hk_projection_lag_seconds` | gauge | `projection` | Age of the newest event a projector has applied |
| `hk_job_last_success_timestamp_seconds` | gauge | `job` | From `platform.job_run` |
| `hk_job_last_outcome` | gauge | `job`, `outcome` | 1 for the latest outcome |
| `hk_wal_archive_age_seconds` | gauge | | Age of the last archived WAL segment |
| `hk_db_pool_in_use`, `hk_db_longest_transaction_seconds` | gauge | `role` | Pool and long-transaction watch |
| `hk_webhook_events_total` | counter | `provider`, `outcome` | Inbound webhooks by outcome |
| `hk_payment_provider_calls_total`, `hk_payment_breaker_state` | counter, gauge | `operation`, `outcome` | Provider calls and circuit state |
| `hk_login_failures_total`, `hk_refresh_reuse_total`, `hk_authorisation_failures_total` | counter | `realm` | Security signals |
| `hk_offline_sync_outcomes_total` | counter | `outcome` | Per-sale outcomes from `/pos/sync` |
| `hk_offline_sync_exceptions_total` | counter | `kind` | Exceptions raised at sync |
| `hk_offline_device_unsynced_seconds` | gauge | `device` | Time since a device with an open shift last synced |
| `hk_messages_total` | counter | `channel`, `outcome` | Notifications |

### 6.3 External uptime monitor

An uptime service outside the server (a free or low-cost plan) checks `https://api.hakoremfarms.com/v1/health`, `https://app.hakoremfarms.com/` and `https://hakoremfarms.com/` every minute from two locations. It alerts after two consecutive failures. A response of 503 with a parseable health body counts as the API being up but unhealthy and is routed as a warning; no response, a timeout or a different 5xx counts as an outage. The nightly jobs call `UPTIME_MONITOR_PING_URL` after the last job, so a scheduler that has stopped is noticed from outside.

## 7. Alert thresholds

Each alert has a warning level (an email to the alert list) and a critical level (an email and an SMS to the owner and the on-call person). Numbers are the design values; B13 adjusts them against measured behaviour on the live server and records the change here. The "for" column is how long the condition must hold before the alert fires.

| Signal | Warning | Critical | For | Runbook |
| --- | --- | --- | --- | --- |
| Outbox backlog (pending messages) | more than 500 | more than 5,000 | 5 min | `queue-backlog.md` |
| Outbox oldest pending age | more than 60 s | more than 300 s | 5 min | `queue-backlog.md` |
| Dead letters (`DEAD` rows) | 1 or more | 10 or more | immediately | `queue-backlog.md` |
| BullMQ waiting jobs | more than 500 | more than 5,000 | 10 min | `queue-backlog.md` |
| Audit sealing lag | more than 60 s | more than 300 s; any event unsealed more than 5 min | 2 min | `audit-chain-integrity.md` |
| Audit chain verification | not run in 26 h | any mismatch, gap in `seq`, or head differing from the latest anchor | immediately | `audit-chain-integrity.md` |
| Projection lag | more than 60 s | more than 300 s | 10 min | `queue-backlog.md` |
| Reconciliation job outcome | no success in 26 h | outcome `DRIFT` or `FAILED`; no success in 36 h | immediately | `reconciliation-break.md`, `stock-balance-drift.md`, `audit-chain-integrity.md` |
| Stock balance drift rows | | any | immediately | `stock-balance-drift.md` |
| Trial balance not zero, control account differs from its subledger | | any | immediately | `reconciliation-break.md` |
| Numbering gap or orphan | | any | immediately | `reconciliation-break.md` |
| WAL archive age | more than 5 min | more than 10 min (the objective is 15) | 2 min | `restore-from-backup.md` |
| WAL archive command failures | 1 in 10 min | 5 in 10 min | | `restore-from-backup.md` |
| Base backup age | more than 26 h | more than 50 h | | `restore-from-backup.md` |
| Monthly restore verification | | failed | immediately | `restore-from-backup.md` |
| Disk used (data volume) | 70 percent | 85 percent; at 92 percent the administrator acts at once | 5 min | `database-failover.md` |
| Memory available | less than 15 percent | less than 8 percent, or any container killed for memory | 5 min | `database-failover.md` |
| CPU | over 80 percent | over 95 percent | 15 min, 10 min | `queue-backlog.md` |
| HTTP error rate (5xx over all requests, at least 20 requests) | more than 1 percent | more than 5 percent | 5 min | `incident-response.md` |
| p95 latency, reads (non-`GET` excluded; sync, report runs, uploads and health excluded) | more than 250 ms (the objective is 300 ms) | more than 450 ms | 10 min | `queue-backlog.md` |
| p95 latency, writes | more than 500 ms (the objective is 600 ms) | more than 900 ms | 10 min | `queue-backlog.md` |
| External availability probe | one failure | two consecutive failures | | `incident-response.md` |
| Database connections in use | more than 80 percent of `max_connections` | more than 95 percent | 5 min | `database-failover.md` |
| Longest open transaction | more than 30 s | more than 120 s (it delays audit sealing) | | `audit-chain-integrity.md` |
| Serialization retries | more than 5 percent of write requests | more than 20 percent | 10 min | `queue-backlog.md` |
| Redis memory | more than 75 percent of `maxmemory` | any eviction | 5 min | `queue-backlog.md` |
| Inbound webhook rejections (`REJECTED_SIGNATURE`) | 5 in 10 min | 20 in 10 min | | `incident-response.md` |
| Payment provider failure rate (charge calls) | more than 20 percent | more than 50 percent, or breaker open | 5 min | `payment-provider-down.md` |
| PENDING payments older than 15 minutes with no webhook | any | more than 5 | | `payment-provider-down.md` |
| Failed logins | more than 50 in 10 min | more than 200 in 10 min | | `incident-response.md` |
| Refresh token reuse (a copied token) | | any | immediately | `incident-response.md` |
| Authorisation failure by an investor principal | | any | immediately | `incident-response.md` |
| Offline: device with an open shift unsynced | more than 12 h | more than 24 h | | `offline-sync-conflicts.md` |
| Offline: `REJECTED_INTEGRITY` outcome | | any | immediately | `offline-sync-conflicts.md` |
| Offline: counter gap, stock conflict | reported on the daily exception report | | | `offline-sync-conflicts.md` |
| Notification send failure rate | more than 20 percent | more than 50 percent | 15 min | `payment-provider-down.md` (messaging section) |
| Certificate expiry | less than 14 days | less than 5 days | | `incident-response.md` |
| Clock offset from NTP | more than 1 s | more than 5 s | 5 min | `audit-chain-integrity.md` |

## 8. Scheduled jobs

One worker instance runs the scheduler (`SCHEDULER_ENABLED=true`); jobs are BullMQ repeatable jobs and every run writes a row to `platform.job_run` (`SUCCESS`, `DRIFT` or `FAILED`) that the health endpoint reads. Times are Africa/Accra (the same as UTC). Heavy work runs between 01:00 and 05:00, outside the maintenance restriction of 06:00 to 20:00. Jobs never correct a finding; a finding is raised for a person.

| Time | Job name | What it does | Source |
| --- | --- | --- | --- |
| Continuous | `outbox-dispatch` | Delivers outbox messages to asynchronous subscribers, ordered per subject, with backoff, then `DEAD` | ADR-0010 |
| Continuous | `audit-seal` | Seals audit events into the chain | ADR-0006 |
| Every minute | `reservation-expiry` | Expires reservations past `expires_at` and publishes `inv.ReservationExpired` | ADR-0019 |
| Every 5 minutes | `payment-status-poll` | Looks up `PENDING` payments older than 2 minutes at the provider | Architecture 7.2 |
| Every 15 minutes | `refund-retry` | Retries `FAILED` refunds under their policy | Architecture 7.2 |
| Hourly, at :15 | `idempotency-purge` | Deletes `platform.idempotency_key` rows past `expires_at` (kept at least 72 hours) | ADR-0014 |
| Hourly, at :30 | `abandoned-cart-notice` | Sends abandoned cart notices to customers who agreed | `shp` |
| Every 15 minutes | `offline-device-watch` | Updates `hk_offline_device_unsynced_seconds` and raises the unsynced-device alert | OFFLINE_SYNC |
| Daily 00:10 | `quote-expiry` | Marks quote versions past their validity as expired | `quo` |
| Daily 00:30 | `balance-snapshot` | On the first day of a month, writes the previous month-end stock balances | `inv.stock_balance_snapshot` |
| Daily 01:00 | `backup-base` | Base backup with pgBackRest, encrypted, uploaded | ADR-0025 |
| Daily 01:30 | `backup-dump` | Logical dump (`pg_dump -Fc`), encrypted with the backup key, uploaded, 30 days kept | Shared brief |
| Daily 02:00 | `stock-balance-recompute` | Recomputes every `inv.stock_balance` and `inv.cost_pool` from the movement ledger and compares | ARCHITECTURE section 8 |
| Daily 02:15 | `trial-balance-check` | Debits equal credits overall and per entry | ARCHITECTURE section 8 |
| Daily 02:25 | `subledger-reconcile` | Each control account against its subledger or module (inventory against cost pools, receivables against open items, provider clearing against unsettled payments) | ARCHITECTURE section 8 |
| Daily 02:35 | `period-balance-refresh` | Refreshes `fin.period_balance` for open periods | `fin` |
| Daily 02:45 | `settlement-match` | Matches imported provider settlement lines to recorded payments and raises `pay.reconciliation_break` rows | ARCHITECTURE section 8 |
| Daily 02:55 | `numbering-check` | Per series: count of allocations equals `next_value - 1`, and every allocated document exists | ADR-0015 |
| Daily 03:10 | `audit-verify` | Recomputes content and chain hashes, compares the head with the latest anchor, finds events unsealed for more than 5 minutes | ADR-0006 |
| Daily 03:30 | `log-archive` | Host cron: uploads the last 24 hours of container logs to the logs bucket | Section 5 |
| Daily 03:30 | `projection-compare` | Key totals in `rpt` against the modules of record | ARCHITECTURE section 8 |
| Daily 03:50 | `session-purge` | Deletes expired sessions and refresh token rows beyond their retention | `aud.retention_policy` |
| Daily 04:00 | `retention-run` | Applies each retention policy (purge, anonymise, archive) and writes `aud.retention_run` | ADR-0026, `aud` |
| Daily 04:20 | `heartbeat` | Calls `UPTIME_MONITOR_PING_URL` after the nightly jobs | Section 6.3 |
| Daily 05:00 | `standing-orders` | Creates the orders due today from active standing orders and records the runs | `whl` |
| Daily 06:00 | `overdue-holds` | Places accounts past the overdue threshold on hold | DOMAIN_MODEL |
| Daily 06:30 | `stock-alerts` | Low stock and expiring lots alerts | `inv` |
| Daily 07:30 | `dunning` | Sends reminder and dunning notices by policy level, after 07:00 so customers are not woken | `whl` |
| Daily 08:00 | `dsr-reminders` | Warns when a data subject request is within 5 days of its due date | `aud` |
| Daily 23:55 | `audit-anchor` | Signs the chain head, writes the anchor to the anchor bucket with object lock, records `platform.audit_anchor` (also done at every shift close) | ADR-0006 |
| Daily 20:30 | `exception-report` | Finalises and sends the daily exception report to the owner | `rpt` |
| Monday 08:00 | `dead-letter-digest` | Weekly summary of dead letters and their cause | ADR-0010 |
| 1st of each month, 03:00 | `backup-verify` | On staging: restores the latest base backup and WAL into a scratch cluster, starts it, runs the row-count and checksum checks, destroys it | NFR: monthly restore test |
| Per `rpt.report_schedule` | `report-schedule` | Runs scheduled reports at the times set, in Africa/Accra | ADR-0023 |

The depreciation run, the distribution run, the period lock and the year-end close are not scheduled: they are decisions, taken by people with approval.

## 9. Backup and restore

### 9.1 What is backed up

| What | How | Where | Kept |
| --- | --- | --- | --- |
| PostgreSQL, continuously | WAL archiving with pgBackRest (`archive_command`, asynchronous), encrypted on the server before upload with the backup key | Backups bucket, off the server | 30 days |
| PostgreSQL, nightly | Base backup (`backup-base`, 01:00), full each night, encrypted | Backups bucket | 30 days |
| PostgreSQL, logical | `pg_dump -Fc` (`backup-dump`, 01:30), encrypted with `gpg --symmetric` using the backup key | Backups bucket | 30 days |
| Documents, images, proofs, anchors | Already in object storage; the provider's server-side encryption in addition. The anchor bucket has object lock | Object storage | By retention policy |
| Secrets and keys | The sealed offline copies (section 4), plus the secrets file in the administrator's password manager | The owner and the administrator | Current |
| The compose file, Caddyfile and scripts | `backend/infra/` in the repository | GitHub | Always |
| The hosting provider's weekly snapshot | Enabled | Provider | A floor, not a backup: it cannot meet the 15-minute recovery point |

The tool is pgBackRest, chosen here for its S3 repository, client-side encryption, parallel restore, point-in-time recovery and `verify` command; B13 records any change in this section. Object storage is the same provider as the media bucket but a separate bucket with separate credentials that can write and cannot delete beyond the lifecycle.

### 9.2 Objectives

| Objective | Target | How it is met | Verified by |
| --- | --- | --- | --- |
| Recovery point | 15 minutes | WAL archived continuously; alert at 5 and 10 minutes of archive age | `wal_archive_age`, the quarterly drill |
| Recovery time | 4 hours | A restore to a new server is a drilled runbook (`docs/runbooks/restore-from-backup.md`) | The quarterly drill, timed |
| Retention | 30 days | Lifecycle on the bucket and pgBackRest retention | Monthly verification |
| Monthly restore test | Once a month | `backup-verify` on staging | The job outcome and the health check |

### 9.3 What "database failover" means here

There is one PostgreSQL server. There is no standby and no automatic failover. In this design a failover is a restore: either a restart of the same server after a crash, or a restore onto a new server from the off-box backups and WAL archive, within the 4-hour objective. The counter keeps selling offline in the meantime. The runbook is `docs/runbooks/database-failover.md`.

### 9.4 Restore verification

After any restore, before traffic returns: the schema migration version equals the release; `platform.audit_chain` verifies; the trial balance is zero; stock balances recompute without drift; the numbering check passes; a sample of encrypted values decrypts with the restored KEK; the latest WAL segment's time is within the recovery point. Each is a step in the runbook.

### 9.5 The quarterly drill

Once a quarter (the first full week of February, May, August and November), an administrator restores the latest backups, timed, onto the staging server, and records it in the drill log (9.6). The drill restores production data, so the staging server is treated as production-classified while it lasts: the restored cluster is a separate, temporary PostgreSQL cluster (not the staging application's database), reachable only from the server itself, with the staging application stopped from reaching it, access limited to the administrator, and it is destroyed with a recorded `shred`/delete step at the end of the drill. This resolves the conflict between "no production data in staging" and the drill: the drill is the one permitted use, and it leaves nothing behind. The first drill is part of B13.

### 9.6 Drill log format

Every drill, and every real restore, adds one entry to this table in this file, and the timings are copied into the session or incident report. A drill that exceeds the 4-hour objective is a finding with an owner and a date.

| Field | What to write |
| --- | --- |
| Date, drill number | `2026-02-05`, `Q1-2027` |
| Type | `DRILL`, `MONTHLY-VERIFY` or `REAL` |
| Performed by, observed by | Names |
| Backup used | Base backup id and the recovery target time |
| Target server and size | For example `staging KVM 2` |
| T0 | Time the scenario was declared (UTC) |
| T1 | New server reachable and Docker ready |
| T2 | Backups fetched and decrypted |
| T3 | Base backup restored |
| T4 | WAL replayed to the target; PostgreSQL accepting connections |
| T5 | Application started; health `OK` or `DEGRADED` with reasons |
| T6 | Restore verification (9.4) passed |
| T7 | Smoke suite passed |
| Total (T7 minus T0) | Hours and minutes. Objective: 4 hours |
| Data loss (recovery point achieved) | Minutes between the last transaction before the scenario and the last one restored. Objective: 15 minutes |
| Defects found | Each with an owner and a fix date |
| Runbook changes | What was corrected in the runbook |
| KEK restored from the sealed copy and a sample decrypted | Yes or no, and which value |

Entries:

| Date | Type | Total | Data loss | Outcome | Notes |
| --- | --- | --- | --- | --- | --- |
| No restore has been performed yet. The first entry is written in B13, before go-live | | | | | |

## 10. Routine tasks

| When | Task | Who |
| --- | --- | --- |
| Daily | Read the daily exception report; resolve or annotate each item | Manager, owner |
| Daily | Check that the health endpoint is `OK` or `DEGRADED` with a known reason | Administrator |
| Weekly | Read the dead-letter digest; check disk and backup size; apply pending OS updates that need a reboot, outside 06:00 to 20:00 | Administrator |
| Monthly | Confirm `backup-verify` succeeded; review users and grants; review open stock exceptions and reconciliation breaks older than 7 days | Administrator, manager, accountant |
| Quarterly | Restore drill; rotate the token signing key; review alert thresholds against measured behaviour | Administrator |
| Yearly | Rotate the KEK, the backup key and the anchor key; renew the domain; review the cost estimate against the invoices | Administrator, owner |
| On staff departure | Disable the account and revoke sessions; rotate database role passwords, the CI SSH key and any shared secret the person knew | Administrator |

## 11. Running cost estimate

**This is an estimate for planning. It uses ranges, not quotes, and it is to be corrected with the real invoices in B13.** No provider price below was checked against a live price list on the date of writing; plan names and prices change, and the owner should confirm each line when the account is opened. Amounts are US dollars per month, year one. The ceiling in the brief is 150 US dollars a month at the capacity targets.

| Item | Low | Planning | High | Basis and assumption |
| --- | --- | --- | --- | --- |
| Production server (Hostinger KVM 4) | 12 | 20 | 30 | Long-term plans are cheaper per month than monthly billing, and renewal prices are higher than first-term prices; the high figure assumes monthly billing at the list rate |
| Staging server (Hostinger KVM 2) | 6 | 9 | 15 | Same pricing behaviour |
| Object storage, off the server | 2 | 4 | 10 | About 100 to 300 GB across media, documents, WAL archive, 30 days of base backups and dumps, anchors and logs, at the usual S3-compatible rates of a few dollars per 100 GB, with egress mostly free or low for backups |
| SMS | 12 | 25 | 36 | Assumes about 3,000 messages a month (one-time codes, delivery alerts, critical reminders) through a Ghanaian aggregator at roughly 0.004 to 0.012 US dollars a message. A gateway that routes internationally can cost several times more per message (0.04 to 0.08) and would break the ceiling at this volume, so the provider must be a local aggregator |
| WhatsApp Business messages | 10 | 30 | 80 | Assumes about 2,000 template messages a month (receipts, quotes, order updates) at the per-message rates Meta publishes by category and country, in the range of roughly 0.005 to 0.04 US dollars |
| Transactional email | 0 | 3 | 15 | The free tiers of transactional providers cover a few thousand messages a month; paid tiers start at around 15 dollars |
| Sentry | 0 | 26 | 26 | The free developer plan covers a small error volume; the entry paid plan is about 26 dollars a month if the free quota is exceeded |
| Domain `hakoremfarms.com` | 1 | 1.5 | 2 | A `.com` registration is roughly 10 to 25 dollars a year |
| Uptime monitor | 0 | 0 | 20 | A free plan with one-minute checks may suffice; a paid plan gives more locations |
| GitHub (Actions minutes, container registry) | 0 | 0 | 8 | The free allowances cover a small team's builds and private images; the high figure is a paid seat or extra storage |
| Backups | included | included | included | Stored in the object storage line above |
| **Total** | **43** | **118.5** | **242** | |

**Reading the table.** The planning column is the estimate to hold the team to: about 118 US dollars a month, leaving about 31 dollars of the 150 dollar ceiling. The low column is what a quiet year could cost. The high column adds every upper bound together and will not happen in full; it is shown because it exceeds the ceiling, and what exceeds it is messaging. If real volumes push the total past 150 dollars, the levers, in order, are: keep SMS for one-time codes and critical alerts only; send receipts and updates by email and WhatsApp utility templates; send marketing only to customers who consented and only when it earns its cost; move to a larger local-aggregator volume tier. Server cost is fixed; messaging is the only line that grows with sales.

**Listed separately: payment provider fees.** They are a percentage of electronic sales, not infrastructure, and they are not counted against the ceiling. The fee is `provider rate x value of mobile money and card sales`. Provider tariffs for Ghana are published by the provider and change; as an illustration only, at a blended rate between 1.5 and 3 percent, GHS 80,000 a month of electronic sales costs between GHS 1,200 and GHS 2,400 in fees. Fees post to account 6910, Payment provider fees, from the settlement report (`pay.ProviderSettled`), so the ledger shows the actual figure and this estimate can be replaced by it.

**Corrections.** In B13, the invoices for the first full month replace the planning column, with the invoice reference in a note, and the totals are recomputed. After go-live the accountant adds the real monthly figure here each quarter.

## 12. Measured results

Load and recovery results are recorded here by the session that measures them (B13), with the date, the tool and the number. A target that is missed is either fixed or renegotiated in writing, and the decision is recorded on the same row. No measurement exists before B13.

| Target | Value required | Measured | Date | Tool | Decision |
| --- | --- | --- | --- | --- | --- |
| API read latency, p95, 50 concurrent users | under 300 ms | none yet | | k6 | |
| API write latency, p95, 50 concurrent users | under 600 ms | none yet | | k6 | |
| Recovery time | 4 hours | none yet (section 9.6) | | Drill | |
| Recovery point | 15 minutes | none yet | | Drill | |
| Argon2id hash time on production | about 250 ms | none yet | | Measurement | |
| Offline: 500 queued sales synced exactly once | 500 of 500 | none yet | | Integration test | |
