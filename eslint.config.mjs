// ESLint for the backend. The module-boundary rule implements docs/MODULE_BOUNDARIES.md section 7 and is
// generated from tooling/architecture.json, so adding a module is one line there. `pnpm lint` runs this with
// --max-warnings 0, then proves with tooling/lint-fixtures that each illegal import still fails.
import { createRequire } from 'node:module';
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const require = createRequire(import.meta.url);
const architecture = require('./tooling/architecture.json');
const hakorem = require('./tooling/eslint/hakorem-plugin.cjs');

const modules = Object.keys(architecture.layers);
const lowerThan = (module) => modules.filter((other) => architecture.layers[other] < architecture.layers[module]);
const own = (type, module) => [type, { module }];

/** Default deny: each element type may import only what section 7 lists. */
function boundaryRules() {
  const rules = [
    { from: 'kernel', allow: [] },
    { from: 'platform', allow: ['kernel', 'platform'] },
    { from: 'entry', allow: ['kernel', 'platform', 'module-public', 'module-root', 'entry'] },
  ];
  for (const module of modules) {
    const lowerPublic = lowerThan(module).map((other) => own('module-public', other));
    const application = [
      'kernel',
      'platform',
      own('module-domain', module),
      own('module-application', module),
      ...lowerPublic,
    ];
    rules.push(
      { from: [own('module-domain', module)], allow: ['kernel', own('module-domain', module)] },
      { from: [own('module-application', module)], allow: application },
      { from: [own('module-infrastructure', module)], allow: [...application, own('module-infrastructure', module)] },
      { from: [own('module-interface', module)], allow: [...application, own('module-interface', module)] },
      {
        from: [own('module-public', module), own('module-events', module)],
        allow: [
          'kernel',
          own('module-domain', module),
          own('module-application', module),
          own('module-infrastructure', module),
          own('module-interface', module),
          own('module-events', module),
          own('module-root', module),
        ],
      },
      {
        from: [own('module-root', module)],
        allow: [
          'kernel',
          'platform',
          own('module-application', module),
          own('module-infrastructure', module),
          own('module-interface', module),
          ...lowerPublic,
        ],
      },
    );
  }
  // Any module may import any module's events.ts, as types only, to subscribe.
  rules.push({
    from: ['module-application', 'module-infrastructure', 'module-interface'],
    allow: ['module-events'],
    importKind: 'type',
  });
  return rules;
}

/** No focused or skipped tests in a merged change (docs/TEST_STRATEGY.md section 9). */
const NO_FOCUSED_TESTS = {
  selector: 'MemberExpression[object.name=/^(describe|it|test)$/][property.name=/^(only|skip|todo)$/]',
  message: 'No .only, .skip or .todo in a merged change; quarantine a test with an issue (docs/TEST_STRATEGY.md section 9).',
};

const FRAMEWORK_IMPORTS = ['@nestjs/*', 'drizzle-orm', 'drizzle-orm/*', 'pg', 'ioredis', 'express', 'pino', '@opentelemetry/*', 'bullmq'];

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'contract/**', 'tooling/lint-fixtures/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    plugins: { boundaries, 'import-x': importX, hakorem },
    settings: {
      'import-x/resolver-next': [require('eslint-import-resolver-typescript').createTypeScriptImportResolver({ project: ['./tsconfig.json', './tooling/lint-fixtures/tsconfig.json'], noWarnOnMultipleProjects: true })],
      'import-x/extensions': ['.ts', '.mts', '.js', '.mjs', '.cjs'],
      'import-x/parsers': { '@typescript-eslint/parser': ['.ts', '.mts'] },
      'import/resolver': { typescript: { project: ['./tsconfig.json', './tooling/lint-fixtures/tsconfig.json'], noWarnOnMultipleProjects: true } },
      'boundaries/include': ['**/packages/kernel/src/**', '**/src/**'],
      'boundaries/elements': [
        { type: 'kernel', pattern: 'packages/kernel/src', mode: 'folder' },
        { type: 'platform', pattern: 'src/platform', mode: 'folder' },
        { type: 'module-public', pattern: 'src/modules/*/index.ts', mode: 'file', capture: ['module'] },
        { type: 'module-events', pattern: 'src/modules/*/events.ts', mode: 'file', capture: ['module'] },
        { type: 'module-root', pattern: 'src/modules/*/*.module.ts', mode: 'file', capture: ['module'] },
        { type: 'module-domain', pattern: 'src/modules/*/domain', mode: 'folder', capture: ['module'] },
        { type: 'module-application', pattern: 'src/modules/*/application', mode: 'folder', capture: ['module'] },
        { type: 'module-infrastructure', pattern: 'src/modules/*/infrastructure', mode: 'folder', capture: ['module'] },
        { type: 'module-interface', pattern: 'src/modules/*/interface', mode: 'folder', capture: ['module'] },
        { type: 'entry', pattern: ['src/*.ts', 'src/cli', 'src/seed'], mode: 'full' },
      ],
    },
    rules: {
      'boundaries/element-types': ['error', { default: 'disallow', rules: boundaryRules() }],
      'import-x/no-cycle': 'error',
      'hakorem/no-number-arithmetic-with-money': 'error',
      'hakorem/no-import-outside-backend': ['error', { root: import.meta.dirname }],
      'no-console': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-restricted-syntax': ['error', NO_FOCUSED_TESTS],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // The domain is pure: no framework, no input or output, no clock (ADR-0008, ENGINEERING_STANDARDS section 8).
    files: ['**/src/modules/*/domain/**/*.ts', '**/packages/kernel/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: FRAMEWORK_IMPORTS, message: 'Domain code imports only the kernel and its own files (ADR-0008).' }] }],
    },
  },
  {
    files: ['**/src/modules/*/domain/**/*.ts', '**/src/modules/*/application/**/*.ts'],
    rules: {
      // Repeats NO_FOCUSED_TESTS: a later config replaces this rule's whole list rather than adding to it.
      'no-restricted-syntax': [
        'error',
        NO_FOCUSED_TESTS,
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Take time from the kernel Clock (ENGINEERING_STANDARDS section 8).' },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: 'Take time from the kernel Clock (ENGINEERING_STANDARDS section 8).' },
      ],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
);
