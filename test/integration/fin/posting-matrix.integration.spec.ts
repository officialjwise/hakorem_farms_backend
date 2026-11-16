import { randomUUID } from 'node:crypto';
import { Money, Quantity } from '@hakorem/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAsSystem } from '../../../src/platform/context/request-context';
import { UnitOfWork } from '../../../src/platform/database/unit-of-work';
import { DomainEvents } from '../../../src/platform/events/domain-events';
import { LedgerCatalogueIncompleteError, LedgerPostings } from '../../../src/modules/fin';
import { Stock } from '../../../src/modules/inv';
import { SYSTEM_PRINCIPAL } from '../../support/iam';
import { createStockFixture, stockDocument, type StockFixture } from '../../support/inventory';
import { startTestApp, type TestApp } from '../../support/test-app';
import { createTestDatabase, type TestDatabase } from '../../support/test-database';

/**
 * ADR-0003's event-to-posting matrix, row by row, for every event a module publishes today (A-182): each event is
 * published through the real event bus in a serializable transaction, FIN's handler posts it through the rules seeded
 * by migration 0123, and the test asserts every line's account, side, exact amount and subledger. Then the guarantees
 * around it: a correction reverses the original's lines, a zero value posts nothing, a replay collides, a refused
 * posting rolls the stock movement back, and the boot assertion names a missing handler or rule (FR-FIN-005).
 */
let database: TestDatabase;
let api: TestApp;
let fx: StockFixture;
let supplierId: string;

type Line = [code: string, side: 'D' | 'C', amount: number, party: string | null];

async function publish(type: string, payload: Record<string, unknown>, subjectId: string = randomUUID()): Promise<string> {
  const uow = api.app.get(UnitOfWork);
  const events = api.app.get(DomainEvents);
  return runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'System' }, randomUUID(), () =>
    uow.run({ isolation: 'serializable' }, async (tx) => (await events.publish(tx, { type, subjectType: 'Test', subjectId, branchId: fx.branchId, payload })).id),
  );
}

