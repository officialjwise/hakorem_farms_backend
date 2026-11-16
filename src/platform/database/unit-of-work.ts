import { AsyncLocalStorage } from 'node:async_hooks';
import type { Clock } from '@hakorem/kernel';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Logger } from 'pino';

export type IsolationLevel = 'serializable' | 'read committed';

export interface UnitOfWorkOptions {
  /** Declared by the outermost command handler, because it cannot be raised after the first query. */
  readonly isolation: IsolationLevel;
  /**
   * Number series the command will allocate from (ADR-0015). Each is locked with a session-level advisory
   * lock before BEGIN, in sorted order, and released after COMMIT or ROLLBACK (ADR-0005).
   */
  readonly seriesLocks?: readonly string[];
}

/** The transaction a command runs in. Repositories take it from `UnitOfWork.current()`; they never open one. */
export interface Transaction {
  readonly isolation: IsolationLevel;
  readonly attempt: number;
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<pg.QueryResult<R>>;
  readonly db: NodePgDatabase;
}

/** SQLSTATEs that mean "run the whole command again": serialization failure and deadlock. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40001', '40P01']);
export const SERIALIZATION_RETRY_LIMIT = 5;
// Full jitter up to 25 ms doubling per attempt, capped at one second: wide enough that two symmetric transactions
// that keep colliding drift apart under load instead of meeting again on every retry.
const RETRY_BASE_DELAY_MS = 25;
const RETRY_MAX_DELAY_MS = 1_000;

/** The command failed with a serialization failure or deadlock on every one of its attempts. */
export class SerializationRetriesExhaustedError extends Error {
  readonly code = 'SERIALIZATION_RETRIES_EXHAUSTED';

  constructor(
    readonly attempts: number,
    readonly sqlState: string,
    options: ErrorOptions,
  ) {
    super(`gave up after ${attempts} attempts on SQLSTATE ${sqlState}`, options);
    this.name = 'SerializationRetriesExhaustedError';
  }
}

/** A command tried to open a transaction inside another one. There are no nested transactions. */
export class NestedTransactionError extends Error {
  readonly code = 'NESTED_TRANSACTION';

  constructor() {
    super('a unit of work is already running in this context');
    this.name = 'NestedTransactionError';
  }
}

/** Code asked for the ambient transaction outside any unit of work. */
export class NoUnitOfWorkError extends Error {
  readonly code = 'NO_UNIT_OF_WORK';

  constructor() {
    super('no unit of work is running in this context');
    this.name = 'NoUnitOfWorkError';
  }
}

/** The caller is a stock or ledger entry point that must run at serializable isolation and does not. */
export class IsolationLevelError extends Error {
  readonly code = 'WRONG_ISOLATION_LEVEL';

  constructor(readonly actual: string) {
    super(`this operation must run at serializable isolation, not ${actual}`);
    this.name = 'IsolationLevelError';
  }
}

/** How many wrappers deep the SQLSTATE is looked for: drizzle adds one; the bound stops a cyclic chain. */
const CAUSE_DEPTH = 4;

/** The fields of a PostgreSQL error the application reads (the `pg` driver's `DatabaseError`). */
export interface DatabaseErrorFields {
  readonly code: string;
  readonly constraint?: string | undefined;
  readonly detail?: string | undefined;
  readonly message?: string | undefined;
}

/**
 * The database error inside a thrown error, found through its wrappers: drizzle throws `DrizzleQueryError` with the pg
 * error as `cause` and neither `code` nor `constraint` of its own, so reading the top level missed every failure raised
 * by a `tx.db` query: a serialization failure was not retried (ADR-0005) and a unique violation lost its constraint
 * name, turning a refusal into a 500. Read `code`, `constraint` and `detail` only through this.
 */
