import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCatalogue, TAX_CATEGORY } from '../../support/catalogue';
import { createBranch, SYSTEM_PRINCIPAL } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** Every rule migration 0011 puts in the database, each violated once (FR-MDM-005, FR-MDM-015, FR-MDM-021). */
let database: TestDatabase;
let app: pg.Pool;
let branchId: string;
let goatSpeciesId: string;
let goatProductId: string;
let listId: string;
let approver: string;
const RETAIL_TIER = '01900000-0000-7000-8000-000000000301';

async function principal(name: string): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', $2, 'ACTIVE', $3, $3)", [id, name, SYSTEM_PRINCIPAL]);
  return id;
}

function insertBand(code: string, min: string, max: string) {
  return app.query('INSERT INTO mdm.weight_band (id, species_id, code, min_kg, max_kg, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [
    randomUUID(),
    goatSpeciesId,
    code,
    min,
    max,
    SYSTEM_PRINCIPAL,
  ]);
}

/** A CUSTOMER list of its own, so each test has its one draft (uq_price_list_version_draft) without a slot clash. */
async function freshList(): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO mdm.price_list (id, code, name, kind, tax_inclusive, created_by, updated_by) VALUES ($1, $2, 'Fixture list', 'CUSTOMER', true, $3, $3)", [
    id,
    `FIX-${id.slice(0, 8).toUpperCase()}`,
    SYSTEM_PRINCIPAL,
  ]);
  return id;
}

async function version(fields: { validFrom: string; validTo?: string | null; versionNo: number; listId?: string }): Promise<string> {
  const id = randomUUID();
  await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'PRICE_LIST_VERSION', 'mdm', $2, $3)", [
    id,
    branchId,
    SYSTEM_PRINCIPAL,
  ]);
  await app.query(
    `INSERT INTO mdm.price_list_version (id, price_list_id, version_no, status, valid_from, valid_to, branch_id, created_by, updated_by)
     VALUES ($1, $2, $3, 'DRAFT', $4, $5, $6, $7, $7)`,
    [id, fields.listId ?? (await freshList()), fields.versionNo, fields.validFrom, fields.validTo ?? null, branchId, SYSTEM_PRINCIPAL],
  );
  return id;
}

