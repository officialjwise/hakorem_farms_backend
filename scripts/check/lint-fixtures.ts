import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ESLint } from 'eslint';

/**
 * Proves the lint rules still fire (docs/MODULE_BOUNDARIES.md section 7, NFR-018 `build fails on a cross-module
 * internal import`). Every file under tooling/lint-fixtures names the rule ids it must produce in an `// expect:`
 * header; this fails if any file produces more, fewer or different ones.
 */
const ROOT = resolve(__dirname, '../..');
const FIXTURES = resolve(ROOT, 'tooling/lint-fixtures');
const EXPECT = /^\/\/ expect: (.+)$/m;

async function main(): Promise<void> {
  const eslint = new ESLint({ cwd: ROOT, ignore: false });
  const results = await eslint.lintFiles([`${FIXTURES}/**/*.ts`]);
  const problems: string[] = [];
  for (const result of results) {
    const file = relative(ROOT, result.filePath);
    const header = EXPECT.exec(readFileSync(result.filePath, 'utf8'))?.[1];
    if (header === undefined) {
      problems.push(`${file}: no "// expect:" header`);
      continue;
    }
    const expected = header === 'none' ? [] : header.split(',').map((rule) => rule.trim()).sort();
    const fatal = result.messages.filter((message) => message.ruleId === null);
    if (fatal.length > 0) {
      problems.push(`${file}: could not be linted: ${fatal.map((m) => m.message).join('; ')}`);
      continue;
    }
    const actual = [...new Set(result.messages.map((message) => message.ruleId as string))].sort();
    if (expected.join(',') !== actual.join(',')) {
      problems.push(`${file}: expected ${expected.join(', ') || 'no errors'}, got ${actual.join(', ') || 'no errors'}`);
    }
  }
  if (results.length === 0) {
    problems.push('no fixture files were linted');
  }
  if (problems.length > 0) {
    process.stderr.write(`lint fixtures: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`lint fixtures: ${results.length} files, every rule fired as expected\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`lint fixtures: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
