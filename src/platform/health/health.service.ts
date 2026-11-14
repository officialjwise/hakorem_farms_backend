import type { Clock } from '@hakorem/kernel';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Logger } from 'pino';

export type CheckStatus = 'OK' | 'DEGRADED' | 'DOWN';

/** The contract's `HealthCheck`. */
export interface HealthCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly observed: string | null;
  readonly detail: string | null;
}

/** The contract's `Health`. */
export interface HealthReport {
  readonly status: CheckStatus;
  readonly version: string;
  readonly checkedAt: string;
  readonly checks: readonly HealthCheck[];
}

/** Milliseconds a single check may take before it counts as down. */
const CHECK_TIMEOUT_MS = 2_000;
const MILLISECONDS_PER_SECOND = 1_000;

const TIMED_OUT = Symbol('timed out');

/**
 * Runs one probe. A failure is reported as TIMEOUT or UNREACHABLE only: the endpoint is public, so the driver's
 * own message (addresses, user names) goes to the log, never into the response.
 */
async function timed(name: string, clock: Clock, logger: Logger, probe: () => Promise<unknown>): Promise<HealthCheck> {
  const started = clock.now().getTime();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), CHECK_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([probe(), timeout]);
    if (outcome === TIMED_OUT) {
      logger.warn({ check: name, timeoutMs: CHECK_TIMEOUT_MS }, 'health check timed out');
      return { name, status: 'DOWN', observed: null, detail: 'TIMEOUT' };
    }
    return { name, status: 'OK', observed: `${clock.now().getTime() - started} ms`, detail: null };
  } catch (error) {
    logger.warn({ check: name, err: error }, 'health check failed');
    return { name, status: 'DOWN', observed: null, detail: 'UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

function overall(checks: readonly HealthCheck[]): CheckStatus {
  if (checks.some((check) => check.status === 'DOWN')) {
    return 'DOWN';
  }
  return checks.some((check) => check.status === 'DEGRADED') ? 'DEGRADED' : 'OK';
}

/**
 * A module's own item in the health report (MODULE_BOUNDARIES section 6, "Health contributors"), such as the
 * last successful reconciliation. A contributor that throws is reported DOWN as UNREACHABLE.
 */
export interface HealthContributor {
  readonly name: string;
  check(): Promise<Omit<HealthCheck, 'name'>>;
}

/** Thresholds above which a mechanism is reported DEGRADED (docs/OPERATIONS.md, health endpoint). */
export const HEALTH_THRESHOLDS = {
  /** Seconds the oldest undelivered outbox message may wait. */
  outboxOldestSeconds: 300,
  /** Seconds the oldest audit event may wait for its chain row (ADR-0006; the verifier alerts at five minutes). */
  auditSealingLagSeconds: 60,
} as const;

function seconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

/** Outbox backlog and the oldest undelivered message (ADR-0010). */
export function outboxBacklogContributor(pool: pg.Pool): HealthContributor {
  return {
    name: 'outbox_backlog',
    async check() {
      const { rows } = await pool.query<{ n: number; oldest: number | null }>(
        `SELECT count(*)::int AS n, extract(epoch FROM now() - min(m.recorded_at))::float8 AS oldest
           FROM platform.outbox_delivery d JOIN platform.outbox_message m ON m.id = d.message_id
          WHERE d.status IN ('PENDING', 'FAILED')`,
      );
      const { n, oldest } = rows[0]!;
      return {
        status: oldest !== null && oldest > HEALTH_THRESHOLDS.outboxOldestSeconds ? 'DEGRADED' : 'OK',
        observed: String(n),
        detail: oldest === null ? null : `Oldest undelivered ${seconds(oldest)}`,
      };
    },
  };
}

/** Deliveries that gave up: the dead letter queue (ADR-0010). Any is DEGRADED, so a person looks. */
export function deadLettersContributor(pool: pg.Pool): HealthContributor {
  return {
    name: 'dead_letters',
    async check() {
      const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM platform.outbox_delivery WHERE status = 'DEAD'");
      const n = rows[0]!.n;
      return { status: n > 0 ? 'DEGRADED' : 'OK', observed: String(n), detail: null };
    },
  };
}

/** How long the oldest unsealed audit event has waited for the sealer (ADR-0006). */
export function auditSealingLagContributor(pool: pg.Pool): HealthContributor {
  return {
    name: 'audit_sealing_lag',
    async check() {
      const { rows } = await pool.query<{ lag: number | null; unsealed: number }>(
        `WITH head AS (
           SELECT e.txid FROM platform.audit_chain c JOIN platform.audit_event e ON e.id = c.audit_event_id
            ORDER BY c.seq DESC LIMIT 1)
         SELECT extract(epoch FROM now() - min(e.recorded_at))::float8 AS lag, count(*)::int AS unsealed
           FROM platform.audit_event e
          WHERE e.txid >= coalesce((SELECT txid FROM head), '0'::xid8)
            AND NOT EXISTS (SELECT 1 FROM platform.audit_chain c WHERE c.audit_event_id = e.id)`,
      );
      const { lag, unsealed } = rows[0]!;
      return {
        status: lag !== null && lag > HEALTH_THRESHOLDS.auditSealingLagSeconds ? 'DEGRADED' : 'OK',
        observed: seconds(lag ?? 0),
        detail: unsealed === 0 ? null : `${unsealed} unsealed`,
      };
    },
  };
}

/** Runs one contributor under the same timeout as the dependency probes; a failure is DOWN without detail. */
async function contributed(contributor: HealthContributor, logger: Logger): Promise<HealthCheck> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), CHECK_TIMEOUT_MS);
  });
  try {
    const outcome = await Promise.race([contributor.check(), timeout]);
    if (outcome === TIMED_OUT) {
      logger.warn({ check: contributor.name, timeoutMs: CHECK_TIMEOUT_MS }, 'health check timed out');
      return { name: contributor.name, status: 'DOWN', observed: null, detail: 'TIMEOUT' };
    }
    return { name: contributor.name, ...outcome };
  } catch (error) {
    logger.warn({ check: contributor.name, err: error }, 'health check failed');
    return { name: contributor.name, status: 'DOWN', observed: null, detail: 'UNREACHABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The health report the deploy pipeline, smoke suite and uptime monitor read (`GET /v1/health`): the database and
 * Redis, then each mechanism's contributor (outbox backlog, dead letters, audit sealing lag from B3; WAL archiving,
 * queue depth, projection lag and reconciliation runs join in the sessions that build them). Cached briefly so
 * probes cannot load the database.
 */
export class HealthService {
  private cached: { readonly report: HealthReport; readonly at: number } | undefined;

  constructor(
    private readonly pool: pg.Pool,
    private readonly redis: Redis,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly version: string,
    private readonly cacheSeconds: number,
    private readonly contributors: readonly HealthContributor[] = [],
  ) {}

  async report(): Promise<HealthReport> {
    const now = this.clock.now().getTime();
    if (this.cached !== undefined && now - this.cached.at < this.cacheSeconds * MILLISECONDS_PER_SECOND) {
      return this.cached.report;
    }
    const checks = await Promise.all([
      timed('database', this.clock, this.logger, () => this.pool.query('SELECT 1')),
      timed('redis', this.clock, this.logger, () => this.redis.ping()),
      ...this.contributors.map((contributor) => contributed(contributor, this.logger)),
    ]);
    const report: HealthReport = {
      status: overall(checks),
      version: this.version,
      checkedAt: new Date(now).toISOString(),
      checks,
    };
    this.cached = { report, at: now };
    return report;
  }
}
