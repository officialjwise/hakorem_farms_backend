import { createUuidV7Generator, formatCedis, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { OrderInvalidError, QuoteRequiredError, type Orders } from '../../ord';
import { pageProbe } from '../domain/paging';
import { judgeSchedule, nextOccurrence, occurrencesBetween, type Frequency, type Schedule } from '../domain/schedule';
import type { AccountStore } from './account-store';
import type { CreditControl } from './credit-control';
import { StandingOrderInvalidError, type StatementRule } from './errors';
import type { StandingOrderLineRecord, StandingOrderRecord, StandingOrderRunRecord, StandingOrderStatus, StandingOrderStore } from './standing-order-store';
import type { Page } from './statements';

const READ = 'whl.standing_order.read';
const MANAGE = 'whl.standing_order.manage';
export const STANDING_ORDER = 'STANDING_ORDER';
const MAX_LINES = 50;
const DUE_BATCH = 100;
/** Each scheduled day's run looks back at most this far for dates it missed (the worker down), recording each as MISSED. */
const MISSED_LOOKBACK_DAYS = 31;

/** The contract's `StandingOrder`. */
export interface StandingOrderView {
  readonly id: string;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string };
  readonly status: StandingOrderStatus;
  readonly frequency: Frequency;
  /** The first of `weekdays` (the planned shape's one weekday), null for a monthly or every-n-days order. */
  readonly weekday: number | null;
  readonly weekdays: readonly number[];
  readonly dayOfMonth: number | null;
  readonly intervalDays: number | null;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly nextRunOn: string | null;
  readonly deliveryAddress: null;
  readonly lines: readonly { readonly id: string; readonly lineNo: number; readonly product: { readonly id: string; readonly sku: string; readonly name: string }; readonly quantity: string; readonly uom: string }[];
  readonly branchId: string;
  readonly version: number;
}

/** The contract's `StandingOrderRun`. */
export interface StandingOrderRunView {
  readonly runDate: string;
  readonly outcome: StandingOrderRunRecord['outcome'];
  readonly reason: string | null;
  readonly order: { readonly id: string; readonly docType: string; readonly number: string | null } | null;
  readonly recordedAt: string;
}

export interface StandingOrderLineInput {
  readonly productId: string;
  readonly quantity: string;
  readonly uom?: string | undefined;
}

export interface StandingOrderCreateRequest {
  readonly customerId: string;
  readonly frequency: Frequency;
  readonly weekday?: number | undefined;
  readonly weekdays?: readonly number[] | undefined;
  readonly dayOfMonth?: number | undefined;
  readonly intervalDays?: number | undefined;
  readonly startsOn: string;
  readonly endsOn?: string | undefined;
  readonly deliveryAddressId?: string | undefined;
  readonly lines: readonly StandingOrderLineInput[];
}

export interface StandingOrderUpdateRequest {
  readonly version: number;
  readonly weekday?: number | undefined;
  readonly weekdays?: readonly number[] | undefined;
  readonly dayOfMonth?: number | undefined;
  readonly intervalDays?: number | undefined;
  readonly endsOn?: string | undefined;
  readonly deliveryAddressId?: string | undefined;
  readonly lines?: readonly StandingOrderLineInput[] | undefined;
}

type SystemPrincipal = { readonly kind: 'SYSTEM'; readonly principalId: string };

/**
 * Standing orders (FR-WHL-004, A-320): a business customer's recurring order, kept by Sales, the Manager or the Owner
 * at the one branch they keep standing orders for. The worker's `standing-orders` job, run as the Scheduler, makes one
 * order per standing order and run date, however often it runs: each date is written once (`whl.standing_order_run`'s
 * key) in the same transaction as the order it made, under the standing order's row lock, so a second run that day
 * finds it done and a run stopped midway leaves each standing order either done for the date or untouched. A run
 * records the order it made, or the reason none was: an account on hold is skipped; a line the engine cannot price is
 * skipped; an order the credit check refuses (over the limit or past the terms, CR-046) is made PLACED and recorded
 * HELD_FOR_CREDIT, waiting for an override like any other, never confirmed by the job. A paused order makes nothing.
 * Each handler authorises first, deny by default.
 */
