import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { XLSX } from '../../../src/platform/storage/content-sniffer';
import { readSheet } from '../../../src/platform/spreadsheet/spreadsheet';
import { count, customerCsv, get, importFile, post, refreshAll, REFUSED_ROLES, startImportWorld, stepUp, type ImportWorld } from '../../support/imports';

/**
 * MDM exports (FR-MDM-020, SEC-009 abuse case 9, A-128): export is a permission, every export needs a fresh step-up,
 * is audited with the user, its parameters and its row count (bulk above 100 rows), and is delivered as a private
 * EXPORT file whose signed link expires after five minutes.
 */
let world: ImportWorld;
const SIX_MINUTES = 6 * 60 * 1_000;
const failures = () => count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'");
const exportsAudited = () => count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'EXPORT'");

beforeAll(async () => {
  world = await startImportWorld();
  // 150 customers, imported through the dry run and apply.
  const fileId = await importFile(world, customerCsv(150, 5_000), 'customers.csv');
  const job = await post(world, world.manager, '/imports', { entity: 'CUSTOMER', fileId });
  expect((await post(world, world.manager, `/imports/${job.body.id as string}/apply`)).status).toBe(202);
}, 120_000);

beforeEach(async () => {
  // Every test starts with a stale step-up, then fresh access tokens.
  world.clock.advanceBy(SIX_MINUTES);
  await refreshAll(world);
});

afterAll(async () => {
  await world.api.close();
  await world.database.drop();
});

describe('exports refuse the wrong role (ADR-0035, SEC-009)', () => {
  it('refuses createExportJob to the cashier, sales, driver, farm hand, storekeeper and a user with no grant, writes no file and audits each refusal', async () => {
    const before = await failures();
    const files = await count(world, "SELECT count(*)::int AS n FROM platform.stored_file WHERE purpose = 'EXPORT'");
    for (const [role, session] of Object.entries(world.refused)) {
      const response = await post(world, session, '/exports', { entity: 'CUSTOMER', format: 'CSV' });
      expect(response.status, role).toBe(403);
      expect(response.body.error.code, role).toBe('FORBIDDEN');
    }
    expect(await failures()).toBe(before + REFUSED_ROLES.length + 1);
    expect(await count(world, "SELECT count(*)::int AS n FROM platform.stored_file WHERE purpose = 'EXPORT'")).toBe(files);
    expect(await exportsAudited()).toBe(0);
  });
});

describe('FR-MDM-020: audits row counts and demands step-up above 100 rows', () => {
  it('refuses an export of 150 customers without step-up, then with it records 150 rows, marks it bulk and delivers a link that expires after five minutes', async () => {
    const refused = await post(world, world.manager, '/exports', { entity: 'CUSTOMER', format: 'CSV' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('STEP_UP_REQUIRED');
    expect(await exportsAudited()).toBe(0);

    await stepUp(world, world.manager);
    const key = randomUUID();
    const exported = await post(world, world.manager, '/exports', { entity: 'CUSTOMER', format: 'CSV' }, key);
    expect(exported.status, JSON.stringify(exported.body)).toBe(202);
    expect(exported.body).toMatchObject({ entity: 'CUSTOMER', direction: 'EXPORT', status: 'APPLIED', rowsTotal: 150, rowsApplied: 150, rowsToCreate: null, file: { contentType: 'text/csv' } });
    expect(exported.body.file.originalName).toMatch(/^customers-export-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(exported.body.createdBy.displayName).toBe('Kwabena Owusu');
    const audit = await world.database.pool('admin').query<{ actor_id: string; after: Buffer }>("SELECT actor_id, after FROM platform.audit_event WHERE action = 'EXPORT' AND entity_id = $1", [exported.body.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.actor_id).toBe(exported.body.createdBy.id);
    expect(JSON.parse(audit.rows[0]!.after.toString('utf8'))).toEqual({ entity: 'CUSTOMER', format: 'CSV', rowCount: 150, bulk: true, fileId: exported.body.file.id });

    // A replay returns the stored job and exports nothing more.
    const replay = await post(world, world.manager, '/exports', { entity: 'CUSTOMER', format: 'CSV' }, key);
    expect(replay.body).toEqual(exported.body);
    expect(await exportsAudited()).toBe(1);

    // The file is served only once the worker's scan passes it, then by a signed link that lives five minutes.
    const fileId = exported.body.file.id as string;
    const early = await post(world, world.manager, `/files/${fileId}/signed-url`);
    expect(early.body.error.code).toBe('FILE_NOT_CLEAN');
    await world.worker.scanPending(50);
    const linked = await post(world, world.manager, `/files/${fileId}/signed-url`);
    expect(linked.status).toBe(200);
    expect(new Date(linked.body.expiresAt as string).getTime() - world.clock.now().getTime()).toBe(300_000);
    expect(await count(world, 'SELECT count(*)::int AS n FROM platform.file_access_log WHERE file_id = $1', [fileId])).toBe(1);
    const content = Buffer.from(await (await fetch(linked.body.url as string)).arrayBuffer());
    const rows = readSheet(content, 'text/csv', 1_000);
    expect(rows).toHaveLength(151);
    expect(rows[0]).toEqual(['customerNo', 'kind', 'name', 'phone', 'email', 'tier']);
    expect(rows[1]).toEqual([expect.stringMatching(/^C-\d{5}$/), 'BUSINESS', 'Customer 5000 Mensah', '+233240005000', 'customer5000@example.com', 'WHOLESALE']);
    // The raw CSV neutralises the leading + so a spreadsheet program does not read the phone as a formula.
    expect(content.toString('utf8')).toContain(",'+233240005000,");
    // The export is the customers' own file: the cashier cannot read it.
    expect((await get(world, world.refused['CASHIER']!, `/files/${fileId}`)).status).toBe(403);
  });

  it('lets the accountant export to XLSX with a step-up, and lists only exports when asked', async () => {
    await stepUp(world, world.accountant);
    const exported = await post(world, world.accountant, '/exports', { entity: 'CUSTOMER', format: 'XLSX' });
    expect(exported.status).toBe(202);
    expect(exported.body.file.contentType).toBe(XLSX);
    await world.worker.scanPending(50);
    const linked = await post(world, world.accountant, `/files/${exported.body.file.id as string}/signed-url`);
    const rows = readSheet(Buffer.from(await (await fetch(linked.body.url as string)).arrayBuffer()), XLSX, 1_000);
    expect(rows).toHaveLength(151);
    expect(rows[1]![3]).toBe('+233240005000');
    const listed = await get(world, world.accountant, '/imports?direction=EXPORT');
    expect(listed.body.data.every((job: { direction: string }) => job.direction === 'EXPORT')).toBe(true);
  });

  it('cannot be cancelled or applied, since an export is done when it is created', async () => {
    await stepUp(world, world.owner);
    const exported = await post(world, world.owner, '/exports', { entity: 'CUSTOMER', format: 'CSV' });
    expect((await post(world, world.owner, `/imports/${exported.body.id as string}/cancel`)).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect((await post(world, world.owner, `/imports/${exported.body.id as string}/apply`)).body.error.code).toBe('IMPORT_NOT_VALIDATED');
  });
});
