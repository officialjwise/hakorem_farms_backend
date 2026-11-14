import type pg from 'pg';

/** A pool or a single connection: the checks only read the catalogue. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}
import { applicationSchemas, layerOf, type Architecture } from './architecture';

/**
 * The database checks of ADR-0008, ADR-0011, ADR-0012 and ADR-0024, run in CI against a migrated database and at
 * each deploy. Each returns a list of problems; an empty list is a pass. They read the catalogue only.
 */
export const TABLE_CLASSES = ['LEDGER', 'DOCUMENT', 'MASTER', 'PROJECTION', 'LOOKUP', 'WORK'] as const;
export type TableClass = (typeof TABLE_CLASSES)[number];

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

/** What `hk_app` holds on a table of each class (ADR-0024), exactly: anything more or less is drift. */
export const APP_PRIVILEGES: Readonly<Record<TableClass, readonly string[]>> = {
  LEDGER: ['INSERT', 'SELECT'],
  DOCUMENT: ['INSERT', 'SELECT', 'UPDATE'],
  MASTER: ['INSERT', 'SELECT', 'UPDATE'],
  PROJECTION: ['SELECT'],
  LOOKUP: ['SELECT'],
  WORK: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
};

const CLASS_COMMENT = /(?:^|;)\s*class=([A-Z]+)\s*(?:;|$)/;
/**
 * `writer=hk_sealer` marks a LEDGER table that only the audit sealer writes (ADR-0006, ADR-0031): the application
 * roles may read it and nothing else.
 */
const WRITER_COMMENT = /(?:^|;)\s*writer=(hk_[a-z]+)\s*(?:;|$)/;
export const SEALER_ONLY_APP_PRIVILEGES: readonly string[] = ['SELECT'];

// pg_trigger.tgtype bits
const TRIGGER_ROW = 1;
const TRIGGER_BEFORE = 2;
const TRIGGER_DELETE = 8;
const TRIGGER_UPDATE = 16;
const TRIGGER_TRUNCATE = 32;

interface TableRow {
  schema: string;
  table: string;
  oid: number;
  comment: string | null;
}

async function applicationTables(client: Queryable, architecture: Architecture): Promise<TableRow[]> {
  const { rows } = await client.query<TableRow>(
    `SELECT n.nspname AS schema, c.relname AS "table", c.oid::int AS oid, obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY($1)
      ORDER BY 1, 2`,
    [applicationSchemas(architecture)],
  );
  return rows;
}

async function privilegesOf(client: Queryable, role: string, oid: number): Promise<string[]> {
  const held: string[] = [];
  for (const privilege of PRIVILEGES) {
    const { rows } = await client.query<{ has: boolean }>('SELECT has_table_privilege($1, $2::oid, $3) AS has', [role, oid, privilege]);
    if (rows[0]?.has === true) {
      held.push(privilege);
    }
  }
  return held.sort();
}

async function ledgerTriggerGaps(client: Queryable, oid: number): Promise<string[]> {
  const { rows } = await client.query<{ tgtype: number }>(
    `SELECT t.tgtype::int AS tgtype FROM pg_trigger t
      WHERE t.tgrelid = $1::oid AND NOT t.tgisinternal AND t.tgenabled <> 'D'
        AND t.tgfoid = 'platform.reject_change()'::regprocedure`,
    [oid],
  );
  const covers = (bits: number, row: boolean) =>
    rows.some((r) => (r.tgtype & TRIGGER_BEFORE) !== 0 && (r.tgtype & bits) !== 0 && ((r.tgtype & TRIGGER_ROW) !== 0) === row);
  const gaps: string[] = [];
  if (!covers(TRIGGER_UPDATE, true)) gaps.push('UPDATE');
  if (!covers(TRIGGER_DELETE, true)) gaps.push('DELETE');
  if (!covers(TRIGGER_TRUNCATE, false)) gaps.push('TRUNCATE');
  return gaps;
}

/** ADR-0012 and ADR-0024: every table declares its class, and hk_app holds exactly the class's privileges. */
export async function checkTableClasses(client: Queryable, architecture: Architecture): Promise<string[]> {
  const problems: string[] = [];
  for (const table of await applicationTables(client, architecture)) {
    const name = `${table.schema}.${table.table}`;
    const declared = CLASS_COMMENT.exec(table.comment ?? '')?.[1];
    if (declared === undefined || !(TABLE_CLASSES as readonly string[]).includes(declared)) {
      problems.push(`${name} declares no table class (COMMENT ON TABLE ... IS 'class=<CLASS>')`);
      continue;
    }
    const tableClass = declared as TableClass;
    const writer = WRITER_COMMENT.exec(table.comment ?? '')?.[1];
    if (writer !== undefined && (writer !== 'hk_sealer' || tableClass !== 'LEDGER')) {
      problems.push(`${name} declares writer=${writer}; only LEDGER tables may name a writer, and only hk_sealer`);
      continue;
    }
    const expected = [...(writer === undefined ? APP_PRIVILEGES[tableClass] : SEALER_ONLY_APP_PRIVILEGES)].sort();
    const actual = await privilegesOf(client, 'hk_app', table.oid);
    if (expected.join(',') !== actual.join(',')) {
      problems.push(`${name} is ${tableClass}${writer === undefined ? '' : ` written by ${writer}`}: hk_app should hold ${expected.join(', ')} but holds ${actual.join(', ') || 'nothing'}`);
    }
    const publicHolds = await privilegesOf(client, 'public', table.oid);
    if (publicHolds.length > 0) {
      problems.push(`${name}: PUBLIC holds ${publicHolds.join(', ')}`);
    }
    if (tableClass === 'LEDGER') {
      const gaps = await ledgerTriggerGaps(client, table.oid);
      if (gaps.length > 0) {
        problems.push(`${name} is LEDGER but platform.reject_change() does not guard ${gaps.join(', ')}`);
      }
    }
  }
  return problems;
}

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolcanlogin: boolean;
  rolinherit: boolean;
}

