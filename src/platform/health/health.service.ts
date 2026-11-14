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
 * The health report the deploy pipeline, smoke suite and uptime monitor read (`GET /v1/health`).
 * Reports the mechanisms that exist; each later mechanism (outbox, audit sealing, reconciliation, WAL
 * archiving) adds its own check in the session that builds it. Cached briefly so probes cannot load the database.
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
  ) {}

  async report(): Promise<HealthReport> {
    const now = this.clock.now().getTime();
    if (this.cached !== undefined && now - this.cached.at < this.cacheSeconds * MILLISECONDS_PER_SECOND) {
      return this.cached.report;
    }
    const checks = await Promise.all([
      timed('database', this.clock, this.logger, () => this.pool.query('SELECT 1')),
      timed('redis', this.clock, this.logger, () => this.redis.ping()),
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
