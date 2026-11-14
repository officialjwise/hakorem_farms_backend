import { spawnSync } from 'node:child_process';

/**
 * `pnpm test:smoke -- --base-url=https://api.staging.hakoremfarms.com`: the smoke suite against a deployed
 * environment (docs/TEST_STRATEGY.md section 3.5). Refuses to run without a base URL; the exit code drives rollback.
 */
const argument = process.argv.slice(2).find((arg) => arg.startsWith('--base-url='));
const baseUrl = argument?.slice('--base-url='.length);
if (baseUrl === undefined || !/^https?:\/\/[^/]+/.test(baseUrl)) {
  process.stderr.write('test:smoke: pass --base-url=<the environment, for example https://api.staging.hakoremfarms.com>\n');
  process.exit(2);
}
const result = spawnSync('corepack', ['pnpm', 'exec', 'vitest', 'run', '--project', 'smoke'], {
  stdio: 'inherit',
  env: { ...process.env, SMOKE_BASE_URL: baseUrl.replace(/\/$/, '') },
});
process.exit(result.status ?? 1);
