import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { toBusinessDate, type ManualClock } from '@hakorem/kernel';
import request from 'supertest';
import { Billing, type IssueRequest } from '../../src/modules/bil';
import { ProviderPayments, Refunds } from '../../src/modules/pay';
import { runAsSystem, runWithRequestContext, type Actor } from '../../src/platform/context/request-context';
import { UnitOfWork } from '../../src/platform/database/unit-of-work';
import type { FakePaystack, FakeTransaction } from './fake-paystack';
import { consolePost, type TestSession } from './iam';
import type { TestApp } from './test-app';
import type { TestDatabase } from './test-database';

const SCHEDULER = { principalId: '01900000-0000-7000-8000-000000000004', displayName: 'Scheduler' };

/** A journal's lines as posted for a source document, straight from SQL: account code, side, amount, party. */
export async function journalOf(database: TestDatabase, sourceDocumentId: string, eventCode?: string): Promise<Array<[string, string, number, string | null]>> {
  const { rows } = await database.pool('admin').query<{ code: string; side: string; amount: string; party: string | null }>(
    `SELECT a.code, l.side, l.amount_pesewas::text AS amount, s.display_name AS party
       FROM fin.journal_entry e JOIN fin.journal_line l ON l.journal_entry_id = e.id JOIN fin.account a ON a.id = l.account_id
       LEFT JOIN fin.subledger_party s ON s.id = l.subledger_party_id
      WHERE e.source_document_id = $1 AND ($2::text IS NULL OR e.event_code = $2) ORDER BY e.entry_no, l.line_no`,
    [sourceDocumentId, eventCode ?? null],
  );
  return rows.map((r) => [r.code, r.side, Number(r.amount), r.party]);
}

export async function journalCount(database: TestDatabase, sourceDocumentId: string, eventCode: string): Promise<number> {
  const { rows } = await database.pool('admin').query<{ n: string }>('SELECT count(*)::text AS n FROM fin.journal_entry WHERE source_document_id = $1 AND event_code = $2', [sourceDocumentId, eventCode]);
  return Number(rows[0]!.n);
}

/** The ledger's signed sum over every line: zero when the books balance. */
export async function trialBalanceSum(database: TestDatabase): Promise<string> {
  const { rows } = await database.pool('admin').query<{ signed: string }>("SELECT COALESCE(sum(CASE side WHEN 'D' THEN amount_pesewas ELSE -amount_pesewas END), 0)::text AS signed FROM fin.journal_line");
  return rows[0]!.signed;
}

/** An account's balance against one subledger party (debit positive). */
export async function balanceOf(database: TestDatabase, code: string, party: string): Promise<number> {
  const { rows } = await database.pool('admin').query<{ balance: string }>(
    `SELECT COALESCE(sum(CASE l.side WHEN 'D' THEN l.amount_pesewas ELSE -l.amount_pesewas END), 0)::text AS balance
       FROM fin.journal_line l JOIN fin.account a ON a.id = l.account_id JOIN fin.subledger_party s ON s.id = l.subledger_party_id
      WHERE a.code = $1 AND s.display_name = $2`,
    [code, party],
  );
  return Number(rows[0]!.balance);
}

/** Issues a zero-rated invoice of exactly `grossPesewas` to a customer, as a selling module would (Billing.issueIn). */
export async function issueInvoice(
  app: TestApp,
  actor: Actor,
  clock: ManualClock,
  at: { branchId: string; customerId: string; productId: string },
  grossPesewas: bigint,
  dueDate: string = toBusinessDate(clock.now()),
): Promise<{ id: string; documentNo: string }> {
  const billing = app.app.get(Billing);
  const uow = app.app.get(UnitOfWork);
  const issue: IssueRequest = {
    kind: 'INVOICE',
    branchId: at.branchId,
    customerId: at.customerId,
    dueDate,
    taxInclusive: true,
    lines: [{ lineKind: 'PRODUCT', productId: at.productId, quantity: '1.000', unitPricePesewas: grossPesewas, resolvedUnitPricePesewas: grossPesewas }],
  };
  const issued = await runWithRequestContext({ correlationId: randomUUID(), ip: null, userAgent: 'payment test', actor }, () =>
    uow.run({ isolation: 'serializable', seriesLocks: billing.seriesLocksFor('INVOICE', at.branchId) }, (tx) => billing.issueIn(tx, actor, issue)),
  );
  return { id: issued.id, documentNo: issued.documentNo! };
}

/** Starts a mobile money charge over the API. */
export function initiateCharge(server: Server, session: TestSession, body: Record<string, unknown>, key: string = randomUUID()) {
  return consolePost(server, session, '/v1/payments/mobile-money', key).send({ id: randomUUID(), payerPhone: '+233244512876', network: 'MTN', ...body });
}

/** Delivers a webhook body as the provider would, raw and signed (or with the signature given). */
export function deliverWebhook(server: Server, hook: { body: string; signature: string }) {
  return request(server).post('/v1/webhooks/payments/PAYSTACK').set('Content-Type', 'application/json').set('X-Paystack-Signature', hook.signature).send(hook.body);
}

/** The customer approves at the provider and the provider sends its signed webhook. */
export async function approveAndDeliver(server: Server, fake: FakePaystack, reference: string, options: { amount?: number; webhookAmount?: number } = {}): Promise<{ status: number; transaction: FakeTransaction }> {
  const t = fake.approve(reference, options.amount === undefined ? {} : { amount: options.amount });
  const response = await deliverWebhook(server, fake.webhook(t, options.webhookAmount === undefined ? {} : { amount: options.webhookAmount }));
  return { status: response.status, transaction: t };
}

/** One run of the provider sweep, as the worker's Scheduler runs it. */
export function runSweep(app: TestApp) {
  return runAsSystem(SCHEDULER, randomUUID(), () => app.app.get(ProviderPayments).sweep({ principalId: SCHEDULER.principalId }));
}

/** One run of the refund dispatch, as the worker's Scheduler runs it. */
export function runRefundDispatch(app: TestApp) {
  return runAsSystem(SCHEDULER, randomUUID(), () => app.app.get(Refunds).dispatch());
}

/** Our reference for a payment's charge. */
export function referenceFor(paymentId: string): string {
  return `HK-${paymentId}`;
}
