import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * The plain-SQL migration runner (ADR-0030). It runs as `hk_migrator` and performs every change as `hk_owner`,
 * so the owner of every object is the role nobody logs in as (ADR-0024).
 *
 * A file is `migrations/<NNNN>_<schema>_<verb>_<subject>.sql` (ENGINEERING_STANDARDS section 1.1) with:
 *   -- migrate:up             the change
 *   -- migrate:down           how to undo it, tested in CI by db:rollback
 *   -- forward-fix: <text>    instead of a down section, when undoing is unsafe; says what to do instead
 *   -- migrate:no-transaction for CREATE INDEX CONCURRENTLY, which cannot run in a transaction
 */
export interface Migration {
  readonly version: string;
  readonly name: string;
  readonly file: string;
  readonly checksum: string;
  readonly up: string;
  readonly down: string | undefined;
  readonly forwardFix: string | undefined;
  readonly transactional: boolean;
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

const FILE_NAME = /^(\d{4})_([a-z]+)_([a-z0-9_]+)\.sql$/;
const UP_MARKER = /^--\s*migrate:up\s*$/m;
const DOWN_MARKER = /^--\s*migrate:down\s*$/m;
const FORWARD_FIX = /^--\s*forward-fix:\s*(.+)$/m;
const NO_TRANSACTION = /^--\s*migrate:no-transaction\s*$/m;
/** Advisory lock key that stops two runners migrating one database at once. */
const RUNNER_LOCK_KEY = 'hakorem.migration-runner';
const OWNER_ROLE = 'hk_owner';

export function parseMigration(file: string, text: string): Migration {
  const match = FILE_NAME.exec(file);
  if (match === null) {
    throw new MigrationError(`${file}: the name must be NNNN_<schema>_<verb>_<subject>.sql`);
  }
  const upAt = text.search(UP_MARKER);
  if (upAt < 0) {
    throw new MigrationError(`${file}: has no "-- migrate:up" section`);
  }
  const downAt = text.search(DOWN_MARKER);
  const up = (downAt < 0 ? text.slice(upAt) : text.slice(upAt, downAt)).replace(UP_MARKER, '').trim();
  const down = downAt < 0 ? undefined : text.slice(downAt).replace(DOWN_MARKER, '').trim();
  const forwardFix = FORWARD_FIX.exec(text)?.[1]?.trim();
  if ((down === undefined || down === '') && forwardFix === undefined) {
    throw new MigrationError(`${file}: needs a "-- migrate:down" section or a "-- forward-fix:" header`);
  }
  return {
    version: match[1] as string,
    name: file.replace(/\.sql$/, ''),
    file,
    checksum: createHash('sha256').update(text).digest('hex'),
    up,
    down: down === '' ? undefined : down,
    forwardFix,
    transactional: !NO_TRANSACTION.test(text),
  };
}

export function readMigrations(directory: string): Migration[] {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const migrations = files.map((file) => parseMigration(file, readFileSync(join(directory, file), 'utf8')));
  const versions = new Set<string>();
  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new MigrationError(`two migrations share version ${migration.version}`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

async function ensureBookkeeping(client: pg.Client): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS migration');
  await client.query('REVOKE ALL ON SCHEMA migration FROM PUBLIC');
  await client.query(`
    CREATE TABLE IF NOT EXISTS migration.applied_migration (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      applied_by text NOT NULL DEFAULT session_user
    )`);
}

async function applied(client: pg.Client): Promise<Map<string, AppliedRow>> {
  const result = await client.query<AppliedRow>('SELECT version, name, checksum FROM migration.applied_migration ORDER BY version');
  return new Map(result.rows.map((row) => [row.version, row]));
}

async function withRunnerLock<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'hakorem-migrator' });
  await client.connect();
  try {
    await client.query("SET TimeZone = 'UTC'");
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [RUNNER_LOCK_KEY]);
    // Every change is made as the owner role; session_user still records who logged in.
    await client.query(`SET ROLE ${OWNER_ROLE}`);
    await ensureBookkeeping(client);
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function runStep(client: pg.Client, migration: Migration, sql: string, record: () => Promise<void>): Promise<void> {
  if (migration.transactional) {
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await record();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new MigrationError(`${migration.file} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return;
  }
  try {
    await client.query(sql);
  } catch (error) {
    throw new MigrationError(`${migration.file} failed outside a transaction; check its state by hand`, { cause: error });
  }
  await record();
}

export interface MigrationOutcome {
  readonly applied: readonly string[];
}

/** Applies every pending migration in order. Refuses if an applied migration's file has changed. */
export async function migrate(connectionString: string, directory: string): Promise<MigrationOutcome> {
  const migrations = readMigrations(directory);
  return withRunnerLock(connectionString, async (client) => {
    const done = await applied(client);
    for (const [version, row] of done) {
      const migration = migrations.find((m) => m.version === version);
      if (migration === undefined) {
        throw new MigrationError(`applied migration ${row.name} is missing from ${directory}`);
      }
      if (migration.checksum !== row.checksum) {
        throw new MigrationError(`${migration.file} was edited after it was applied; write a new migration instead`);
      }
    }
    const appliedNow: string[] = [];
    for (const migration of migrations.filter((m) => !done.has(m.version))) {
      await runStep(client, migration, migration.up, async () => {
        await client.query('INSERT INTO migration.applied_migration (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
      });
      appliedNow.push(migration.name);
    }
    return { applied: appliedNow };
  });
}

export type RollbackOutcome =
  | { readonly kind: 'NOTHING_APPLIED' }
  | { readonly kind: 'ROLLED_BACK'; readonly name: string }
  | { readonly kind: 'FORWARD_FIX_ONLY'; readonly name: string; readonly forwardFix: string };

/** Rolls back the last applied migration, or reports its documented forward fix and changes nothing. */
export async function rollback(connectionString: string, directory: string): Promise<RollbackOutcome> {
  const migrations = readMigrations(directory);
  return withRunnerLock(connectionString, async (client) => {
    const done = [...(await applied(client)).values()];
    const last = done.at(-1);
    if (last === undefined) {
      return { kind: 'NOTHING_APPLIED' };
    }
    const migration = migrations.find((m) => m.version === last.version);
    if (migration === undefined) {
      throw new MigrationError(`applied migration ${last.name} is missing from ${directory}`);
    }
    if (migration.down === undefined) {
      return { kind: 'FORWARD_FIX_ONLY', name: migration.name, forwardFix: migration.forwardFix ?? '' };
    }
    await runStep(client, migration, migration.down, async () => {
      await client.query('DELETE FROM migration.applied_migration WHERE version = $1', [migration.version]);
    });
    return { kind: 'ROLLED_BACK', name: migration.name };
  });
}
