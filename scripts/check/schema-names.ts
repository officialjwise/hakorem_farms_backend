import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { applicationSchemas, readArchitecture, type Architecture } from './architecture';

/**
 * docs/MODULE_BOUNDARIES.md section 7, data check 2: a migration, or a module's infrastructure code, names only its
 * own schema. It may also name the shared platform objects (domains and trigger functions), a published key in a
 * REFERENCES clause, and, for CST and RPT only, a published `pub_` view.
 */
const ROOT = resolve(__dirname, '../..');
const MIGRATION_NAME = /^\d{4}_([a-z]+)_/;

export function schemaNameProblems(file: string, ownSchema: string, text: string, architecture: Architecture): string[] {
  const schemas = applicationSchemas(architecture).filter((schema) => schema !== ownSchema);
  if (schemas.length === 0) {
    return [];
  }
  const reference = new RegExp(`(REFERENCES\\s+)?\\b(${schemas.join('|')})\\.([a-z_][a-z0-9_]*)`, 'gi');
  const problems: string[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const code = line.replace(/--.*$/, '').replace(/^\s*(\/\/|\*|\/\*).*$/, '');
    for (const match of code.matchAll(reference)) {
      const isForeignKey = match[1] !== undefined;
      const schema = (match[2] as string).toLowerCase();
      const object = (match[3] as string).toLowerCase();
      const qualified = `${schema}.${object}`;
      const allowed =
        (schema === 'platform' && architecture.platformSharedObjects.includes(object)) ||
        (isForeignKey && (architecture.universalKeys.includes(qualified) || architecture.publishedKeys[schema]?.includes(object) === true)) ||
        (architecture.publishedViewReaders.includes(ownSchema) && object.startsWith('pub_'));
      if (!allowed) {
        problems.push(`${file}:${index + 1}: names ${qualified}, which belongs to another schema`);
      }
    }
  });
  return problems;
}

function filesUnder(directory: string, extension: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...filesUnder(path, extension));
    } else if (entry.endsWith(extension)) {
      found.push(path);
    }
  }
  return found;
}

if (require.main === module) {
  const architecture = readArchitecture();
  const problems: string[] = [];
  let scanned = 0;
  for (const path of filesUnder(resolve(ROOT, 'migrations'), '.sql')) {
    const own = MIGRATION_NAME.exec(basename(path))?.[1];
    if (own === undefined || !applicationSchemas(architecture).includes(own)) {
      problems.push(`${relative(ROOT, path)}: the file name must start NNNN_<schema>_ with a known schema`);
      continue;
    }
    problems.push(...schemaNameProblems(relative(ROOT, path), own, readFileSync(path, 'utf8'), architecture));
    scanned += 1;
  }
  const modulesDir = resolve(ROOT, 'src/modules');
  for (const module of existsSync(modulesDir) ? readdirSync(modulesDir) : []) {
    for (const path of filesUnder(join(modulesDir, module, 'infrastructure'), '.ts')) {
      problems.push(...schemaNameProblems(relative(ROOT, path), module, readFileSync(path, 'utf8'), architecture));
      scanned += 1;
    }
  }
  if (problems.length > 0) {
    process.stderr.write(`schema names:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`schema names: ${scanned} files name only their own schema\n`);
}
