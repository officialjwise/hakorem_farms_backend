import { HTTP_METHODS } from '../../scripts/contract/build-contract';
import type { Json } from '../../scripts/contract/yaml-emitter';

type JsonObject = { [key: string]: Json };

/** Operations by id and every component they reach through `$ref`, transitively: what a client of them depends on. */
export interface ContractClosure {
  readonly operations: { readonly [operationId: string]: Json };
  readonly components: { readonly [ref: string]: Json };
}

/**
 * The part of a contract that the named operations stand on: each operation as written, and each component
 * (`#/components/<kind>/<name>`) reached from them through references, followed until none is new. Two contracts
 * whose closures are equal give those operations' clients exactly the same shapes, examples and texts.
 */
export function closureOf(contract: JsonObject, operationIds: readonly string[]): ContractClosure {
  const operations: { [operationId: string]: Json } = {};
  for (const item of Object.values(contract['paths'] as JsonObject)) {
    for (const [method, operation] of Object.entries((item ?? {}) as JsonObject)) {
      const id = (operation as JsonObject | null)?.['operationId'];
      if ((HTTP_METHODS as readonly string[]).includes(method) && typeof id === 'string' && operationIds.includes(id)) operations[id] = operation;
    }
  }
  const components: { [ref: string]: Json } = {};
  const pending: string[] = [];
  const collect = (node: Json): void => {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node !== null && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string' && !(value in components) && !pending.includes(value)) pending.push(value);
        collect(value);
      }
    }
  };
  collect(operations);
  while (pending.length > 0) {
    const ref = pending.shift()!;
    const [, , kind, name] = ref.split('/');
    const component = ((contract['components'] as JsonObject)[kind!] as JsonObject | undefined)?.[name!];
    if (component === undefined) throw new Error(`the contract has no ${ref}`);
    components[ref] = component;
    collect(component);
  }
  return { operations, components };
}
