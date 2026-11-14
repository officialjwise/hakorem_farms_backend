import { createPrivateKey, createPublicKey, randomUUID, type KeyObject } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type pg from 'pg';
import type { Logger } from 'pino';
import { AuditAnchor } from '../audit/audit-anchor';
import { AuditSealer } from '../audit/audit-sealer';
import { AuditVerifier } from '../audit/audit-verifier';
import type { AppConfig } from '../config/app-config';
import { runAsSystem } from '../context/request-context';
import type { UnitOfWork } from '../database/unit-of-work';
import type { DomainEvents } from '../events/domain-events';
import { DISPATCHER_PRINCIPAL, OutboxDispatcher } from '../events/outbox-dispatcher';
import type { Metrics } from '../observability/metrics';
import type { JobQueue } from '../queue/job-queue';
import type { ObjectStorage } from '../storage/object-storage';

const SCHEDULER = { principalId: '01900000-0000-7000-8000-000000000004', displayName: 'Scheduler' } as const;
const SEALER = { principalId: '01900000-0000-7000-8000-000000000002', displayName: 'Audit sealer' } as const;

/** Schedules, in UTC, which is Africa/Accra all year. */
export const SCHEDULES = {
  'audit-anchor': { cron: '55 23 * * *' },
  'audit-verify': { cron: '30 2 * * *' },
  'idempotency-purge': { cron: '15 * * * *' },
} as const;

/** Seven years, as the statutory retention of financial records (A-063). */
const ANCHOR_RETENTION_DAYS = 2_557;
const DISPATCH_BATCH = 100;
const OUTBOX_BACKOFF_BASE_MS = 1_000;

/** Reads a key given as PEM or as the base64 of PKCS#8 DER, as JWT_SIGNING_KEYS are. */
export function readPrivateKey(value: string): KeyObject {
  return value.includes('-----BEGIN') ? createPrivateKey(value) : createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' });
}

/**
 * The worker process (ADR-0010, ADR-0006): delivers the outbox, seals the audit chain, and runs the scheduled jobs.
 * Durable work lives in PostgreSQL; the loops poll it, so a Redis outage delays scheduled jobs but loses nothing.
 */
export class WorkerRuntime {
  private readonly timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private readonly nextId: () => string;

  constructor(
    private readonly config: AppConfig,
    private readonly uow: UnitOfWork,
    private readonly workerPool: pg.Pool,
    private readonly sealerPool: pg.Pool,
    private readonly events: DomainEvents,
    private readonly queue: JobQueue,
    private readonly storage: ObjectStorage,
    private readonly metrics: Metrics,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  async start(): Promise<void> {
    const anchorKey = readPrivateKey(this.config.AUDIT_ANCHOR_SIGNING_KEY!);
    const keyId = this.config.AUDIT_ANCHOR_KEY_ID!;
    const bucket = this.config.S3_BUCKET_ANCHORS!;
    if (this.config.APP_ENV === 'development' || this.config.APP_ENV === 'test') {
      await this.storage.ensureBucket(bucket, { objectLock: true });
    }
    const dispatcher = new OutboxDispatcher(this.uow, this.events, this.clock, this.logger, {
      maxAttempts: this.config.OUTBOX_MAX_ATTEMPTS,
      backoffBaseMs: OUTBOX_BACKOFF_BASE_MS,
      backoffMaxMs: this.config.OUTBOX_BACKOFF_MAX_MS,
      batchSize: DISPATCH_BATCH,
    });
    const delivered = this.metrics.counter('hk_outbox_delivered_total', 'Outbox deliveries completed');
    const failed = this.metrics.counter('hk_outbox_failed_total', 'Outbox delivery attempts that failed');
    const dead = this.metrics.counter('hk_outbox_dead_total', 'Outbox deliveries given up (dead letters)');
    this.loop('outbox-dispatch', this.config.OUTBOX_POLL_INTERVAL_MS, async () => {
      const outcome = await runAsSystem(DISPATCHER_PRINCIPAL, randomUUID(), () => dispatcher.dispatchOnce());
      delivered.add(outcome.delivered);
      failed.add(outcome.failed);
      dead.add(outcome.dead);
    });
    if (this.config.AUDIT_SEALER_ENABLED) {
      const sealer = new AuditSealer(this.sealerPool, this.logger);
      const sealed = this.metrics.counter('hk_audit_sealed_total', 'Audit events sealed into the chain');
      this.loop('audit-seal', this.config.AUDIT_SEAL_INTERVAL_MS, async () => sealed.add(await sealer.sealOnce()));
    }

    const anchor = new AuditAnchor(this.sealerPool, this.storage, anchorKey, this.clock, { keyId, bucket, retentionDays: ANCHOR_RETENTION_DAYS });
    const verifier = new AuditVerifier(this.workerPool, new Map([[keyId, createPublicKey(anchorKey)]]), this.clock);
    this.queue.process('audit-anchor', async () => {
      await runAsSystem(SEALER, randomUUID(), () => anchor.anchor('DAILY'));
    });
    this.queue.process('audit-verify', async () => {
      const report = await verifier.verify();
      if (report.outcome !== 'SUCCESS') {
        this.logger.error({ report }, 'audit verification found drift');
      }
    });
    this.queue.process('idempotency-purge', async () => {
      await this.purgeIdempotencyKeys();
    });
    if (this.config.SCHEDULER_ENABLED) {
      for (const [name, when] of Object.entries(SCHEDULES)) {
        await this.queue.schedule(name, when);
      }
    }
    this.logger.info({ scheduler: this.config.SCHEDULER_ENABLED, sealer: this.config.AUDIT_SEALER_ENABLED }, 'worker started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    await this.queue.close();
  }

  /** Expired idempotency keys are purged; keys live at least 72 hours (ADR-0014). */
  async purgeIdempotencyKeys(): Promise<number> {
    const started = this.clock.now();
    const { rowCount } = await this.workerPool.query('DELETE FROM platform.idempotency_key WHERE expires_at < $1', [started]);
    await this.workerPool.query(
      `INSERT INTO platform.job_run (id, job_name, started_at, finished_at, outcome, summary, actor_id)
       VALUES ($1, 'idempotency-purge', $2, $3, 'SUCCESS', $4, $5)`,
      [this.nextId(), started, this.clock.now(), JSON.stringify({ purged: rowCount ?? 0 }), SCHEDULER.principalId],
    );
    return rowCount ?? 0;
  }

  /** Runs `work` every `intervalMs`, one run at a time; a failure is logged and the loop carries on. */
  private loop(name: string, intervalMs: number, work: () => Promise<void>): void {
    const tick = async () => {
      try {
        await work();
      } catch (error) {
        this.logger.error({ loop: name, err: error }, 'worker loop failed; will try again');
      }
      if (!this.stopped) {
        this.timers.push(setTimeout(() => void tick(), intervalMs));
      }
    };
    void tick();
  }
}
