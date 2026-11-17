import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { bootstrapDatabase, type RoleCredentials } from '../../src/platform/database/database-bootstrap';
import { migrate } from '../../src/platform/database/migration-runner';
import type { Json } from './yaml-emitter';

/** Where the matrix is published: an extension on `components` (CR-023), so it is documentation, never a schema. */
export const SEEDED_ROLES_EXTENSION = 'x-seeded-roles';

/** The engine docker-compose.yml and the tests run, so the migrations apply exactly as they do everywhere else. */
const POSTGRES_IMAGE = 'postgres:17.6-alpine';
const MIGRATIONS = resolve(__dirname, '../../migrations');
const DATABASE = 'hakorem_contract_roles';

/** One seeded role as the migrations leave it: the fields of `Role` that the seed decides, never a count or a time. */
export interface SeededRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly requiresTotp: boolean;
  readonly permissions: readonly string[];
  readonly limits: ReadonlyArray<{ readonly limitKind: string; readonly amountPesewas: number }>;
}

type Query = (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

/**
 * Reads every role the migrations seeded, with its full permissions and limits, ordered by the role's id (the order
 * 0004 seeds them in) and each list by code. Run on a database that holds the migrations and nothing else.
 */
export async function readSeededRoles(query: Query): Promise<SeededRole[]> {
  const roles = await query(`SELECT id::text, code, name, is_system, requires_totp FROM iam.role WHERE deleted_at IS NULL ORDER BY id`);
  const grants = await query(`SELECT role_id::text, permission_code FROM iam.role_permission ORDER BY role_id, permission_code COLLATE "C"`);
  const limits = await query(`SELECT role_id::text, limit_kind, amount_pesewas::text FROM iam.role_limit WHERE deleted_at IS NULL ORDER BY role_id, limit_kind COLLATE "C"`);
  return roles.rows.map((role) => ({
    id: String(role['id']),
    code: String(role['code']),
    name: String(role['name']),
    isSystem: role['is_system'] === true,
    requiresTotp: role['requires_totp'] === true,
    permissions: grants.rows.filter((grant) => grant['role_id'] === role['id']).map((grant) => String(grant['permission_code'])),
    limits: limits.rows
      .filter((limit) => limit['role_id'] === role['id'])
      .map((limit) => ({ limitKind: String(limit['limit_kind']), amountPesewas: Number(limit['amount_pesewas']) })),
  }));
}

/** The matrix as the contract publishes it. */
export function seededRolesExtension(roles: readonly SeededRole[]): Json {
  return roles.map((role) => ({ ...role, permissions: [...role.permissions], limits: role.limits.map((limit) => ({ ...limit })) }));
}

function secret(): string {
  return randomBytes(18).toString('hex');
}

/**
 * The seeded role matrix, generated from the IAM seed migrations themselves (CR-023, ADR-0071): a throwaway
 * PostgreSQL 17 is started, every migration in `migrations/` is applied exactly as `pnpm db:migrate` applies it, and
 * the roles and grants are read back. Never hand-written, so a grant changed in any migration changes the contract,
 * and `pnpm contract:generate --check` fails CI until the regenerated file is committed. Needs Docker.
 */
export async function seededRolesFromMigrations(directory: string = MIGRATIONS): Promise<SeededRole[]> {
  const adminPassword = secret();
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE)
    .withUsername('postgres')
    .withPassword(adminPassword)
    .withDatabase(DATABASE)
    .withCommand(['postgres', '-c', 'timezone=UTC'])
    .start();
  try {
    const url = (user: string, password: string, database: string = DATABASE) =>
      `postgres://${user}:${password}@${container.getHost()}:${container.getPort()}/${database}`;
    const passwords: RoleCredentials = { migrator: secret(), app: secret(), worker: secret(), sealer: secret(), report: secret(), backup: secret() };
    await bootstrapDatabase({ adminUrl: url('postgres', adminPassword, 'postgres'), database: DATABASE, environment: 'test', passwords, reportStatementTimeoutMs: 30_000 });
    await migrate(url('hk_migrator', passwords.migrator), directory);
    // The superuser reads the result: the migrator role holds no read on IAM's schema of its own (NOINHERIT).
    const client = new pg.Client({ connectionString: url('postgres', adminPassword) });
    await client.connect();
    try {
      return await readSeededRoles((text) => client.query(text));
    } finally {
      await client.end();
    }
  } finally {
    await container.stop();
  }
}
