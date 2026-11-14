import { describe, expect, it } from 'vitest';
import { PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { versioningProblems } from '../../../scripts/contract/versioning';
import type { Json } from '../../../scripts/contract/yaml-emitter';

type JsonObject = { [key: string]: Json };

function committed(): JsonObject {
  return readYaml(PUBLISHED_PATH);
}

function schema(document: JsonObject, name: string): JsonObject {
  return ((document['components'] as JsonObject)['schemas'] as JsonObject)[name] as JsonObject;
}

function withVersion(document: JsonObject, version: string): JsonObject {
  return { ...document, info: { ...(document['info'] as JsonObject), version } };
}

describe('contract versioning (FR-API-001)', () => {
  it('fails on an unversioned breaking change', () => {
    const previous = committed();
    const next = structuredClone(previous);
    // Remove a required response field from Health without a version bump.
    delete (schema(next, 'Health')['properties'] as JsonObject)['version'];
    expect(versioningProblems(previous, next)).toEqual([
      'the contract changed but info.version stayed 1.1.0',
      'breaking changes need a new major version (still 1.x): schema Health lost property version',
    ]);
  });

  it('fails on a breaking change that bumps only the minor version', () => {
    const previous = committed();
    const next = withVersion(structuredClone(previous), '1.2.0');
    (schema(next, 'HealthCheck')['required'] as string[]).push('since');
    expect(versioningProblems(previous, next)).toEqual([
      'breaking changes need a new major version (still 1.x): schema HealthCheck now requires since',
    ]);
  });

  it('passes a breaking change with a new major version', () => {
    const previous = committed();
    const next = withVersion(structuredClone(previous), '2.0.0');
    delete (schema(next, 'Health')['properties'] as JsonObject)['version'];
    expect(versioningProblems(previous, next)).toEqual([]);
  });

  it('passes an additive change with a new minor version, and fails it without one', () => {
    const previous = committed();
    const additive = structuredClone(previous);
    (schema(additive, 'Health')['properties'] as JsonObject)['region'] = { type: 'string' };
    expect(versioningProblems(previous, withVersion(additive, '1.2.0'))).toEqual([]);
    expect(versioningProblems(previous, additive)).toEqual(['the contract changed but info.version stayed 1.1.0']);
  });

  it('passes an unchanged contract', () => {
    expect(versioningProblems(committed(), committed())).toEqual([]);
  });
});
