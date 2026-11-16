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
        ...fullCoverage('src/modules/mdm/domain/tax/**/*.ts'), // B4 continued: the tax calculator and scheme versions (ADR-0020)
        ...fullCoverage('src/modules/mdm/domain/catalogue.ts'), // B04d continued: weight band ranges and archive rules
        ...fullCoverage('src/modules/mdm/domain/parties.ts'), // B04d continued 2: Ghana phones, addresses, price list assignment windows
        ...fullCoverage('src/modules/mdm/domain/locations.ts'), // B04d continued 2: the location tree and virtual locations
        ...fullCoverage('src/modules/mdm/domain/reference-data.ts'), // B04d continued 3: payment method flags, zone areas, the delivery quote
        ...fullCoverage('src/modules/iam/domain/access-admin.ts'), // B04e: grant judgement, account status, the last owner, temporary passwords
        ...fullCoverage('src/modules/iam/domain/role-admin.ts'), // B04e continued: role changes beyond the actor, own roles, TOTP roles
        ...fullCoverage('src/modules/iam/domain/approval.ts'), // B04e continued: deciding, withdrawing, the shown status
        ...fullCoverage('src/modules/iam/domain/self-service.ts'), // B04e continued: phone codes, attempts, reset tokens
        ...fullCoverage('src/modules/doc/domain/file-use.ts'), // B04e continued 2: upload allow-lists, SA-11 caps, what is served
        ...fullCoverage('src/platform/storage/content-sniffer.ts'), // B04e continued 2: the type from the bytes (SC-12)
        ...fullCoverage('src/modules/shp/domain/**/*.ts'), // B07 continued 2: storefront line estimates, fees, totals, reservation spread, levels
        ...fullCoverage('src/platform/http/keyset-sort.ts'), // B07 continued 2: the shared sort (CR-019, ADR-0054)
        ...fullCoverage('src/platform/storage/image-variant-plan.ts'), // B04e continued 3: variant widths, byte budgets, the quality ladder
        ...fullCoverage('src/modules/mdm/domain/product-images.ts'), // B04e continued 3: which photograph is attached, gallery order
        ...fullCoverage('src/modules/mdm/domain/unit-conversion.ts'), // B06u: exact unit conversion factors and quantities (FR-MDM-003)
        ...fullCoverage('src/modules/inv/domain/valuation/**/*.ts'), // B5: stock valuation, cost pool and average cost (ADR-0018)
        ...fullCoverage('src/modules/inv/domain/stock-take.ts'), // B05 continued 3: stock-take scopes, overlap, variances, recounts
        ...fullCoverage('src/modules/inv/domain/stock-hold.ts'), // B05 continued 3: hold windows, placement and early release
        ...fullCoverage('src/modules/inv/domain/stock-exception.ts'), // B05 continued 3b: exception resolution kinds and summaries (ADR-0048)
        ...fullCoverage('src/modules/inv/domain/reservation.ts'), // B05 continued 3b: what may be promised, and what the expiry job ends
        ...fullCoverage('src/modules/inv/domain/availability.ts'), // B05 continued 3b: available to promise and its level
        ...fullCoverage('src/modules/inv/domain/stock-alert.ts'), // B05 continued 4: reorder levels, one alert per crossing, expiry
        ...fullCoverage('src/modules/inv/domain/temperature.ts'), // B05 continued 4: a reading against its range, in tenths of a degree
        ...fullCoverage('src/modules/inv/domain/opening-stock.ts'), // B05 continued 4: an opening stock row, read exactly
        ...fullCoverage('src/modules/inv/domain/label.ts'), // B05x: what a lot or animal label prints, its weight summed exactly
        ...fullCoverage('src/modules/mdm/domain/label.ts'), // B05x: what a product label encodes
        ...fullCoverage('src/modules/pur/domain/**/*.ts'), // B7: the three-way match, receipt tolerance, order actions, payment allocations; B07 continued: payout details, requisitions, terms, order splitting
        ...fullCoverage('src/modules/aud/domain/**/*.ts'), // B07 continued: the setting catalogue (FR-AUD-007)
        ...fullCoverage('src/modules/rpt/domain/**/*.ts'), // B05x: dashboard periods, daily series in pesewas, pending figures
        ...fullCoverage('src/modules/prc/domain/**/*.ts'), // B6: cost allocation by relative sales value, yield against standard (ADR-0018)
        ...fullCoverage('src/modules/liv/domain/**/*.ts'), // B06 continued: cost spread by head-days, withdrawal ends, the write-off threshold, animal status
        ...fullCoverage('src/modules/fin/domain/**/*.ts'), // B8: posting rules into journal lines, the late-event rule, the boot assertion, the trial balance, event amounts (ADR-0003)
        // ...fullCoverage('src/modules/cap/domain/distribution/**/*.ts'), // B12: distribution, unit-days and allocation (ADR-0028)
      },
    },
  },
});
