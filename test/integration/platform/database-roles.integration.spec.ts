import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readArchitecture } from '../../../scripts/check/architecture';
import { checkCrossSchemaForeignKeys, checkRoles, checkTableClasses } from '../../../scripts/check/database-rules';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

const architecture = readArchitecture();
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

async function sqlStateOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (error: unknown) => (error as { code?: string }).code,
  );
}

describe('database roles (ADR-0024, SEC-036)', () => {
  it('grants only the privileges each role needs', async () => {
    const admin = database.pool('admin');
    expect(await checkRoles(admin, architecture)).toEqual([]);
    expect(await checkTableClasses(admin, architecture)).toEqual([]);

    const { rows } = await admin.query<{ rolname: string; rolconnlimit: number; rolconfig: string[] | null }>(
      "SELECT rolname, rolconnlimit, rolconfig FROM pg_roles WHERE rolname = 'hk_report'",
    );
    expect(rows[0]?.rolconnlimit).toBe(5);
    expect(rows[0]?.rolconfig).toContain('statement_timeout=30000');
  });

  it('hk_app cannot run DDL', async () => {
    const app = database.pool('app');
    expect(await sqlStateOf(app.query('CREATE TABLE platform.intruder (id int)'))).toBe('42501');
    expect(await sqlStateOf(app.query('CREATE SCHEMA intruder'))).toBe('42501');
    expect(await sqlStateOf(app.query('CREATE TABLE public.intruder (id int)'))).toBe('42501');
    expect(await sqlStateOf(app.query('DROP FUNCTION platform.reject_change()'))).toBe('42501');
    expect(await sqlStateOf(app.query('ALTER DOMAIN platform.pesewas DROP CONSTRAINT ck_pesewas_range'))).toBe('42501');
  });

  it('hk_app cannot read the migration bookkeeping', async () => {
    expect(await sqlStateOf(database.pool('app').query('SELECT * FROM migration.applied_migration'))).toBe('42501');
  });

  it('the migrator changes the schema only as hk_owner', async () => {
    const migrator = database.pool('migrator');
    expect(await sqlStateOf(migrator.query('CREATE TABLE platform.intruder (id int)'))).toBe('42501');
  });
});