async function journalOf(eventId: string): Promise<{ kind: string; entryNo: string; reverses: string | null; lines: Line[] } | null> {
  const entry = await fx.app.query<{ id: string; kind: string; entry_no: string; reverses_entry_id: string | null }>(
    'SELECT id, kind, entry_no, reverses_entry_id FROM fin.journal_entry WHERE event_id = $1',
    [eventId],
  );
  if (entry.rows[0] === undefined) return null;
  const { rows } = await fx.app.query<{ code: string; side: 'D' | 'C'; amount: string; party: string | null }>(
    `SELECT a.code, l.side, l.amount_pesewas AS amount, p.kind || ':' || p.display_name AS party
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id LEFT JOIN fin.subledger_party p ON p.id = l.subledger_party_id
      WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
    [entry.rows[0].id],
  );
  return {
    kind: entry.rows[0].kind,
    entryNo: entry.rows[0].entry_no,
    reverses: entry.rows[0].reverses_entry_id,
    lines: rows.map((r) => [r.code, r.side, Number(r.amount), r.party]),
  };
}

async function linesOf(type: string, payload: Record<string, unknown>): Promise<Line[]> {
  return (await journalOf(await publish(type, payload)))!.lines;
}

const movement = async (productId: string, movementType: string, valuePesewas: number, reasonCode: string | null = null, extra: Record<string, unknown> = {}) => ({
  movementId: randomUUID(),
  movementType,
  productId,
  stockUnitId: null,
  fromLocationId: fx.virtual.SUPPLIER,
  toLocationId: fx.store,
  qty: '1.000',
  valuePesewas,
  costElement: null,
  reasonCode,
  sourceDocumentId: await stockDocument(fx),
  reversesMovementId: null,
  ...extra,
});

beforeAll(async () => {
  database = await createTestDatabase();
  fx = await createStockFixture(database);
  supplierId = randomUUID();
  await fx.app.query("INSERT INTO mdm.supplier (id, supplier_no, name, status, created_by, updated_by) VALUES ($1, 'S-0457', 'Kpone Livestock Traders', 'ACTIVE', $2, $2)", [supplierId, SYSTEM_PRINCIPAL]);
  api = await startTestApp(database);
});

afterAll(async () => {
  await api?.close();
  await database.drop();
});

describe('every row of the ADR-0003 matrix posts exact debit and credit amounts (A-182)', () => {
  it('inv.GoodsReceived: inventory of the GL group debited, goods received not invoiced credited', async () => {
    expect(await linesOf('inv.GoodsReceived', await movement(fx.goat, 'RECEIPT_PURCHASE', 71_400))).toEqual([
      ['1310', 'D', 71_400, null],
      ['2010', 'C', 71_400, null],
    ]);
  });

  it('inv.ProductionReceived: eggs at standard cost against own production capitalised', async () => {
    expect(await linesOf('inv.ProductionReceived', await movement(fx.eggs, 'RECEIPT_HARVEST', 3_500))).toEqual([
      ['1330', 'D', 3_500, null],
      ['5210', 'C', 3_500, null],
    ]);
  });

  it('inv.OpeningStockLoaded: meat against opening balance equity', async () => {
    expect(await linesOf('inv.OpeningStockLoaded', await movement(fx.beef, 'OPENING_BALANCE', 540_000))).toEqual([
      ['1320', 'D', 540_000, null],
      ['3900', 'C', 540_000, null],
    ]);
  });

  it('inv.CostCapitalised: feed capitalised onto growing animals', async () => {
    expect(await linesOf('inv.CostCapitalised', await movement(fx.goat, 'COST_CAPITALISE', 1_250))).toEqual([
      ['1310', 'D', 1_250, null],
      ['1300', 'C', 1_250, null],
    ]);
  });

  it('inv.UpkeepExpensed: feed for breeding stock expensed to breeding herd upkeep', async () => {
    const payload = { stockUnitId: randomUUID(), productId: fx.goat, branchId: fx.branchId, locationId: fx.pens, valuePesewas: 800, costElement: 'FEED', sourceDocumentId: await stockDocument(fx), sourceLineRef: null };
    expect(await linesOf('inv.UpkeepExpensed', payload)).toEqual([
      ['5200', 'D', 800, null],
      ['1300', 'C', 800, null],
    ]);
  });

  it('inv.StockConsumedInProcessing and inv.ProcessingOutputReceived: through work in progress (FR-FIN-007)', async () => {
    expect(await linesOf('inv.StockConsumedInProcessing', await movement(fx.goat, 'PROCESS_CONSUME', 71_400))).toEqual([
      ['1340', 'D', 71_400, null],
      ['1310', 'C', 71_400, null],
    ]);
    expect(await linesOf('inv.ProcessingOutputReceived', await movement(fx.beef, 'PROCESS_OUTPUT', 69_568))).toEqual([
      ['1320', 'D', 69_568, null],
      ['1340', 'C', 69_568, null],
    ]);
  });

  it('inv.StockIssuedForSale and inv.SaleReturnReceived: cost of sales of the GL group', async () => {
    expect(await linesOf('inv.StockIssuedForSale', await movement(fx.goat, 'SALE_ISSUE', 71_400))).toEqual([
      ['5000', 'D', 71_400, null],
      ['1310', 'C', 71_400, null],
    ]);
    expect(await linesOf('inv.SaleReturnReceived', await movement(fx.eggs, 'SALE_RETURN', 3_500, 'WRONG_ITEM'))).toEqual([
      ['1330', 'D', 3_500, null],
      ['5020', 'C', 3_500, null],
    ]);
  });

  it('inv.StockWrittenOff: mortality to 5100, wastage to 5120, shrinkage and a write-off with no loss group to 5110', async () => {
    expect(await linesOf('inv.StockWrittenOff', await movement(fx.goat, 'MORTALITY', 60_000, 'DISEASE_SUSPECTED'))).toEqual([
      ['5100', 'D', 60_000, null],
      ['1310', 'C', 60_000, null],
    ]);
    expect(await linesOf('inv.StockWrittenOff', await movement(fx.eggs, 'ADJUST_LOSS', 1_750, 'EXPIRED'))).toEqual([
      ['5120', 'D', 1_750, null],
      ['1330', 'C', 1_750, null],
    ]);
    expect(await linesOf('inv.StockWrittenOff', await movement(fx.beef, 'ADJUST_LOSS', 12_000, 'COUNT_ERROR'))).toEqual([
      ['5110', 'D', 12_000, null],
      ['1320', 'C', 12_000, null],
    ]);
    expect(await linesOf('inv.StockWrittenOff', await movement(fx.beef, 'STOCKTAKE_LOSS', 333, null))).toEqual([
      ['5110', 'D', 333, null],
      ['1320', 'C', 333, null],
    ]);
  });

  it('inv.StockGainRecorded and inv.SupplierReturnIssued', async () => {
    expect(await linesOf('inv.StockGainRecorded', await movement(fx.eggs, 'STOCKTAKE_GAIN', 700, 'FOUND_STOCK'))).toEqual([
      ['1330', 'D', 700, null],
      ['5110', 'C', 700, null],
    ]);
    expect(await linesOf('inv.SupplierReturnIssued', await movement(fx.beef, 'SUPPLIER_RETURN', 27_500, 'DAMAGED'))).toEqual([
      ['2010', 'D', 27_500, null],
      ['1320', 'C', 27_500, null],
    ]);
  });

  it('prc.DirectCostIncurred and prc.ProcessingOrderReversed: labour into and out of work in progress (A-162, A-182)', async () => {
    const order = randomUUID();
    expect(
      await linesOf('prc.DirectCostIncurred', { processingOrderId: order, processingCostId: randomUUID(), costKind: 'LABOUR', valuePesewas: 5_000, branchId: fx.branchId, sourceDocumentId: await stockDocument(fx) }),
    ).toEqual([
      ['1340', 'D', 5_000, null],
      ['2020', 'C', 5_000, null],
    ]);
    expect(
      await linesOf('prc.ProcessingOrderReversed', { processingOrderId: order, processingReversalId: await stockDocument(fx), branchId: fx.branchId, directCostPesewas: 5_000, inputCostPesewas: 71_400, totalCostPesewas: 76_400 }),
    ).toEqual([
      ['5110', 'D', 5_000, null],
      ['1340', 'C', 5_000, null],
    ]);
  });

  it('pur.SupplierInvoiceMatched: receipt 110,000 then invoice at 111,000 posts 2010 110,000, 5140 1,000 and 2000 111,000 (FR-PUR-015)', async () => {
    const invoice = { supplierInvoiceId: await stockDocument(fx), supplierId, grossPesewas: 111_000, lines: [{ lineNo: 1, netPesewas: 111_000, orderValuePesewas: 110_000, expenseCategory: null }], levies: [] };
    expect(await linesOf('pur.SupplierInvoiceMatched', invoice)).toEqual([
      ['2010', 'D', 110_000, null],
      ['5140', 'D', 1_000, null],
      ['2000', 'C', 111_000, 'SUPPLIER:Kpone Livestock Traders'],
    ]);
  });

  it('pur.SupplierInvoiceMatched with a reclaimable levy debits 1400 against the levy', async () => {
    const levyId = randomUUID();
    const invoice = {
      supplierInvoiceId: await stockDocument(fx),
      supplierId,
      grossPesewas: 115_000,
      lines: [{ lineNo: 1, netPesewas: 100_000, orderValuePesewas: 100_000, expenseCategory: null }],
      levies: [{ lineNo: 1, levyId, levyCode: 'VAT', amountPesewas: 15_000, isReclaimable: true }],
    };
    expect(await linesOf('pur.SupplierInvoiceMatched', invoice)).toEqual([
      ['2010', 'D', 100_000, null],
      ['1400', 'D', 15_000, 'TAX_LEVY:VAT'],
      ['2000', 'C', 115_000, 'SUPPLIER:Kpone Livestock Traders'],
    ]);
  });

  it('pur.ExpenseInvoiceApproved: the goats transport, 15,000, to administration against the supplier', async () => {
    const invoice = { supplierInvoiceId: await stockDocument(fx), supplierId, grossPesewas: 15_000, lines: [{ lineNo: 1, netPesewas: 15_000, orderValuePesewas: null, expenseCategory: null }], levies: [] };
    expect(await linesOf('pur.ExpenseInvoiceApproved', invoice)).toEqual([
      ['6800', 'D', 15_000, null],
      ['2000', 'C', 15_000, 'SUPPLIER:Kpone Livestock Traders'],
    ]);
  });

  it('pur.SupplierCreditNoteApproved: payables debited, 2010 cleared at the returned cost, the rest to purchase price variance', async () => {
    const credit = {
      creditNoteId: await stockDocument(fx),
      supplierId,
      purchaseOrderId: randomUUID(),
      grossPesewas: 30_000,
      lines: [{ lineNo: 1, netPesewas: 30_000, orderValuePesewas: 28_000, expenseCategory: null }],
      levies: [],
      returns: [{ lineNo: 1, movementId: randomUUID(), productId: fx.beef, qty: '2.000', costPesewas: 27_500 }],
    };
    expect(await linesOf('pur.SupplierCreditNoteApproved', credit)).toEqual([
      ['2000', 'D', 30_000, 'SUPPLIER:Kpone Livestock Traders'],
      ['2010', 'C', 27_500, null],
      ['5140', 'C', 2_500, null],
    ]);
  });

  it('pur.SupplierPaymentMade: payables debited, the safe credited for cash and the wallet for mobile money (A-185)', async () => {
    const payment = async (method: string, amountPesewas: number) => ({ supplierPaymentId: await stockDocument(fx), supplierId, method, amountPesewas, paidAt: new Date().toISOString(), approvalRequestId: randomUUID(), allocations: [] });
    expect(await linesOf('pur.SupplierPaymentMade', await payment('CASH', 15_000))).toEqual([
      ['2000', 'D', 15_000, 'SUPPLIER:Kpone Livestock Traders'],
      ['1010', 'C', 15_000, null],
    ]);
    expect(await linesOf('pur.SupplierPaymentMade', await payment('MOBILE_MONEY', 40_000))).toEqual([
      ['2000', 'D', 40_000, 'SUPPLIER:Kpone Livestock Traders'],
      ['1110', 'C', 40_000, 'BANK_ACCOUNT:Bank account not yet named'],
    ]);
  });
});

describe('around the matrix', () => {
  it('reverses a movement by swapping the original lines, linking the entry it reverses', async () => {
    const original = await movement(fx.goat, 'RECEIPT_PURCHASE', 64_000);
    const first = (await journalOf(await publish('inv.GoodsReceived', original)))!;
    const reversal = (await journalOf(await publish('inv.GoodsReceived', await movement(fx.goat, 'RECEIPT_PURCHASE', 64_000, null, { reversesMovementId: original.movementId }))))!;
    expect(reversal.kind).toBe('REVERSAL');
    expect(reversal.lines).toEqual([
      ['1310', 'C', 64_000, null],
      ['2010', 'D', 64_000, null],
    ]);
    const { rows } = await fx.app.query<{ id: string }>('SELECT id FROM fin.journal_entry WHERE entry_no = $1', [first.entryNo]);
    expect(reversal.reverses).toBe(rows[0]!.id);
  });

  it('posts nothing for a zero-value receipt, as ADR-0003 says for harvest at nil standard cost', async () => {
    expect(await journalOf(await publish('inv.ProductionReceived', await movement(fx.eggs, 'RECEIPT_HARVEST', 0)))).toBeNull();
  });

  it('numbers every entry in one gap-free journal series for the branch and year', async () => {
    const { rows } = await fx.app.query<{ entry_no: string }>("SELECT entry_no FROM fin.journal_entry WHERE branch_id = $1 ORDER BY entry_no", [fx.branchId]);
    const year = new Date().getUTCFullYear();
    expect(rows.map((r) => r.entry_no)).toEqual(rows.map((_, i) => `JNL-${year}-DDW-${(BigInt(i) + 1n).toString().padStart(6, '0')}`));
  });

  it('rolls back the stock movement whole when its posting is refused, here for a locked period', async () => {
    const stock = api.app.get(Stock);
    const uow = api.app.get(UnitOfWork);
    const today = new Date();
    const { rows: period } = await fx.app.query<{ id: string }>('SELECT id FROM fin.accounting_period WHERE start_date <= $1::date AND end_date >= $1::date', [today.toISOString().slice(0, 10)]);
    await fx.app.query("UPDATE fin.accounting_period SET status = 'LOCKED', locked_at = now(), locked_by = $1, version = version + 1 WHERE id = $2", [SYSTEM_PRINCIPAL, period[0]!.id]);
    const sourceDocumentId = await stockDocument(fx);
    try {
      await expect(
        runAsSystem({ principalId: SYSTEM_PRINCIPAL, displayName: 'System' }, randomUUID(), () =>
          uow.run({ isolation: 'serializable' }, (tx) =>
            stock.postIn(tx, fx.actor, {
              movementType: 'RECEIPT_PURCHASE',
              productId: fx.eggs,
              branchId: fx.branchId,
              fromLocationId: fx.virtual.SUPPLIER,
              toLocationId: fx.store,
              qty: Quantity.parse('10.000'),
              value: Money.ofPesewas(35_000n),
              costElement: 'PURCHASE',
              sourceDocumentId,
              occurredAt: today,
            }),
          ),
        ),
      ).rejects.toMatchObject({ code: 'PERIOD_NOT_OPEN', status: 422 });
    } finally {
      await fx.app.query("UPDATE fin.accounting_period SET status = 'OPEN', locked_at = NULL, locked_by = NULL, version = version + 1 WHERE id = $1", [period[0]!.id]);
    }
    const { rows } = await fx.app.query('SELECT 1 FROM inv.stock_movement WHERE source_document_id = $1', [sourceDocumentId]);
    expect(rows).toHaveLength(0);
  });

  it('collides a replayed event on its event id, so an event never posts twice', async () => {
    const eventId = await publish('inv.GoodsReceived', await movement(fx.eggs, 'RECEIPT_PURCHASE', 900));
    const { rows } = await fx.app.query<Record<string, unknown>>('SELECT * FROM fin.journal_entry WHERE event_id = $1', [eventId]);
    const entry = rows[0]!;
    await expect(
      fx.app.query(
        `INSERT INTO fin.journal_entry (id, entry_no, posting_date, period_id, branch_id, kind, event_code, event_id, source_document_id, posting_group_id, description, occurred_at, actor_id)
         VALUES ($1, 'JNL-REPLAY', $2, $3, $4, 'AUTO', $5, $6, $7, $8, 'replay', now(), $9)`,
        [randomUUID(), entry.posting_date, entry.period_id, entry.branch_id, entry.event_code, eventId, entry.source_document_id, randomUUID(), SYSTEM_PRINCIPAL],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_journal_entry_event' });
  });
});

describe('the boot assertion (ADR-0003 safeguard one, FR-FIN-005)', () => {
  it('passes for the catalogue as built, every declared event handled with a complete rule set', async () => {
    const events = api.app.get(DomainEvents);
    expect(events.declaredLedgerEvents()).toEqual(api.app.get(LedgerPostings).handledTypes());
    await api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) => api.app.get(LedgerPostings).assertCatalogueIn(tx, events.declaredLedgerEvents()));
  });

  it('declares exactly the posting events of the movement types, and the upkeep event', async () => {
    const { rows } = await fx.app.query<{ code: string }>('SELECT DISTINCT posting_event AS code FROM inv.movement_type WHERE posting_event IS NOT NULL ORDER BY 1');
    const declared = api.app.get(DomainEvents).declaredLedgerEvents().filter((t) => t.startsWith('inv.'));
    expect(declared).toEqual([...rows.map((r) => r.code), 'inv.UpkeepExpensed'].sort());
  });

  it('fails naming the event when a handler is removed', async () => {
    const postings = api.app.get(LedgerPostings);
    const handled = postings.handledTypes().filter((t) => t !== 'inv.StockWrittenOff');
    await expect(
      api.app.get(UnitOfWork).run({ isolation: 'read committed' }, (tx) => postings.assertCatalogueIn(tx, api.app.get(DomainEvents).declaredLedgerEvents(), handled)),
    ).rejects.toThrow('inv.StockWrittenOff has no posting handler');
  });

  it('stops the application starting when a rule is removed, naming the event', async () => {
    const other = await createTestDatabase();
    try {
      await other.pool('admin').query("DELETE FROM fin.posting_rule WHERE event_code = 'pur.SupplierCreditNoteApproved' AND amount_key = 'returnCost'");
      const refused = await startTestApp(other).then(
        async (started) => {
          await started.close();
          return null;
        },
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(LedgerCatalogueIncompleteError);
      expect((refused as LedgerCatalogueIncompleteError).gaps).toEqual(['pur.SupplierCreditNoteApproved: amount "returnCost" has no posting rule in force']);
    } finally {
      await other.drop();
    }
  });
});
