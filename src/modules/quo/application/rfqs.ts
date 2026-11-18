import { createHmac } from 'node:crypto';
import { createUuidV7Generator, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import { currentRequestContext, type Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { NotFoundError, RateLimitedError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { RateLimiter } from '../../../platform/http/rate-limiter';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { Authoriser, PrincipalNames } from '../../iam';
import type { StockUnits } from '../../inv';
import type { MasterDataRefs, PartiesAdmin } from '../../mdm';
import { pageProbe } from '../domain/paging';
import type { RfqReceived } from '../events';
import { RfqInvalidError, type QuoteRule } from './errors';
import { STOREFRONT_PRINCIPAL } from './public-actor';
import type { QuoteStore, RfqRecord, RfqSource, RfqStatus } from './quote-store';

const READ = 'quo.rfq.read';
const CREATE = 'quo.rfq.create';
const UPDATE = 'quo.rfq.update';
export const RFQ = 'RFQ';
export const RFQ_RECEIVED = 'quo.RfqReceived';
/** FR-QUO-001: five requests an hour from one address or one phone; the sixth is 429 (fail closed). Settings, so the owner can change them. */
export const RFQ_ADDRESS_LIMIT_SETTING = 'quo.rfq.per_address_1h';
export const RFQ_PHONE_LIMIT_SETTING = 'quo.rfq.per_phone_1h';
const RFQ_LIMIT = 5;
const RFQ_WINDOW_SECONDS = 3_600;
const RECEIVED_MESSAGE = 'Thank you. Our sales team will call you within one working day.';

/** The contract's `PublicQuoteRequest`, with item 4's quantity and unit. */
export interface PublicRfqRequest {
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail?: string | undefined;
  readonly requirements: string;
  readonly productId?: string | undefined;
  readonly stockUnitId?: string | undefined;
  readonly quantity?: string | undefined;
  readonly uom?: string | undefined;
  readonly neededBy?: string | undefined;
  readonly deliveryArea?: string | undefined;
  readonly consentToContact: boolean;
}

/** The contract's `RfqCreate`. */
export interface RfqCreateRequest {
  readonly source: 'PHONE' | 'WHATSAPP' | 'COUNTER' | 'WHOLESALE_ORDER';
  readonly customerId?: string | undefined;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly requirements: string;
  readonly productId?: string | undefined;
  readonly quantity?: string | undefined;
  readonly uom?: string | undefined;
  readonly neededBy?: string | undefined;
  readonly deliveryArea?: string | undefined;
}

export interface RfqUpdateRequest {
  readonly assignedToId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly status?: 'IN_PROGRESS' | 'CLOSED' | 'SPAM' | undefined;
}

/** The contract's `Rfq`, with item 4's quantity and unit. */
export interface RfqView {
  readonly id: string;
  readonly rfqNo: string;
  readonly source: RfqSource;
  readonly status: RfqStatus;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string | null;
  readonly requirements: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly quantity: string | null;
  readonly uom: string | null;
  readonly neededBy: string | null;
  readonly deliveryArea: string | null;
  readonly assignedTo: { readonly id: string; readonly displayName: string } | null;
  readonly quoteIds: readonly string[];
  readonly createdAt: string;
  readonly branchId: string;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

/**
 * Requests for quote (FR-QUO-001, FR-QUO-002, the owner's item 4). The storefront's form needs no session: it is rate
 * limited by address and by phone (five an hour each, failing closed), takes a quantity only with its unit and only in
 * a unit the product is sold by (its base unit or one with an exact conversion, B06u), stores the text as given (shown
 * escaped by every screen) and answers with the request's number only. Staff log a request taken by phone, WhatsApp or
 * at the counter, linked to the live customer who holds the number. A request belongs to a branch: the public form's
 * to the head office (A-309 (b)). Each staff handler authorises first, deny by default, at the request's branch.
 */
export class Rfqs {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: QuoteStore,
    private readonly refs: MasterDataRefs,
    private readonly parties: PartiesAdmin,
    private readonly units: StockUnits,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly registry: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly limiter: RateLimiter,
    private readonly settings: Settings,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
    private readonly limiterKey: Buffer,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  /** submitQuoteRequest (FR-QUO-001): 202 with the request's number; the sixth an hour from one address or phone is 429. */
  async submitPublic(request: PublicRfqRequest, key: string): Promise<StoredResponse<{ readonly rfqNo: string; readonly message: string }>> {
    const ip = currentRequestContext()?.ip ?? 'unknown';
    await this.limit('rfq-address', ip, RFQ_ADDRESS_LIMIT_SETTING);
    await this.limit('rfq-phone', request.contactPhone, RFQ_PHONE_LIMIT_SETTING);
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const head = await this.refs.headOfficeBranchIn(tx);
      if (head === null) throw new Error('no head office branch takes the storefront’s requests for quote');
      return head;
    });
    const year = toBusinessDate(this.clock.now()).slice(0, 4);
    return this.uow.run({ isolation: 'serializable', seriesLocks: [`${RFQ}:${year}:${branchId}`] }, async (tx) => {
      const claim = await this.idempotency.claim(tx, { operationId: 'submitQuoteRequest', principalId: STOREFRONT_PRINCIPAL, key, request: { ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<{ rfqNo: string; message: string }>;
      await this.checkProduct(tx, request.productId, request.stockUnitId, request.quantity, request.uom);
      const holder = await this.parties.phoneHolder(tx, request.contactPhone);
      const rfq = await this.insertIn(tx, {
        source: request.productId === undefined ? 'PUBLIC_FORM' : 'REQUEST_TO_BUY',
        customerId: holder?.id ?? null,
        contactName: request.contactName,
        contactPhone: request.contactPhone,
        contactEmail: request.contactEmail ?? null,
        requirements: request.requirements,
        productId: request.productId ?? null,
        stockUnitId: request.stockUnitId ?? null,
        qty: request.quantity === undefined ? null : Quantity.parse(request.quantity).toDecimalString(),
        uom: request.uom ?? null,
        neededBy: request.neededBy ?? null,
        deliveryArea: request.deliveryArea ?? null,
        assignedTo: null,
        submittedIp: ip === 'unknown' ? null : ip,
        consentToContact: request.consentToContact,
        branchId,
        year,
      }, STOREFRONT_PRINCIPAL);
      const response = { status: 202, body: { rfqNo: rfq.rfqNo, message: RECEIVED_MESSAGE } };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** createRfq (FR-QUO-002): a request taken by staff, linked to the customer named or to the one holding the number. */
  async create(actor: Actor | undefined, request: RfqCreateRequest, key: string): Promise<StoredResponse<RfqView>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      const branches = [...new Set((await this.authoriser.scopes(tx, actor!, CREATE)).filter((s) => s.locationId === null).map((s) => s.branchId))];
      if (branches.length !== 1) throw new RfqInvalidError([{ field: '', rule: 'BRANCH_REQUIRED' }]);
      return branches[0]!;
    });
    const year = toBusinessDate(this.clock.now()).slice(0, 4);
    return this.uow.run({ isolation: 'serializable', seriesLocks: [`${RFQ}:${year}:${branchId}`] }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE, { branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'createRfq', principalId: actor!.principalId, key, request: { ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RfqView>;
      await this.checkProduct(tx, request.productId, undefined, request.quantity, request.uom);
      const customerId = request.customerId ?? (await this.parties.phoneHolder(tx, request.contactPhone))?.id ?? null;
      if (request.customerId !== undefined) await this.checkCustomer(tx, request.customerId);
      const rfq = await this.insertIn(tx, {
        source: request.source,
        customerId,
        contactName: request.contactName,
        contactPhone: request.contactPhone,
        contactEmail: null,
        requirements: request.requirements,
        productId: request.productId ?? null,
        stockUnitId: null,
        qty: request.quantity === undefined ? null : Quantity.parse(request.quantity).toDecimalString(),
        uom: request.uom ?? null,
        neededBy: request.neededBy ?? null,
        deliveryArea: request.deliveryArea ?? null,
        assignedTo: actor!.principalId,
        submittedIp: null,
        consentToContact: false,
        branchId,
        year,
      }, actor!.principalId);
      const view = (await this.viewsIn(tx, [rfq]))[0]!;
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  list(actor: Actor | undefined, query: { readonly status: RfqStatus | null; readonly source: RfqSource | null; readonly assignedToId: string | null }, cursor: string | undefined, limit: number): Promise<Page<RfqView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
      const binding = { operationId: 'listRfqs', principalId: actor!.principalId, filters: query };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const found = await this.store.listRfqs(tx, { ...query, branchIds }, beforeId, pageProbe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.viewsIn(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<RfqView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const [rfq] = await this.store.rfqs(tx, [id]);
      if (rfq === undefined) throw new NotFoundError('no such request for quote');
      await this.authoriser.authorise(tx, actor, READ, { branchId: rfq.branchId });
      return (await this.viewsIn(tx, [rfq]))[0]!;
    });
  }

  /** updateRfq: assign it, link it to a customer, close it or mark it as spam; the database holds the status's edges. */
  async update(actor: Actor | undefined, id: string, request: RfqUpdateRequest, key: string): Promise<StoredResponse<RfqView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, UPDATE);
      const claim = await this.idempotency.claim(tx, { operationId: 'updateRfq', principalId: actor!.principalId, key, request: { id, ...request } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<RfqView>;
      const rfq = await this.store.lockRfq(tx, id);
      if (rfq === null) throw new NotFoundError('no such request for quote');
      await this.authoriser.authorise(tx, actor, UPDATE, { branchId: rfq.branchId });
      if (request.customerId !== undefined) await this.checkCustomer(tx, request.customerId);
      if (request.assignedToId !== undefined && !(await this.principals.refs(tx, [request.assignedToId])).has(request.assignedToId)) throw new RfqInvalidError([{ field: '/assignedToId', rule: 'ASSIGNEE_UNKNOWN' }]);
      const before = (await this.viewsIn(tx, [rfq]))[0]!;
      const at = this.clock.now();
      await this.store.updateRfq(tx, id, { status: request.status ?? rfq.status, customerId: request.customerId ?? rfq.customerId, assignedTo: request.assignedToId ?? rfq.assignedTo }, actor!.principalId, at);
      const view = (await this.viewsIn(tx, await this.store.rfqs(tx, [id])))[0]!;
      await this.audit.record(tx, { module: 'quo', action: 'UPDATE', entityType: 'Rfq', entityId: id, branchId: rfq.branchId, before: { ...before }, after: { ...view } });
      const response = { status: 200, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async insertIn(tx: Transaction, r: Omit<RfqRecord, 'id' | 'rfqNo' | 'version' | 'status' | 'createdAt'> & { readonly year: string }, actorId: string): Promise<RfqRecord> {
    const id = this.nextId();
    const at = this.clock.now();
    const branch = (await this.refs.branchesIn(tx, [r.branchId])).get(r.branchId)!;
    await this.registry.register(tx, { id, docType: RFQ, ownerModule: 'quo', branchId: r.branchId, actorId });
    const rfqNo = await this.numbers.allocateIn(tx, { docType: RFQ, fiscalYear: Number(r.year), branchId: r.branchId, branchCode: branch.code, documentId: id });
    const { year: _year, ...fields } = r;
    const record = { ...fields, id, rfqNo, createdAt: at };
    await this.store.insertRfq(tx, record, actorId);
    const received: RfqReceived = { rfqId: id, rfqNo, source: r.source, branchId: r.branchId, customerId: r.customerId, productId: r.productId, receivedAt: at.toISOString() };
    await this.events.publish(tx, { type: RFQ_RECEIVED, subjectType: 'Rfq', subjectId: id, branchId: r.branchId, payload: received, occurredAt: at });
    // The audit row keeps no phone, email or address in clear beyond the request itself (DC-22): the record holds them.
    await this.audit.record(tx, { module: 'quo', action: 'CREATE', entityType: 'Rfq', entityId: id, branchId: r.branchId, before: null, after: { rfqNo, source: r.source, customerId: r.customerId, productId: r.productId, qty: r.qty, uom: r.uom } });
    return (await this.store.rfqs(tx, [id]))[0]!;
  }

  /** A product asked about must be live; a quantity names a unit the product is sold by, converting exactly (item 4). */
  private async checkProduct(tx: Transaction, productId: string | undefined, stockUnitId: string | undefined, quantity: string | undefined, uom: string | undefined): Promise<void> {
    if (productId === undefined) return;
    const broken: QuoteRule[] = [];
    const product = (await this.refs.productsIn(tx, [productId])).get(productId);
    if (product === undefined || !product.isLive) throw new RfqInvalidError([{ field: '/productId', rule: 'PRODUCT_NOT_ACTIVE' }]);
    if (quantity !== undefined && uom !== undefined) {
      const base = await this.refs.toBaseIn(tx, product.id, uom, Quantity.parse(quantity));
      if (!base.ok) broken.push({ field: '/uom', rule: base.error === 'INEXACT_QUANTITY' ? 'INEXACT_QUANTITY' : 'UOM_NOT_SOLD' });
    }
    if (stockUnitId !== undefined) {
      const unit = (await this.units.factsIn(tx, [stockUnitId], this.clock.now())).get(stockUnitId);
      if (unit === undefined || unit.productId !== product.id) broken.push({ field: '/stockUnitId', rule: 'STOCK_UNIT_OTHER_PRODUCT' });
    }
    if (broken.length > 0) throw new RfqInvalidError(broken);
  }

  private async checkCustomer(tx: Transaction, customerId: string): Promise<void> {
    const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
    if (customer === undefined || !customer.isLive) throw new RfqInvalidError([{ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' }]);
  }

  private async limit(name: string, subject: string, setting: string): Promise<void> {
    const allowed = await this.settings.integer(setting, RFQ_LIMIT);
    const decision = await this.limiter.consume(`quo:${name}`, createHmac('sha256', this.limiterKey).update(subject).digest('hex'), allowed, RFQ_WINDOW_SECONDS, true);
    if (!decision.allowed) throw new RateLimitedError(decision.retryAfterSeconds, `${name} limit for requests for quote`);
  }

  private async viewsIn(tx: Transaction, rows: readonly RfqRecord[]): Promise<RfqView[]> {
    const customers = await this.refs.customersIn(
      tx,
      rows.flatMap((r) => (r.customerId === null ? [] : [r.customerId])),
    );
    const products = await this.refs.productsIn(
      tx,
      rows.flatMap((r) => (r.productId === null ? [] : [r.productId])),
    );
    const units = await this.units.factsIn(
      tx,
      rows.flatMap((r) => (r.stockUnitId === null ? [] : [r.stockUnitId])),
      this.clock.now(),
    );
    const people = await this.principals.refs(
      tx,
      rows.flatMap((r) => (r.assignedTo === null ? [] : [r.assignedTo])),
    );
    const quotes = await this.store.quoteIdsOfRfqs(
      tx,
      rows.map((r) => r.id),
    );
    return rows.map((r) => {
      const customer = r.customerId === null ? undefined : customers.get(r.customerId);
      const product = r.productId === null ? undefined : products.get(r.productId);
      const unit = r.stockUnitId === null ? undefined : units.get(r.stockUnitId);
      return {
        id: r.id,
        rfqNo: r.rfqNo,
        source: r.source,
        status: r.status,
        customer: customer === undefined ? null : { id: customer.id, publicId: customer.publicId, name: customer.name },
        contactName: r.contactName,
        contactPhone: r.contactPhone,
        contactEmail: r.contactEmail,
        requirements: r.requirements,
        product: product === undefined ? null : { id: product.id, sku: product.sku, name: product.name },
        stockUnit: unit === undefined ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
        quantity: r.qty,
        uom: r.uom,
        neededBy: r.neededBy,
        deliveryArea: r.deliveryArea,
        assignedTo: r.assignedTo === null ? null : (people.get(r.assignedTo) ?? { id: r.assignedTo, displayName: r.assignedTo }),
        quoteIds: quotes.get(r.id) ?? [],
        createdAt: r.createdAt.toISOString(),
        branchId: r.branchId,
      };
    });
  }
}
