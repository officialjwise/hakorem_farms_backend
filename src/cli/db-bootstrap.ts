import { z } from 'zod';
import { parseEnvironment, postgresUrl } from '../platform/config/app-config';
import { bootstrapDatabase, passwordFromUrl } from '../platform/database/database-bootstrap';
import { runCli } from './run-cli';

const schema = z.object({
  APP_ENV: z.enum(['development', 'test'], { message: 'must be development or test; staging and production are provisioned in B13' }),
  DATABASE_URL_ADMIN: postgresUrl,
  DATABASE_URL_MIGRATOR: postgresUrl,
  DATABASE_URL_APP: postgresUrl,
  DATABASE_URL_WORKER: postgresUrl,
  DATABASE_URL_SEALER: postgresUrl,
  DATABASE_URL_REPORT: postgresUrl,
  DATABASE_URL_BACKUP: postgresUrl,
  DB_REPORT_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(30_000),
});

/** `pnpm db:bootstrap`: the database roles and ownership, as the superuser, in development and test only. */
runCli('db:bootstrap', async () => {
  const env = parseEnvironment(schema, process.env);
  const database = new URL(env.DATABASE_URL_APP).pathname.replace(/^\//, '');
  await bootstrapDatabase({
    adminUrl: env.DATABASE_URL_ADMIN,
    database,
    environment: env.APP_ENV,
    passwords: {
      migrator: passwordFromUrl(env.DATABASE_URL_MIGRATOR),
      app: passwordFromUrl(env.DATABASE_URL_APP),
      worker: passwordFromUrl(env.DATABASE_URL_WORKER),
      sealer: passwordFromUrl(env.DATABASE_URL_SEALER),
      report: passwordFromUrl(env.DATABASE_URL_REPORT),
      backup: passwordFromUrl(env.DATABASE_URL_BACKUP),
    },
    reportStatementTimeoutMs: env.DB_REPORT_STATEMENT_TIMEOUT_MS,
  });
  process.stdout.write(`db:bootstrap: roles ready, database ${database} owned by hk_owner, environment ${env.APP_ENV}\n`);
});
