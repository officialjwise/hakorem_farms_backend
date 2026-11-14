import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSchema } from '../../support/contract-schemas';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';
import { startTestApp, type TestApp } from '../../support/test-app';

let database: TestDatabase;
let api: TestApp;

beforeAll(async () => {
  database = await createTestDatabase();
  api = await startTestApp(database);
});

afterAll(async () => {
  await api.close();
  await database.drop();
});

describe('getHealth against contract/openapi.yaml', () => {
  it("responds with the contract's Health shape and a correlation id header", async () => {
    const response = await request(api.server).get('/v1/health');
    expect(response.status).toBe(200);
    expect(response.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    const validate = contractSchema('Health');
    expect(validate(response.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it("answers an unknown path with the contract's Error envelope", async () => {
    const response = await request(api.server).get('/v1/no-such-route');
    const validate = contractSchema('Error');
    expect(validate(response.body), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects a body that breaks the Health schema, so the check has teeth', () => {
    const validate = contractSchema('Health');
    expect(validate({ status: 'FINE', version: '1', checkedAt: 'yesterday', checks: [] })).toBe(false);
  });
});
