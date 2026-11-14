import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HTTP_METHODS } from '../../../scripts/contract/build-contract';
import { PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import type { Json } from '../../../scripts/contract/yaml-emitter';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

type JsonObject = { [key: string]: Json };
let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

describe('x-requires-step-up agrees with iam.permission (CR-007)', () => {
  it('marks an operation exactly when the seeded permission it checks requires step-up', async () => {
    const { rows } = await database.pool('admin').query<{ code: string; requires_step_up: boolean }>('SELECT code, requires_step_up FROM iam.permission');
    const seeded = new Map(rows.map((row) => [row.code, row.requires_step_up]));
    const problems: string[] = [];
    let checked = 0;
    for (const [path, item] of Object.entries(readYaml(PUBLISHED_PATH)['paths'] as JsonObject)) {
      for (const [method, value] of Object.entries((item ?? {}) as JsonObject)) {
        const operation = value as JsonObject;
        const permission = operation['x-permission'];
        if (!(HTTP_METHODS as readonly string[]).includes(method) || typeof permission !== 'string' || !seeded.has(permission)) {
          continue; // a permission later sessions seed is checked once it exists
        }
        checked += 1;
        if ((operation['x-requires-step-up'] === true) !== seeded.get(permission)) {
          problems.push(`${method.toUpperCase()} ${path} checks ${permission} (requires_step_up ${String(seeded.get(permission))}) but x-requires-step-up is ${String(operation['x-requires-step-up'])}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(17);
  });
});
