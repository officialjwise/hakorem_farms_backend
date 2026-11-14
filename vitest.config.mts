import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const kernelSource = fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url));
const shared = {
  resolve: { alias: { '@hakorem/kernel': kernelSource } },
};

/** Container start, role bootstrap and migrations can take a while on a cold machine. */
const CONTAINER_HOOK_TIMEOUT_MS = 180_000;
const DATABASE_TEST_TIMEOUT_MS = 60_000;

// One project per test layer (docs/TEST_STRATEGY.md section 4). A file in the wrong place does not run, and
// `pnpm lint` fails if a spec under test/ has no layer suffix. No retries anywhere: a flaky test is a failing test.
export default defineConfig({
  ...shared,
  test: {
    retry: 0,
    projects: [
      {
        ...shared,
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.spec.ts', 'src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
        },
      },
      {
        ...shared,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.integration.spec.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          testTimeout: DATABASE_TEST_TIMEOUT_MS,
          hookTimeout: CONTAINER_HOOK_TIMEOUT_MS,
          pool: 'forks',
        },
      },
      {
        ...shared,
        test: {
          name: 'contract',
          include: ['test/contract/**/*.contract.spec.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          testTimeout: DATABASE_TEST_TIMEOUT_MS,
          hookTimeout: CONTAINER_HOOK_TIMEOUT_MS,
          pool: 'forks',
        },
      },
      {
        ...shared,
        test: {
          name: 'e2e',
          include: ['test/e2e/**/*.e2e.spec.ts'],
          testTimeout: DATABASE_TEST_TIMEOUT_MS,
        },
      },
      {
        ...shared,
        test: {
          name: 'smoke',
          include: ['test/smoke/**/*.smoke.spec.ts'],
          testTimeout: 10_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/kernel/src/**/*.ts', 'src/**/*.ts'],
      // Excluded by docs/TEST_STRATEGY.md section 6: entry points (the API's and the worker's), the migration runner and
      // test files.
      exclude: ['**/*.spec.ts', '**/index.ts', 'src/main.ts', 'src/worker.ts', 'src/cli/**', 'src/platform/database/migration-runner.ts'],
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
        'packages/kernel/src/**/*.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
