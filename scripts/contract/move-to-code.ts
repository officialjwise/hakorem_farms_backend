import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLANNED_PATH, readYaml } from './generate';
import { emitYaml, type Json } from './yaml-emitter';

type JsonObject = { [key: string]: Json };

/**
 * Moves operations from the planned contract into fragments beside their controller (ADR-0031):
 * `tsx scripts/contract/move-to-code.ts <interface/openapi dir> <operationId>...`. The operation is deleted from the
 * planned file in the same change, as buildContract requires. A path left with no operation stays as an empty item,
 * which keeps its place in the published order.
 */
function main(): void {
  const [directory, ...operationIds] = process.argv.slice(2);
  if (directory === undefined || operationIds.length === 0) {
    throw new Error('usage: move-to-code.ts <openapi dir> <operationId>...');
  }
  const planned = readYaml(PLANNED_PATH);
  const paths = planned['paths'] as JsonObject;
  for (const operationId of operationIds) {
    let moved = false;
    for (const item of Object.values(paths) as JsonObject[]) {
      for (const [method, operation] of Object.entries(item)) {
        if ((operation as JsonObject | null)?.['operationId'] === operationId) {
          writeFileSync(join(directory, `${operationId}.yaml`), emitYaml(operation as JsonObject));
          delete item[method];
          moved = true;
        }
      }
    }
    if (!moved) {
      throw new Error(`${operationId} is not in the planned contract`);
    }
  }
  writeFileSync(PLANNED_PATH, emitYaml(planned));
}

main();
