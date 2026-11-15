import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readSheet } from '../../../src/platform/spreadsheet/spreadsheet';
import { createCatalogue } from '../../support/catalogue';
import { createBranch, SYSTEM_PRINCIPAL } from '../../support/iam';
import { count, get, importFile, post, refreshAll, REFUSED_ROLES, startImportWorld, stepUp, type ImportWorld } from '../../support/imports';

/**
 * The product, supplier, location and price list entry sheets (FR-MDM-019, FR-MDM-020, A-130): each dry run writes
 * nothing but the job and its row errors; each apply writes every row through the entity's own service in one
 * transaction, or none; each export is audited with its row count and needs a fresh step-up; every operation refuses
 * the wrong role (ADR-0035), and applying needs the entity's own permission at the branch it writes (ADR-0017).
 * The describes run in order: the price list entries price the products the product sheet created.
 */
let world: ImportWorld;
let accraBranchId: string;
let goatSpeciesId: string;

const csv = (...lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`);
const failures = () => count(world, "SELECT count(*)::int AS n FROM platform.audit_event WHERE action = 'AUTHORISATION_FAILURE'");
const audits = (entityType: string, action: string) => count(world, 'SELECT count(*)::int AS n FROM platform.audit_event WHERE entity_type = $1 AND action = $2', [entityType, action]);

interface JobView {
  id: string;
  status: string;
  rowsTotal: number | null;
  rowsValid: number | null;
  rowsToCreate: number | null;
  rowsToUpdate: number | null;
  rowsApplied: number | null;
}

async function dryRun(entity: string, content: Buffer): Promise<JobView> {
  const fileId = await importFile(world, content, `${entity.toLowerCase()}.csv`);
  const response = await post(world, world.manager, '/imports', { entity, fileId });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return response.body as JobView;
}

const errorsOf = async (job: JobView) => (await get(world, world.manager, `/imports/${job.id}/errors?limit=100`)).body.data as { rowNo: number; column: string | null; message: string }[];

async function apply(job: JobView, session = world.manager) {
  return post(world, session, `/imports/${job.id}/apply`);
}

/** Exports with a fresh step-up; returns the job, its audited parameters and the file's rows once scanned. */
async function exported(entity: string) {
  await stepUp(world, world.manager);
  const response = await post(world, world.manager, '/exports', { entity, format: 'CSV' });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  const audit = await world.database.pool('admin').query<{ after: Buffer }>("SELECT after FROM platform.audit_event WHERE action = 'EXPORT' AND entity_id = $1", [response.body.id]);
  await world.worker.scanPending(50);
  const linked = await post(world, world.manager, `/files/${response.body.file.id as string}/signed-url`);
  const rows = readSheet(Buffer.from(await (await fetch(linked.body.url as string)).arrayBuffer()), 'text/csv', 10_000);
  return { job: response.body as JobView, audited: JSON.parse(audit.rows[0]!.after.toString('utf8')) as Record<string, unknown>, rows };
}

beforeAll(async () => {
  world = await startImportWorld();
  goatSpeciesId = (await createCatalogue(world.database)).goatSpeciesId;
  const app = world.database.pool('app');
  await app.query("INSERT INTO mdm.grade (id, species_id, code, name, created_by, updated_by) VALUES ($1, $2, 'A', 'Grade A', $3, $3)", [randomUUID(), goatSpeciesId, SYSTEM_PRINCIPAL]);
  await app.query("INSERT INTO mdm.weight_band (id, species_id, code, min_kg, max_kg, created_by, updated_by) VALUES ($1, $2, 'B20-25', 20, 25, $3, $3)", [randomUUID(), goatSpeciesId, SYSTEM_PRINCIPAL]);
  // A second branch where nobody in this world holds a grant.
  accraBranchId = (await createBranch(world.database, 'ACC')).branchId;
}, 120_000);

beforeEach(async () => {
  await refreshAll(world);
});

afterAll(async () => {
  await world.api.close();
  await world.database.drop();
});

const SHEETS = {
  PRODUCT: { file: csv('sku,name,category,stockPolicy,baseUom,saleUom', 'REFUSED-1,Refused,EGGS,COUNTABLE,CRATE,CRATE'), permission: 'mdm.product.create', table: 'mdm.product' },
  SUPPLIER: { file: csv('name,phone', 'Refused Feeds,0244990001'), permission: 'mdm.supplier.create', table: 'mdm.supplier' },
  LOCATION: { file: csv('branch,code,name,kind', 'DDW,REFUSED,Refused store,STORE'), permission: 'mdm.location.create', table: 'mdm.location' },
} as const;

describe('every new sheet refuses the wrong role (ADR-0035, deny by default)', () => {
  it('refuses createImportJob for products, suppliers, locations and price list entries to the accountant, cashier, sales, driver, farm hand, storekeeper and a user with no grant, and audits each refusal', async () => {
    for (const entity of ['PRODUCT', 'SUPPLIER', 'LOCATION', 'PRICE_LIST_ENTRY']) {
      const fileId = await importFile(world, csv('name', 'x'), 'refused.csv');
      const before = await failures();
      const jobs = await count(world, 'SELECT count(*)::int AS n FROM mdm.import_job');
      for (const [role, session] of Object.entries({ ACCOUNTANT: world.accountant, ...world.refused })) {
        const response = await post(world, session, '/imports', { entity, fileId });
        expect(response.status, `${entity} ${role}`).toBe(403);
      }
      expect(await failures()).toBe(before + REFUSED_ROLES.length + 2);
      expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.import_job')).toBe(jobs);
    }
  });

  it('refuses createExportJob for each new sheet to the cashier, sales, driver, farm hand, storekeeper and a user with no grant', async () => {
    for (const entity of ['PRODUCT', 'SUPPLIER', 'LOCATION', 'PRICE_LIST_ENTRY']) {
      for (const [role, session] of Object.entries(world.refused)) expect((await post(world, session, '/exports', { entity, format: 'CSV' })).status, `${entity} ${role}`).toBe(403);
    }
  });

  it("refuses to apply a sheet to a manager whose role lost the entity's own create permission, writing nothing", async () => {
    const admin = world.database.pool('admin');
    const managerRole = (await admin.query<{ id: string }>("SELECT id FROM iam.role WHERE code = 'MANAGER'")).rows[0]!.id;
    for (const [entity, sheet] of Object.entries(SHEETS)) {
      const job = await dryRun(entity, sheet.file);
      expect(job, entity).toMatchObject({ status: 'VALIDATED', rowsValid: 1, rowsToCreate: 1 });
      await admin.query('DELETE FROM iam.role_permission WHERE role_id = $1 AND permission_code = $2', [managerRole, sheet.permission]);
      try {
        const before = await count(world, `SELECT count(*)::int AS n FROM ${sheet.table}`);
        expect((await apply(job)).status, entity).toBe(403);
        expect(await count(world, `SELECT count(*)::int AS n FROM ${sheet.table}`), entity).toBe(before);
      } finally {
        await admin.query('INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by) VALUES ($1, $2, $3, $3)', [managerRole, sheet.permission, SYSTEM_PRINCIPAL]);
      }
      expect((await post(world, world.manager, `/imports/${job.id}/cancel`)).status).toBe(200);
    }
  });

  it('answers 422 IMPORT_ENTITY_NOT_AVAILABLE for opening stock only, which waits for B5', async () => {
    const fileId = await importFile(world, csv('name', 'x'), 'stock.csv');
    expect((await post(world, world.manager, '/imports', { entity: 'OPENING_STOCK', fileId })).body.error.code).toBe('IMPORT_ENTITY_NOT_AVAILABLE');
    await stepUp(world, world.manager);
    expect((await post(world, world.manager, '/exports', { entity: 'OPENING_STOCK', format: 'CSV' })).body.error.code).toBe('IMPORT_ENTITY_NOT_AVAILABLE');
  });
});

describe('products (FR-MDM-001 through FR-MDM-019)', () => {
  const header = 'sku,name,category,stockPolicy,species,baseUom,saleUom,taxCategory,nominalPackKg,shelfLifeDays,barcode,description,onlineMode';

  it('reports each bad row with its column, writes no product, and refuses to apply', async () => {
    const products = await count(world, 'SELECT count(*)::int AS n FROM mdm.product');
    const created = await audits('Product', 'CREATE');
    const job = await dryRun(
      'PRODUCT',
      csv(
        header,
        'GOAT-LIVE,Live goat,LIVE,SERIALISED,GOAT,HEAD,HEAD,,,,,,LISTED',
        'BEEF-15KG,Beef 15 kg pack,MEAT,CATCH_WEIGHT,,KG,KG,,15,5,,,LISTED',
        'EGGS-30,Crate of 30 eggs,POULTRY,COUNTABLE,,CRATE,CRATE,,,,,,',
        'BEEF-15KG,Beef again,MEAT,CATCH_WEIGHT,,KG,KG,,,,,,',
        'SVC-DEL,Delivery,MEAT,NON_STOCK,,UNIT,UNIT,,,7,,,',
      ),
    );
    expect(job).toMatchObject({ status: 'VALIDATED', rowsTotal: 5, rowsValid: 1, rowsToCreate: 5, rowsToUpdate: 0 });
    expect(await errorsOf(job)).toEqual([
      { rowNo: 2, column: 'onlineMode', message: 'A live animal is sold on request: onlineMode must be REQUEST_TO_BUY or HIDDEN' },
      { rowNo: 4, column: 'category', message: 'Unknown category "POULTRY"' },
      { rowNo: 5, column: 'sku', message: 'Duplicate of row 3' },
      { rowNo: 6, column: 'shelfLifeDays', message: 'A NON_STOCK product has no shelfLifeDays' },
    ]);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.product')).toBe(products);
    expect(await audits('Product', 'CREATE')).toBe(created);
    expect((await apply(job)).body.error.code).toBe('IMPORT_NOT_VALIDATED');
  });

  it('applies the corrected file through createProduct: every product created, audited and published, the tax category from its category', async () => {
    const products = await count(world, 'SELECT count(*)::int AS n FROM mdm.product');
    const created = await audits('Product', 'CREATE');
    const events = await count(world, "SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'mdm.ProductCreated'");
    const job = await dryRun(
      'PRODUCT',
      csv(
        header,
        'GOAT-LIVE,Live goat,LIVE,SERIALISED,GOAT,HEAD,HEAD,,,,,,REQUEST_TO_BUY',
        'BEEF-15KG,Beef 15 kg pack,MEAT,CATCH_WEIGHT,,KG,KG,,15,5,,,LISTED',
        'EGGS-30,Crate of 30 eggs,EGGS,COUNTABLE,,CRATE,CRATE,,,,6001234500017,Fresh layers,',
      ),
    );
    expect(job).toMatchObject({ rowsTotal: 3, rowsValid: 3, rowsToCreate: 3 });
    const applied = await apply(job);
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    expect(applied.body).toMatchObject({ status: 'APPLIED', rowsApplied: 3 });
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.product')).toBe(products + 3);
    expect(await audits('Product', 'CREATE')).toBe(created + 3);
    expect(await count(world, "SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'mdm.ProductCreated'")).toBe(events + 3);
    const rows = await world.database.pool('admin').query<{ sku: string; tracking: string; nominal_pack_kg: string | null; online_mode: string; tax: string; status: string }>(
      'SELECT p.sku, p.tracking, p.nominal_pack_kg::text, p.online_mode, t.code AS tax, p.status FROM mdm.product p JOIN mdm.tax_category t ON t.id = p.tax_category_id ORDER BY p.sku',
    );
    expect(rows.rows).toEqual([
      { sku: 'BEEF-15KG', tracking: 'LOT', nominal_pack_kg: '15.000', online_mode: 'LISTED', tax: 'PROCESSED_MEAT', status: 'ACTIVE' },
      { sku: 'EGGS-30', tracking: 'NONE', nominal_pack_kg: null, online_mode: 'HIDDEN', tax: 'EGGS', status: 'ACTIVE' },
      { sku: 'GOAT-LIVE', tracking: 'SERIAL', nominal_pack_kg: null, online_mode: 'REQUEST_TO_BUY', tax: 'LIVE_ANIMALS', status: 'ACTIVE' },
    ]);
  });

  it('changes a product named by its SKU, refuses a change to its stock-keeping policy or units, and a barcode another product has', async () => {
    const refused = await dryRun('PRODUCT', csv('sku,stockPolicy,baseUom,barcode', 'EGGS-30,NON_STOCK,,', 'GOAT-LIVE,,KG,', 'BEEF-15KG,,,6001234500017'));
    expect(refused).toMatchObject({ rowsToCreate: 0, rowsToUpdate: 3, rowsValid: 0 });
    expect(await errorsOf(refused)).toEqual([
      { rowNo: 2, column: 'stockPolicy', message: 'stockPolicy cannot change once a product exists' },
      { rowNo: 3, column: 'baseUom', message: 'baseUom cannot change once a product exists' },
      { rowNo: 4, column: 'barcode', message: 'barcode is already used by another product' },
    ]);
    const change = await dryRun('PRODUCT', csv('sku,name,description,onlineMode', 'EGGS-30,Tray of 30 eggs,,LISTED'));
    expect(change).toMatchObject({ rowsToCreate: 0, rowsToUpdate: 1, rowsValid: 1 });
    expect((await apply(change)).status).toBe(202);
    const after = await world.database.pool('admin').query<{ name: string; description: string; online_mode: string; version: number }>("SELECT name, description, online_mode, version FROM mdm.product WHERE sku = 'EGGS-30'");
    expect(after.rows[0]).toEqual({ name: 'Tray of 30 eggs', description: 'Fresh layers', online_mode: 'LISTED', version: 2 });
  });

  it('exports every product with a fresh step-up, audited with its row count', async () => {
    const products = await count(world, 'SELECT count(*)::int AS n FROM mdm.product WHERE deleted_at IS NULL');
    const { job, audited, rows } = await exported('PRODUCT');
    expect(job).toMatchObject({ rowsTotal: products, rowsApplied: products });
    expect(audited).toMatchObject({ entity: 'PRODUCT', format: 'CSV', rowCount: products, bulk: false });
    expect(rows[0]).toEqual(header.split(','));
    expect(rows).toContainEqual(['BEEF-15KG', 'Beef 15 kg pack', 'MEAT', 'CATCH_WEIGHT', '', 'KG', 'KG', 'PROCESSED_MEAT', '15.000', '5', '', '', 'LISTED']);
  });
});

describe('suppliers (FR-MDM-007, FR-MDM-019)', () => {
  it('reports a phone used twice in the file, a phone another supplier holds, an unknown category and an unknown number, and writes nothing', async () => {
    const existing = await post(world, world.manager, '/suppliers', { name: 'Ashaiman Feeds', phone: '0244550001' });
    expect(existing.status).toBe(201);
    const suppliers = await count(world, 'SELECT count(*)::int AS n FROM mdm.supplier');
    const job = await dryRun(
      'SUPPLIER',
      csv('supplierNo,name,contactName,phone,email,address,categories', ',Dodowa Poultry,Kojo Mensah,0244550002,,,EGGS', ',Dodowa Poultry 2,,0244550002,,,', ',Tema Cattle,,0244550001,,,', ',Ho Produce,,,,,VEGETABLES', 'S-9999,Nobody,,,,,'),
    );
    expect(job).toMatchObject({ rowsTotal: 5, rowsValid: 1, rowsToCreate: 4, rowsToUpdate: 1 });
    expect(await errorsOf(job)).toEqual([
      { rowNo: 3, column: 'phone', message: 'Duplicate of row 2' },
      { rowNo: 4, column: 'phone', message: 'Phone number already belongs to another supplier' },
      { rowNo: 5, column: 'categories', message: 'Unknown category "VEGETABLES"' },
      { rowNo: 6, column: 'supplierNo', message: 'No supplier S-9999' },
    ]);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.supplier')).toBe(suppliers);
  });

  it('registers and changes suppliers through the supplier service, all in one transaction', async () => {
    const existing = (await get(world, world.manager, '/suppliers?limit=100')).body.data.find((supplier: { name: string }) => supplier.name === 'Ashaiman Feeds') as { id: string; supplierNo: string };
    const registered = await audits('Supplier', 'CREATE');
    const job = await dryRun('SUPPLIER', csv('supplierNo,name,phone,email,categories', ',Dodowa Poultry,0244550002,sales@example.com,EGGS;MEAT', `${existing.supplierNo},,,,LIVE`));
    expect(job).toMatchObject({ rowsValid: 2, rowsToCreate: 1, rowsToUpdate: 1 });
    expect((await apply(job)).body).toMatchObject({ status: 'APPLIED', rowsApplied: 2 });
    expect(await audits('Supplier', 'CREATE')).toBe(registered + 1);
    const changed = await get(world, world.manager, `/suppliers/${existing.id}`);
    expect(changed.body).toMatchObject({ name: 'Ashaiman Feeds', phone: '+233244550001', categories: [{ code: 'LIVE' }] });
    const listed = (await get(world, world.manager, '/suppliers?q=Dodowa')).body.data[0];
    expect(listed).toMatchObject({ name: 'Dodowa Poultry', phone: '+233244550002', email: 'sales@example.com' });
    expect(listed.categories.map((category: { code: string }) => category.code).sort()).toEqual(['EGGS', 'MEAT']);
  });

  it('exports the suppliers with no tax number column, audited with the row count', async () => {
    const { audited, rows } = await exported('SUPPLIER');
    expect(rows[0]).toEqual(['supplierNo', 'name', 'contactName', 'phone', 'email', 'address', 'categories']);
    expect(audited).toMatchObject({ entity: 'SUPPLIER', rowCount: rows.length - 1, bulk: false });
    expect(rows.length - 1).toBe(await count(world, 'SELECT count(*)::int AS n FROM mdm.supplier WHERE deleted_at IS NULL'));
  });
});

describe('locations (FR-MDM-006, FR-MDM-019)', () => {
  const header = 'branch,code,name,kind,parent,isSellable,tempClass,tempMinC,tempMaxC,capacityHead';

  it('reports an unknown branch and parent, a cold room without temperatures and a virtual location, and writes nothing', async () => {
    await world.database.pool('app').query("INSERT INTO mdm.location (id, branch_id, code, name, kind, is_virtual, allows_negative, created_by, updated_by) SELECT $1, id, 'V-LOSS', 'Virtual: loss', 'LOSS', true, true, $2, $2 FROM mdm.branch WHERE code = 'DDW'", [randomUUID(), SYSTEM_PRINCIPAL]);
    const locations = await count(world, 'SELECT count(*)::int AS n FROM mdm.location');
    const job = await dryRun('LOCATION', csv(header, 'KSI,STORE-1,Store,STORE,,,,,,', 'DDW,PEN-9,Pen 9,PEN,BARN-1,,,,,', 'DDW,CR-1,Cold room,COLD_ROOM,,,CHILLED,,,', 'DDW,V-LOSS,Loss,,,,,,,'));
    expect(job).toMatchObject({ rowsTotal: 4, rowsValid: 0, rowsToCreate: 3, rowsToUpdate: 1 });
    expect(await errorsOf(job)).toEqual([
      { rowNo: 2, column: 'branch', message: 'Unknown branch "KSI"' },
      { rowNo: 3, column: 'parent', message: 'No location "BARN-1" in branch DDW, and no row above creates it' },
      { rowNo: 4, column: 'tempMaxC', message: 'A cold room needs tempClass CHILLED or FROZEN, tempMinC and tempMaxC' },
      { rowNo: 4, column: 'tempMinC', message: 'A cold room needs tempClass CHILLED or FROZEN, tempMinC and tempMaxC' },
      { rowNo: 5, column: 'code', message: 'A virtual location cannot change' },
    ]);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.location')).toBe(locations);
  });

  it('creates a site and the pens below it in one file, and changes a location named by its code', async () => {
    const created = await audits('Location', 'CREATE');
    const job = await dryRun('LOCATION', csv(header, 'DDW,SITE-2,North site,SITE,,,,,,', 'DDW,PEN-21,Pen 21,PEN,SITE-2,,,,,40', 'DDW,CR-1,Cold room 1,COLD_ROOM,SITE-2,true,CHILLED,0,4,', 'DDW,PENS,Goat pens east,,SITE-2,,,,,120'));
    expect(job).toMatchObject({ rowsValid: 4, rowsToCreate: 3, rowsToUpdate: 1 });
    const applied = await apply(job);
    expect(applied.status, JSON.stringify(applied.body)).toBe(202);
    expect(await audits('Location', 'CREATE')).toBe(created + 3);
    const tree = await world.database.pool('admin').query<{ code: string; parent: string | null; temp_min_c: string | null; capacity_head: number | null; name: string }>(
      "SELECT l.code, p.code AS parent, l.temp_min_c::text, l.capacity_head, l.name FROM mdm.location l LEFT JOIN mdm.location p ON p.id = l.parent_id JOIN mdm.branch b ON b.id = l.branch_id WHERE b.code = 'DDW' AND l.code IN ('SITE-2', 'PEN-21', 'CR-1', 'PENS') ORDER BY l.code",
    );
    expect(tree.rows).toEqual([
      { code: 'CR-1', parent: 'SITE-2', temp_min_c: '0.0', capacity_head: null, name: 'Cold room 1' },
      { code: 'PEN-21', parent: 'SITE-2', temp_min_c: null, capacity_head: 40, name: 'Pen 21' },
      { code: 'PENS', parent: 'SITE-2', temp_min_c: null, capacity_head: 120, name: 'Goat pens east' },
      { code: 'SITE-2', parent: null, temp_min_c: null, capacity_head: null, name: 'North site' },
    ]);
  });

  it("refuses to apply rows for a branch the manager holds no grant at, writing none of the file's rows (ADR-0017)", async () => {
    const job = await dryRun('LOCATION', csv(header, 'DDW,STORE-9,Feed store,STORE,,,,,,', 'ACC,STORE-1,Accra store,STORE,,,,,,'));
    expect(job).toMatchObject({ rowsValid: 2, rowsToCreate: 2 });
    const before = await count(world, 'SELECT count(*)::int AS n FROM mdm.location');
    const refusals = await failures();
    const refused = await apply(job);
    expect(refused.status).toBe(403);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.location')).toBe(before);
    expect(await failures()).toBe(refusals + 1);
    expect(await count(world, 'SELECT count(*)::int AS n FROM mdm.location WHERE branch_id = $1', [accraBranchId])).toBe(2);
  });

  it('exports the physical locations with their parents by code and no virtual one, audited with the row count', async () => {
    const { audited, rows } = await exported('LOCATION');
    expect(rows[0]).toEqual(header.split(','));
    expect(rows.some((row) => row[1] === 'V-LOSS')).toBe(false);
    expect(rows).toContainEqual(['DDW', 'CR-1', 'Cold room 1', 'COLD_ROOM', 'SITE-2', 'TRUE', 'CHILLED', '0.0', '4.0', '']);
    expect(audited).toMatchObject({ entity: 'LOCATION', rowCount: rows.length - 1 });
    expect(rows.length - 1).toBe(await count(world, 'SELECT count(*)::int AS n FROM mdm.location WHERE deleted_at IS NULL AND NOT is_virtual'));
  });
});

describe('price list entries: into a draft version, never an active one (FR-MDM-015, FR-MDM-019)', () => {
  const header = 'priceList,sku,grade,weightBand,minQty,basis,listPricePesewas,floorPricePesewas,ceilingPricePesewas,quoteOnly';
  let listId: string;
  let activeId: string;
  let draftId: string;
  const entriesOf = async (versionId: string) =>
    (
      await world.database.pool('admin').query<{ sku: string; grade: string | null; list: string; floor: string; ceiling: string; min_qty: string }>(
        `SELECT p.sku, g.code AS grade, e.list_price_pesewas::text AS list, e.floor_price_pesewas::text AS floor, e.ceiling_price_pesewas::text AS ceiling, e.min_qty::text
           FROM mdm.price_list_entry e JOIN mdm.product p ON p.id = e.product_id LEFT JOIN mdm.grade g ON g.id = e.grade_id
          WHERE e.version_id = $1 ORDER BY p.sku, g.code NULLS FIRST, e.min_qty`,
        [versionId],
      )
    ).rows;

  beforeAll(async () => {
    await refreshAll(world);
    const list = await post(world, world.manager, '/price-lists', { code: 'RETAIL', name: 'Retail prices', kind: 'BASE', taxInclusive: true });
    expect(list.status, JSON.stringify(list.body)).toBe(201);
    listId = list.body.id as string;
    expect((await post(world, world.manager, '/price-lists', { code: 'ONLINE', name: 'Online prices', kind: 'CHANNEL', channel: 'ONLINE', taxInclusive: true })).status).toBe(201);
    // Version 1 is drafted through the sheet, approved by the owner and active.
    const first = await post(world, world.manager, `/price-lists/${listId}/versions`, { validFrom: world.clock.now().toISOString() });
    activeId = first.body.id as string;
  });

  it('reports a price in cedis, a floor above its list, an unknown grade, a list with no draft and two rows for one entry, and writes no entry', async () => {
    const job = await dryRun(
      'PRICE_LIST_ENTRY',
      csv(
        header,
        'RETAIL,GOAT-LIVE,A,B20-25,,PER_HEAD,90000,80000,100000,',
        'RETAIL,GOAT-LIVE,,B20-25,,PER_HEAD,850.00,75000,95000,',
        'RETAIL,BEEF-15KG,,,,PER_KG,8000,9000,10000,',
        'RETAIL,GOAT-LIVE,Z,,,PER_HEAD,1,1,1,',
        'ONLINE,EGGS-30,,,,PER_UNIT,6000,5500,6500,',
        'RETAIL,GOAT-LIVE,A,B20-25,0.000,PER_HEAD,91000,80000,100000,',
      ),
    );
    expect(job).toMatchObject({ rowsTotal: 6, rowsValid: 1 });
    expect(await errorsOf(job)).toEqual([
      { rowNo: 3, column: 'listPricePesewas', message: 'listPricePesewas must be a whole number of pesewas, such as 85000 for GHS 850.00' },
      { rowNo: 4, column: 'floorPricePesewas', message: 'The floor price is above the list price' },
      { rowNo: 5, column: 'grade', message: 'Unknown grade "Z" for this product\'s species' },
      { rowNo: 6, column: 'priceList', message: 'Price list ONLINE has no draft version: draft one before importing its prices' },
      { rowNo: 7, column: 'sku', message: 'Duplicate of row 2' },
    ]);
    expect(await entriesOf(activeId)).toEqual([]);
  });

  it('writes the entries into the draft with exact pesewas, and the owner approves them live', async () => {
    const job = await dryRun('PRICE_LIST_ENTRY', csv(header, 'RETAIL,GOAT-LIVE,A,B20-25,,PER_HEAD,90000,80000,100000,', 'RETAIL,GOAT-LIVE,,B20-25,,PER_HEAD,85000,75000,95000,', 'RETAIL,BEEF-15KG,,,,PER_KG,8000,7000,9000,'));
    expect(job).toMatchObject({ rowsValid: 3, rowsToCreate: 3, rowsToUpdate: 0 });
    expect((await apply(job)).body).toMatchObject({ status: 'APPLIED', rowsApplied: 3 });
    expect(await entriesOf(activeId)).toEqual([
      { sku: 'BEEF-15KG', grade: null, list: '8000', floor: '7000', ceiling: '9000', min_qty: '0.000' },
      { sku: 'GOAT-LIVE', grade: null, list: '85000', floor: '75000', ceiling: '95000', min_qty: '0.000' },
      { sku: 'GOAT-LIVE', grade: 'A', list: '90000', floor: '80000', ceiling: '100000', min_qty: '0.000' },
    ]);
    const submitted = await post(world, world.manager, `/price-list-versions/${activeId}/submit`);
    expect(submitted.status).toBe(202);
    // A submitted version is never written by an import.
    const pending = await dryRun('PRICE_LIST_ENTRY', csv(header, 'RETAIL,BEEF-15KG,,,,PER_KG,1,1,1,'));
    expect(await errorsOf(pending)).toEqual([{ rowNo: 2, column: 'priceList', message: 'Price list RETAIL has a version waiting for approval, which cannot change' }]);
    await stepUp(world, world.owner);
    const approved = await post(world, world.owner, `/iam/approvals/${submitted.body.approvalRequestId as string}/approve`, { reason: 'Checked against the market' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await get(world, world.manager, `/price-list-versions/${activeId}`)).body.status).toBe('ACTIVE');
  });

  it('replaces a matching entry and adds a new one in the next draft, leaving the active version exactly as approved', async () => {
    const draft = await post(world, world.manager, `/price-lists/${listId}/versions`, { validFrom: new Date(world.clock.now().getTime() + 86_400_000).toISOString(), copyFromVersionId: activeId });
    expect(draft.status).toBe(201);
    draftId = draft.body.id as string;
    const job = await dryRun('PRICE_LIST_ENTRY', csv(header, 'RETAIL,GOAT-LIVE,A,B20-25,,PER_HEAD,95000,85000,105000,', 'retail,beef-15kg,,,10,per_kg,7500,6500,8500,'));
    expect(job).toMatchObject({ rowsValid: 2, rowsToCreate: 1, rowsToUpdate: 1 });
    expect((await apply(job)).status).toBe(202);
    expect(await entriesOf(draftId)).toEqual([
      { sku: 'BEEF-15KG', grade: null, list: '8000', floor: '7000', ceiling: '9000', min_qty: '0.000' },
      { sku: 'BEEF-15KG', grade: null, list: '7500', floor: '6500', ceiling: '8500', min_qty: '10.000' },
      { sku: 'GOAT-LIVE', grade: null, list: '85000', floor: '75000', ceiling: '95000', min_qty: '0.000' },
      { sku: 'GOAT-LIVE', grade: 'A', list: '95000', floor: '85000', ceiling: '105000', min_qty: '0.000' },
    ]);
    expect(await entriesOf(activeId)).toEqual([
      { sku: 'BEEF-15KG', grade: null, list: '8000', floor: '7000', ceiling: '9000', min_qty: '0.000' },
      { sku: 'GOAT-LIVE', grade: null, list: '85000', floor: '75000', ceiling: '95000', min_qty: '0.000' },
      { sku: 'GOAT-LIVE', grade: 'A', list: '90000', floor: '80000', ceiling: '100000', min_qty: '0.000' },
    ]);
  });

  it('exports the prices in force, from the active version and not the draft, audited with the row count', async () => {
    const { audited, rows } = await exported('PRICE_LIST_ENTRY');
    expect(rows[0]).toEqual(header.split(','));
    expect(rows.slice(1)).toHaveLength(3);
    expect(rows).toContainEqual(['RETAIL', 'GOAT-LIVE', 'A', 'B20-25', '0.000', 'PER_HEAD', '90000', '80000', '100000', 'FALSE']);
    expect(rows.some((row) => row[6] === '95000')).toBe(false);
    expect(audited).toMatchObject({ entity: 'PRICE_LIST_ENTRY', rowCount: 3, bulk: false });
  });
});
