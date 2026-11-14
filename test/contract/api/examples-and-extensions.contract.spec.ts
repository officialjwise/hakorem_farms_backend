import { describe, expect, it } from 'vitest';
import { HTTP_METHODS } from '../../../scripts/contract/build-contract';
import { PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import type { Json } from '../../../scripts/contract/yaml-emitter';

type JsonObject = { [key: string]: Json };
const contract = readYaml(PUBLISHED_PATH);

function operations(): Array<{ readonly where: string; readonly operation: JsonObject }> {
  const found: Array<{ readonly where: string; readonly operation: JsonObject }> = [];
  for (const [path, item] of Object.entries(contract['paths'] as JsonObject)) {
    for (const [method, operation] of Object.entries((item ?? {}) as JsonObject)) {
      if ((HTTP_METHODS as readonly string[]).includes(method)) {
        found.push({ where: `${method.toUpperCase()} ${path}`, operation: operation as JsonObject });
      }
    }
  }
  return found;
}

/** Every array under `node` whose rows carry ids that repeat, with where it is. */
function repeatedIds(node: Json, where: string, found: string[]): string[] {
  if (Array.isArray(node)) {
    const ids = node.flatMap((row) => (row !== null && typeof row === 'object' && !Array.isArray(row) && typeof row['id'] === 'string' ? [row['id']] : []));
    if (new Set(ids).size !== ids.length) {
      found.push(where);
    }
    node.forEach((row, index) => repeatedIds(row, `${where}[${index}]`, found));
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      repeatedIds(value, `${where}/${key}`, found);
    }
  }
  return found;
}

describe('response examples (CR-008)', () => {
  it('never repeat a row id, because the mock server serves an example as the answer', () => {
    const problems = operations().flatMap(({ where, operation }) => repeatedIds(operation['responses'] ?? null, where, []));
    expect(problems).toEqual([]);
  });
});

describe('x-requires-step-up (CR-007)', () => {
  it('is true exactly on the operations whose description says they require step-up', () => {
    const problems = operations().flatMap(({ where, operation }) => {
      const prose = typeof operation['description'] === 'string' && operation['description'].includes('Requires step-up');
      const marked = operation['x-requires-step-up'] === true;
      const valid = operation['x-requires-step-up'] === undefined || operation['x-requires-step-up'] === true;
      return prose === marked && valid ? [] : [`${where}: description ${prose ? 'says' : 'does not say'} step-up, x-requires-step-up is ${String(operation['x-requires-step-up'])}`];
    });
    expect(problems).toEqual([]);
    expect(operations().filter(({ operation }) => operation['x-requires-step-up'] === true).length).toBeGreaterThan(0);
  });
});
