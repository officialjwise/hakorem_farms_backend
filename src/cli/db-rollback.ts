import { resolve } from 'node:path';
import { z } from 'zod';
import { parseEnvironment, postgresUrl } from '../platform/config/app-config';
import { rollback } from '../platform/database/migration-runner';
import { runCli } from './run-cli';

/** `pnpm db:rollback`: rolls back the last migration, or prints its forward fix and exits 2 without changing anything. */
const FORWARD_FIX_EXIT_CODE = 2;

runCli('db:rollback', async () => {
  const env = parseEnvironment(z.object({ DATABASE_URL_MIGRATOR: postgresUrl }), process.env);
  const outcome = await rollback(env.DATABASE_URL_MIGRATOR, resolve(process.cwd(), 'migrations'));
  switch (outcome.kind) {
    case 'NOTHING_APPLIED':
      process.stdout.write('db:rollback: nothing to roll back\n');
      return;
    case 'ROLLED_BACK':
      process.stdout.write(`db:rollback: rolled back ${outcome.name}\n`);
      return;
    case 'FORWARD_FIX_ONLY':
      process.stderr.write(`db:rollback: ${outcome.name} has no rollback; forward fix: ${outcome.forwardFix}\n`);
      process.exit(FORWARD_FIX_EXIT_CODE);
  }
});
