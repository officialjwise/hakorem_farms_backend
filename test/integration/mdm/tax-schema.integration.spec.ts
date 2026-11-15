import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TAX_CATEGORY } from '../../support/catalogue';
import { createBranch, SYSTEM_PRINCIPAL } from '../../support/iam';
import { SQLSTATE, sqlStateOf } from '../../support/sql-state';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/** Every rule migration 0014 puts in the database, each violated once (FR-MDM-012, ADR-0020, ADR-0039). */
let database: TestDatabase;
let app: pg.Pool;
let branchId: string;
let checker: string;
let versionNo = 0;

const LEVY = { VAT: '01900000-0000-7000-8000-000000000501', NHIL: '01900000-0000-7000-8000-000000000502', GETFUND: '01900000-0000-7000-8000-000000000503' } as const;
const STANDARD_RATES: Readonly<Record<keyof typeof LEVY, string>> = { VAT: '15', NHIL: '2.5', GETFUND: '2.5' };
const STANDARD_CATEGORIES = new Set<string>([TAX_CATEGORY.PROCESSED_MEAT, TAX_CATEGORY.DELIVERY_SERVICE, '01900000-0000-7000-8000-000000000207']);

async function draft(validFrom = '2026-01-01', validTo: string | null = null): Promise<string> {
  const id = randomUUID();
  versionNo += 1;
  await app.query("INSERT INTO platform.business_document (id, doc_type, owner_module, branch_id, actor_id) VALUES ($1, 'TAX_SCHEME_VERSION', 'mdm', $2, $3)", [id, branchId, SYSTEM_PRINCIPAL]);
  await app.query(
    `INSERT INTO mdm.tax_scheme_version (id, version_no, status, valid_from, valid_to, source_note, branch_id, created_by, updated_by)
     VALUES ($1, $2, 'DRAFT', $3, $4, 'Fixture rates', $5, $6, $6)`,
    [id, versionNo, validFrom, validTo, branchId, SYSTEM_PRINCIPAL],
  );
  return id;
}

function cell(versionId: string, categoryId: string, levyId: string, fields: { treatment?: string; rate?: string; baseKind?: string; calcOrder?: number } = {}) {
  const id = randomUUID();
  return app
    .query(
      `INSERT INTO mdm.tax_category_levy (id, version_id, tax_category_id, levy_id, treatment, rate_percent, base_kind, is_reclaimable, calc_order, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $9)`,
      [id, versionId, categoryId, levyId, fields.treatment ?? 'ZERO_RATED', fields.rate ?? '0', fields.baseKind ?? 'NET', fields.calcOrder ?? 1, SYSTEM_PRINCIPAL],
    )
    .then(() => id);
}

/** The seeded matrix shape: 15, 2.5 and 2.5 percent on the standard categories, zero-rated elsewhere. */
async function fullMatrix(versionId: string): Promise<void> {
  const { rows } = await app.query<{ id: string }>('SELECT id FROM mdm.tax_category WHERE deleted_at IS NULL');
  for (const category of rows) {
    for (const [order, code] of (['VAT', 'NHIL', 'GETFUND'] as const).entries()) {
      const standard = STANDARD_CATEGORIES.has(category.id);
      await cell(versionId, category.id, LEVY[code], { treatment: standard ? 'STANDARD' : 'ZERO_RATED', rate: standard ? STANDARD_RATES[code] : '0', calcOrder: order + 1 });
    }
  }
}

