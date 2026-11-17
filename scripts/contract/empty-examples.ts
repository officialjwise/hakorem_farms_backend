import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HTTP_METHODS } from './build-contract';
import { loadFragments, SOURCE_ROOT } from './code-document';
import { PLANNED_PATH, PUBLISHED_PATH, readYaml } from './generate';
import { emitYaml, type Json } from './yaml-emitter';

type JsonObject = { [key: string]: Json };

/** The name of the example a mock client asks for with `Prefer: example=empty` (CR-005). */
export const EMPTY_EXAMPLE = 'empty';
export const EMPTY_SUMMARY = 'Nothing matches: no rows and no next page';

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list's example: an object whose rows are an array under `data`, with a `page` object. */
export function isListExample(value: Json | undefined): value is JsonObject {
  return isObject(value) && Array.isArray(value['data']) && isObject(value['page']);
}

/** A decimal string such as "4200.0000" or "30.40", written as zero at the same scale. */
const DECIMAL = /^-?\d+\.(\d+)$/;

/** A figure beside the rows, as it reads when nothing matches: numbers 0, decimals zero, lists empty, words kept. */
function zeroed(value: Json): Json {
  if (typeof value === 'number') return 0;
  if (typeof value === 'string') {
    const decimal = DECIMAL.exec(value);
    return decimal === null ? value : `0.${'0'.repeat(decimal[1]!.length)}`;
  }
  if (Array.isArray(value)) return [];
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, zeroed(inner)]));
  return value;
}

/** The empty answer of a list whose populated example is `example`: no rows, no next page, the default limit. */
export function emptyOf(example: JsonObject, limit: number): JsonObject {
  const empty: JsonObject = {};
  for (const [key, value] of Object.entries(example)) {
    if (key === 'data') empty[key] = [];
    else if (key === 'page') empty[key] = { nextCursor: null, limit, hasMore: false };
    else empty[key] = zeroed(value);
  }
  return empty;
}

function follow(ref: Json | undefined, components: JsonObject): JsonObject | undefined {
  if (!isObject(ref)) return undefined;
  const target = ref['$ref'];
  if (typeof target !== 'string') return ref;
  const [, , kind, name] = target.split('/');
  const found = (components[kind!] as JsonObject | undefined)?.[name!];
  return follow(found, components);
}

/** The default of the operation's `limit` query parameter, following references into the components. */
function defaultLimit(operation: JsonObject, components: JsonObject): number | undefined {
  const parameters = Array.isArray(operation['parameters']) ? operation['parameters'] : [];
  for (const raw of parameters) {
    const parameter = follow(raw, components);
    if (parameter?.['name'] === 'limit' && parameter['in'] === 'query') {
      const value = follow(parameter['schema'], components)?.['default'];
      return typeof value === 'number' ? value : undefined;
    }
  }
  return undefined;
}

/**
 * The operation with a named `empty` example beside its populated one on every 2xx JSON list answer (CR-005): a single
 * `example` moves under `default`; an operation that already names its examples keeps them and gains `empty`, built
 * from the first. Only a GET is a list; anything else is returned unchanged, and so is an operation already done.
 */
export function withEmptyExample(method: string, operation: JsonObject, components: JsonObject): JsonObject {
  if (method !== 'get' || !isObject(operation['responses'])) return operation;
  const result = structuredClone(operation);
  for (const [status, response] of Object.entries(result['responses'] as JsonObject)) {
    if (!status.startsWith('2') || !isObject(response) || !isObject(response['content'])) continue;
    const media = response['content']['application/json'];
    if (!isObject(media)) continue;
    const named = isObject(media['examples']) ? media['examples'] : undefined;
    const populated = named === undefined ? media['example'] : (Object.values(named)[0] as JsonObject | undefined)?.['value'];
    if (!isListExample(populated) || named?.[EMPTY_EXAMPLE] !== undefined) continue;
    const limit = defaultLimit(result, components) ?? (populated['page'] as JsonObject)['limit'];
    const empty = { summary: EMPTY_SUMMARY, value: emptyOf(populated, typeof limit === 'number' ? limit : 25) };
    const rebuilt: JsonObject = {};
    for (const [key, value] of Object.entries(media)) {
      if (key === 'example') continue;
      if (key !== 'examples') rebuilt[key] = value;
    }
    rebuilt['examples'] = named === undefined ? { default: { value: populated }, [EMPTY_EXAMPLE]: empty } : { ...named, [EMPTY_EXAMPLE]: empty };
    response['content']['application/json'] = rebuilt;
  }
  return result;
}

/**
 * The one scripted pass (CR-005): `tsx scripts/contract/empty-examples.ts` rewrites every operation fragment under
 * `src/` and every planned operation whose list answer has no `empty` example yet, then `pnpm contract:generate`
 * publishes them. The contract test `examples-and-extensions` keeps every list with its `empty` from then on.
 */
function main(): void {
  const planned = readYaml(PLANNED_PATH);
  const components = planned['components'] as JsonObject;
  // A fragment holds no method; the published contract says which method each operationId answers.
  const methods = new Map<string, string>();
  for (const item of Object.values(readYaml(PUBLISHED_PATH)['paths'] as JsonObject)) {
    for (const [method, operation] of Object.entries(isObject(item) ? item : {})) {
      if (isObject(operation) && typeof operation['operationId'] === 'string') methods.set(operation['operationId'], method);
    }
  }
  let changed = 0;
  for (const [operationId, { file, operation }] of loadFragments(SOURCE_ROOT)) {
    const path = resolve(__dirname, '../..', file);
    const next = withEmptyExample(methods.get(operationId) ?? 'unknown', operation, components);
    if (JSON.stringify(next) !== JSON.stringify(operation)) {
      writeFileSync(path, emitYaml(next));
      changed += 1;
    }
  }
  for (const item of Object.values(planned['paths'] as JsonObject)) {
    if (!isObject(item)) continue;
    for (const method of Object.keys(item)) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
      const next = withEmptyExample(method, item[method] as JsonObject, components);
      if (JSON.stringify(next) !== JSON.stringify(item[method])) {
        item[method] = next;
        changed += 1;
      }
    }
  }
  const text = emitYaml(planned);
  if (text !== readFileSync(PLANNED_PATH, 'utf8')) writeFileSync(PLANNED_PATH, text);
  process.stdout.write(`empty-examples: ${changed} list operations given an empty example\n`);
}

if (require.main === module) {
  main();
}