describe('table classes (ADR-0012)', () => {
  beforeAll(async () => {
    const admin = database.pool('admin');
    await admin.query('CREATE SCHEMA inv AUTHORIZATION hk_owner');
    await admin.query('GRANT USAGE ON SCHEMA inv TO hk_app');
    // A correct LEDGER table, written as the migration skill shows.
    await admin.query(`
      CREATE TABLE inv.fixture_ledger (id uuid PRIMARY KEY, value_pesewas platform.pesewas NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(), actor_id uuid NOT NULL);
      COMMENT ON TABLE inv.fixture_ledger IS 'class=LEDGER';
      CREATE TRIGGER trg_fixture_ledger_immutable BEFORE UPDATE OR DELETE ON inv.fixture_ledger
        FOR EACH ROW EXECUTE FUNCTION platform.reject_change();
      CREATE TRIGGER trg_fixture_ledger_no_truncate BEFORE TRUNCATE ON inv.fixture_ledger
        FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_change();
      REVOKE ALL ON inv.fixture_ledger FROM PUBLIC;
      GRANT SELECT, INSERT ON inv.fixture_ledger TO hk_app;`);
    // A correct MASTER table with the version trigger.
    await admin.query(`
      CREATE TABLE inv.fixture_master (id uuid PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT '2000-01-01T00:00:00Z');
      COMMENT ON TABLE inv.fixture_master IS 'class=MASTER';
      CREATE TRIGGER trg_fixture_master_version BEFORE UPDATE ON inv.fixture_master
        FOR EACH ROW EXECUTE FUNCTION platform.touch_version();
      GRANT SELECT, INSERT, UPDATE ON inv.fixture_master TO hk_app;`);
  });

  it('the schema test reads the class of every table and passes when the grants match', async () => {
    expect(await checkTableClasses(database.pool('admin'), architecture)).toEqual([]);
  });

  it('reports a table that declares no class', async () => {
    const admin = database.pool('admin');
    await admin.query('CREATE TABLE inv.fixture_unclassed (id uuid PRIMARY KEY)');
    try {
      expect(await checkTableClasses(admin, architecture)).toEqual([
        "inv.fixture_unclassed declares no table class (COMMENT ON TABLE ... IS 'class=<CLASS>')",
      ]);
    } finally {
      await admin.query('DROP TABLE inv.fixture_unclassed');
    }
  });

  it('reports a LEDGER table on which hk_app may update, and one without its triggers', async () => {
    const admin = database.pool('admin');
    await admin.query(`
      CREATE TABLE inv.fixture_bad_ledger (id uuid PRIMARY KEY);
      COMMENT ON TABLE inv.fixture_bad_ledger IS 'class=LEDGER';
      GRANT SELECT, INSERT, UPDATE ON inv.fixture_bad_ledger TO hk_app;`);
    try {
      expect(await checkTableClasses(admin, architecture)).toEqual([
        'inv.fixture_bad_ledger is LEDGER: hk_app should hold INSERT, SELECT but holds INSERT, SELECT, UPDATE',
        'inv.fixture_bad_ledger is LEDGER but platform.reject_change() does not guard UPDATE, DELETE, TRUNCATE',
      ]);
    } finally {
      await admin.query('DROP TABLE inv.fixture_bad_ledger');
    }
  });

  it('reports a table PUBLIC can read', async () => {
    const admin = database.pool('admin');
    await admin.query(`
      CREATE TABLE inv.fixture_public (id uuid PRIMARY KEY);
      COMMENT ON TABLE inv.fixture_public IS 'class=LOOKUP';
      GRANT SELECT ON inv.fixture_public TO hk_app;
      GRANT SELECT ON inv.fixture_public TO PUBLIC;`);
    try {
      expect(await checkTableClasses(admin, architecture)).toEqual(['inv.fixture_public: PUBLIC holds SELECT']);
    } finally {
      await admin.query('DROP TABLE inv.fixture_public');
    }
  });

  it('platform.reject_change refuses UPDATE, DELETE and TRUNCATE on a LEDGER table, even for the superuser', async () => {
    const app = database.pool('app');
    await app.query(
      "INSERT INTO inv.fixture_ledger (id, value_pesewas, actor_id) VALUES ('01a1d75b-0000-7000-8000-000000000001', 25000, '01a1d75b-0000-7000-8000-0000000000aa')",
    );
    const admin = database.pool('admin');
    expect(await sqlStateOf(admin.query('UPDATE inv.fixture_ledger SET value_pesewas = 1'))).toBe('HK001');
    expect(await sqlStateOf(admin.query('DELETE FROM inv.fixture_ledger'))).toBe('HK001');
    expect(await sqlStateOf(admin.query('TRUNCATE inv.fixture_ledger'))).toBe('HK001');
    expect(await sqlStateOf(app.query('UPDATE inv.fixture_ledger SET value_pesewas = 1'))).toBe('42501');
    const { rows } = await app.query<{ value_pesewas: string }>('SELECT value_pesewas FROM inv.fixture_ledger');
    expect(rows).toEqual([{ value_pesewas: '25000' }]);
  });

  it('platform.touch_version accepts the next version and refuses any other', async () => {
    const app = database.pool('app');
    await app.query("INSERT INTO inv.fixture_master (id, name) VALUES ('01a1d75b-0000-7000-8000-000000000002', 'Dodowa pen 3')");
    await app.query("UPDATE inv.fixture_master SET name = 'Dodowa pen 3A', version = 2 WHERE id = '01a1d75b-0000-7000-8000-000000000002'");
    const after = await app.query<{ version: number; touched: boolean }>(
      "SELECT version, updated_at > '2000-01-01T00:00:00Z' AS touched FROM inv.fixture_master",
    );
    expect(after.rows).toEqual([{ version: 2, touched: true }]);
    expect(await sqlStateOf(app.query("UPDATE inv.fixture_master SET name = 'stale write' WHERE id = '01a1d75b-0000-7000-8000-000000000002'"))).toBe('HK002');
    expect(await sqlStateOf(app.query("UPDATE inv.fixture_master SET version = 4 WHERE id = '01a1d75b-0000-7000-8000-000000000002'"))).toBe('HK002');
  });
});

describe('cross-schema foreign keys (ADR-0011)', () => {
  beforeAll(async () => {
    const admin = database.pool('admin');
    // iam.principal is the real, migrated table; iam.session_note is an unpublished stand-in.
    await admin.query('CREATE SCHEMA ord AUTHORIZATION hk_owner');
    await admin.query('CREATE TABLE iam.session_note (id uuid PRIMARY KEY)');
    await admin.query('CREATE TABLE ord.sales_order (id uuid PRIMARY KEY)');
  });

  it('passes a key to a published or universal key, from a higher layer, with ON DELETE RESTRICT', async () => {
    const admin = database.pool('admin');
    await admin.query(`
      CREATE TABLE inv.fixture_ok (id uuid PRIMARY KEY,
        actor_id uuid CONSTRAINT fk_fixture_ok_actor REFERENCES iam.principal (id) ON DELETE RESTRICT)`);
    try {
      expect(await checkCrossSchemaForeignKeys(admin, architecture)).toEqual([]);
    } finally {
      await admin.query('DROP TABLE inv.fixture_ok');
    }
  });

  it('fails on a key to an unpublished table, an upward key, and a cascading key', async () => {
    const admin = database.pool('admin');
    await admin.query(`
      CREATE TABLE inv.fixture_bad (id uuid PRIMARY KEY,
        note_id uuid CONSTRAINT fk_a_unpublished REFERENCES iam.session_note (id) ON DELETE RESTRICT,
        order_id uuid CONSTRAINT fk_b_upward REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
        actor_id uuid CONSTRAINT fk_c_cascade REFERENCES iam.principal (id) ON DELETE CASCADE)`);
    try {
      expect(await checkCrossSchemaForeignKeys(admin, architecture)).toEqual([
        'fk_a_unpublished (inv.fixture_bad -> iam.session_note) points at a key that is not published',
        'fk_b_upward (inv.fixture_bad -> ord.sales_order) does not point from a higher layer to a lower one',
        'fk_c_cascade (inv.fixture_bad -> iam.principal) must be ON DELETE RESTRICT',
      ]);
    } finally {
      await admin.query('DROP TABLE inv.fixture_bad');
    }
  });
});
