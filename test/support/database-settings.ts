import type { RoleCredentials } from '../../src/platform/database/database-bootstrap';

export const TEMPLATE_DATABASE = 'hakorem_template';

export type DatabaseRole = 'admin' | keyof RoleCredentials;

/** What the global setup hands to every test file. */
export interface ProvidedDatabase {
  readonly host: string;
  readonly port: number;
  readonly adminPassword: string;
  readonly passwords: RoleCredentials;
}

declare module 'vitest' {
  export interface ProvidedContext {
    database: ProvidedDatabase;
    redisUrl: string;
    objectStore: { endpoint: string; accessKeyId: string; secretAccessKey: string };
  }
}

const ROLE_NAMES: Readonly<Record<DatabaseRole, string>> = {
  admin: 'postgres',
  migrator: 'hk_migrator',
  app: 'hk_app',
  worker: 'hk_worker',
  sealer: 'hk_sealer',
  report: 'hk_report',
  backup: 'hk_backup',
};

export function roleName(role: DatabaseRole): string {
  return ROLE_NAMES[role];
}

export function roleUrl(settings: ProvidedDatabase, role: DatabaseRole, database: string): string {
  const password = role === 'admin' ? settings.adminPassword : settings.passwords[role];
  return `postgres://${ROLE_NAMES[role]}:${password}@${settings.host}:${settings.port}/${database}`;
}
