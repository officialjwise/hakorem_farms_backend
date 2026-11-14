import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

/** Casting through the domain applies its CHECK exactly as a column of that domain would. */
async function accepts(domain: string, literal: string): Promise<boolean> {
  return database
    .pool('app')
    .query(`SELECT ${literal}::${domain}`)
    .then(
      () => true,
      (error: unknown) => {
        if ((error as { code?: string }).code === '23514') {
          return false;
        }
        throw error;
      },
    );
}

describe('value domains (ADR-0001, docs/data-model/platform.md)', () => {
  it('the platform.pesewas domain rejects negative and oversize values', async () => {
    expect(await accepts('platform.pesewas', '(-1)')).toBe(false);
    expect(await accepts('platform.pesewas', '9007199254740992')).toBe(false);
    expect(await accepts('platform.pesewas', '0')).toBe(true);
    expect(await accepts('platform.pesewas', '9007199254740991')).toBe(true);
  });

  it('the platform.pesewas domain refuses a fraction of a pesewa', async () => {
    // A bigint domain cannot hold 0.5; PostgreSQL rounds a numeric cast, so the test uses the text form.
    const failure = await database
      .pool('app')
      .query("SELECT '0.5'::platform.pesewas")
      .then(() => undefined, (error: unknown) => (error as { code?: string }).code);
    expect(failure).toBe('22P02');
  });

  it('the platform.kg domain holds three decimal places and refuses a negative weight', async () => {
    expect(await accepts('platform.kg', '(-0.001)')).toBe(false);
    expect(await accepts('platform.kg', '9999999.999')).toBe(true);
    const { rows } = await database.pool('app').query<{ kg: string }>("SELECT '31.2496'::platform.kg::text AS kg");
    // NUMERIC(10,3) rounds half away from zero at the cast; the kernel rounds the scale reading before it gets here.
    expect(rows[0]?.kg).toBe('31.250');
  });

  it('the platform.qty domain refuses a negative quantity', async () => {
    expect(await accepts('platform.qty', '(-1)')).toBe(false);
    expect(await accepts('platform.qty', '99999999999.999')).toBe(true);
  });

  it('the platform.percent domain holds 0 to 100', async () => {
    expect(await accepts('platform.percent', '(-0.0001)')).toBe(false);
    expect(await accepts('platform.percent', '100.0001')).toBe(false);
    expect(await accepts('platform.percent', '2.5')).toBe(true);
    expect(await accepts('platform.percent', '100')).toBe(true);
  });
});
