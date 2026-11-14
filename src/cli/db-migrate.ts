import { resolve } from 'node:path';
import { z } from 'zod';
import { parseEnvironment, postgresUrl } from '../platform/config/app-config';
import { migrate } from '../platform/database/migration-runner';
import { runCli } from './run-cli';

/** `pnpm db:migrate`: applies pending migrations as hk_migrator, each as hk_owner. */
runCli('db:migrate', async () => {
  const env = parseEnvironment(z.object({ DATABASE_URL_MIGRATOR: postgresUrl }), process.env);
  const outcome = await migrate(env.DATABASE_URL_MIGRATOR, resolve(process.cwd(), 'migrations'));
  const summary = outcome.applied.length === 0 ? 'already up to date' : `applied ${outcome.applied.join(', ')}`;
  process.stdout.write(`db:migrate: ${summary}\n`);
});
