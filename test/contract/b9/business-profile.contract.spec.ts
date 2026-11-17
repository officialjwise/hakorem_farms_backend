import { randomUUID } from 'node:crypto';
import { ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLISHED_PATH, readYaml } from '../../../scripts/contract/generate';
import { SHOP_PROFILE_KEYS } from '../../../src/modules/aud/domain/business-profile';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { seedUnits } from '../../../src/seed/seed-units';
import { contractSchema } from '../../support/contract-schemas';
import { consoleGet, createUser, enrolAndLogin, relaxRateLimits, testStartTime, type TestSession } from '../../support/iam';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * B09x continued's responses against the committed contract (FR-AUD-008, CR-028): the business profile and the shop's
 * contact details in their shapes, the shop's shape holding exactly the keys the code hands out, and the 404 before a
 * profile is set in the error envelope.
 */
let database: TestDatabase;
let api: TestApp;
let clock: ManualClock;
let manager: TestSession;

function conforms(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

type JsonObject = Record<string, unknown>;
const schemaOf = (name: string) => ((readYaml(PUBLISHED_PATH)['components'] as JsonObject)['schemas'] as JsonObject)[name] as JsonObject;

beforeAll(async () => {
  database = await createTestDatabase();
  clock = new ManualClock(testStartTime());
  await relaxRateLimits(database);
  api = await startTestApp(database, { clock });
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('the business profile in the contract (FR-AUD-008, CR-028)', () => {
  it('answers the shop 404 in the error envelope before any profile is set', async () => {
    const missing = await request(api.server).get('/v1/shop/profile');
    expect(missing.status).toBe(404);
    conforms('Error', missing.body);
  });

  it('publishes the shop profile with exactly the keys the code hands out, all required, nothing else allowed', () => {
    const shop = schemaOf('ShopProfile');
    expect(Object.keys(shop['properties'] as JsonObject)).toEqual([...SHOP_PROFILE_KEYS]);
    expect(shop['required']).toEqual([...SHOP_PROFILE_KEYS]);
    expect(shop['additionalProperties']).toBe(false);
    expect(Object.keys(shop['properties'] as JsonObject).join(' ')).not.toMatch(/tin|vat|email|legal|logo|bank|staff/i);
  });

  it('answers the seeded profile to the console and the shop in their shapes', async () => {
    await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
    const branchId = (await database.pool('admin').query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
    manager = await enrolAndLogin(api.server, await createUser(database, { name: 'Akosua Boateng', grants: [{ role: 'MANAGER', branchId }] }), () => clock.now());
    const profile = await consoleGet(api.server, manager, '/v1/admin/business-profile');
    expect(profile.status).toBe(200);
    conforms('BusinessProfile', profile.body);
    const shop = await request(api.server).get('/v1/shop/profile');
    expect(shop.status).toBe(200);
    conforms('ShopProfile', shop.body);
    expect(shop.headers['cache-control']).toBe('public, max-age=300');
  });
});