export function databaseErrorOf(error: unknown): DatabaseErrorFields | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    if (typeof (current as { code?: unknown }).code === 'string') {
      return current as DatabaseErrorFields;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The SQLSTATE of a database error, through its wrappers (see `databaseErrorOf`). */
export function sqlStateOf(error: unknown): string | undefined {
  return databaseErrorOf(error)?.code;
}

export type Sleep = (milliseconds: number) => Promise<void>;
const realSleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Full jitter: a random delay up to an exponentially growing cap. */
function retryDelay(attempt: number): number {
  const cap = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

const BEGIN: Record<IsolationLevel, string> = {
  serializable: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
  'read committed': 'BEGIN ISOLATION LEVEL READ COMMITTED',
};

/**
 * One business operation is one transaction (ADR-0005). The whole command is re-run on 40001 and 40P01,
 * reads included, up to five attempts with jittered backoff, then fails with a typed error. Commands are
 * therefore re-runnable: no external call inside, side effects through the outbox.
 */
export class UnitOfWork {
  private readonly ambient = new AsyncLocalStorage<Transaction>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly logger: Logger,
    private readonly sleep: Sleep = realSleep,
    /**
     * The application's clock. Each attempt writes its instant into the transaction-local setting `hk.app_now` right
     * after BEGIN, which `platform.app_now()` reads for the rules in views and triggers whose "now" decides something
     * (ADR-0066). Without one, `platform.app_now()` is the database's `now()`.
     */
    private readonly clock: Clock | null = null,
  ) {}

  /** The transaction of the command running in this context. */
  current(): Transaction {
    const tx = this.ambient.getStore();
    if (tx === undefined) {
      throw new NoUnitOfWorkError();
    }
    return tx;
  }

  /**
   * A transaction of its own on another connection, even inside a unit of work: for a worker's record of its own
   * failure (a WORK row such as a render job's attempt), which must survive the rollback of the work that failed. It
   * must never touch a row the enclosing transaction has written or locked, or the two wait on each other. Never for
   * business data: one business operation is still one transaction.
   */
  runApart<T>(options: UnitOfWorkOptions, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.ambient.exit(() => this.run(options, work));
  }

  async run<T>(options: UnitOfWorkOptions, work: (tx: Transaction) => Promise<T>): Promise<T> {
    if (this.ambient.getStore() !== undefined) {
      throw new NestedTransactionError();
    }
    const locks = [...new Set(options.seriesLocks ?? [])].sort();
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.attempt(options.isolation, locks, attempt, work);
      } catch (error) {
        const sqlState = sqlStateOf(error);
        if (sqlState === undefined || !RETRYABLE_SQLSTATES.has(sqlState)) {
          throw error;
        }
        if (attempt >= SERIALIZATION_RETRY_LIMIT) {
          throw new SerializationRetriesExhaustedError(attempt, sqlState, { cause: error });
        }
        this.logger.warn({ attempt, sqlState }, 'transaction retried');
        await this.sleep(retryDelay(attempt));
      }
    }
  }

  private async attempt<T>(
    isolation: IsolationLevel,
    locks: readonly string[],
    attempt: number,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let held = 0;
    let destroy: Error | undefined;
    try {
      for (const key of locks) {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
        held += 1;
      }
      await client.query(BEGIN[isolation]);
      if (this.clock !== null) {
        await client.query("SELECT set_config('hk.app_now', $1, true)", [this.clock.now().toISOString()]);
      }
      const tx: Transaction = {
        isolation,
        attempt,
        query: (text, values) => client.query(text, values as unknown[]),
        db: drizzle(client),
      };
      try {
        const result = await this.ambient.run(tx, () => work(tx));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch((rollbackError: unknown) => {
          destroy = new Error('rollback failed', { cause: rollbackError });
        });
        throw error;
      }
    } finally {
      for (const key of locks.slice(0, held).reverse()) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key]).catch((unlockError: unknown) => {
          // A lock that cannot be released must not go back to the pool: destroying the session releases it.
          destroy = new Error('advisory unlock failed', { cause: unlockError });
        });
      }
      client.release(destroy);
    }
  }
}

/** Stock and ledger entry points call this first and refuse to run below serializable (ADR-0005, SC-23). */
export async function assertSerializable(tx: Transaction): Promise<void> {
  const result = await tx.query<{ level: string }>("SELECT current_setting('transaction_isolation') AS level");
  const level = result.rows[0]?.level ?? 'unknown';
  if (level !== 'serializable') {
    throw new IsolationLevelError(level);
  }
}
