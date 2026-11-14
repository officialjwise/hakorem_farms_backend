import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import type { DynamicModule, Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer, NestFactory } from '@nestjs/core';
import pino from 'pino';
import { parse } from 'yaml';
import { AppModule } from '../../src/app.module';
import { loadConfig } from '../../src/platform/config/app-config';
import { OPERATION_METADATA, type OperationSpec } from '../../src/platform/http/operation';
import type { Json } from './yaml-emitter';

type JsonObject = { [key: string]: Json };

const ROOT = resolve(__dirname, '../..');
/** Where operation fragments live: `<module>/interface/openapi/<operationId>.yaml` and `src/platform/**\/openapi/`. */
export const SOURCE_ROOT = resolve(ROOT, 'src');

/**
 * Configuration for building the module graph without running it. In preview mode NestJS reads controllers and
 * their decorators but instantiates no provider, so nothing connects to these addresses and no key is used.
 */
const PREVIEW_ENVIRONMENT = {
  NODE_ENV: 'development',
  APP_ENV: 'development',
  DATABASE_URL_APP: 'postgres://contract-preview@127.0.0.1:1/contract_preview',
  REDIS_URL: 'redis://127.0.0.1:1/0',
  LOOKUP_HMAC_KEY: Buffer.alloc(32).toString('base64'),
  JWT_ACTIVE_KEY_ID: 'preview',
  JWT_SIGNING_KEYS: '{"preview":"not-a-key"}',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
};

