import { isDeepStrictEqual } from 'node:util';
import type { Json } from './yaml-emitter';

type JsonObject = { [key: string]: Json };

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export class ContractMergeError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the contract cannot be generated:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ContractMergeError';
  }
}

function asObject(value: Json | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

/**
 * Builds the published contract (ADR-0030, FR-API-002): every operation and schema the code documents, plus
 * every operation still waiting in the planned contract that B1 wrote by hand. An operation is in exactly one
 * of the two: when a session implements it, it deletes it from the planned file in the same change. Info,
 * servers, security schemes and the version come from the planned file until the code owns them.
 */
export function buildContract(planned: JsonObject, code: JsonObject): JsonObject {
  const problems: string[] = [];
  const result = structuredClone(planned);
  const resultPaths = asObject(result['paths']);
  result['paths'] = resultPaths;

  for (const [path, item] of Object.entries(asObject(code['paths']))) {
    const target = asObject(resultPaths[path]);
    const mixed = Object.keys(target).some((key) => (HTTP_METHODS as readonly string[]).includes(key));
    for (const [method, operation] of Object.entries(asObject(item))) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) {
        continue;
      }
      if (target[method] !== undefined) {
        problems.push(`${method.toUpperCase()} ${path} is in the code and still in the planned contract; delete it from the planned file`);
        continue;
      }
      target[method] = operation;
    }
    // A path whose operations are split between the code and the planned file keeps the usual method order, so an
    // operation moving into code does not reorder the published file. A planned path whose operations have all
    // moved stays in the planned file as an empty item, which keeps its place in the published order.
    resultPaths[path] = mixed ? withMethodsInOrder(target) : target;
  }

  const resultComponents = asObject(result['components']);
  const resultSchemas = asObject(resultComponents['schemas']);
  for (const [name, schema] of Object.entries(asObject(asObject(code['components'])['schemas']))) {
    const existing = resultSchemas[name];
    if (existing !== undefined && !isDeepStrictEqual(existing, schema)) {
      problems.push(`schema ${name} differs between the code and the planned contract`);
      continue;
    }
    resultSchemas[name] = schema;
  }
  if (Object.keys(resultSchemas).length > 0) {
    resultComponents['schemas'] = resultSchemas;
    result['components'] = resultComponents;
  }

  if (problems.length > 0) {
    throw new ContractMergeError(problems);
  }
  return result;
}

function withMethodsInOrder(item: JsonObject): JsonObject {
  const ordered: JsonObject = {};
  for (const key of Object.keys(item).filter((k) => !(HTTP_METHODS as readonly string[]).includes(k))) {
    ordered[key] = item[key]!;
  }
  for (const method of HTTP_METHODS) {
    if (item[method] !== undefined) {
      ordered[method] = item[method]!;
    }
  }
  return ordered;
}

/** The operations of a document, as `METHOD /path`, for reports and checks. */
export function operationsOf(document: JsonObject): string[] {
  const operations: string[] = [];
  for (const [path, item] of Object.entries(asObject(document['paths']))) {
    for (const method of Object.keys(asObject(item))) {
      if ((HTTP_METHODS as readonly string[]).includes(method)) {
        operations.push(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return operations;
}
