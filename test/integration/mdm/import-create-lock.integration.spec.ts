import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { count, customerCsv, importFile, post, refreshAll, startImportWorld, type ImportWorld } from '../../support/imports';

/**
 * An import that creates customers or suppliers queues on the same advisory lock createCustomer and createSupplier take
 * (PR #102, `CUSTOMER_CREATE_LOCK`, `SUPPLIER_CREATE_LOCK`; the owner, 2026-11-17, B09u item 8): every create reads what
 * every other create writes, so an import applied beside creates would abort them, or be aborted, and retry. With the
 * lock they run one after another: every request answers at once, none is retried, and no phone is held twice.
 */
let world: ImportWorld;
let next = 7_100_000;
const block = (n: number) => {
  const start = next;
  next += n;
  return start;
};
const phone = (n: number) => `024${String(n).padStart(7, '0')}`;
/** The unit of work's retries logged while serving these responses, by their correlation ids. */
const retriesOf = (responses: ReadonlyArray<{ headers: Record<string, string> }>) => {
  const ids = new Set(responses.map((r) => r.headers['x-correlation-id']));
  return world.api.logLines().filter((line) => line.msg === 'transaction retried' && ids.has(line.correlationId as string));
};

async function dryRun(entity: 'CUSTOMER' | 'SUPPLIER', content: Buffer, filename: string): Promise<{ id: string; rowsToCreate: number }> {
  const fileId = await importFile(world, content, filename);
  const response = await post(world, world.manager, '/imports', { entity, fileId });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return response.body as { id: string; rowsToCreate: number };
}

function supplierCsv(n: number, start: number): Buffer {
  const lines = ['publicId,name,contactName,phone,email,address,categories'];
  for (let i = 0; i < n; i += 1) lines.push(`,Akropong Egg Farm ${start + i},Kojo Mensah,${phone(start + i)},,,`);
  return Buffer.from(`${lines.join('\r\n')}\r\n`);
}

beforeAll(async () => {
  world = await startImportWorld();
}, 120_000);

beforeEach(async () => {
  await refreshAll(world);
});

afterAll(async () => {
  await world.api.close();
  await world.database.drop();
});

describe('an import that creates customers, applied beside createCustomer', () => {
  it('applies 40 rows while 8 customers are created, every request answering at once with none retried, 48 new customers in all', async () => {
    const rows = block(40);
    const job = await dryRun('CUSTOMER', customerCsv(40, rows), 'customers.csv');
    expect(job.rowsToCreate).toBe(40);
    const before = await count(world, 'SELECT count(*)::int AS n FROM mdm.customer');
    const singles = block(8);
    const answers = await Promise.all([
      post(world, world.owner, `/imports/${job.id}/apply`),
      ...Array.from({ length: 8 }, (_, i) => post(world, world.manager, '/customers', { kind: 'INDIVIDUAL', name: `Ama Owusu ${i + 1}`, phone: phone(singles + i) })),
    ]);
    expect(answers.map((a) => a.status)).toEqual([202, ...Array(8).fill(201)]);
    expect(retriesOf(answers)).toEqual([]);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.customer')).toBe(before + 48);
  });

  it('holds one phone once when a create and an import race for it: the create that wins first is kept and the import writes nothing', async () => {
    const rows = block(20);
    const job = await dryRun('CUSTOMER', customerCsv(20, rows), 'customers.csv');
    const before = await count(world, 'SELECT count(*)::int AS n FROM mdm.customer');
    const [applied, created] = await Promise.all([
      post(world, world.owner, `/imports/${job.id}/apply`),
      post(world, world.manager, '/customers', { kind: 'INDIVIDUAL', name: 'Kwame Asante', phone: phone(rows + 19) }),
    ]);
    expect([applied, created].every((r) => r.status < 500)).toBe(true);
    expect(retriesOf([applied, created])).toEqual([]);
    const added = (await count(world, 'SELECT count(*)::int AS n FROM mdm.customer')) - before;
    // Either the import ran first (20 rows, the create refused as a duplicate) or the create did (1, the import refused):
    // never 21, which would hold the phone twice.
    expect(added === 20 ? [applied.status, created.status] : [created.status, applied.status]).toEqual(added === 20 ? [202, 422] : [201, 422]);
    expect([1, 20]).toContain(added);
  });
});

describe('an import that creates suppliers, applied beside createSupplier', () => {
  it('applies 40 rows while 8 suppliers are created, every request answering at once with none retried, 48 new suppliers in all', async () => {
    const rows = block(40);
    const job = await dryRun('SUPPLIER', supplierCsv(40, rows), 'suppliers.csv');
    expect(job.rowsToCreate).toBe(40);
    const before = await count(world, 'SELECT count(*)::int AS n FROM mdm.supplier');
    const singles = block(8);
    const answers = await Promise.all([
      post(world, world.owner, `/imports/${job.id}/apply`),
      ...Array.from({ length: 8 }, (_, i) => post(world, world.manager, '/suppliers', { name: `Nsawam Vegetable Growers ${singles + i}`, phone: phone(singles + i) })),
    ]);
    expect(answers.map((a) => a.status)).toEqual([202, ...Array(8).fill(201)]);
    expect(retriesOf(answers)).toEqual([]);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.supplier')).toBe(before + 48);
  });
});
