import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contractSchema } from '../../support/contract-schemas';
import { customerCsv, get, importFile, post, refreshAll, startImportWorld, stepUp, type ImportWorld } from '../../support/imports';

/** Imports and exports answer in the shapes of contract 1.14.0 (ImportJob, ImportJobPage, ImportRowErrorPage, Error). */
let world: ImportWorld;

function expectShape(schema: string, body: unknown): void {
  const validate = contractSchema(schema);
  expect(validate(body), `${schema}: ${JSON.stringify(validate.errors)}`).toBe(true);
}

beforeAll(async () => {
  world = await startImportWorld();
}, 120_000);

afterAll(async () => {
  await world.api.close();
  await world.database.drop();
});

describe('import and export shapes (contract 1.14.0)', () => {
  it('answers every import and export operation in its contract shape', async () => {
    const fileId = await importFile(world, customerCsv(3, 7_000, { 1: { tier: 'VIP' } }), 'customers.csv');
    const created = await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId });
    expect(created.status).toBe(202);
    expectShape('ImportJob', created.body);
    const id = created.body.id as string;
    expectShape('ImportJob', (await get(world, world.manager, `/imports/${id}`)).body);
    expectShape('ImportJobPage', (await get(world, world.manager, '/imports')).body);
    const errors = await get(world, world.manager, `/imports/${id}/errors`);
    expectShape('ImportRowErrorPage', errors.body);
    expect(errors.body.data).toHaveLength(1);
    const refused = await post(world, world.manager, `/imports/${id}/apply`);
    expect(refused.status).toBe(422);
    expectShape('Error', refused.body);
    const cancelled = await post(world, world.manager, `/imports/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expectShape('ImportJob', cancelled.body);

    const good = await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId: await importFile(world, customerCsv(3, 7_100), 'good.csv') });
    const applied = await post(world, world.manager, `/imports/${good.body.id as string}/apply`);
    expect(applied.status).toBe(202);
    expectShape('ImportJob', applied.body);

    // The step-up of the first sign-in goes stale after five minutes.
    world.clock.advanceBy(6 * 60 * 1_000);
    await refreshAll(world);
    const stale = await post(world, world.manager, '/exports', { entity: 'CUSTOMER', format: 'CSV' });
    expect(stale.status).toBe(403);
    expectShape('Error', stale.body);
    await stepUp(world, world.manager);
    const exported = await post(world, world.manager, '/exports', { entity: 'CUSTOMER', format: 'XLSX' });
    expect(exported.status).toBe(202);
    expectShape('ImportJob', exported.body);
  });
});