/** Requests the approval and marks the version in one transaction, as the service does: a refusal leaves neither. */
async function submit(versionId: string): Promise<void> {
  const approvalId = randomUUID();
  const client = await app.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO iam.approval_request (id, kind, branch_id, subject_document_id, payload_hash, summary, requested_by, status)
       VALUES ($1, 'TAX_SCHEME_ACTIVATION', $2, $3, $4, 'Activate a tax scheme version', $5, 'PENDING')`,
      [approvalId, branchId, versionId, Buffer.alloc(32), SYSTEM_PRINCIPAL],
    );
    await client.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'PENDING_APPROVAL', approval_request_id = $2 WHERE id = $1", [versionId, approvalId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function activate(versionId: string, validFrom?: string) {
  return app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'ACTIVE', activated_at = now(), activated_by = $2, valid_from = COALESCE($3::date, valid_from) WHERE id = $1", [
    versionId,
    checker,
    validFrom ?? null,
  ]);
}

/** Ends every open or active version, so each test starts with no open draft and nothing in force. */
async function clearVersions(): Promise<void> {
  await app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'SUPERSEDED' WHERE status = 'ACTIVE'");
  await app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'REJECTED' WHERE status = 'PENDING_APPROVAL'");
  const { rows } = await app.query<{ id: string }>("SELECT id FROM mdm.tax_scheme_version WHERE status = 'DRAFT'");
  for (const row of rows) {
    await app.query('SELECT mdm.clear_draft_tax_cells($1)', [row.id]);
    await fullMatrix(row.id);
    await submit(row.id);
    await app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'REJECTED' WHERE id = $1", [row.id]);
  }
}

beforeAll(async () => {
  database = await createTestDatabase();
  app = database.pool('app');
  branchId = (await createBranch(database)).branchId;
  checker = randomUUID();
  await app.query("INSERT INTO iam.principal (id, kind, display_name, status, created_by, updated_by) VALUES ($1, 'USER', 'Kwabena Owusu', 'ACTIVE', $2, $2)", [checker, SYSTEM_PRINCIPAL]);
});

beforeEach(clearVersions);

afterAll(async () => {
  await database.drop();
});

describe('tax levies (ADR-0020)', () => {
  it('seeds VAT, NHIL and GETFund, in print order', async () => {
    const { rows } = await app.query<{ code: string }>('SELECT code FROM mdm.tax_levy WHERE deleted_at IS NULL ORDER BY sort_order');
    expect(rows.map((row) => row.code)).toEqual(['VAT', 'NHIL', 'GETFUND']);
  });
});

describe('tax matrix cells (FR-MDM-012)', () => {
  it('refuses a rate on a cell that is not STANDARD', async () => {
    const versionId = await draft();
    expect(await sqlStateOf(cell(versionId, TAX_CATEGORY.EGGS, LEVY.VAT, { treatment: 'ZERO_RATED', rate: '15' }))).toBe(SQLSTATE.checkViolation);
  });

  it('refuses a second cell for one category and levy, and two levies of one category at one calculation order', async () => {
    const versionId = await draft();
    await cell(versionId, TAX_CATEGORY.EGGS, LEVY.VAT, { calcOrder: 1 });
    expect(await sqlStateOf(cell(versionId, TAX_CATEGORY.EGGS, LEVY.VAT, { calcOrder: 2 }))).toBe(SQLSTATE.uniqueViolation);
    expect(await sqlStateOf(cell(versionId, TAX_CATEGORY.EGGS, LEVY.NHIL, { calcOrder: 1 }))).toBe(SQLSTATE.uniqueViolation);
  });

  it('refuses a rate above 100 percent or below zero', async () => {
    const versionId = await draft();
    expect(await sqlStateOf(cell(versionId, TAX_CATEGORY.PROCESSED_MEAT, LEVY.VAT, { treatment: 'STANDARD', rate: '100.0001' }))).toBe(SQLSTATE.checkViolation);
    expect(await sqlStateOf(cell(versionId, TAX_CATEGORY.PROCESSED_MEAT, LEVY.VAT, { treatment: 'STANDARD', rate: '-1' }))).toBe(SQLSTATE.checkViolation);
  });

  it('accepts a compounding base of an earlier levy of the same category, and refuses any other', async () => {
    const versionId = await draft();
    const nhil = await cell(versionId, TAX_CATEGORY.PROCESSED_MEAT, LEVY.NHIL, { treatment: 'STANDARD', rate: '2.5', calcOrder: 1 });
    const vat = await cell(versionId, TAX_CATEGORY.PROCESSED_MEAT, LEVY.VAT, { treatment: 'STANDARD', rate: '15', calcOrder: 2, baseKind: 'NET_PLUS_LEVIES' });
    const eggsNhil = await cell(versionId, TAX_CATEGORY.EGGS, LEVY.NHIL, { calcOrder: 1 });
    const component = (owner: string, included: string) =>
      app.query('INSERT INTO mdm.tax_levy_base_component (tax_category_levy_id, included_category_levy_id, created_by) VALUES ($1, $2, $3)', [owner, included, SYSTEM_PRINCIPAL]);

    await component(vat, nhil);
    expect(await sqlStateOf(component(nhil, vat))).toBe(SQLSTATE.checkViolation); // NHIL is NET, and VAT comes after it
    expect(await sqlStateOf(component(vat, eggsNhil))).toBe(SQLSTATE.checkViolation); // another category
    expect(await sqlStateOf(component(vat, vat))).toBe(SQLSTATE.checkViolation); // itself: not earlier
  });

  it('lets hk_app delete no cell; only the definer function empties a draft', async () => {
    const versionId = await draft();
    await cell(versionId, TAX_CATEGORY.EGGS, LEVY.VAT);
    expect(await sqlStateOf(app.query('DELETE FROM mdm.tax_category_levy WHERE version_id = $1', [versionId]))).toBe(SQLSTATE.insufficientPrivilege);
    const { rows } = await app.query<{ removed: number }>('SELECT mdm.clear_draft_tax_cells($1) AS removed', [versionId]);
    expect(rows[0]!.removed).toBe(1);
  });
});

describe('tax scheme version lifecycle (FR-MDM-012, ADR-0039)', () => {
  it('refuses to submit a version missing the EGGS/NHIL cell: missing never means zero', async () => {
    const versionId = await draft();
    const { rows } = await app.query<{ id: string }>('SELECT id FROM mdm.tax_category WHERE deleted_at IS NULL');
    for (const category of rows) {
      for (const [order, levy] of [LEVY.VAT, LEVY.NHIL, LEVY.GETFUND].entries()) {
        if (!(category.id === TAX_CATEGORY.EGGS && levy === LEVY.NHIL)) {
          await cell(versionId, category.id, levy, { calcOrder: order + 1 });
        }
      }
    }

    expect(await sqlStateOf(submit(versionId))).toBe(SQLSTATE.checkViolation);
    const { rows: status } = await app.query<{ status: string }>('SELECT status FROM mdm.tax_scheme_version WHERE id = $1', [versionId]);
    expect(status[0]!.status).toBe('DRAFT');
  });

  it('refuses a version that lacks a cell for a levy added after its cells were written', async () => {
    const versionId = await draft();
    await fullMatrix(versionId);
    const levyId = randomUUID();
    await app.query("INSERT INTO mdm.tax_levy (id, code, name, sort_order, created_by, updated_by) VALUES ($1, 'COVID', 'COVID-19 Health Recovery Levy', 4, $2, $2)", [levyId, SYSTEM_PRINCIPAL]);
    try {
      expect(await sqlStateOf(submit(versionId))).toBe(SQLSTATE.checkViolation);
    } finally {
      await app.query("UPDATE mdm.tax_levy SET version = version + 1, deleted_at = now(), deleted_by = $2, delete_reason = 'fixture' WHERE id = $1", [levyId, SYSTEM_PRINCIPAL]);
    }
  });

  it('freezes the cells once submitted: no insert, update or removal, even through the definer function', async () => {
    const versionId = await draft();
    await fullMatrix(versionId);
    await submit(versionId);

    expect(await sqlStateOf(app.query("UPDATE mdm.tax_category_levy SET version = version + 1, rate_percent = 0, treatment = 'EXEMPT' WHERE version_id = $1", [versionId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(cell(versionId, TAX_CATEGORY.EGGS, LEVY.VAT, { calcOrder: 9 }))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query('SELECT mdm.clear_draft_tax_cells($1)', [versionId]))).toBe(SQLSTATE.documentFrozen);
  });

  it('refuses a second open version while one is a draft', async () => {
    await draft();
    expect(await sqlStateOf(draft('2027-01-01'))).toBe(SQLSTATE.uniqueViolation);
  });

  it('refuses two ACTIVE versions whose dates overlap, and accepts one that starts where the other ends', async () => {
    const first = await draft('2026-01-01', '2026-12-01');
    await fullMatrix(first);
    await submit(first);
    await activate(first);
    const overlapping = await draft('2026-11-01');
    await fullMatrix(overlapping);
    await submit(overlapping);
    expect(await sqlStateOf(activate(overlapping))).toBe(SQLSTATE.exclusionViolation);
    await app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'REJECTED' WHERE id = $1", [overlapping]);

    const adjacent = await draft('2026-12-01');
    await fullMatrix(adjacent);
    await submit(adjacent);
    await activate(adjacent);
  });

  it('lets activation move the first day later, never earlier, and freezes an ACTIVE version but for an earlier end', async () => {
    const versionId = await draft('2026-11-01');
    await fullMatrix(versionId);
    await submit(versionId);
    expect(await sqlStateOf(activate(versionId, '2026-10-01'))).toBe(SQLSTATE.documentFrozen);
    await activate(versionId, '2026-11-14');

    expect(await sqlStateOf(app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, source_note = 'changed' WHERE id = $1", [versionId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, valid_from = '2026-11-20' WHERE id = $1", [versionId]))).toBe(SQLSTATE.documentFrozen);
    await app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, valid_to = '2027-01-01' WHERE id = $1", [versionId]);
    expect(await sqlStateOf(app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, valid_to = '2027-06-01' WHERE id = $1", [versionId]))).toBe(SQLSTATE.documentFrozen);
    expect(await sqlStateOf(app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'DRAFT' WHERE id = $1", [versionId]))).toBe(SQLSTATE.documentFrozen);
  });

  it('refuses an ACTIVE version without an approval or without who activated it', async () => {
    const versionId = await draft('2028-01-01');
    await fullMatrix(versionId);
    expect(await sqlStateOf(app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'PENDING_APPROVAL' WHERE id = $1", [versionId]))).toBe(SQLSTATE.checkViolation);
    await submit(versionId);
    expect(await sqlStateOf(app.query("UPDATE mdm.tax_scheme_version SET version = version + 1, status = 'ACTIVE' WHERE id = $1", [versionId]))).toBe(SQLSTATE.checkViolation);
  });
});
