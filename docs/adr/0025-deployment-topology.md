# ADR-0025: Deployment topology on a single VPS

- **Status:** Proposed (awaiting B0 gate; provisioning detail is finalised in B13)
- **Date:** 2026-11-13
- **Session:** B0
- **Deciders:** backend track; owner approves at the B0 gate

## Context

The shared brief fixes the runtime: Docker Compose on a Hostinger KVM VPS in the United Kingdom or the Netherlands, Caddy as reverse proxy, GitHub Actions building images and deploying over SSH, staging and production as separate compose projects, off-box backups with continuous WAL archiving, a 15-minute recovery point and 4-hour recovery time, zero-downtime deploys with the smoke suite as the gate, and a year-one cost under 150 US dollars a month. The owner's defaults add a staging server on the smallest plan and the domain `hakoremfarms.com` with `app.` and `api.` subdomains.

What this ADR decides is how the containers are arranged within those constraints.

## Options considered

1. **One API container that also runs background jobs.** Fewest parts, but a long job competes with the counter, and a deploy interrupts jobs.
2. **API and worker as separate containers from one image, with the API able to run two instances side by side during a deploy.** Meets zero-downtime and keeps background load away from request handling.
3. **Managed database and managed Redis.** Less to operate, but breaks the cost ceiling and the portability rule.

## Decision

Option 2.

**Containers on the production server (KVM 4)**

| Container | Role | Exposed |
| --- | --- | --- |
| `caddy` | TLS termination, routing, security headers, static console files | 80, 443 |
| `storefront` | Next.js server for the public shop (image from the frontend repository) | Internal |
| `api` | NestJS API. Two instances during a deploy, one otherwise | Internal |
| `worker` | Same image as `api`, different entry point: outbox dispatcher, audit sealer, notifications, document rendering, projections, reconciliation and scheduled jobs | Internal |
| `postgres` | PostgreSQL 17 with WAL archiving | Internal |
| `redis` | Redis 7 with append-only file, for BullMQ, rate limits and short-lived caches | Internal |
| `prometheus` | Metrics scraping with short retention, alert rules | Internal |

- Routing: apex to `storefront`, `app.` to the console's static files, `api.` to `api`.
- Two Docker networks: `edge` (Caddy, storefront, API) and `data` (API, worker, PostgreSQL, Redis). PostgreSQL and Redis are never published on a host port.
- The firewall allows 22, 80 and 443 only.
- Object storage is an S3-compatible service off the server, used for product images, the document archive, backups, WAL archives and audit anchors. Development and CI use a MinIO container. The provider is chosen in B13 and recorded in `docs/OPERATIONS.md`; nothing in the code depends on which.
- Errors go to Sentry. Traces are exported by OpenTelemetry with sampling. Logs are JSON on standard output with Docker's rotation.

**Deploy sequence**

1. CI builds the image, tags it with the commit SHA and pushes it to the GitHub Container Registry.
2. The deploy job connects over SSH as the deploy user and pulls the image.
3. Migrations run in a one-shot container as `hk_migrator`. Production migrations wait for manual approval. Migrations are backward compatible for one release, so the old API keeps working against the new schema.
4. A second `api` instance starts from the new image. The smoke suite runs against it through an internal route.
5. If smoke passes, Caddy switches to the new instance, the old one drains and stops, and the worker restarts on the new image.
6. If smoke fails, the new instance is removed. Traffic never moved, and the job exits non-zero.

**Data protection**

- Continuous WAL archiving to object storage, a nightly base backup, 30 days retained, both encrypted before leaving the server.
- The hosting provider's weekly snapshot is treated as a floor, not a backup.
- A quarterly restore drill into staging, timed and recorded.

**Staging** is a separate, smaller server with the same compose file, its own database, its own secrets and sandbox credentials for every provider.

**Secrets** live in one file on each server, readable only by the deploy user, and are injected as environment variables. They are never in an image, a repository or a workflow file.

**Database connections** go directly from `api` and `worker` to PostgreSQL with a bounded pool each. No transaction-mode pooler (ADR-0005, ADR-0024).

## Consequences

- One server is a single point of failure. The availability target of 99.5 percent a month allows about 3.6 hours of downtime, and the recovery time objective is 4 hours. A hardware loss is recovered by restoring to a new server. This is a recorded residual risk.
- The counter survives a server outage for eight hours through offline mode (ADR-0027).
- Builds never run on the server, since the provider's CPUs are reported to throttle.
- The compose file and deploy scripts live in `backend/infra/` and deploy both repositories' images.
- Estimated running cost stays well under the ceiling. The itemised estimate is kept in `docs/OPERATIONS.md` from B1 and corrected with actual figures in B13.
- Binds: `docs/ARCHITECTURE.md` deployment diagram, `docs/DEPLOYMENT.md` and `docs/OPERATIONS.md` (B1), the B13 session.

## Verification

- B2: the same compose topology runs locally from one command.
- B13: a deploy with a deliberately failing smoke test leaves the old version serving and exits non-zero.
- B13: the restore drill meets the recovery time objective, with the time written down.
