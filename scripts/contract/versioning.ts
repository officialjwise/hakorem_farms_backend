import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { HTTP_METHODS } from './build-contract';
import type { Json } from './yaml-emitter';

type JsonObject = { [key: string]: Json };

function obj(value: Json | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function strings(value: Json | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function versionOf(document: JsonObject): [number, number, number] {
  const text = String(obj(document['info'])['version'] ?? '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (match === null) {
    throw new Error(`info.version "${text}" is not MAJOR.MINOR.PATCH`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Changes a client generated from the old contract cannot survive (docs/API.md section 1): a removed operation or
 * schema, a removed property, a property that became required, a removed enumeration value, or a changed type.
 */
export function breakingChanges(previous: JsonObject, next: JsonObject): string[] {
  const found: string[] = [];
  for (const [path, item] of Object.entries(obj(previous['paths']))) {
    for (const method of Object.keys(obj(item))) {
      if ((HTTP_METHODS as readonly string[]).includes(method) && obj(obj(next['paths'])[path])[method] === undefined) {
        found.push(`operation ${method.toUpperCase()} ${path} was removed`);
      }
    }
  }
  const nextSchemas = obj(obj(next['components'])['schemas']);
  for (const [name, schemaValue] of Object.entries(obj(obj(previous['components'])['schemas']))) {
    const before = obj(schemaValue);
    const after = nextSchemas[name];
    if (after === undefined) {
      found.push(`schema ${name} was removed`);
      continue;
    }
    const afterObj = obj(after);
    if (!isDeepStrictEqual(before['type'], afterObj['type'])) {
      found.push(`schema ${name} changed type`);
    }
    for (const property of Object.keys(obj(before['properties']))) {
      if (obj(afterObj['properties'])[property] === undefined) {
        found.push(`schema ${name} lost property ${property}`);
      }
    }
    const wasRequired = new Set(strings(before['required']));
    for (const property of strings(afterObj['required'])) {
      if (!wasRequired.has(property)) {
        found.push(`schema ${name} now requires ${property}`);
      }
    }
    const nextEnum = new Set(strings(afterObj['enum']));
    for (const value of strings(before['enum'])) {
      if (!nextEnum.has(value)) {
        found.push(`schema ${name} lost enumeration value ${value}`);
      }
    }
  }
  return found;
}

/**
 * FR-API-001: a breaking change needs a new major version; any other change needs at least a new version.
 * Returns the problems; an empty list is a pass.
 */
export function versioningProblems(previous: JsonObject, next: JsonObject): string[] {
  const [prevMajor, prevMinor, prevPatch] = versionOf(previous);
  const [nextMajor, nextMinor, nextPatch] = versionOf(next);
  const withoutVersion = (document: JsonObject) => ({ ...document, info: { ...obj(document['info']), version: '' } });
  const changed = !isDeepStrictEqual(withoutVersion(previous), withoutVersion(next));
  const bumped = nextMajor > prevMajor || (nextMajor === prevMajor && (nextMinor > prevMinor || (nextMinor === prevMinor && nextPatch > prevPatch)));
  const problems: string[] = [];
  if (changed && !bumped) {
    problems.push(`the contract changed but info.version stayed ${prevMajor}.${prevMinor}.${prevPatch}`);
  }
  const breaking = breakingChanges(previous, next);
  if (breaking.length > 0 && nextMajor <= prevMajor) {
    problems.push(`breaking changes need a new major version (still ${nextMajor}.x): ${breaking.join('; ')}`);
  }
  return problems;
}

/** `tsx scripts/contract/versioning.ts <previous.yaml> <next.yaml>`: the CI check against the base branch. */
if (require.main === module) {
  const [previousPath, nextPath] = process.argv.slice(2);
  if (previousPath === undefined || nextPath === undefined) {
    process.stderr.write('usage: versioning.ts <previous.yaml> <next.yaml>\n');
    process.exit(2);
  }
  const read = (path: string) => parse(readFileSync(path, 'utf8'), { maxAliasCount: -1 }) as JsonObject;
  const problems = versioningProblems(read(previousPath), read(nextPath));
  if (problems.length > 0) {
    process.stderr.write(`contract versioning: ${problems.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write('contract versioning: ok\n');
}