export class StandingOrders {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: StandingOrderStore,
    private readonly accounts: AccountStore,
    private readonly credit: CreditControl,
    private readonly orders: Orders,
    private readonly refs: MasterDataRefs,
    private readonly registry: DocumentRegistry,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** listStandingOrders: at the branches the caller reads standing orders for, newest first. */
  list(actor: Actor | undefined, query: { readonly customerId: string | null; readonly status: StandingOrderStatus | null }, cursor: string | undefined, limit: number): Promise<Page<StandingOrderView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = await this.wholeBranches(tx, actor!, READ);
      const binding = { operationId: 'listStandingOrders', principalId: actor!.principalId, filters: query };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.list(tx, { branchIds, customerId: query.customerId, status: query.status }, beforeId, pageProbe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  /** getStandingOrder: one the caller reads at its branch; any other id is not found. */
  get(actor: Actor | undefined, id: string): Promise<StandingOrderView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const order = await this.readable(tx, actor, READ, id);
      return (await this.views(tx, [order]))[0]!;
    });
  }

  /** listStandingOrderRuns: one standing order's runs, newest date first. */
  runs(actor: Actor | undefined, id: string, cursor: string | undefined, limit: number): Promise<Page<StandingOrderRunView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.readable(tx, actor, READ, id);
      const binding = { operationId: 'listStandingOrderRuns', principalId: actor!.principalId, filters: { id } };
      const before = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['runDate'] ?? null);
      const found = await this.store.runs(tx, id, before, pageProbe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      const documents = await this.registry.numberedRefs(tx, rows.flatMap((r) => (r.orderId === null ? [] : [r.orderId])));
      return {
        data: rows.map((r) => ({
          runDate: r.runDate,
          outcome: r.outcome,
          reason: r.reason,
          order: r.orderId === null ? null : { id: r.orderId, docType: documents.get(r.orderId)?.docType ?? 'SALES_ORDER', number: documents.get(r.orderId)?.number ?? null },
          recordedAt: r.recordedAt.toISOString(),
        })),
        page: { nextCursor: hasMore ? this.cursors.encode(binding, { runDate: rows.at(-1)!.runDate }) : null, limit, hasMore },
      };
    });
  }

  /** createStandingOrder: at the one branch the caller keeps standing orders for, its first run date worked out now. Replayed by its key. */
  create(actor: Actor | undefined, request: StandingOrderCreateRequest, key: string): Promise<StoredResponse<StandingOrderView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const branches = await this.wholeBranches(tx, actor!, MANAGE);
      if (branches.length !== 1) throw new StandingOrderInvalidError([{ field: '', rule: 'BRANCH_REQUIRED' }]);
      const branchId = branches[0]!;
      await this.authoriser.authorise(tx, actor, MANAGE, { branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'createStandingOrder', principalId: actor!.principalId, key, request: { ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<StandingOrderView>;

      const today = toBusinessDate(this.clock.now());
      const schedule: Schedule = {
        frequency: request.frequency,
        weekdays: weekdaysOf(request),
        dayOfMonth: request.dayOfMonth ?? null,
        intervalDays: request.intervalDays ?? null,
        startsOn: request.startsOn,
        endsOn: request.endsOn ?? null,
      };
      const broken: StatementRule[] = [...judgeSchedule(schedule), ...(await this.customerRules(tx, request.customerId))];
      if (request.startsOn < today) broken.push({ field: '/startsOn', rule: 'STARTS_IN_PAST' });
      if (request.deliveryAddressId !== undefined) broken.push({ field: '/deliveryAddressId', rule: 'FULFILMENT_NOT_AVAILABLE' });
      const lines = await this.checkLines(tx, request.lines, broken);
      if (broken.length > 0) throw new StandingOrderInvalidError(broken);

      const id = this.nextId();
      const at = this.clock.now();
      await this.registry.register(tx, { id, docType: STANDING_ORDER, ownerModule: 'whl', branchId, actorId: actor!.principalId });
      await this.store.insert(
        tx,
        { id, customerId: request.customerId, branchId, ...schedule, nextRunOn: nextOccurrence(schedule, today), salespersonId: actor!.principalId, status: 'ACTIVE' },
        actor!.principalId,
        at,
      );
      await this.store.insertLines(tx, id, lines, actor!.principalId, at);
      const view = (await this.views(tx, [(await this.store.get(tx, id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'whl', action: 'CREATE', entityType: 'StandingOrder', entityId: id, branchId, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** updateStandingOrder: the schedule's days, its end and its lines, at the version read; the next run date is worked out again. */
  update(actor: Actor | undefined, id: string, request: StandingOrderUpdateRequest, key: string): Promise<StoredResponse<StandingOrderView>> {
    return this.write(actor, id, 'updateStandingOrder', { ...request }, key, async (tx, order) => {
      if (order.version !== request.version) throw new VersionConflictError(`standing order ${id} is at version ${String(order.version)}`);
      if (order.status !== 'ACTIVE' && order.status !== 'PAUSED') throw new StandingOrderInvalidError([{ field: '', rule: 'ENDED' }]);
      const today = toBusinessDate(this.clock.now());
      const daysGiven = request.weekday !== undefined || request.weekdays !== undefined;
      const schedule: Schedule = {
        frequency: order.frequency,
        weekdays: daysGiven ? weekdaysOf(request) : order.weekdays,
        dayOfMonth: request.dayOfMonth ?? order.dayOfMonth,
        intervalDays: request.intervalDays ?? order.intervalDays,
        startsOn: order.startsOn,
        endsOn: request.endsOn ?? order.endsOn,
      };
      const broken: StatementRule[] = judgeSchedule(schedule);
      if (request.endsOn !== undefined && request.endsOn < today) broken.push({ field: '/endsOn', rule: 'ENDS_IN_PAST' });
      if (request.deliveryAddressId !== undefined) broken.push({ field: '/deliveryAddressId', rule: 'FULFILMENT_NOT_AVAILABLE' });
      const lines = request.lines === undefined ? null : await this.checkLines(tx, request.lines, broken);
      if (broken.length > 0) throw new StandingOrderInvalidError(broken);
      const at = this.clock.now();
      if (lines !== null) {
        await this.store.retireLines(tx, id, actor!.principalId, at);
        await this.store.insertLines(tx, id, lines, actor!.principalId, at);
      }
      return { ...schedule, nextRunOn: order.status === 'ACTIVE' ? await this.nextRunIn(tx, id, schedule, today) : null, status: order.status };
    });
  }

  /** pauseStandingOrder: an active order makes nothing until it is resumed. */
  pause(actor: Actor | undefined, id: string, reason: string, key: string): Promise<StoredResponse<StandingOrderView>> {
    return this.write(actor, id, 'pauseStandingOrder', { reason }, key, async (_tx, order) => {
      if (order.status !== 'ACTIVE') throw new StandingOrderInvalidError([{ field: '', rule: 'NOT_ACTIVE' }]);
      return { ...scheduleOf(order), nextRunOn: null, status: 'PAUSED' };
    }, reason);
  }

  /** resumeStandingOrder: a paused order runs again from its next date on or after today; the dates it was paused are not made up. */
  resume(actor: Actor | undefined, id: string, reason: string, key: string): Promise<StoredResponse<StandingOrderView>> {
    return this.write(actor, id, 'resumeStandingOrder', { reason }, key, async (tx, order) => {
      if (order.status !== 'PAUSED') throw new StandingOrderInvalidError([{ field: '', rule: 'NOT_PAUSED' }]);
      return { ...scheduleOf(order), nextRunOn: await this.nextRunIn(tx, id, scheduleOf(order), toBusinessDate(this.clock.now())), status: 'ACTIVE' };
    }, reason);
  }

  /** endStandingOrder: an active or paused order ends for good. */
  end(actor: Actor | undefined, id: string, reason: string, key: string): Promise<StoredResponse<StandingOrderView>> {
    return this.write(actor, id, 'endStandingOrder', { reason }, key, async (_tx, order) => {
      if (order.status !== 'ACTIVE' && order.status !== 'PAUSED') throw new StandingOrderInvalidError([{ field: '', rule: 'ENDED' }]);
      return { ...scheduleOf(order), nextRunOn: null, status: 'ENDED' };
    }, reason);
  }

  /**
   * The worker's `standing-orders` job, run as the Scheduler: every active standing order due today or before is run
   * for each date it is due, in a transaction of its own per standing order. Answers the runs written this time.
   */
  async run(system: SystemPrincipal): Promise<StandingOrderRunRecord[]> {
    if (system.kind !== 'SYSTEM') throw new Error('the standing order job runs as a SYSTEM principal only');
    const today = toBusinessDate(this.clock.now());
    const written: StandingOrderRunRecord[] = [];
    let after: string | null = null;
    for (;;) {
      const batch: string[] = await this.uow.run({ isolation: 'read committed' }, (tx) => this.store.due(tx, today, after, DUE_BATCH));
      for (const id of batch) written.push(...(await this.uow.run({ isolation: 'serializable' }, (tx) => this.runIn(tx, id, today, system))));
      if (batch.length < DUE_BATCH) return written;
      after = batch.at(-1)!;
    }
  }

  // ------------------------------------------------------------------------------------------- inside

  /** One standing order's dates due up to today, under its row lock: earlier dates MISSED, today's run made. */
  private async runIn(tx: Transaction, id: string, today: string, system: SystemPrincipal): Promise<StandingOrderRunRecord[]> {
    const order = await this.store.get(tx, id, true);
    if (order === null || order.status !== 'ACTIVE' || order.nextRunOn === null || order.nextRunOn > today) return [];
    const schedule = scheduleOf(order);
    const from = order.nextRunOn < daysBefore(today, MISSED_LOOKBACK_DAYS) ? daysBefore(today, MISSED_LOOKBACK_DAYS) : order.nextRunOn;
    const written: StandingOrderRunRecord[] = [];
    for (const date of occurrencesBetween(schedule, from, today)) {
      if (await this.store.hasRun(tx, id, date)) continue;
      const run = date < today ? this.outcome(order, date, 'MISSED', null, 'The scheduler did not run on this date; no order was made for it') : await this.makeIn(tx, order, date, system);
      if (await this.store.insertRun(tx, run, system.principalId)) written.push(run);
    }
    const next = nextOccurrence(schedule, daysAfter(today, 1));
    await this.store.change(tx, id, order.version, { ...schedule, nextRunOn: next, status: 'ACTIVE' }, system.principalId, this.clock.now());
    for (const run of written) {
      await this.audit.record(tx, { module: 'whl', action: 'STANDING_ORDER_RUN', entityType: 'StandingOrder', entityId: id, branchId: order.branchId, before: null, after: { runDate: run.runDate, outcome: run.outcome, orderId: run.orderId, reason: run.reason } });
    }
    return written;
  }

  /** Today's run: skipped on hold, the order made, and the credit check's verdict recorded beside it. */
  private async makeIn(tx: Transaction, order: StandingOrderRecord, date: string, system: SystemPrincipal): Promise<StandingOrderRunRecord> {
    const account = await this.accounts.account(tx, order.customerId, true);
    if (account === null || account.status === 'CLOSED') return this.outcome(order, date, 'FAILED', null, 'The customer has no open business account');
    if (account.status === 'ON_HOLD') return this.outcome(order, date, 'SKIPPED_ON_HOLD', null, `The account is on hold: ${account.holdReason ?? 'no reason given'}`);
    const scheduler: Actor = { principalId: system.principalId, kind: 'SYSTEM', displayName: 'Scheduler', realm: null, sessionId: null, steppedUpAt: null };
    let placed;
    try {
      placed = await this.orders.placeStandingIn(tx, scheduler, {
        standingOrderId: order.id,
        branchId: order.branchId,
        customerId: order.customerId,
        salespersonId: order.salespersonId,
        lines: order.lines.map((l) => ({ productId: l.productId, quantity: l.qty, uom: l.uom })),
      });
    } catch (error) {
      if (error instanceof QuoteRequiredError) return this.outcome(order, date, 'SKIPPED_NO_PRICE', null, 'A line has no price the engine can resolve on this date; it needs a quote');
      if (error instanceof OrderInvalidError) return this.outcome(order, date, 'FAILED', null, `The order was refused: ${error.details.map((d) => d.code).join(', ')}`);
      throw error;
    }
    const judged = await this.credit.judgeIn(tx, account, BigInt(placed.estimatedTotalPesewas));
    if (judged.outcome === 'PASSES') return this.outcome(order, date, 'CREATED', placed.id, null);
    const words = judged.reasons.map((r) => (r === 'OVER_LIMIT' ? `over the credit limit by ${formatCedis(judged.overLimit.pesewas)}` : r === 'PAST_TERMS' ? `past the payment terms (${formatCedis(judged.overdue.pesewas)} overdue)` : 'on hold'));
    return this.outcome(order, date, 'HELD_FOR_CREDIT', placed.id, `Made and left unconfirmed: ${words.join('; ')}. It needs a credit override to be confirmed`);
  }

  private outcome(order: StandingOrderRecord, runDate: string, outcome: StandingOrderRunRecord['outcome'], orderId: string | null, reason: string | null): StandingOrderRunRecord {
    return { standingOrderId: order.id, runDate, outcome, orderId, reason, recordedAt: this.clock.now() };
  }

  /** The next date on or after `from` the schedule runs and has not run yet. */
  private async nextRunIn(tx: Transaction, id: string, schedule: Schedule, from: string): Promise<string | null> {
    let date = nextOccurrence(schedule, from);
    while (date !== null && (await this.store.hasRun(tx, id, date))) date = nextOccurrence(schedule, daysAfter(date, 1));
    return date;
  }

  private async write(
    actor: Actor | undefined,
    id: string,
    operationId: string,
    request: Record<string, unknown>,
    key: string,
    decide: (tx: Transaction, order: StandingOrderRecord) => Promise<Omit<StandingOrderRecord, 'id' | 'customerId' | 'branchId' | 'frequency' | 'startsOn' | 'salespersonId' | 'version' | 'lines'>>,
    reason: string | null = null,
  ): Promise<StoredResponse<StandingOrderView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { id, ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<StandingOrderView>;
      const order = await this.readable(tx, actor, MANAGE, id, true);
      const before = (await this.views(tx, [order]))[0]!;
      const change = await decide(tx, order);
      if (!(await this.store.change(tx, id, order.version, change, actor!.principalId, this.clock.now()))) throw new VersionConflictError(`standing order ${id} changed meanwhile`);
      const view = (await this.views(tx, [(await this.store.get(tx, id, false))!]))[0]!;
      await this.audit.record(tx, { module: 'whl', action: operationId.replace('StandingOrder', '').toUpperCase(), entityType: 'StandingOrder', entityId: id, branchId: order.branchId, before: { ...before }, after: { ...view, reason } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** A standing order the caller holds `permission` for at its branch; any other id, real or not, is not found. */
  private async readable(tx: Transaction, actor: Actor | undefined, permission: string, id: string, lock = false): Promise<StandingOrderRecord> {
    await this.authoriser.authorise(tx, actor, permission);
    const order = await this.store.get(tx, id, lock);
    if (order === null || !(await this.wholeBranches(tx, actor!, permission)).includes(order.branchId)) throw new NotFoundError(`no standing order ${id}`);
    return order;
  }

  private async customerRules(tx: Transaction, customerId: string): Promise<StatementRule[]> {
    const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
    if (customer === undefined || !customer.isLive) return [{ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' }];
    const account = await this.accounts.account(tx, customerId, false);
    if (account === null) return [{ field: '/customerId', rule: 'NO_BUSINESS_ACCOUNT' }];
    if (account.status === 'CLOSED') return [{ field: '/customerId', rule: 'ACCOUNT_CLOSED' }];
    return [];
  }

  /** The lines as entered, checked against MDM: a live stocked product that is not one named animal, once each, in a unit it converts from exactly. */
  private async checkLines(tx: Transaction, input: readonly StandingOrderLineInput[], broken: StatementRule[]): Promise<StandingOrderLineRecord[]> {
    if (input.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
    if (input.length > MAX_LINES) broken.push({ field: '/lines', rule: 'TOO_MANY_LINES' });
    const products = await this.refs.productsIn(tx, input.map((l) => l.productId));
    const seen = new Set<string>();
    const lines: StandingOrderLineRecord[] = [];
    for (const [i, line] of input.entries()) {
      const field = `/lines/${String(i)}`;
      const product = products.get(line.productId);
      if (product === undefined || !product.isLive) {
        broken.push({ field: `${field}/productId`, rule: 'PRODUCT_NOT_ACTIVE' });
        continue;
      }
      if (product.stockPolicy === 'NON_STOCK') broken.push({ field: `${field}/productId`, rule: 'PRODUCT_NOT_STOCKED' });
      if (product.tracking === 'SERIAL') broken.push({ field: `${field}/productId`, rule: 'PRODUCT_SERIAL' });
      const uom = line.uom ?? product.baseUom;
      if (seen.has(`${product.id}:${uom}`)) broken.push({ field: `${field}/productId`, rule: 'PRODUCT_REPEATED' });
      seen.add(`${product.id}:${uom}`);
      const qty = Quantity.parse(line.quantity);
      if (uom !== product.baseUom) {
        const converted = await this.refs.toBaseIn(tx, product.id, uom, qty);
        if (!converted.ok) broken.push({ field: `${field}/uom`, rule: converted.error === 'INEXACT_QUANTITY' ? 'INEXACT_QUANTITY' : 'NO_CONVERSION' });
      }
      lines.push({ id: this.nextId(), lineNo: i + 1, productId: product.id, qty: qty.toDecimalString(), uom });
    }
    return lines;
  }

  private async wholeBranches(tx: Transaction, actor: Actor, permission: string): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, permission)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
  }

  private async views(tx: Transaction, orders: readonly StandingOrderRecord[]): Promise<StandingOrderView[]> {
    if (orders.length === 0) return [];
    const customers = await this.refs.customersIn(tx, [...new Set(orders.map((o) => o.customerId))]);
    const products = await this.refs.productsIn(tx, [...new Set(orders.flatMap((o) => o.lines.map((l) => l.productId)))]);
    return orders.map((o) => {
      const customer = customers.get(o.customerId);
      return {
        id: o.id,
        customer: { id: o.customerId, publicId: customer?.publicId ?? '', name: customer?.name ?? '' },
        status: o.status,
        frequency: o.frequency,
        weekday: o.weekdays[0] ?? null,
        weekdays: o.weekdays,
        dayOfMonth: o.dayOfMonth,
        intervalDays: o.intervalDays,
        startsOn: o.startsOn,
        endsOn: o.endsOn,
        nextRunOn: o.nextRunOn,
        deliveryAddress: null,
        lines: o.lines.map((l) => {
          const product = products.get(l.productId);
          return { id: l.id, lineNo: l.lineNo, product: { id: l.productId, sku: product?.sku ?? '', name: product?.name ?? '' }, quantity: l.qty, uom: l.uom };
        }),
        branchId: o.branchId,
        version: o.version,
      };
    });
  }
}

/** The named days asked for: `weekdays`, or the planned shape's one `weekday`, in the order given. */
function weekdaysOf(r: { readonly weekday?: number | undefined; readonly weekdays?: readonly number[] | undefined }): number[] {
  if (r.weekdays !== undefined) return [...r.weekdays];
  return r.weekday === undefined ? [] : [r.weekday];
}

function scheduleOf(o: StandingOrderRecord): Schedule {
  return { frequency: o.frequency, weekdays: o.weekdays, dayOfMonth: o.dayOfMonth, intervalDays: o.intervalDays, startsOn: o.startsOn, endsOn: o.endsOn };
}

const DAY_MS = 86_400_000;
const daysAfter = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBefore = (date: string, days: number): string => daysAfter(date, -days);
