import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeSheet } from '../../../src/platform/spreadsheet/spreadsheet';
import { count, customerCsv, get, importFile, post, refreshAll, REFUSED_ROLES, startImportWorld, type ImportWorld } from '../../support/imports';
import { sqlStateOf } from '../../support/sql-state';

/**
 * MDM imports (FR-MDM-019, ADR-0046, A-128): the dry run writes only the job and its row errors; apply writes every
 * row through the entity's own service in one transaction, or none; every operation refuses the wrong role in the
 * application layer (ADR-0035) and the database refuses what the job rules forbid (HK009).
 */
let world: ImportWorld;
const customers = () => count(world, 'SELECT count(*)::int AS n FROM mdm.customer');
const failures = () => count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'");
let next = 1_000;
/** A fresh block of phone numbers for each file. */
const block = (size: number) => {
  const start = next;
  next += size + 10;
  return start;
};

async function dryRun(content: Buffer, filename = 'customers.csv', session = world.manager) {
  const fileId = await importFile(world, content, filename);
  const response = await post(world, session, '/imports', { entity: 'CUSTOMER', fileId });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return response.body as { id: string; status: string; rowsTotal: number | null; rowsValid: number | null; rowsToCreate: number | null; rowsToUpdate: number | null; rowsApplied: number | null };
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

describe('imports refuse the wrong role (ADR-0035, deny by default)', () => {
  it('refuses createImportJob to the accountant, cashier, sales, driver, farm hand, storekeeper and a user with no grant, writes no job and audits each refusal', async () => {
    const fileId = await importFile(world, customerCsv(2, block(2)), 'customers.csv');
    const before = await failures();
    const jobs = await count(world, 'SELECT count(*)::int AS n FROM mdm.import_job');
    for (const [role, session] of Object.entries({ ACCOUNTANT: world.accountant, ...world.refused })) {
      const response = await post(world, session, '/imports', { entity: 'CUSTOMER', fileId });
      expect(response.status, role).toBe(403);
      expect(response.body.error.code, role).toBe('FORBIDDEN');
    }
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.import_job')).toBe(jobs);
    expect(await failures()).toBe(before + REFUSED_ROLES.length + 2);
  });

  it('refuses applyImportJob and cancelImportJob to the same roles and leaves the job VALIDATED with nothing written', async () => {
    const job = await dryRun(customerCsv(3, block(3)));
    const before = await customers();
    for (const [role, session] of Object.entries({ ACCOUNTANT: world.accountant, ...world.refused })) {
      expect((await post(world, session, `/imports/${job.id}/apply`)).status, role).toBe(403);
      expect((await post(world, session, `/imports/${job.id}/cancel`)).status, role).toBe(403);
    }
    expect(await customers()).toBe(before);
    expect((await get(world, world.manager, `/imports/${job.id}`)).body.status).toBe('VALIDATED');
  });

  it('lets the accountant read the jobs and refuses the reads to the cashier, sales, driver, farm hand, storekeeper and a user with no grant', async () => {
    const job = await dryRun(customerCsv(1, block(1)));
    expect((await get(world, world.accountant, '/imports')).status).toBe(200);
    for (const [role, session] of Object.entries(world.refused)) {
      expect((await get(world, session, '/imports')).status, role).toBe(403);
      expect((await get(world, session, `/imports/${job.id}`)).status, role).toBe(403);
      expect((await get(world, session, `/imports/${job.id}/errors`)).status, role).toBe(403);
    }
  });

  it('refuses to apply rows that create customers to a manager whose role lost mdm.customer.create, writing nothing', async () => {
    const job = await dryRun(customerCsv(2, block(2)));
    const admin = world.database.pool('admin');
    const managerRole = (await admin.query<{ id: string }>("SELECT id FROM iam.role WHERE code = 'MANAGER'")).rows[0]!.id;
    await admin.query("DELETE FROM iam.role_permission WHERE role_id = $1 AND permission_code = 'mdm.customer.create'", [managerRole]);
    try {
      const before = await customers();
      const response = await post(world, world.manager, `/imports/${job.id}/apply`);
      expect(response.status).toBe(403);
      expect(await customers()).toBe(before);
    } finally {
      await admin.query("INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by) VALUES ($1, 'mdm.customer.create', '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001')", [managerRole]);
    }
  });
});

describe('FR-MDM-019: writes nothing in a dry run and applies all or none', () => {
  it('finds the 3 bad rows of a 200-row file with their row numbers and columns, writes no customer, refuses to apply, and applies the corrected 200 rows', async () => {
    const start = block(200);
    const bad = { 13: { phone: '12345' }, 87: { name: '' }, 151: { tier: 'VIP' } };
    const before = await customers();
    const audits = await count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'Customer'");
    const first = await dryRun(customerCsv(200, start, bad));
    expect(first).toMatchObject({ status: 'VALIDATED', rowsTotal: 200, rowsValid: 197, rowsToCreate: 200, rowsToUpdate: 0, rowsApplied: null });
    const errors = await get(world, world.manager, `/imports/${first.id}/errors?limit=2`);
    expect(errors.status).toBe(200);
    expect(errors.body.data).toEqual([
      { rowNo: 15, column: 'phone', message: 'Phone number must be a Ghanaian number such as 024 412 3456, or start with + and the country code' },
      { rowNo: 89, column: 'name', message: 'Name is empty' },
    ]);
    const rest = await get(world, world.manager, `/imports/${first.id}/errors?limit=2&cursor=${encodeURIComponent(errors.body.page.nextCursor as string)}`);
    expect(rest.body).toMatchObject({ data: [{ rowNo: 153, column: 'tier', message: 'Unknown tier "VIP"' }], page: { hasMore: false, nextCursor: null } });
    // Zero writes outside the job: no customer and no customer audit event.
    expect(await customers()).toBe(before);
    expect(await count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'Customer'")).toBe(audits);

    const refused = await post(world, world.manager, `/imports/${first.id}/apply`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('IMPORT_NOT_VALIDATED');
    expect(await customers()).toBe(before);

    const fixed = Buffer.from(writeSheet('XLSX', 'Customers', customerCsv(200, start).toString().trim().split('\r\n').map((line) => line.split(','))));
    const second = await dryRun(fixed, 'customers-fixed.xlsx');
    expect(second).toMatchObject({ status: 'VALIDATED', rowsTotal: 200, rowsValid: 200, rowsToCreate: 200 });
    const key = randomUUID();
    const applied = await post(world, world.owner, `/imports/${second.id}/apply`, {}, key);
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    expect(applied.body).toMatchObject({ status: 'APPLIED', rowsApplied: 200 });
    expect(await customers()).toBe(before + 200);
    expect(await count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'Customer' AND action = 'CREATE'")).toBe(audits + 200);
    expect(await count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = 'ImportJob' AND action = 'APPLY' AND entity_id = $1", [second.id])).toBe(1);
    // A replay returns the stored answer and writes nothing more; applying again is refused.
    const replay = await post(world, world.owner, `/imports/${second.id}/apply`, {}, key);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(applied.body);
    expect((await post(world, world.owner, `/imports/${second.id}/apply`)).body.error.code).toBe('IMPORT_NOT_VALIDATED');
    expect(await customers()).toBe(before + 200);

    // The refused job and its errors stay readable.
    expect((await get(world, world.manager, `/imports/${first.id}`)).body).toMatchObject({ status: 'VALIDATED', rowsValid: 197 });
    const listed = await get(world, world.accountant, '/imports?entity=CUSTOMER&direction=IMPORT&limit=100');
    expect(listed.body.data.map((job: { id: string }) => job.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(listed.body.data[0].createdBy.displayName).toBeTypeOf('string');
  });

  it('writes none of the rows when one no longer passes at apply, and adds that row error to the job', async () => {
    const start = block(5);
    const job = await dryRun(customerCsv(5, start));
    // Between the dry run and the apply, someone saves a customer with row 6's phone.
    const created = await post(world, world.manager, '/customers', { kind: 'INDIVIDUAL', name: 'Yaw Darko', phone: `024${String(start + 4).padStart(7, '0')}` });
    expect(created.status).toBe(201);
    const before = await customers();
    const response = await post(world, world.manager, `/imports/${job.id}/apply`);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('IMPORT_NOT_VALIDATED');
    expect(await customers()).toBe(before);
    const errors = await get(world, world.manager, `/imports/${job.id}/errors`);
    expect(errors.body.data).toEqual([{ rowNo: 6, column: 'phone', message: `Phone number already belongs to customer ${created.body.customerNo as string}` }]);
    expect((await get(world, world.manager, `/imports/${job.id}`)).body).toMatchObject({ status: 'VALIDATED', rowsValid: 4 });
  });

  it('changes an existing customer named by its number and refuses a duplicate in the file, an unknown number and a change of kind', async () => {
    const start = block(3);
    const created = await post(world, world.manager, '/customers', { kind: 'INDIVIDUAL', name: 'Abena Ofori', phone: `020${String(start).padStart(7, '0')}` });
    const no = created.body.customerNo as string;
    const phone = `024${String(start + 1).padStart(7, '0')}`;
    const content = Buffer.from(`customerNo,kind,name,phone,email,tier\r\n${no},BUSINESS,,,,\r\n,INDIVIDUAL,Kofi Asare,${phone},,\r\n,INDIVIDUAL,Kofi Asare Jr,${phone},,\r\nC-99999,,Nobody,,,\r\n`);
    const job = await dryRun(content);
    expect(job).toMatchObject({ rowsTotal: 4, rowsValid: 1, rowsToCreate: 2, rowsToUpdate: 2 });
    expect((await get(world, world.manager, `/imports/${job.id}/errors`)).body.data).toEqual([
      { rowNo: 2, column: 'kind', message: "A customer's kind cannot change by import" },
      { rowNo: 4, column: 'phone', message: 'Duplicate of row 3' },
      { rowNo: 5, column: 'customerNo', message: 'No customer C-99999' },
    ]);
    const change = await dryRun(Buffer.from(`customerNo,name,tier\r\n${no},Abena Ofori-Atta,WHOLESALE\r\n`));
    expect(change).toMatchObject({ rowsTotal: 1, rowsValid: 1, rowsToCreate: 0, rowsToUpdate: 1 });
    expect((await post(world, world.manager, `/imports/${change.id}/apply`)).status).toBe(202);
    const after = await get(world, world.manager, `/customers/${created.body.id as string}`);
    expect(after.body).toMatchObject({ name: 'Abena Ofori-Atta', tier: { code: 'WHOLESALE' }, phone: created.body.phone, version: (created.body.version as number) + 1 });
  });

  it('fails a file that cannot be read as the customer sheet, with its errors on row 1', async () => {
    const unknown = await dryRun(Buffer.from('name,age\r\nAma,30\r\n'));
    expect(unknown).toMatchObject({ status: 'FAILED', rowsTotal: null, rowsValid: 0 });
    expect((await get(world, world.manager, `/imports/${unknown.id}/errors`)).body.data).toEqual([{ rowNo: 1, column: 'age', message: 'Unknown column "age"' }]);
    const empty = await dryRun(Buffer.from('name,phone\r\n'));
    expect((await get(world, world.manager, `/imports/${empty.id}/errors`)).body.data).toEqual([{ rowNo: 1, column: null, message: 'The file has no rows below the header' }]);
    const broken = await dryRun(Buffer.from('name\r\n"Ama\r\n'));
    expect(broken.status).toBe('FAILED');
    expect((await post(world, world.manager, `/imports/${broken.id}/apply`)).body.error.code).toBe('IMPORT_NOT_VALIDATED');
    expect((await post(world, world.manager, `/imports/${broken.id}/cancel`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
  });
});

describe('the import file and the entity', () => {
  it('refuses a file not yet scanned, a file of another use or none, and an entity whose sheet is not built', async () => {
    const pending = await importFile(world, customerCsv(1, block(1)), 'customers.csv', world.manager, false);
    const notClean = await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId: pending });
    expect(notClean.status).toBe(422);
    expect(notClean.body.error.code).toBe('FILE_NOT_CLEAN');
    await world.worker.scanPending(50);
    const missing = await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId: randomUUID() });
    expect(missing.body.error).toMatchObject({ code: 'REFERENCE_NOT_FOUND', details: [{ field: '/fileId' }] });
    for (const entity of ['OPENING_STOCK']) {
      const response = await post(world, world.manager, '/imports', { entity, fileId: pending });
      expect(response.status, entity).toBe(422);
      expect(response.body.error.code, entity).toBe('IMPORT_ENTITY_NOT_AVAILABLE');
    }
    expect((await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId: pending, extra: 1 })).status).toBe(400);
  });

  it('returns the stored job for a replayed key and 409 for a different body under it', async () => {
    const fileId = await importFile(world, customerCsv(2, block(2)), 'customers.csv');
    const key = randomUUID();
    const first = await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId }, key);
    const replay = await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId }, key);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    const other = await importFile(world, customerCsv(1, block(1)), 'other.csv');
    expect((await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId: other }, key)).status).toBe(409);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.import_job WHERE file_id = $1', [fileId])).toBe(1);
  });

  it('cancels a validated import once, after which it cannot be applied, and answers 404 for an unknown job', async () => {
    const job = await dryRun(customerCsv(2, block(2)));
    const cancelled = await post(world, world.manager, `/imports/${job.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await post(world, world.manager, `/imports/${job.id}/cancel`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await post(world, world.manager, `/imports/${job.id}/apply`)).body.error.code).toBe('IMPORT_NOT_VALIDATED');
    expect((await get(world, world.manager, `/imports/${randomUUID()}`)).status).toBe(404);
    expect((await get(world, world.manager, `/imports/${randomUUID()}/errors`)).status).toBe(404);
    expect((await post(world, world.manager, `/imports/${randomUUID()}/apply`)).status).toBe(404);
    expect((await post(world, world.manager, `/imports/${randomUUID()}/cancel`)).status).toBe(404);
  });
});

describe('the database holds the job rules (HK009, HK004)', () => {
  it('refuses an import of a file that is not a clean import file, applying a job with row errors, moving a status back and changing a frozen job', async () => {
    const admin = world.database.pool('admin');
    const job = await dryRun(customerCsv(3, block(3), { 1: { email: 'not-an-email' } }));
    const refusal = (sql: string, values: unknown[]) => sqlStateOf(admin.query(sql, values));
    expect(await refusal("UPDATE mdm.import_job SET status = 'APPLIED', rows_valid = rows_total, rows_applied = rows_total, posted_at = now(), posted_by = created_by WHERE id = $1", [job.id])).toBe('HK009');
    expect(await refusal("UPDATE mdm.import_job SET status = 'UPLOADED' WHERE id = $1", [job.id])).toBe('HK009');
    expect(await refusal('UPDATE mdm.import_job SET entity = $2 WHERE id = $1', [job.id, 'SUPPLIER'])).toBe('HK009');
    const pending = await importFile(world, customerCsv(1, block(1)), 'pending.csv', world.manager, false);
    const branch = (await admin.query<{ id: string }>('SELECT branch_id AS id FROM mdm.import_job WHERE id = $1', [job.id])).rows[0]!.id;
    expect(
      await refusal(
        "INSERT INTO mdm.import_job (id, entity, direction, file_id, status, branch_id, created_by, updated_by) SELECT $1, 'CUSTOMER', 'IMPORT', $2, 'VALIDATED', $3, created_by, created_by FROM mdm.import_job WHERE id = $4",
        [randomUUID(), pending, branch, job.id],
      ),
    ).toBe('HK008');
    await world.worker.scanPending(50);
    const cancelled = (await post(world, world.manager, `/imports/${job.id}/cancel`)).body as { id: string };
    expect(await refusal('UPDATE mdm.import_job SET rows_valid = 0 WHERE id = $1', [cancelled.id])).toBe('HK004');
  });
});
