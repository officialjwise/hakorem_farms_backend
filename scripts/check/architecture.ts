import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Architecture {
  readonly layers: Readonly<Record<string, number>>;
  readonly platformLayer: number;
  readonly publishedKeys: Readonly<Record<string, readonly string[]>>;
  readonly universalKeys: readonly string[];
  readonly platformSharedObjects: readonly string[];
  readonly publishedViewReaders: readonly string[];
}

/** tooling/architecture.json: the module layers and published keys of docs/MODULE_BOUNDARIES.md. */
export function readArchitecture(): Architecture {
  return JSON.parse(readFileSync(resolve(__dirname, '../../tooling/architecture.json'), 'utf8')) as Architecture;
}

/** The layer of a schema: `platform`, or a module code. Undefined for anything else. */
export function layerOf(architecture: Architecture, schema: string): number | undefined {
  return schema === 'platform' ? architecture.platformLayer : architecture.layers[schema];
}

/** Schemas that hold application data: platform and one per module. */
export function applicationSchemas(architecture: Architecture): string[] {
  return ['platform', ...Object.keys(architecture.layers)];
}
