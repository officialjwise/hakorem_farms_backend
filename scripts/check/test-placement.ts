import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * docs/TEST_STRATEGY.md section 4: unit specs sit beside the code; every other layer lives under test/<layer>/ with
 * its suffix. A spec in the wrong place would silently not run, so this fails the lint step instead.
 */
const ROOT = resolve(__dirname, '../..');
const LAYERS: ReadonlyArray<readonly [folder: string, suffix: string]> = [
  ['test/integration/', '.integration.spec.ts'],
  ['test/contract/', '.contract.spec.ts'],
  ['test/e2e/', '.e2e.spec.ts'],
  ['test/smoke/', '.smoke.spec.ts'],
];
const SKIP = new Set(['node_modules', 'dist', 'coverage', '.git', 'lint-fixtures']);

function walk(directory: string, found: string[]): string[] {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry)) {
      continue;
    }
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      walk(path, found);
    } else if (entry.endsWith('.spec.ts')) {
      found.push(relative(ROOT, path));
    }
  }
  return found;
}

export function placementProblems(files: readonly string[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const layer = LAYERS.find(([, suffix]) => file.endsWith(suffix));
    if (file.startsWith('test/')) {
      if (layer === undefined) {
        problems.push(`${file}: a spec under test/ needs a layer suffix (${LAYERS.map(([, s]) => s).join(', ')})`);
      } else if (!file.startsWith(layer[0])) {
        problems.push(`${file}: a ${layer[1]} file belongs under ${layer[0]}`);
      }
    } else if (layer !== undefined) {
      problems.push(`${file}: only unit specs sit beside the code; move it under ${layer[0]}`);
    }
  }
  return problems;
}

if (require.main === module) {
  const files = walk(ROOT, []);
  const problems = placementProblems(files);
  if (problems.length > 0) {
    process.stderr.write(`test placement:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`test placement: ${files.length} spec files in place\n`);
}