const LOGIN_ROLES = ['hk_migrator', 'hk_app', 'hk_worker', 'hk_sealer', 'hk_report', 'hk_backup'];
/** Roles that run application code and must never change the schema. */
const NO_DDL_ROLES = ['hk_app', 'hk_worker', 'hk_sealer', 'hk_report', 'hk_backup'];

/** ADR-0024: the seven roles exist with least privilege, and no runtime role can create or own anything. */
export async function checkRoles(client: Queryable, architecture: Architecture): Promise<string[]> {
  const problems: string[] = [];
  const { rows } = await client.query<RoleRow>(
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin, rolinherit FROM pg_roles WHERE rolname LIKE 'hk\\_%'`,
  );
  const byName = new Map(rows.map((row) => [row.rolname, row]));
  const owner = byName.get('hk_owner');
  if (owner === undefined || owner.rolcanlogin) {
    problems.push('hk_owner must exist and must not be able to log in');
  }
  for (const name of LOGIN_ROLES) {
    const role = byName.get(name);
    if (role === undefined) {
      problems.push(`${name} does not exist`);
    } else if (role.rolsuper || role.rolcreatedb || role.rolcreaterole) {
      problems.push(`${name} has superuser, create-database or create-role rights`);
    }
  }
  if (byName.get('hk_migrator')?.rolinherit === true) {
    problems.push('hk_migrator must not inherit hk_owner; it acts as the owner only through SET ROLE');
  }
  const database = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
  for (const role of NO_DDL_ROLES) {
    const db = await client.query<{ create: boolean; temp: boolean }>(
      `SELECT has_database_privilege($1, $2, 'CREATE') AS create, has_database_privilege($1, $2, 'TEMP') AS temp`,
      [role, database],
    );
    if (db.rows[0]?.create === true) {
      problems.push(`${role} can create schemas in ${database}`);
    }
    for (const schema of [...applicationSchemas(architecture), 'public', 'migration']) {
      const { rows: schemaRows } = await client.query<{ create: boolean | null }>(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $2)
                     THEN has_schema_privilege($1, $2, 'CREATE') END AS create`,
        [role, schema],
      );
      if (schemaRows[0]?.create === true) {
        problems.push(`${role} can create objects in schema ${schema}`);
      }
    }
    const owned = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = $1`,
      [role],
    );
    if ((owned.rows[0]?.n ?? 0) > 0) {
      problems.push(`${role} owns ${owned.rows[0]!.n} relations; everything is owned by hk_owner`);
    }
  }
  const migrationAccess = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'migration' AND has_schema_privilege('hk_app', oid, 'USAGE')`,
  );
  if ((migrationAccess.rows[0]?.n ?? 0) > 0) {
    problems.push('hk_app can use the migration schema');
  }
  return problems;
}

interface ForeignKeyRow {
  name: string;
  from_schema: string;
  from_table: string;
  to_schema: string;
  to_table: string;
  on_delete: string;
}

/**
 * ADR-0011 and docs/MODULE_BOUNDARIES.md section 5: a foreign key may cross schemas only to a published key, from a
 * higher layer to a lower one, with ON DELETE RESTRICT. The three universal keys may be referenced from any layer.
 */
export async function checkCrossSchemaForeignKeys(client: Queryable, architecture: Architecture): Promise<string[]> {
  const { rows } = await client.query<ForeignKeyRow>(
    `SELECT con.conname AS name, fn.nspname AS from_schema, fc.relname AS from_table,
            tn.nspname AS to_schema, tc.relname AS to_table, con.confdeltype AS on_delete
       FROM pg_constraint con
       JOIN pg_class fc ON fc.oid = con.conrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       JOIN pg_class tc ON tc.oid = con.confrelid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
      WHERE con.contype = 'f' AND fn.nspname <> tn.nspname
      ORDER BY 1`,
  );
  const problems: string[] = [];
  for (const fk of rows) {
    const label = `${fk.name} (${fk.from_schema}.${fk.from_table} -> ${fk.to_schema}.${fk.to_table})`;
    const target = `${fk.to_schema}.${fk.to_table}`;
    const universal = architecture.universalKeys.includes(target);
    const published = architecture.publishedKeys[fk.to_schema]?.includes(fk.to_table) === true;
    if (!universal && !published) {
      problems.push(`${label} points at a key that is not published`);
      continue;
    }
    const fromLayer = layerOf(architecture, fk.from_schema);
    const toLayer = layerOf(architecture, fk.to_schema);
    if (!universal && (fromLayer === undefined || toLayer === undefined || fromLayer <= toLayer)) {
      problems.push(`${label} does not point from a higher layer to a lower one`);
    }
    if (fk.on_delete !== 'r') {
      problems.push(`${label} must be ON DELETE RESTRICT`);
    }
  }
  return problems;
}
