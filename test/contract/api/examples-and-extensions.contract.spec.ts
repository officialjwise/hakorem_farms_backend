import { Resvg } from '@resvg/resvg-js';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { HTTP_METHODS } from '../../../scripts/contract/build-contract';
import { PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { EMPTY_EXAMPLE } from '../../../scripts/contract/empty-examples';
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

const components = contract['components'] as JsonObject;

function follow(node: Json | undefined): JsonObject | undefined {
  let current = node;
  while (current !== null && typeof current === 'object' && !Array.isArray(current) && typeof current['$ref'] === 'string') {
    const [, , kind, name] = current['$ref'].split('/');
    current = (components[kind!] as JsonObject | undefined)?.[name!];
  }
  return current !== null && typeof current === 'object' && !Array.isArray(current) ? current : undefined;
}

/** The properties a schema declares, through `allOf` and references. */
function propertiesOf(node: Json | undefined): JsonObject {
  const schema = follow(node);
  if (schema === undefined) return {};
  let found: JsonObject = { ...((schema['properties'] as JsonObject | undefined) ?? {}) };
  for (const part of (schema['allOf'] as Json[] | undefined) ?? []) found = { ...found, ...propertiesOf(part) };
  return found;
}

/** Every GET whose 2xx JSON answer is a page of rows by its schema (`data` and `page`), whatever its example says. */
function listAnswers(): Array<{ readonly where: string; readonly operation: JsonObject; readonly media: JsonObject }> {
  const found: Array<{ readonly where: string; readonly operation: JsonObject; readonly media: JsonObject }> = [];
  for (const { where, operation } of operations()) {
    if (!where.startsWith('GET ')) continue;
    for (const [status, raw] of Object.entries((operation['responses'] ?? {}) as JsonObject)) {
      const media = ((follow(raw)?.['content'] as JsonObject | undefined)?.['application/json'] ?? undefined) as JsonObject | undefined;
      const properties = propertiesOf(media?.['schema']);
      if (status.startsWith('2') && media !== undefined && properties['data'] !== undefined && properties['page'] !== undefined) {
        found.push({ where: `${where} ${status} (${String(operation['operationId'])})`, operation, media });
      }
    }
  }
  return found;
}

function defaultLimitOf(operation: JsonObject): number | undefined {
  for (const raw of (operation['parameters'] as Json[] | undefined) ?? []) {
    const parameter = follow(raw);
    if (parameter?.['name'] === 'limit' && parameter['in'] === 'query') return follow(parameter['schema'])?.['default'] as number | undefined;
  }
  return undefined;
}

describe('named empty examples on every list (CR-005)', () => {
  it('finds the lists by their schema, from code and planned alike', () => {
    expect(listAnswers().length).toBeGreaterThanOrEqual(160);
  });

  it('gives every list a named empty example beside a populated one, with no rows, no next page and the default limit', () => {
    const problems = listAnswers().flatMap(({ where, operation, media }) => {
      const examples = media['examples'] as JsonObject | undefined;
      if (media['example'] !== undefined) return [`${where}: a single example, not a named map`];
      if (examples === undefined) return [`${where}: no examples`];
      const empty = (examples[EMPTY_EXAMPLE] as JsonObject | undefined)?.['value'] as JsonObject | undefined;
      if (empty === undefined) return [`${where}: no ${EMPTY_EXAMPLE} example`];
      const populated = Object.entries(examples).filter(([name, example]) => name !== EMPTY_EXAMPLE && ((example as JsonObject)['value'] as JsonObject | undefined)?.['data'] !== undefined);
      const rows = populated.map(([, example]) => (((example as JsonObject)['value'] as JsonObject)['data'] as Json[]).length);
      const problemsHere: string[] = [];
      if (populated.length === 0 || rows.every((count) => count === 0)) problemsHere.push(`${where}: no populated example beside ${EMPTY_EXAMPLE}`);
      const limit = defaultLimitOf(operation) ?? ((populated[0]?.[1] as JsonObject | undefined)?.['value'] as { page?: { limit?: number } } | undefined)?.page?.limit;
      const expected = { nextCursor: null, limit, hasMore: false };
      if (JSON.stringify(empty['data']) !== '[]') problemsHere.push(`${where}: ${EMPTY_EXAMPLE} has rows`);
      if (JSON.stringify(empty['page']) !== JSON.stringify(expected)) problemsHere.push(`${where}: ${EMPTY_EXAMPLE} page is ${JSON.stringify(empty['page'])}, not ${JSON.stringify(expected)}`);
      return problemsHere;
    });
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

describe('the TotpEnrolment example (CR-006)', () => {
  it('carries a QR code that an independent renderer and decoder read back as exactly its otpauthUri', () => {
    const operation = operations().find(({ operation: o }) => o['operationId'] === 'startTotpEnrolment')!.operation;
    const example = (((operation['responses'] as JsonObject)['200'] as JsonObject)['content'] as JsonObject)['application/json'] as JsonObject;
    const { otpauthUri, qrCodeDataUri } = example['example'] as { otpauthUri: string; qrCodeDataUri: string };
    const svg = Buffer.from(qrCodeDataUri.replace(/^data:image\/svg\+xml;base64,/, ''), 'base64').toString('utf8');
    const image = new Resvg(svg, { fitTo: { mode: 'width', value: 600 }, background: 'white', font: { loadSystemFonts: false } }).render();
    expect(jsQR(new Uint8ClampedArray(image.pixels), image.width, image.height)?.data).toBe(otpauthUri);
  });
});
