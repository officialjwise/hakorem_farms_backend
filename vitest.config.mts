import { globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const kernelSource = fileURLToPath(new URL('./packages/kernel/src/index.ts', import.meta.url));
const shared = {
  resolve: { alias: { '@hakorem/kernel': kernelSource } },
};

/** Container start, role bootstrap and migrations can take a while on a cold machine. */
const CONTAINER_HOOK_TIMEOUT_MS = 180_000;
const DATABASE_TEST_TIMEOUT_MS = 60_000;

/**
 * A 100 percent gate (docs/TEST_STRATEGY.md section 6, NFR-015). Vitest passes a threshold whose glob matches no file,
 * so a renamed or moved folder would drop its gate in silence; this refuses to load the configuration instead.
 */
function fullCoverage(glob: string): Record<string, { branches: 100; functions: 100; lines: 100; statements: 100 }> {
  const sources = globSync(glob, { cwd: fileURLToPath(new URL('.', import.meta.url)) }).filter((file) => !file.endsWith('.spec.ts'));
  if (sources.length === 0) {
    throw new Error(`coverage gate ${glob} matches no source file: move the gate with the code, never drop it`);
  }
  return { [glob]: { branches: 100, functions: 100, lines: 100, statements: 100 } };
}

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
        // 100 percent on the money paths (docs/TEST_STRATEGY.md section 6, NFR-015). Each session that creates one of
        // the folders below adds its gate here, uncommented, before its gate passes.
        ...fullCoverage('packages/kernel/src/**/*.ts'),
        ...fullCoverage('src/modules/mdm/domain/pricing/**/*.ts'), // B4: the ADR-0004 walk and price list rules
        // ...fullCoverage('src/modules/mdm/domain/tax/**/*.ts'),          // B4 continued: the tax calculator (ADR-0020)
        // ...fullCoverage('src/modules/inv/domain/valuation/**/*.ts'),    // B5: stock valuation, cost pool and average cost (ADR-0018)
        // ...fullCoverage('src/modules/fin/domain/**/*.ts'),              // B8: the ledger, posting rules, journals, periods (ADR-0003)
        // ...fullCoverage('src/modules/cap/domain/distribution/**/*.ts'), // B12: distribution, unit-days and allocation (ADR-0028)
      },
    },
  },
});
