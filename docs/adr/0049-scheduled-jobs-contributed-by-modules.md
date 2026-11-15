# ADR-0049: A module contributes its scheduled jobs to the worker through the composition root

- **Status:** Proposed (B05 continued 3b; awaiting the owner)
- **Date:** 2026-11-15
- **Session:** B05 continued 3b
- **Deciders:** backend track

## Context

FR-INV-021 and ADR-0019 require a scheduled job that expires reservations past `expires_at` and publishes `inv.ReservationExpired`; `docs/OPERATIONS.md` schedules `reservation-expiry` every minute. The worker that runs scheduled jobs (`src/platform/worker/worker-runtime.ts`, ADR-0009, ADR-0010) is in the platform, the lowest layer, and its schedules so far are the platform's own (audit anchor and verify, idempotency purge). The platform may not import a module (`docs/MODULE_BOUNDARIES.md` section 1), so it cannot call INV's expiry. Later modules bring more jobs: the nightly stock recompute and expiry alerts (B05 continued 4), quote expiry (B10), session purge (B13).

`docs/MODULE_BOUNDARIES.md` section 6 says a lower layer calling a higher one through an interface is a port, and a new port needs an ADR.

## Options considered

1. **Each module runs its own timer inside the API process.** No new interface, but every API instance would run every job, the `SCHEDULER_ENABLED` rule (one scheduler) would be broken, and runs would not be recorded in `platform.job_run`.
2. **The worker imports the modules' jobs.** Simple, and breaks the layer rule for the platform.
3. **A `ScheduledJob` shape defined by the platform, filled in by the composition root.** `src/worker-app.ts`, which already builds the whole module graph, takes each module's job from the Nest context and hands the list to `WorkerRuntime`. The worker registers each with the queue, schedules it only where `SCHEDULER_ENABLED`, runs it as the Scheduler principal and records every run.

## Decision

Option 3.

- `ScheduledJob` (`src/platform/worker/worker-runtime.ts`): `name` (the `platform.job_run.job_name`), `when` (`everyMs` or a UTC cron), and `run(system)`, which does its own work in its own transaction and answers a summary.
- `WorkerRuntime` takes `jobs` as its last constructor argument; `runJob` runs one under `runAsSystem` as the Scheduler (`01900000-0000-7000-8000-000000000004`) and writes `platform.job_run` with `SUCCESS` and the summary, or `FAILED` with the error message, which it rethrows.
- `src/worker-app.ts` lists the jobs. The first is INV's `reservation-expiry`, every 60 seconds, answering `{ expired: n }`.
- A module exports the class its job calls through its `index.ts`, as any published interface. A job never corrects a finding (OPERATIONS.md); it raises it.
- The row is added to `docs/MODULE_BOUNDARIES.md` section 6.

## Consequences

- One scheduler runs every job, and every run is visible to the health endpoint through `platform.job_run`.
- Adding a job is one entry in `src/worker-app.ts` and one in `docs/OPERATIONS.md`; no change to the platform.
- The composition root grows a little with each job. It already wires every module, so nothing new depends on it.

## Verification

- `test/integration/platform/worker.integration.spec.ts`: a queued `reservation-expiry` runs in the worker and records `SUCCESS` with its summary as the Scheduler.
- `test/integration/inv/reservations.integration.spec.ts`: the job's work, two concurrent runs ending each lapsed reservation once.
