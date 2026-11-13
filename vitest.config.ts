import { defineConfig } from 'vitest/config';

// One project per test layer (docs/TEST_STRATEGY.md section 4). A file in the wrong place does not run.
export default defineConfig({
  test: {
    retry: 0,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/src/**/*.spec.ts', 'src/**/*.spec.ts'],
          exclude: ['**/node_modules/**', '**/dist/**', 'test/**'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/kernel/src/**/*.ts'],
      exclude: ['**/*.spec.ts', '**/index.ts'],
      thresholds: {
        'packages/kernel/src/**/*.ts': { branches: 100, functions: 100, lines: 100, statements: 100 },
      },
    },
  },
});