export class OperationFragmentError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`the code's operations do not match their contract fragments:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'OperationFragmentError';
  }
}

interface Route {
  readonly method: string;
  readonly path: string;
  readonly handler: string;
  readonly spec: OperationSpec | undefined;
}

/** Every route of every controller in the graph, with its declared operation. Paths are OpenAPI-style, without /v1. */
function routesOf(container: ModulesContainer): Route[] {
  const routes: Route[] = [];
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const type = wrapper.metatype as (new (...args: never[]) => object) | null;
      if (type === null) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, type) ?? '');
      for (const name of Object.getOwnPropertyNames(type.prototype)) {
        const handler = (type.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!.toLowerCase();
        const joined = [base, String(Reflect.getMetadata(PATH_METADATA, handler))].filter((part) => part !== '' && part !== '/').join('/');
        const path = `/${joined}`.replace(/\/+/g, '/').replace(/:([A-Za-z]+)/g, '{$1}');
        routes.push({ method, path, handler: `${type.name}.${name}`, spec: Reflect.getMetadata(OPERATION_METADATA, handler) as OperationSpec | undefined });
      }
    }
  }
  return routes;
}

function fragmentFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      found.push(...fragmentFiles(path));
    } else if (entry.endsWith('.yaml') && basename(directory) === 'openapi') {
      found.push(path);
    }
  }
  return found;
}

/** Every operation fragment under a directory, by operationId (the file name). */
export function loadFragments(directory: string): Map<string, { readonly file: string; readonly operation: JsonObject }> {
  const fragments = new Map<string, { file: string; operation: JsonObject }>();
  for (const file of fragmentFiles(directory)) {
    const operation = parse(readFileSync(file, 'utf8'), { maxAliasCount: -1 }) as JsonObject;
    fragments.set(basename(file, '.yaml'), { file: relative(ROOT, file), operation });
  }
  return fragments;
}

const REALM_SCHEME = { STAFF: 'staffSession', CUSTOMER: 'customerSession', INVESTOR: 'investorSession' } as const;

function parameterRefs(operation: JsonObject): string[] {
  const parameters = Array.isArray(operation['parameters']) ? operation['parameters'] : [];
  return parameters
    .map((parameter) => (typeof parameter === 'object' && parameter !== null && !Array.isArray(parameter) ? parameter['$ref'] : undefined))
    .filter((ref): ref is string => typeof ref === 'string');
}

function securitySchemes(operation: JsonObject): string[] {
  const security = Array.isArray(operation['security']) ? operation['security'] : [];
  return security.flatMap((requirement) => (typeof requirement === 'object' && requirement !== null && !Array.isArray(requirement) ? Object.keys(requirement) : []));
}

/**
 * The checks that keep a fragment honest about its route (ADR-0031): the fragment is the published description, and
 * the route's @Operation metadata is what the guard enforces, so the two must say the same thing.
 */
function mismatches(route: Route, spec: OperationSpec, fragment: JsonObject, file: string): string[] {
  const problems: string[] = [];
  const where = `${spec.operationId} (${file})`;
  if (fragment['operationId'] !== spec.operationId) {
    problems.push(`${where}: operationId is ${String(fragment['operationId'])}`);
  }
  if ((fragment['x-permission'] ?? null) !== spec.permission) {
    problems.push(`${where}: x-permission is ${String(fragment['x-permission'] ?? null)} but the route checks ${String(spec.permission)}`);
  }
  const refs = parameterRefs(fragment);
  if (refs.includes('#/components/parameters/IdempotencyKey') !== spec.idempotent) {
    problems.push(`${where}: Idempotency-Key is ${spec.idempotent ? 'required by the route but not declared' : 'declared but the route does not take it'}`);
  }
  const csrfRef = spec.acceptsLoginChallenge === true ? '#/components/parameters/CsrfTokenOptional' : '#/components/parameters/CsrfToken';
  const declaresCsrf = refs.includes('#/components/parameters/CsrfToken') || refs.includes('#/components/parameters/CsrfTokenOptional');
  if (spec.csrf !== declaresCsrf || (spec.csrf && !refs.includes(csrfRef))) {
    problems.push(`${where}: the CSRF header should be ${spec.csrf ? csrfRef : 'absent'}`);
  }
  const schemes = securitySchemes(fragment);
  if (spec.access === 'PUBLIC' && schemes.length > 0) {
    problems.push(`${where}: a public route declares security ${schemes.join(', ')}`);
  }
  for (const realm of spec.access === 'SESSION' ? spec.realms : []) {
    if (!schemes.includes(REALM_SCHEME[realm])) {
      problems.push(`${where}: the route accepts ${realm} sessions but security does not list ${REALM_SCHEME[realm]}`);
    }
  }
  if (route.method === 'get' && fragment['requestBody'] !== undefined) {
    problems.push(`${where}: a GET operation declares a request body`);
  }
  return problems;
}

/**
 * The OpenAPI paths of every operation a module graph implements (ADR-0031): the route gives the method and path,
 * its @Operation metadata gives the operationId, and the fragment beside the controller gives the published text.
 * A route without a fragment, a fragment without a route, or a fragment that contradicts its route fails.
 */
export async function documentModule(root: DynamicModule | Type, fragmentsDirectory: string = SOURCE_ROOT): Promise<JsonObject> {
  const app = await NestFactory.create(root, { preview: true, logger: false, abortOnError: false });
  const routes = routesOf(app.get(ModulesContainer));
  await app.close();
  const fragments = loadFragments(fragmentsDirectory);
  const problems: string[] = [];
  const paths: { [path: string]: JsonObject } = {};
  const used = new Set<string>();
  for (const route of routes) {
    if (route.spec === undefined) {
      problems.push(`${route.handler} (${route.method.toUpperCase()} ${route.path}) declares no @Operation`);
      continue;
    }
    const fragment = fragments.get(route.spec.operationId);
    if (fragment === undefined) {
      problems.push(`${route.spec.operationId} has no fragment openapi/${route.spec.operationId}.yaml beside its controller`);
      continue;
    }
    problems.push(...mismatches(route, route.spec, fragment.operation, fragment.file));
    used.add(route.spec.operationId);
    paths[route.path] = { ...(paths[route.path] ?? {}), [route.method]: fragment.operation };
  }
  for (const [operationId, fragment] of fragments) {
    if (!used.has(operationId)) {
      problems.push(`${fragment.file} describes ${operationId}, which no route implements`);
    }
  }
  if (problems.length > 0) {
    throw new OperationFragmentError(problems);
  }
  return { paths };
}

/** The OpenAPI document of the application's own operations. */
export async function codeDocument(): Promise<JsonObject> {
  const config = loadConfig(PREVIEW_ENVIRONMENT, '0.0.0');
  return documentModule(AppModule.forRoot(config, pino({ level: 'silent' })));
}
