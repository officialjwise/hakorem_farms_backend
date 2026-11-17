import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { buildContract, operationsOf } from './build-contract';
import { codeDocument } from './code-document';
import { SEEDED_ROLES_EXTENSION, seededRolesExtension, seededRolesFromMigrations, type SeededRole } from './seeded-roles';
import { emitYaml, type Json } from './yaml-emitter';

export const PLANNED_PATH = resolve(__dirname, '../../contract/planned/openapi.planned.yaml');
export const PUBLISHED_PATH = resolve(__dirname, '../../contract/openapi.yaml');

export function readYaml(path: string): { [key: string]: Json } {
  return parse(readFileSync(path, 'utf8'), { maxAliasCount: -1 }) as { [key: string]: Json };
}

/**
 * The contract text `pnpm contract:generate` writes: the code's operations plus the planned ones, and the seeded role
 * matrix read from the migrations (CR-023). A caller that already holds a migrated database passes its roles.
 */
export async function generateContractText(
  seededRoles?: readonly SeededRole[],
): Promise<{ text: string; fromCode: number; planned: number; roles: number }> {
  const planned = readYaml(PLANNED_PATH);
  const code = await codeDocument();
  const roles = seededRoles ?? (await seededRolesFromMigrations());
  const contract = buildContract(planned, code);
  (contract['components'] as { [key: string]: Json })[SEEDED_ROLES_EXTENSION] = seededRolesExtension(roles);
  const text = emitYaml(contract);
  return { text, fromCode: operationsOf(code).length, planned: operationsOf(planned).length, roles: roles.length };
}

/**
 * `pnpm contract:generate` writes contract/openapi.yaml. With `--check` it writes nothing and exits 1 when the
 * committed file differs from what the code produces, which is the CI drift gate (FR-API-002).
 */
async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const { text, fromCode, planned, roles } = await generateContractText();
  const committed = readFileSync(PUBLISHED_PATH, 'utf8');
  if (check) {
    if (text !== committed) {
      process.stderr.write('contract:generate --check: contract/openapi.yaml differs from the code; run pnpm contract:generate and commit it\n');
      process.exit(1);
    }
    process.stdout.write(`contract:generate --check: up to date (${fromCode} operations from code, ${planned} planned, ${roles} seeded roles)\n`);
    return;
  }
  if (text === committed) {
    process.stdout.write(`contract:generate: unchanged (${fromCode} operations from code, ${planned} planned, ${roles} seeded roles)\n`);
    return;
  }
  writeFileSync(PUBLISHED_PATH, text);
  process.stdout.write(`contract:generate: wrote contract/openapi.yaml (${fromCode} operations from code, ${planned} planned, ${roles} seeded roles)\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`contract:generate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
