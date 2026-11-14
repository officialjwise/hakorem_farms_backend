import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, MigrationError, rollback } from '../../../src/platform/database/migration-runner';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;
let directory: string;

const REPOSITORY_MIGRATIONS = resolve(__dirname, '../../../migrations');
/** Every repository migration, by name, in the order the runner applies them. */
const REPOSITORY_NAMES = readdirSync(REPOSITORY_MIGRATIONS)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => file.replace(/\.sql$/, ''));

/** Rolls back every applied migration, newest first, and returns what it rolled back. */
async function rollbackAll(url: string): Promise<string[]> {
  const rolledBack: string[] = [];
  for (;;) {
    const outcome = await rollback(url, REPOSITORY_MIGRATIONS);
    if (outcome.kind !== 'ROLLED_BACK') {
      return rolledBack;
    }
    rolledBack.push(outcome.name);
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  directory = mkdtempSync(join(tmpdir(), 'hk-migrations-'));
});

afterAll(async () => {
  await database.drop();
});

async function appliedVersions(): Promise<string[]> {
  const { rows } = await database
    .pool('admin')
    .query<{ version: string; applied_by: string }>('SELECT version, applied_by FROM migration.applied_migration ORDER BY version');
  return rows.map((row) => `${row.version}:${row.applied_by}`);
}

describe('the migration runner (ADR-0030)', () => {
  it('finds the repository migrations already applied to the template and reapplies nothing', async () => {
    const outcome = await migrate(database.url('migrator'), REPOSITORY_MIGRATIONS);
    expect(outcome.applied).toEqual([]);
    expect(await appliedVersions()).toEqual(REPOSITORY_NAMES.map((name) => `${name.slice(0, 4)}:hk_migrator`));
  });

  it('rolls back every migration, newest first, and applies them all again, leaving the same schema', async () => {
    expect(await rollbackAll(database.url('migrator'))).toEqual([...REPOSITORY_NAMES].reverse());
    const gone = await database.pool('admin').query("SELECT 1 FROM pg_namespace WHERE nspname IN ('platform', 'iam', 'mdm')");
    expect(gone.rowCount).toBe(0);
    expect(await rollback(database.url('migrator'), REPOSITORY_MIGRATIONS)).toEqual({ kind: 'NOTHING_APPLIED' });

    expect((await migrate(database.url('migrator'), REPOSITORY_MIGRATIONS)).applied).toEqual(REPOSITORY_NAMES);
    const owner = await database
      .pool('admin')
      .query<{ owner: string }>("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'platform'");
    expect(owner.rows[0]?.owner).toBe('hk_owner');
  });

  it('refuses a migration that was edited after it was applied', async () => {
    const fresh = await createTestDatabase();
    try {
      await rollbackAll(fresh.url('migrator'));
      const probeDir = mkdtempSync(join(tmpdir(), 'hk-edited-'));
      const file = join(probeDir, '0001_platform_create_schema.sql');
      writeFileSync(file, '-- migrate:up\nCREATE SCHEMA platform AUTHORIZATION hk_owner;\n-- migrate:down\nDROP SCHEMA platform;\n');
      await migrate(fresh.url('migrator'), probeDir);
      writeFileSync(file, '-- migrate:up\nCREATE SCHEMA platform AUTHORIZATION hk_owner;\nSELECT 1;\n-- migrate:down\nDROP SCHEMA platform;\n');
      const failure = await migrate(fresh.url('migrator'), probeDir).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MigrationError);
      expect((failure as Error).message).toBe('0001_platform_create_schema.sql was edited after it was applied; write a new migration instead');
    } finally {
      await fresh.drop();
    }
  });

  it('reports a forward fix instead of rolling back a migration that has no down section', async () => {
    writeFileSync(join(directory, '0001_platform_create_schema.sql'), '-- forward-fix: none needed\n-- migrate:up\nSELECT 1;\n');
    writeFileSync(
      join(directory, '0002_platform_add_probe.sql'),
      '-- forward-fix: add a new migration that copies the rows back; dropping this table loses data\n-- migrate:up\nCREATE TABLE platform.forward_probe (id int);\n',
    );
    const fresh = await createTestDatabase();
    try {
      await rollbackAll(fresh.url('migrator'));
      await fresh.pool('admin').query('CREATE SCHEMA platform AUTHORIZATION hk_owner');
      await migrate(fresh.url('migrator'), directory);
      expect(await rollback(fresh.url('migrator'), directory)).toEqual({
        kind: 'FORWARD_FIX_ONLY',
        name: '0002_platform_add_probe',
        forwardFix: 'add a new migration that copies the rows back; dropping this table loses data',
      });
      const still = await fresh.pool('admin').query("SELECT to_regclass('platform.forward_probe') IS NOT NULL AS present");
      expect(still.rows[0]).toEqual({ present: true });
    } finally {
      await fresh.drop();
    }
  });

  it('rolls back a failed migration whole and records nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hk-failing-'));
    writeFileSync(join(dir, '0001_platform_create_schema.sql'), '-- forward-fix: none\n-- migrate:up\nSELECT 1;\n');
    writeFileSync(
      join(dir, '0002_platform_break_midway.sql'),
      '-- migrate:up\nCREATE TABLE platform.half_done (id int);\nSELECT * FROM platform.no_such_table;\n-- migrate:down\nDROP TABLE platform.half_done;\n',
    );
    const fresh = await createTestDatabase();
    try {
      await rollbackAll(fresh.url('migrator'));
      await fresh.pool('admin').query('CREATE SCHEMA platform AUTHORIZATION hk_owner');
      const failure = await migrate(fresh.url('migrator'), dir).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(MigrationError);
      const left = await fresh.pool('admin').query("SELECT to_regclass('platform.half_done') IS NOT NULL AS present");
      expect(left.rows[0]).toEqual({ present: false });
      const recorded = await fresh.pool('admin').query<{ version: string }>('SELECT version FROM migration.applied_migration');
      expect(recorded.rows.map((row) => row.version)).toEqual(['0001']);
    } finally {
      await fresh.drop();
    }
  });
});
