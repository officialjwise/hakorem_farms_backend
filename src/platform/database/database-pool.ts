import pg from 'pg';

export interface PoolSettings {
  readonly connectionString: string;
  readonly applicationName: string;
  readonly max: number;
  readonly statementTimeoutMs: number;
}

/** Milliseconds a command waits for a free connection before failing rather than queueing forever. */
const CONNECTION_TIMEOUT_MS = 5_000;
/** Milliseconds an idle connection is kept. */
const IDLE_TIMEOUT_MS = 30_000;
/** Milliseconds a statement may wait for a row or table lock before failing. */
const LOCK_TIMEOUT_MS = 10_000;

/**
 * A direct pool to PostgreSQL. No transaction-mode pooler sits in between, because the unit of work holds a
 * session-level advisory lock across BEGIN and COMMIT on one connection (ADR-0005, ADR-0024).
 * Every session runs in UTC; Africa/Accra is a rendering concern.
 */
export function createPool(settings: PoolSettings): pg.Pool {
  return new pg.Pool({
    connectionString: settings.connectionString,
    application_name: settings.applicationName,
    max: settings.max,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    options: `-c TimeZone=UTC -c statement_timeout=${settings.statementTimeoutMs} -c lock_timeout=${LOCK_TIMEOUT_MS}`,
  });
}
