import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe('GET /v1/health', () => {
  it('reports the database, Redis, the outbox, dead letters and audit sealing as OK with the version and time checked', async () => {
    const response = await request(api.server).get('/v1/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'OK',
      version: '0.1.0+local',
      checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      checks: [
        { name: 'database', status: 'OK', observed: expect.stringMatching(/^\d+ ms$/), detail: null },
        { name: 'redis', status: 'OK', observed: expect.stringMatching(/^\d+ ms$/), detail: null },
        { name: 'outbox_backlog', status: 'OK', observed: '0', detail: null },
        { name: 'dead_letters', status: 'OK', observed: '0', detail: null },
        { name: 'audit_sealing_lag', status: 'OK', observed: '0.0 s', detail: null },
      ],
    });
  });

  it('answers 503 SERVICE_UNAVAILABLE naming the check that is down, without the driver error', async () => {
    const broken = await startTestApp(database, {
      environment: { DATABASE_URL_APP: database.url('app').replace(/\/\/hk_app:[^@]+@/, '//hk_app:wrong-password@') },
    });
    try {
      const response = await request(broken.server).get('/v1/health');
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
      const message = 'A service this system depends on is not responding.';
      // The three mechanism checks read the database too, so they are down with it.
      expect(response.body.error.details).toEqual(
        ['DATABASE_DOWN', 'OUTBOX_BACKLOG_DOWN', 'DEAD_LETTERS_DOWN', 'AUDIT_SEALING_LAG_DOWN'].map((code) => ({ field: null, code, message })),
      );
      expect(JSON.stringify(response.body)).not.toMatch(/password|hk_app|authentication/i);
      expect(broken.logLines().some((line) => line['msg'] === 'health check failed' && line['check'] === 'database')).toBe(true);
    } finally {
      await broken.close();
    }
  });
});
