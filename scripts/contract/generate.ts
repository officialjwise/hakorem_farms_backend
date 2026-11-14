import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { buildContract, operationsOf } from './build-contract';
import { codeDocument } from './code-document';
import { emitYaml, type Json } from './yaml-emitter';

export const PLANNED_PATH = resolve(__dirname, '../../contract/planned/openapi.planned.yaml');
export const PUBLISHED_PATH = resolve(__dirname, '../../contract/openapi.yaml');

export function readYaml(path: string): { [key: string]: Json } {
  return parse(readFileSync(path, 'utf8'), { maxAliasCount: -1 }) as { [key: string]: Json };
}

/** The contract text `pnpm contract:generate` writes: the code's operations plus the planned ones. */
export async function generateContractText(): Promise<{ text: string; fromCode: number; planned: number }> {
  const planned = readYaml(PLANNED_PATH);
  const code = await codeDocument();
  const text = emitYaml(buildContract(planned, code));
  return { text, fromCode: operationsOf(code).length, planned: operationsOf(planned).length };
}

/**
 * `pnpm contract:generate` writes contract/openapi.yaml. With `--check` it writes nothing and exits 1 when the
 * committed file differs from what the code produces, which is the CI drift gate (FR-API-002).
 */
async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const { text, fromCode, planned } = await generateContractText();
  const committed = readFileSync(PUBLISHED_PATH, 'utf8');
  if (check) {
    if (text !== committed) {
      process.stderr.write('contract:generate --check: contract/openapi.yaml differs from the code; run pnpm contract:generate and commit it\n');
      process.exit(1);
    }
    process.stdout.write(`contract:generate --check: up to date (${fromCode} operations from code, ${planned} planned)\n`);
    return;
  }
  if (text === committed) {
    process.stdout.write(`contract:generate: unchanged (${fromCode} operations from code, ${planned} planned)\n`);
    return;
  }
  writeFileSync(PUBLISHED_PATH, text);
  process.stdout.write(`contract:generate: wrote contract/openapi.yaml (${fromCode} operations from code, ${planned} planned)\n`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(`contract:generate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
