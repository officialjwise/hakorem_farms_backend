import { randomUUID } from 'node:crypto';
import { toBusinessDate } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Billing } from '../../../src/modules/bil';
import { Approvals } from '../../../src/modules/iam';
import { TaxAdmin, type TaxCellRequest } from '../../../src/modules/mdm';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { runSeedUnits } from '../../../src/seed/run-seed';
import { SeedStaff } from '../../../src/seed/seed-staff';
import { seedUnits } from '../../../src/seed/seed-units';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * ADR-0020's verification, the B08 continued 2 gate: a fourth levy is added as data only, through MDM's tax
 * administration (a levy row and a new scheme version, approved by a second person), with no change to billing, the
 * ledger or any table. An invoice issued afterwards shows four levy rows on each line and the ledger posts four levy
 * lines on 2100, each against its own levy party, through the one TAX_LEVY / OUTPUT rule; an invoice issued before
 * keeps its three.
 */
let database: TestDatabase;
let api: TestApp;
const admin = () => database.pool('admin');

beforeAll(async () => {
  database = await createTestDatabase();
  api = await startTestApp(database);
  await runSeedUnits(database.pool('app'), api.app, seedUnits({ SEED_STAFF_PASSWORD: `Seed-${randomUUID()}` }));
});

afterAll(async () => {
  await api?.close();
  await database?.drop();
});

async function levyLinesOf(documentId: string): Promise<{ side: string; amount: number; party: string }[]> {
  const { rows } = await admin().query<{ side: string; amount: string; party: string }>(
    `SELECT l.side, l.amount_pesewas::text AS amount, s.display_name AS party
       FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
       JOIN fin.subledger_party s ON s.id = l.subledger_party_id
      WHERE e.source_document_id = $1 AND a.code = '2100' ORDER BY l.line_no`,
    [documentId],
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

describe('a fourth levy is data only (ADR-0020, FR-BIL-004)', () => {
  it('issues an invoice with four levy rows and posts four levy lines against four parties, with no code or table change', async () => {
    const staff = await SeedStaff.load(api.app);
    const billing = api.app.get(Billing);
    const uow = api.app.get(UnitOfWork);
    const tax = api.app.get(TaxAdmin);
    const branchId = (await admin().query<{ id: string }>("SELECT id FROM mdm.branch WHERE code = 'DDW'")).rows[0]!.id;
    const tema = (await admin().query<{ id: string }>("SELECT id FROM mdm.customer WHERE name = 'Tema Cold Store Ltd (SEED)'")).rows[0]!.id;
    const meat = (await admin().query<{ id: string }>("SELECT id FROM mdm.product WHERE sku = 'MEAT-0007'")).rows[0]!.id;
    const invoice = () =>
      staff.as('accountant', (accountant) =>
        uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('INVOICE', branchId) }, (tx) =>
          billing.issueIn(tx, accountant, {
            kind: 'INVOICE',
            branchId,
            customerId: tema,
            taxInclusive: false,
            lines: [{ lineKind: 'PRODUCT', productId: meat, quantity: '1.000', uom: 'PACK', unitPricePesewas: 40_000n }],
          }),
        ),
      );
    const before = await invoice();
    expect(before.lines[0]!.levies.map((l) => l.levyCode)).toEqual(['VAT', 'NHIL', 'GETFUND']);

    // The data change: a levy, and a scheme version copying today's cells with a row per category for it.
    const active = (await admin().query<{ id: string }>("SELECT id FROM mdm.tax_scheme_version WHERE status = 'ACTIVE' ORDER BY valid_from DESC LIMIT 1")).rows[0]!.id;
    const cells = await admin().query<{ tax_category_id: string; levy_id: string; treatment: TaxCellRequest['treatment']; rate_percent: string; base_kind: TaxCellRequest['baseKind']; is_reclaimable: boolean; calc_order: number }>(
      'SELECT tax_category_id, levy_id, treatment, rate_percent::text, base_kind, is_reclaimable, calc_order FROM mdm.tax_category_levy WHERE version_id = $1',
      [active],
    );
    const categories = [...new Set(cells.rows.map((c) => c.tax_category_id))];
    const standard = new Set(cells.rows.filter((c) => c.treatment === 'STANDARD').map((c) => c.tax_category_id));
    const pending = await staff.as('accountant', async (accountant) => {
      const levy = await tax.createLevy(accountant, { code: 'COVID', name: 'COVID-19 Health Recovery Levy', sortOrder: 4 }, 'test:fourth-levy:levy');
      const version = await tax.createVersion(accountant, { validFrom: toBusinessDate(new Date()), sourceNote: 'A fourth levy, as data only (test)' }, 'test:fourth-levy:version');
      const matrix: TaxCellRequest[] = [
        ...cells.rows.map((c) => ({ taxCategoryId: c.tax_category_id, levyId: c.levy_id, treatment: c.treatment, ratePercent: c.rate_percent, baseKind: c.base_kind, isReclaimable: c.is_reclaimable, calcOrder: c.calc_order })),
        ...categories.map((categoryId) => ({
          taxCategoryId: categoryId,
          levyId: levy.body.id,
          treatment: standard.has(categoryId) ? ('STANDARD' as const) : ('ZERO_RATED' as const),
          ratePercent: standard.has(categoryId) ? '1' : '0',
          baseKind: 'NET' as const,
          isReclaimable: true,
          calcOrder: 4,
        })),
      ];
      const filled = await tax.replaceCells(accountant, version.body.id, { version: version.body.version, cells: matrix }, 'test:fourth-levy:cells');
      return tax.submit(accountant, filled.body.id, 'test:fourth-levy:submit');
    });
    await staff.as('owner', (owner) => uow.run({ isolation: 'serializable' }, (tx) => api.app.get(Approvals).decide(tx, owner, pending.body.approvalRequestId, 'APPROVED', 'A fourth levy (test)')));

    const after = await invoice();
    // 40,000 net: VAT 6,000, NHIL 1,000, GETFund 1,000, COVID 400.
    expect(after.lines[0]!.levies.map((l) => [l.levyCode, l.ratePercent, l.amountPesewas])).toEqual([
      ['VAT', '15.00', 6_000],
      ['NHIL', '2.50', 1_000],
      ['GETFUND', '2.50', 1_000],
      ['COVID', '1.00', 400],
    ]);
    expect(after.levyTotals.map((t) => t.levyCode)).toEqual(['VAT', 'NHIL', 'GETFUND', 'COVID']);
    expect([after.netPesewas, after.taxPesewas, after.grossPesewas]).toEqual([40_000, 8_400, 48_400]);
    expect(await levyLinesOf(after.id)).toEqual([
      { side: 'C', amount: 6_000, party: 'VAT' },
      { side: 'C', amount: 1_000, party: 'NHIL' },
      { side: 'C', amount: 1_000, party: 'GETFUND' },
      { side: 'C', amount: 400, party: 'COVID' },
    ]);
    const parties = await admin().query<{ n: number }>(
      "SELECT count(DISTINCT l.subledger_party_id)::int AS n FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id WHERE e.source_document_id = $1 AND a.code = '2100'",
      [after.id],
    );
    expect(parties.rows[0]!.n).toBe(4);
    // The invoice issued before keeps its three rows and three postings.
    const earlier = await admin().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM bil.billing_document_line_tax t JOIN bil.billing_document_line l ON l.id = t.billing_document_line_id WHERE l.billing_document_id = $1',
      [before.id],
    );
    expect(earlier.rows[0]!.n).toBe(3);
    expect(await levyLinesOf(before.id)).toHaveLength(3);
  });
});