async function approvalFor(versionId: string): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, summary, requested_by, status)
     VALUES ($1, 'PRICE_LIST_ACTIVATION', $2, $3, $4, 'Activate a price list version', $5, 'PENDING')`,
    [id, branchId, versionId, Buffer.alloc(32), SYSTEM_PRINCIPAL],
  );
  return id;
}

/** Drafts, submits and activates a version straight in SQL, as the application does it. */
async function activate(versionId: string): Promise<void> {
  const approval = await approvalFor(versionId);
  await app.query("UPDATE mdm.price_list_version SET status = 'PENDING_APPROVAL', approval_request_id = $2, version = version + 1 WHERE id = $1", [versionId, approval]);
  await app.query("UPDATE mdm.price_list_version SET status = 'ACTIVE', activated_at = now(), activated_by = $2, version = version + 1 WHERE id = $1", [versionId, approver]);
}

function insertEntry(versionId: string, fields: { list: number; floor: number; ceiling: number; quoteOnly?: boolean; bandId?: string | null }) {
  return app.query(
    `INSERT INTO mdm.price_list_entry (id, version_id, product_id, weight_band_id, basis, list_price_pesewas, floor_price_pesewas, ceiling_price_pesewas,
                                       quote_only, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'PER_HEAD', $5, $6, $7, $8, $9, $9)`,
    [randomUUID(), versionId, goatProductId, fields.bandId ?? null, fields.list, fields.floor, fields.ceiling, fields.quoteOnly ?? false, SYSTEM_PRINCIPAL],
  );
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = database.pool('app');
  ({ branchId } = await createBranch(database));
  const catalogue = await createCatalogue(database);
  goatSpeciesId = catalogue.goatSpeciesId;
  goatProductId = randomUUID();
  await app.query(
    `INSERT INTO mdm.product (id, sku, name, category_id, stock_policy, tracking, species_id, base_uom, sale_uom, tax_category_id, gl_group, online_mode, status, created_by, updated_by)
     VALUES ($1, 'LIV-GOAT', 'Goat', $2, 'SERIALISED', 'SERIAL', $3, 'HEAD', 'HEAD', $4, 'LIVE_ANIMALS', 'REQUEST_TO_BUY', 'ACTIVE', $5, $5)`,
    [goatProductId, catalogue.liveCategoryId, goatSpeciesId, TAX_CATEGORY.LIVE_ANIMALS, SYSTEM_PRINCIPAL],
  );
  listId = randomUUID();
  await app.query("INSERT INTO mdm.price_list (id, code, name, kind, tax_inclusive, created_by, updated_by) VALUES ($1, 'BASE', 'Base prices', 'BASE', true, $2, $2)", [
    listId,
    SYSTEM_PRINCIPAL,
  ]);
  approver = await principal('Akosua Boateng');
});

afterAll(async () => {
  await database.drop();
});

describe('weight bands (FR-MDM-005)', () => {
  it('accepts 10.000 to 20.000 and 20.000 to 30.000, and refuses 19.500 to 25.000 by exclusion', async () => {
    await insertBand('GOAT-S', '10.000', '20.000');
    await insertBand('GOAT-M', '20.000', '30.000');
    expect(await sqlStateOf(insertBand('GOAT-X', '19.500', '25.000'))).toBe(SQLSTATE.exclusionViolation);
  });

  it('refuses a band that ends where it starts', async () => {
    expect(await sqlStateOf(insertBand('GOAT-Z', '40.000', '40.000'))).toBe(SQLSTATE.checkViolation);
  });
});

describe('price lists occupy one slot each', () => {
  it('refuses a second BASE list for every branch, and a TIER list without its tier', async () => {
    const insert = (code: string, kind: string, channel: string | null, tier: string | null) =>
      app.query('INSERT INTO mdm.price_list (id, code, name, kind, channel, customer_tier_id, tax_inclusive, created_by, updated_by) VALUES ($1, $2, $2, $3, $4, $5, true, $6, $6)', [
        randomUUID(),
        code,
        kind,
        channel,
        tier,
        SYSTEM_PRINCIPAL,
      ]);
    expect(await sqlStateOf(insert('BASE-2', 'BASE', null, null))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(insert('TIER-1', 'TIER', 'WHOLESALE', null))).toBe(SQLSTATE.checkViolation);
    await insert('TIER-RETAIL-POS', 'TIER', 'POS', RETAIL_TIER);
    await insert('CUST-A', 'CUSTOMER', null, null);
    await insert('CUST-B', 'CUSTOMER', null, null);
  });
});

describe('price list versions (FR-MDM-015)', () => {
  it('refuses an ACTIVE version without an approval or an activation record', async () => {
    const id = await version({ validFrom: '2026-01-01T00:00:00Z', validTo: '2026-02-01T00:00:00Z', versionNo: 90 });
    expect(await sqlStateOf(app.query("UPDATE mdm.price_list_version SET status = 'PENDING_APPROVAL', version = version + 1 WHERE id = $1", [id]))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses two ACTIVE versions of one list overlapping 1-30 Nov and 15 Nov-15 Dec', async () => {
    const november = await version({ validFrom: '2026-11-01T00:00:00Z', validTo: '2026-12-01T00:00:00Z', versionNo: 1, listId });
    await insertEntry(november, { list: 90_000, floor: 80_000, ceiling: 100_000 });
    await activate(november);
    const overlapping = await version({ validFrom: '2026-11-15T00:00:00Z', validTo: '2026-12-15T00:00:00Z', versionNo: 2, listId });
    expect(await sqlStateOf(activate(overlapping))).toBe(SQLSTATE.exclusionViolation);
  });

  it('allows one draft or submitted version per list at a time', async () => {
    expect(await sqlStateOf(version({ validFrom: '2027-01-01T00:00:00Z', versionNo: 5, listId }))).toBe(SQLSTATE.uniqueViolation);
  });

  it('freezes an ACTIVE version: its entries, its start and a longer end are refused; an earlier end and SUPERSEDED are not', async () => {
    const { rows } = await app.query<{ id: string }>("SELECT id FROM mdm.price_list_version WHERE price_list_id = $1 AND status = 'ACTIVE'", [listId]);
    const active = rows[0]!.id;
    expect(await sqlStateOf(insertEntry(active, { list: 70_000, floor: 60_000, ceiling: 80_000 }))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('UPDATE mdm.price_list_entry SET list_price_pesewas = 85000, version = version + 1 WHERE version_id = $1', [active]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('SELECT mdm.clear_draft_price_list_entries($1)', [active]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.price_list_version SET notes = 'edited', version = version + 1 WHERE id = $1", [active]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.price_list_version SET valid_from = '2026-11-02T00:00:00Z', version = version + 1 WHERE id = $1", [active]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.price_list_version SET valid_to = '2027-01-01T00:00:00Z', version = version + 1 WHERE id = $1", [active]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.price_list_version SET status = 'DRAFT', version = version + 1 WHERE id = $1", [active]))).toBe(SQLSTATE.documentFrozen);
    await app.query("UPDATE mdm.price_list_version SET valid_to = '2026-11-20T00:00:00Z', version = version + 1 WHERE id = $1", [active]);
    await app.query("UPDATE mdm.price_list_version SET status = 'SUPERSEDED', version = version + 1 WHERE id = $1", [active]);
    expect(await sqlStateOf(app.query("UPDATE mdm.price_list_version SET status = 'ACTIVE', version = version + 1 WHERE id = $1", [active]))).toBe(SQLSTATE.documentFrozen);
  });

  it('lets activation move the start later, never earlier', async () => {
    const id = await version({ validFrom: '2027-03-01T00:00:00Z', versionNo: 3 });
    const approval = await approvalFor(id);
    await app.query("UPDATE mdm.price_list_version SET status = 'PENDING_APPROVAL', approval_request_id = $2, version = version + 1 WHERE id = $1", [id, approval]);
    const earlier = app.query(
      "UPDATE mdm.price_list_version SET status = 'ACTIVE', valid_from = '2027-02-01T00:00:00Z', activated_at = now(), activated_by = $2, version = version + 1 WHERE id = $1",
      [id, approver],
    );
    expect(await sqlStateOf(earlier)).toBe(SQLSTATE.documentFrozen);
    await app.query(
      "UPDATE mdm.price_list_version SET status = 'ACTIVE', valid_from = '2027-03-02T00:00:00Z', activated_at = now(), activated_by = $2, version = version + 1 WHERE id = $1",
      [id, approver],
    );
  });
});

describe('price list entries (FR-MDM-015)', () => {
  let draft: string;

  beforeAll(async () => {
    draft = await version({ validFrom: '2028-01-01T00:00:00Z', versionNo: 4 });
  });

  it('refuses floor 90,000 above list 80,000, and a priced entry with a zero floor', async () => {
    expect(await sqlStateOf(insertEntry(draft, { list: 80_000, floor: 90_000, ceiling: 100_000 }))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(insertEntry(draft, { list: 80_000, floor: 0, ceiling: 100_000 }))).toBe(SQLSTATE.checkViolation);
  });

  it('accepts a quote-only entry with no price, then refuses a second entry for the same product, grade and band', async () => {
    await insertEntry(draft, { list: 0, floor: 0, ceiling: 0, quoteOnly: true });
    expect(await sqlStateOf(insertEntry(draft, { list: 90_000, floor: 80_000, ceiling: 100_000 }))).toBe(SQLSTATE.uniqueViolation);
  });

  it('lets the clearing function empty a DRAFT version, and hk_app delete nothing itself', async () => {
    expect(await sqlStateOf(app.query('DELETE FROM mdm.price_list_entry WHERE version_id = $1', [draft]))).toBe(SQLSTATE.insufficientPrivilege);
    const { rows } = await app.query<{ removed: number }>('SELECT mdm.clear_draft_price_list_entries($1) AS removed', [draft]);
    expect(rows[0]!.removed).toBe(1);
  });
});

describe('customer price list assignment (FR-MDM-021)', () => {
  it('assigns only a CUSTOMER list, and at most one at a time', async () => {
    const customerId = randomUUID();
    await app.query(
      `INSERT INTO mdm.customer (id, customer_no, kind, name, tier_id, status, created_by, updated_by)
       VALUES ($1, 'C-00001', 'BUSINESS', 'Accra Caterers', $2, 'ACTIVE', $3, $3)`,
      [customerId, RETAIL_TIER, SYSTEM_PRINCIPAL],
    );
    const { rows } = await app.query<{ id: string }>("SELECT id FROM mdm.price_list WHERE code = 'CUST-A'");
    const assign = (list: string, from: string, to: string | null) =>
      app.query('INSERT INTO mdm.customer_price_list (id, customer_id, price_list_id, valid_from, valid_to, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [
        randomUUID(),
        customerId,
        list,
        from,
        to,
        SYSTEM_PRINCIPAL,
      ]);
    expect(await sqlStateOf(assign(listId, '2026-01-01T00:00:00Z', null))).toBe(SQLSTATE.checkViolation);
    await assign(rows[0]!.id, '2026-01-01T00:00:00Z', '2026-07-01T00:00:00Z');
    expect(await sqlStateOf(assign(rows[0]!.id, '2026-06-01T00:00:00Z', null))).toBe(SQLSTATE.exclusionViolation);
    await assign(rows[0]!.id, '2026-07-01T00:00:00Z', null);
  });
});
