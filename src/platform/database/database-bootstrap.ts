import pg from 'pg';

/**
 * Creates the seven database roles of ADR-0024 and hands the database to `hk_owner`. Development and test only:
 * it needs the superuser, and staging and production are provisioned by hand in B13 with their own secrets.
 * Safe to run again; every step checks before it acts.
 */
export type BootstrapEnvironment = 'development' | 'test';

export interface RoleCredentials {
  readonly migrator: string;
  readonly app: string;
  readonly worker: string;
  readonly sealer: string;
  readonly report: string;
  readonly backup: string;
}

export interface BootstrapSettings {
  readonly adminUrl: string;
  readonly database: string;
  readonly environment: BootstrapEnvironment;
  /** Passwords for the login roles. */
  readonly passwords: RoleCredentials;
  /** `hk_report`'s statement timeout (DB_REPORT_STATEMENT_TIMEOUT_MS). */
  readonly reportStatementTimeoutMs: number;
}

/** `hk_report` may hold at most this many connections, so a burst of reports cannot starve the counter. */
const REPORT_CONNECTION_LIMIT = 5;

interface LoginRole {
  readonly name: string;
  readonly password: string;
  readonly attributes: string;
}

/** Reads the password out of a role's connection URL, so `.env` holds each secret once. */
export function passwordFromUrl(url: string): string {
  const password = decodeURIComponent(new URL(url).password);
  if (password === '') {
    throw new Error('the connection URL carries no password');
  }
  return password;
}

export async function bootstrapDatabase(settings: BootstrapSettings): Promise<void> {
  const client = new pg.Client({ connectionString: settings.adminUrl, application_name: 'hakorem-bootstrap' });
  await client.connect();
  const id = (name: string) => client.escapeIdentifier(name);
  const literal = (value: string) => client.escapeLiteral(value);
  try {
    const exists = async (role: string) =>
      (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;

    if (!(await exists('hk_owner'))) {
      await client.query('CREATE ROLE hk_owner NOLOGIN');
    }
    const logins: LoginRole[] = [
      { name: 'hk_migrator', password: settings.passwords.migrator, attributes: 'LOGIN NOINHERIT' },
      { name: 'hk_app', password: settings.passwords.app, attributes: 'LOGIN' },
      { name: 'hk_worker', password: settings.passwords.worker, attributes: 'LOGIN' },
      { name: 'hk_sealer', password: settings.passwords.sealer, attributes: 'LOGIN' },
      { name: 'hk_report', password: settings.passwords.report, attributes: `LOGIN CONNECTION LIMIT ${REPORT_CONNECTION_LIMIT}` },
      { name: 'hk_backup', password: settings.passwords.backup, attributes: 'LOGIN REPLICATION' },
    ];
    for (const role of logins) {
      const verb = (await exists(role.name)) ? 'ALTER' : 'CREATE';
      await client.query(
        `${verb} ROLE ${id(role.name)} WITH ${role.attributes} NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${literal(role.password)}`,
      );
    }
    // The migrator may act as the owner, but does not inherit its privileges outside a SET ROLE.
    await client.query('GRANT hk_owner TO hk_migrator WITH INHERIT FALSE, SET TRUE');
    await client.query('GRANT pg_read_all_data TO hk_backup');
    await client.query(`ALTER ROLE hk_report SET statement_timeout = ${Number(settings.reportStatementTimeoutMs)}`);

    const db = id(settings.database);
    await client.query(`ALTER DATABASE ${db} OWNER TO hk_owner`);
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO hk_migrator, hk_app, hk_worker, hk_sealer, hk_report, hk_backup`);
    await client.query(`ALTER DATABASE ${db} SET hk.environment = ${literal(settings.environment)}`);
  } finally {
    await client.end();
  }
  await lockDownPublicSchema(settings.adminUrl, settings.database);
}

/** `PUBLIC` has no privileges on any schema (ADR-0024), including the default `public` schema. */
async function lockDownPublicSchema(adminUrl: string, database: string): Promise<void> {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: url.toString(), application_name: 'hakorem-bootstrap' });
  await client.connect();
  try {
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query('ALTER SCHEMA public OWNER TO hk_owner');
  } finally {
    await client.end();
  }
}
