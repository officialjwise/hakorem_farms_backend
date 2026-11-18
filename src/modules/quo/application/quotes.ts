import { createHash } from 'node:crypto';
import { createUuidV7Generator, formatCedis, Money, Quantity, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import { currentRequestContext, type Actor } from '../../../platform/context/request-context';
import { canonicalJson } from '../../../platform/crypto/canonical-json';
import { issueLinkToken, linkTokenHash, sameLinkTokenHash } from '../../../platform/crypto/link-tokens';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { DocumentRefRecord, DocumentRegistry } from '../../../platform/documents/document-registry';
import type { NumberSeries } from '../../../platform/documents/number-series';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import { translate } from '../../../platform/i18n/messages';
import type { Settings } from '../../../platform/settings/settings';
import type { ApprovalHandler, ApprovalRecord, Approvals, Authoriser, PrincipalNames } from '../../iam';
import {
  InsufficientStockError,
  reservationLockKey,
  StockUnitNotAvailableError,
  StockUnitOnHoldError,
  StockUnitReservedError,
  type Reservations,
  type StockQueries,
  type StockUnits,
} from '../../inv';
import type { MasterDataRefs, PricingService, ProductFacts, TaxService } from '../../mdm';
import type { Orders, QuoteOrderLine, SalesOrderView } from '../../ord';
import { countOf, lineNumber, nextVersionNo } from '../domain/numbering';
import { pageProbe } from '../domain/paging';
import {
  DEFAULT_MARGIN_FLOOR_BASIS_POINTS,
  linkState,
  lineNet,
  planReservation,
  unitCost,
  versionFigures,
  type LinkState,
  type PriceBasis,
  type QuoteStatus,
} from '../domain/quote';
import type { QuoteConverted, QuoteDecided, QuoteIssued } from '../events';
import { QuoteAlreadyConvertedError, QuoteAlreadyDecidedError, QuoteAuthorCannotApproveError, QuoteInvalidError, QuoteLinkClosedError, type QuoteRule } from './errors';
import { STOREFRONT_PRINCIPAL } from './public-actor';
import type { AcceptanceRecord, LineRecord, QuoteFilter, QuoteRecord, QuoteStore, VersionRecord } from './quote-store';

const READ = 'quo.quote.read';
const CREATE = 'quo.quote.create';
const ISSUE = 'quo.quote.issue';
const CONVERT = 'quo.quote.convert';
export const QUOTE = 'QUOTE';
export const QUOTE_BELOW_MARGIN_KIND = 'QUOTE_BELOW_MARGIN';
export const QUOTE_ISSUED = 'quo.QuoteIssued';
export const QUOTE_ACCEPTED = 'quo.QuoteAccepted';
export const QUOTE_DECLINED = 'quo.QuoteDeclined';
export const QUOTE_EXPIRED = 'quo.QuoteExpired';
export const QUOTE_CONVERTED = 'quo.QuoteConverted';
/** The setting holding the margin floor in basis points of cost (FR-QUO-005, seed 10 percent). */
export const MARGIN_FLOOR_SETTING = 'quo.margin_floor_basis_points';
const TOKEN_PREFIX = 'quo_';
const EXPIRY_BATCH = 100;
const DEFAULT_UOM: Readonly<Record<PriceBasis, string>> = { PER_HEAD: 'HEAD', PER_KG: 'KG', PER_UNIT: 'UNIT' };

/** The contract's `QuoteLineInput`, with CR-045's unit. */
export interface QuoteLineInput {
  readonly productId?: string | undefined;
  readonly description: string;
  readonly gradeId?: string | undefined;
  readonly weightBandId?: string | undefined;
  readonly stockUnitId?: string | undefined;
  readonly quantity: string;
  /** The unit the line is in: a crate or a single egg (CR-045); the product's base unit when left out. */
  readonly uom?: string | undefined;
  readonly priceBasis: PriceBasis;
  readonly unitPricePesewas: bigint;
}

export interface QuoteCreateRequest {
  readonly rfqId?: string | undefined;
  readonly customerId?: string | undefined;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly validUntil: Date;
  readonly terms?: string | undefined;
  readonly deliveryEstimate?: string | undefined;
  readonly deliveryFeePesewas?: bigint | undefined;
  readonly taxInclusive: boolean;
  readonly lines: readonly QuoteLineInput[];
}

export interface QuoteVersionUpdateRequest {
  readonly version: number;
  readonly validUntil?: Date | undefined;
  readonly terms?: string | undefined;
  readonly deliveryEstimate?: string | undefined;
  readonly deliveryFeePesewas?: bigint | undefined;
  readonly lines?: readonly QuoteLineInput[] | undefined;
}

export interface QuoteConvertRequest {
  readonly fulfilmentMode: 'COLLECTION' | 'DELIVERY';
  readonly paymentTerms: 'PREPAID' | 'COD' | 'CREDIT';
  readonly stockUnitIds?: readonly string[] | undefined;
  readonly deliveryAddressId?: string | undefined;
  readonly deliverySlotId?: string | undefined;
}

export interface QuoteQuery {
  readonly status: QuoteStatus | null;
  readonly customerId: string | null;
  readonly salespersonId: string | null;
  readonly from: Date | null;
  readonly to: Date | null;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

type Ref = { readonly id: string; readonly displayName: string };

/** The contract's `QuoteLine`. */
export interface QuoteLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string } | null;
  readonly description: string;
  readonly grade: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly weightBand: { readonly id: string; readonly code: string; readonly minKg: string; readonly maxKg: string } | null;
  readonly stockUnit: { readonly id: string; readonly identifier: string; readonly tracking: 'SERIAL' | 'LOT' } | null;
  readonly reservationId: string | null;
  readonly quantity: string;
  readonly uom: string;
  readonly baseQuantity: string | null;
  readonly priceBasis: PriceBasis;
  readonly resolvedUnitPricePesewas: number | null;
  readonly unitPricePesewas: number;
  readonly lineNetPesewas: number;
  readonly estimatedUnitCostPesewas: number | null;
}

/** The contract's `QuoteVersion`, with the version's author and its optimistic lock (B10, additive). */
export interface QuoteVersionView {
  readonly id: string;
  readonly versionNo: number;
  readonly status: VersionRecord['status'];
  readonly validUntil: string;
  readonly terms: string | null;
  readonly deliveryEstimate: string | null;
  readonly deliveryFeePesewas: number;
  readonly taxInclusive: boolean;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly estimatedCostPesewas: number | null;
  readonly marginPercent: string | null;
  readonly belowMarginFloor: boolean;
  readonly approvalRequestId: string | null;
  readonly changeNote: string | null;
  readonly issuedAt: string | null;
  readonly issuedBy: Ref | null;
  readonly lines: readonly QuoteLineView[];
  readonly acceptance: { readonly method: AcceptanceRecord['method']; readonly acceptedName: string; readonly acceptedAt: string } | null;
  readonly documentId: string | null;
  readonly currency: 'GHS';
  readonly createdBy: Ref;
  readonly createdAt: string;
  readonly version: number;
  /** The acceptance link's token, answered once by the call that issued it and null everywhere else (CR-047). */
  readonly acceptanceLinkToken: string | null;
}

/** The contract's `Quote`. */
export interface QuoteView {
  readonly id: string;
  readonly quoteNo: string;
  readonly status: QuoteStatus;
  readonly rfqId: string | null;
  readonly customer: { readonly id: string; readonly publicId: string; readonly name: string } | null;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly salesperson: Ref;
  readonly productLine: string | null;
  readonly currentVersion: QuoteVersionView;
  readonly versionCount: number;
  readonly acceptedVersionId: string | null;
  readonly convertedOrder: DocumentRefRecord | null;
  readonly declineReason: string | null;
  readonly branchId: string;
  readonly version: number;
  readonly createdAt: string;
}

/** The contract's `ApprovalPending`. */
export interface ApprovalPendingView {
  readonly status: 'PENDING_APPROVAL';
  readonly approvalRequestId: string;
  readonly kind: string;
  readonly subject: { readonly id: string; readonly docType: string; readonly number: string | null };
  readonly summary: string;
  readonly requestedAt: string;
}

/** The contract's `PublicQuote`: what the buyer sees by the link, never a cost, a floor or a margin. */
export interface PublicQuoteView {
  readonly quoteNo: string;
  readonly versionNo: number;
  readonly status: 'ISSUED' | 'ACCEPTED' | 'DECLINED';
  readonly validUntil: string;
  readonly customerName: string;
  readonly lines: readonly { readonly description: string; readonly quantity: string; readonly uom: string; readonly priceBasis: PriceBasis; readonly unitPricePesewas: number; readonly lineNetPesewas: number }[];
  readonly deliveryFeePesewas: number;
  readonly netPesewas: number;
  readonly taxPesewas: number;
  readonly grossPesewas: number;
  readonly currency: 'GHS';
  readonly terms: string | null;
  readonly deliveryEstimate: string | null;
  readonly documentUrl: string | null;
}

/** The contract's `QuoteDecision`. */
export interface QuoteDecisionView {
  readonly quoteNo: string;
  readonly versionNo: number;
  readonly status: 'ACCEPTED' | 'DECLINED';
  readonly message: string;
}

const json = (pesewas: bigint) => Money.ofPesewas(pesewas).toJsonInteger();
const jsonOrNull = (pesewas: bigint | null) => (pesewas === null ? null : json(pesewas));
const lineField = (i: number, name: string) => `/lines/${i}/${name}`;
const isSet = <T>(v: T | null | undefined): v is T => v !== undefined && v !== null;

function stateError(status: string): InvalidStateTransitionError {
  return new InvalidStateTransitionError(`the quote is ${status}`, [{ field: null, code: status, message: translate('error.invalid_state_transition') }]);
}

/** The hex SHA-256 a below-margin approval binds: the version's prices and quantities as they were asked for (ADR-0017). */
export function marginHash(version: VersionRecord, lines: readonly LineRecord[]): string {
  const payload = {
    versionId: version.id,
    validUntil: version.validUntil.toISOString(),
    deliveryFeePesewas: version.deliveryFeePesewas.toString(),
    netPesewas: version.netPesewas.toString(),
    estimatedCostPesewas: version.estimatedCostPesewas?.toString() ?? null,
    lines: lines.map((l) => ({ lineNo: l.lineNo, productId: l.productId, stockUnitId: l.stockUnitId, qty: l.qty, uom: l.uom, unitPricePesewas: l.unitPricePesewas.toString() })),
  };
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * Quotes (FR-QUO-003 to FR-QUO-012, CR-045, CR-047, ADR-0004, ADR-0017, ADR-0019, ADR-0074). A quote keeps one number
 * across immutable versions: a draft is edited, an issued version never changes (migration 0251), a change is a new
 * version that supersedes the live one when it is issued. Every line is priced by the engine for the record (in its own
 * unit, never derived from another unit's price, CR-045) at the quoted price the salesperson sets, extended once, with
 * its cost estimated from the cost pools it may be promised from; a version below the margin floor over cost, or with a
 * line below the engine's floor, is issued only once a holder of `quo.quote_margin.approve` who neither drafted it nor
 * asked to issue it approves it (`QUOTE_BELOW_MARGIN`, also held by the database). Issuing reserves every product line
 * in the base unit for the validity (a named animal, or lots oldest first; an unnamed animal is chosen at conversion),
 * answers the acceptance link's random token once (only its hash is stored), and queues `quo.QuoteIssued` for NTF to send
 * (B11). The link opens only the live version and accepts it once. An accepted quote converts to exactly one ORD order
 * that names the quote as its source and each quote line as its lines' price rule, its stock handed over. Each handler
 * authorises first, deny by default, at the quote's branch.
 */
export class Quotes {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: QuoteStore,
    private readonly refs: MasterDataRefs,
    private readonly pricing: PricingService,
    private readonly tax: TaxService,
    private readonly units: StockUnits,
    private readonly stock: StockQueries,
    private readonly reservations: Reservations,
    private readonly orders: Orders,
    private readonly approvals: Approvals,
    private readonly authoriser: Authoriser,
    private readonly principals: PrincipalNames,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly registry: DocumentRegistry,
    private readonly numbers: NumberSeries,
    private readonly settings: Settings,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  // ---------------------------------------------------------------------------------------------------------- reads

  list(actor: Actor | undefined, query: QuoteQuery, cursor: string | undefined, limit: number): Promise<Page<QuoteView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = await this.wholeBranches(tx, actor!, READ);
      const binding = { operationId: 'listQuotes', principalId: actor!.principalId, filters: { ...query, from: query.from?.toISOString() ?? null, to: query.to?.toISOString() ?? null } };
      const beforeId = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const filter: QuoteFilter = { ...query, branchIds };
      const found = await this.store.listQuotes(tx, filter, beforeId, pageProbe(limit));
      const rows = found.slice(0, limit);
      const hasMore = found.length > limit;
      return { data: await this.viewsIn(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { id: rows.at(-1)!.id }) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<QuoteView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const quote = await this.readable(tx, actor, READ, id);
      return (await this.viewsIn(tx, [quote]))[0]!;
    });
  }

  /** listQuoteVersions: every version, newest first, with its author, time and totals (FR-QUO-006). */
  versions(actor: Actor | undefined, id: string, cursor: string | undefined, limit: number): Promise<Page<QuoteVersionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.readable(tx, actor, READ, id);
      const all = await this.store.versionsOf(tx, [id]);
      const binding = { operationId: 'listQuoteVersions', principalId: actor!.principalId, filters: { id } };
      const before = cursor === undefined ? null : Number(this.cursors.decode(cursor, binding)['versionNo'] ?? 0);
      const after = before === null ? all : all.filter((v) => v.versionNo < before);
      const rows = after.slice(0, limit);
      const hasMore = after.length > limit;
      return { data: await this.versionViewsIn(tx, rows), page: { nextCursor: hasMore ? this.cursors.encode(binding, { versionNo: String(rows.at(-1)!.versionNo) }) : null, limit, hasMore } };
    });
  }

  // --------------------------------------------------------------------------------------------------------- writes

  /**
   * createQuote (FR-QUO-003): a quote at the one branch the caller drafts quotes for (or its request's branch), numbered
   * now, with version 1 a DRAFT priced line by line. Replayed by its Idempotency-Key.
   */
  async create(actor: Actor | undefined, request: QuoteCreateRequest, key: string): Promise<StoredResponse<QuoteView>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE);
      if (isSet(request.rfqId)) {
        const [rfq] = await this.store.rfqs(tx, [request.rfqId]);
        if (rfq === undefined) throw new QuoteInvalidError([{ field: '/rfqId', rule: 'RFQ_UNKNOWN' }]);
        return rfq.branchId;
      }
      const branches = await this.wholeBranches(tx, actor!, CREATE);
      if (branches.length !== 1) throw new QuoteInvalidError([{ field: '', rule: 'BRANCH_REQUIRED' }]);
      return branches[0]!;
    });
    const year = toBusinessDate(this.clock.now()).slice(0, 4);
    return this.uow.run({ isolation: 'serializable', seriesLocks: [`${QUOTE}:${year}:${branchId}`] }, async (tx) => {
      await this.authoriser.authorise(tx, actor, CREATE, { branchId });
      const claim = await this.idempotency.claim(tx, { operationId: 'createQuote', principalId: actor!.principalId, key, request: wire(request) });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<QuoteView>;
      const at = this.clock.now();
      const broken: QuoteRule[] = [];
      const rfq = isSet(request.rfqId) ? await this.store.lockRfq(tx, request.rfqId) : null;
      if (rfq !== null && (rfq.status === 'CLOSED' || rfq.status === 'SPAM')) broken.push({ field: '/rfqId', rule: 'RFQ_CLOSED' });
      const customerId = request.customerId ?? rfq?.customerId ?? null;
      if (customerId !== null) {
        const customer = (await this.refs.customersIn(tx, [customerId])).get(customerId);
        if (customer === undefined || !customer.isLive) broken.push({ field: '/customerId', rule: 'CUSTOMER_NOT_ACTIVE' });
      }
      if (request.validUntil <= at) broken.push({ field: '/validUntil', rule: 'VALIDITY_PASSED' });
      if (broken.length > 0) throw new QuoteInvalidError(broken);

      const branch = (await this.refs.branchesIn(tx, [branchId])).get(branchId)!;
      const quoteId = this.nextId();
      const versionId = this.nextId();
      const priced = await this.priceLines(tx, versionId, branchId, customerId, request.lines, at);
      const figures = await this.figuresIn(tx, branchId, priced, { taxInclusive: request.taxInclusive, deliveryFeePesewas: request.deliveryFeePesewas ?? 0n, at });
      await this.registry.register(tx, { id: quoteId, docType: QUOTE, ownerModule: 'quo', branchId, actorId: actor!.principalId });
      const quoteNo = await this.numbers.allocateIn(tx, { docType: QUOTE, fiscalYear: Number(year), branchId, branchCode: branch.code, documentId: quoteId });
      await this.store.insertQuote(tx, {
        id: quoteId,
        quoteNo,
        rfqId: rfq?.id ?? null,
        customerId,
        contactName: request.contactName,
        contactPhone: request.contactPhone,
        salespersonId: actor!.principalId,
        productLine: await this.productLineOf(tx, priced.lines),
        branchId,
        createdAt: at,
        createdBy: actor!.principalId,
      });
      await this.store.insertVersion(tx, {
        id: versionId,
        quoteId,
        versionNo: 1,
        validUntil: request.validUntil,
        terms: request.terms ?? null,
        deliveryEstimate: request.deliveryEstimate ?? null,
        deliveryFeePesewas: request.deliveryFeePesewas ?? 0n,
        taxInclusive: request.taxInclusive,
        ...figures,
        changeNote: null,
        createdAt: at,
        createdBy: actor!.principalId,
      });
      await this.store.replaceLines(tx, versionId, priced.lines);
      if (rfq !== null && (rfq.status === 'NEW' || rfq.status === 'IN_PROGRESS')) {
        await this.store.updateRfq(tx, rfq.id, { status: 'QUOTED', customerId: rfq.customerId ?? customerId, assignedTo: rfq.assignedTo ?? actor!.principalId }, actor!.principalId, at);
      }
      const view = await this.viewOf(tx, quoteId);
      await this.audit.record(tx, { module: 'quo', action: 'CREATE', entityType: 'Quote', entityId: quoteId, branchId, before: null, after: { ...view } });
      const response = { status: 201, body: view };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** reviseQuote (FR-QUO-006): a new DRAFT version copied from the live one (or the version named), for editing. */
  async revise(actor: Actor | undefined, quoteId: string, request: { readonly changeNote: string; readonly copyFromVersionId?: string | undefined }, key: string): Promise<StoredResponse<QuoteVersionView>> {
    return this.write(actor, CREATE, 'reviseQuote', quoteId, { ...request }, key, async (tx, quote, at) => {
      if (quote.status !== 'ISSUED') throw stateError(quote.status);
      const versions = await this.store.versionsOf(tx, [quoteId]);
      if (versions.some((v) => v.status === 'DRAFT' || v.status === 'PENDING_APPROVAL')) throw new QuoteInvalidError([{ field: '', rule: 'VERSION_OPEN' }]);
      const from = isSet(request.copyFromVersionId) ? versions.find((v) => v.id === request.copyFromVersionId) : versions.find((v) => v.status === 'ISSUED');
      if (from === undefined) throw new QuoteInvalidError([{ field: '/copyFromVersionId', rule: 'VERSION_UNKNOWN' }]);
      const inputs = (await this.store.linesOf(tx, [from.id])).map(inputOf);
      const versionId = this.nextId();
      const versionNo = nextVersionNo(versions[0]!.versionNo);
      const priced = await this.priceLines(tx, versionId, quote.branchId, quote.customerId, inputs, at);
      const figures = await this.figuresIn(tx, quote.branchId, priced, { taxInclusive: from.taxInclusive, deliveryFeePesewas: from.deliveryFeePesewas, at });
      await this.store.insertVersion(tx, {
        id: versionId,
        quoteId,
        versionNo,
        validUntil: from.validUntil,
        terms: from.terms,
        deliveryEstimate: from.deliveryEstimate,
        deliveryFeePesewas: from.deliveryFeePesewas,
        taxInclusive: from.taxInclusive,
        ...figures,
        changeNote: request.changeNote,
        createdAt: at,
        createdBy: actor!.principalId,
      });
      await this.store.replaceLines(tx, versionId, priced.lines);
      await this.store.updateQuote(tx, quoteId, { currentVersionNo: versionNo }, actor!.principalId, at);
      const view = (await this.versionViewsIn(tx, [(await this.store.version(tx, versionId))!]))[0]!;
      await this.audit.record(tx, { module: 'quo', action: 'REVISE', entityType: 'QuoteVersion', entityId: versionId, branchId: quote.branchId, before: null, after: { ...view } });
      return { status: 201, body: view };
    });
  }

  /** updateQuoteVersion: a draft's validity, terms, fee and lines, at its optimistic version; anything else is frozen. */
  async updateVersion(actor: Actor | undefined, versionId: string, request: QuoteVersionUpdateRequest, key: string): Promise<StoredResponse<QuoteVersionView>> {
    const quoteId = await this.quoteOfVersion(actor, CREATE, versionId);
    return this.write(actor, CREATE, 'updateQuoteVersion', quoteId, { versionId, ...wire(request) }, key, async (tx, quote, at) => {
      const version = (await this.store.version(tx, versionId))!;
      if (version.status !== 'DRAFT') throw stateError(version.status);
      if (version.version !== request.version) throw new VersionConflictError(`quote version ${versionId} is at ${version.version}`);
      const before = (await this.versionViewsIn(tx, [version]))[0]!;
      const validUntil = request.validUntil ?? version.validUntil;
      if (validUntil <= at) throw new QuoteInvalidError([{ field: '/validUntil', rule: 'VALIDITY_PASSED' }]);
      const inputs = request.lines ?? (await this.store.linesOf(tx, [versionId])).map(inputOf);
      const fee = request.deliveryFeePesewas ?? version.deliveryFeePesewas;
      const priced = await this.priceLines(tx, versionId, quote.branchId, quote.customerId, inputs, at);
      const figures = await this.figuresIn(tx, quote.branchId, priced, { taxInclusive: version.taxInclusive, deliveryFeePesewas: fee, at });
      await this.store.replaceLines(tx, versionId, priced.lines);
      await this.store.setFigures(tx, versionId, { validUntil, terms: request.terms ?? version.terms, deliveryEstimate: request.deliveryEstimate ?? version.deliveryEstimate, deliveryFeePesewas: fee, ...figures }, actor!.principalId, at);
      const view = (await this.versionViewsIn(tx, [(await this.store.version(tx, versionId))!]))[0]!;
      await this.audit.record(tx, { module: 'quo', action: 'UPDATE', entityType: 'QuoteVersion', entityId: versionId, branchId: quote.branchId, before: { ...before }, after: { ...view } });
      return { status: 200, body: view };
    });
  }

  /**
   * issueQuoteVersion (FR-QUO-004, FR-QUO-005, FR-QUO-007, FR-QUO-012): a draft is priced again and judged; below the
   * floor it waits for approval (202 `ApprovalPending`); otherwise every product line is reserved for the validity, the
   * live version (if any) is superseded and its hold released, the version is issued and `quo.QuoteIssued` queued once.
   * The answer carries the acceptance link's token, made now and kept only as its hash; asking again for an issued
   * version (a replay, or after its approval) answers a fresh token and sends nothing a second time.
   */
  async issue(actor: Actor | undefined, versionId: string, request: { readonly channels: readonly string[] }, key: string): Promise<StoredResponse<QuoteVersionView | ApprovalPendingView>> {
    const quoteId = await this.quoteOfVersion(actor, ISSUE, versionId);
    const locks = await this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const quote = await this.readable(tx, actor, ISSUE, quoteId);
      return this.reservationLocksIn(tx, quote.branchId, await this.store.linesOf(tx, [versionId]));
    });
    const response = await this.write<QuoteVersionView | ApprovalPendingView>(actor, ISSUE, 'issueQuoteVersion', quoteId, { versionId, channels: [...request.channels] }, key, async (tx, quote, at) => {
      const version = (await this.store.version(tx, versionId))!;
      if (version.status === 'ISSUED') return { status: 200, body: (await this.versionViewsIn(tx, [version]))[0]! };
      if (version.status === 'PENDING_APPROVAL') return { status: 202, body: await this.pendingOf(tx, quote, version) };
      if (version.status !== 'DRAFT' || !['DRAFT', 'PENDING_APPROVAL', 'ISSUED'].includes(quote.status)) throw stateError(version.status === 'DRAFT' ? quote.status : version.status);
      const inputs = (await this.store.linesOf(tx, [versionId])).map(inputOf);
      const broken: QuoteRule[] = [];
      if (inputs.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
      inputs.forEach((l, i) => l.unitPricePesewas <= 0n && broken.push({ field: lineField(i, 'unitPricePesewas'), rule: 'LINE_NOT_PRICED' }));
      if (version.validUntil <= at) broken.push({ field: '/validUntil', rule: 'VALIDITY_PASSED' });
      if (broken.length > 0) throw new QuoteInvalidError(broken);
      // Judged on the prices and costs of now, not of the last edit.
      const priced = await this.priceLines(tx, versionId, quote.branchId, quote.customerId, inputs, at);
      const figures = await this.figuresIn(tx, quote.branchId, priced, { taxInclusive: version.taxInclusive, deliveryFeePesewas: version.deliveryFeePesewas, at });
      await this.store.replaceLines(tx, versionId, priced.lines);
      await this.store.setFigures(tx, versionId, { validUntil: version.validUntil, terms: version.terms, deliveryEstimate: version.deliveryEstimate, deliveryFeePesewas: version.deliveryFeePesewas, ...figures }, actor!.principalId, at);
      const judged = (await this.store.version(tx, versionId))!;
      if (judged.belowMarginFloor) {
        const approval = await this.approvals.request(tx, actor, {
          kind: QUOTE_BELOW_MARGIN_KIND,
          branchId: quote.branchId,
          subjectDocumentId: quote.id,
          payloadHash: marginHash(judged, priced.lines),
          amountPesewas: judged.netPesewas,
          summary: `Quote ${quote.quoteNo} version ${judged.versionNo}: ${formatCedis(judged.netPesewas)} at a margin of ${judged.marginPercent ?? 'unknown'} percent over cost, below the floor or the engine's floor`,
        });
        await this.store.setVersionStatus(tx, versionId, { status: 'PENDING_APPROVAL', approvalRequestId: approval.id }, actor!.principalId, at);
        if (quote.status === 'DRAFT') await this.store.updateQuote(tx, quote.id, { status: 'PENDING_APPROVAL' }, actor!.principalId, at);
        await this.audit.record(tx, { module: 'quo', action: 'REQUEST_MARGIN_APPROVAL', entityType: 'QuoteVersion', entityId: versionId, branchId: quote.branchId, before: { status: 'DRAFT' }, after: { status: 'PENDING_APPROVAL', approvalRequestId: approval.id } });
        return { status: 202, body: await this.pendingOf(tx, quote, (await this.store.version(tx, versionId))!) };
      }
      await this.issueIn(tx, quote, judged, { issuerId: actor!.principalId, approvedBy: null, channels: request.channels, at, actorId: actor!.principalId });
      return { status: 200, body: (await this.versionViewsIn(tx, [(await this.store.version(tx, versionId))!]))[0]! };
    }, locks);
    // The token leaves the system once, in this answer, and never in the stored answer a replay reads (ADR-0074).
    if (response.status !== 200) return response;
    const token = await this.uow.run({ isolation: 'read committed' }, async (tx) => this.linkTokenIn(tx, versionId, actor!.principalId));
    return { status: 200, body: { ...(response.body as QuoteVersionView), acceptanceLinkToken: token } };
  }

  /** A fresh acceptance link for an issued version (B11's sender asks for one just before it sends, ADR-0074). */
  async linkTokenIn(tx: Transaction, versionId: string, actorId: string): Promise<string> {
    const version = await this.store.version(tx, versionId);
    if (version === null || version.status !== 'ISSUED') throw stateError(version?.status ?? 'UNKNOWN');
    const issued = issueLinkToken(TOKEN_PREFIX);
    await this.store.insertLinkToken(tx, { id: this.nextId(), quoteVersionId: versionId, tokenHash: issued.hash, expiresAt: version.validUntil }, actorId, this.clock.now());
    return issued.token;
  }

  /** recordQuoteAcceptance (FR-QUO-010): an acceptance in person or by phone, with its note, as a link acceptance. */
  async recordAcceptance(
    actor: Actor | undefined,
    quoteId: string,
    request: { readonly method: 'IN_PERSON' | 'PHONE_CONFIRMED'; readonly acceptedName: string; readonly note?: string | undefined },
    key: string,
  ): Promise<StoredResponse<QuoteView>> {
    return this.write(actor, ISSUE, 'recordQuoteAcceptance', quoteId, { ...request }, key, async (tx, quote, at) => {
      // FR-QUO-010: staff record an acceptance only with the evidence of it.
      if (request.note === undefined) throw new QuoteInvalidError([{ field: '/note', rule: 'NOTE_REQUIRED' }]);
      const live = await this.liveVersionIn(tx, quote);
      this.openOrRefuse(quote, live, live.validUntil, at);
      await this.acceptIn(tx, quote, live, { method: request.method, acceptedName: request.acceptedName, note: request.note, ip: null, userAgent: null }, actor!.principalId, at);
      return { status: 200, body: await this.viewOf(tx, quoteId) };
    });
  }

  /** declineQuote: the buyer declined, told to staff, with the reason; the hold on stock is released. */
  async decline(actor: Actor | undefined, quoteId: string, reason: string, key: string): Promise<StoredResponse<QuoteView>> {
    return this.write(actor, ISSUE, 'declineQuote', quoteId, { reason }, key, async (tx, quote, at) => {
      if (quote.status !== 'ISSUED') throw stateError(quote.status);
      await this.declineIn(tx, quote, await this.liveVersionIn(tx, quote), reason, 'STAFF', actor!.principalId, at);
      return { status: 200, body: await this.viewOf(tx, quoteId) };
    });
  }

  /** cancelQuote: the farm withdraws the quote; a waiting approval is withdrawn and the hold released. */
  async cancel(actor: Actor | undefined, quoteId: string, reason: string, key: string): Promise<StoredResponse<QuoteView>> {
    return this.write(actor, ISSUE, 'cancelQuote', quoteId, { reason }, key, async (tx, quote, at) => {
      if (!['DRAFT', 'PENDING_APPROVAL', 'ISSUED', 'ACCEPTED'].includes(quote.status)) throw stateError(quote.status);
      const before = await this.viewOf(tx, quoteId);
      for (const v of await this.store.versionsOf(tx, [quoteId])) {
        if (v.status !== 'PENDING_APPROVAL') continue;
        if (v.approvalRequestId !== null) await this.approvals.withdrawIn(tx, v.approvalRequestId, 'The quote was withdrawn before its margin was decided');
        await this.store.setVersionStatus(tx, v.id, { status: 'DRAFT' }, actor!.principalId, at);
      }
      await this.reservations.releaseHeldByIn(tx, actor!.principalId, quoteId, `Quote ${quote.quoteNo} withdrawn: ${reason}`);
      await this.store.updateQuote(tx, quoteId, { status: 'CANCELLED', cancelReason: reason }, actor!.principalId, at);
      const view = await this.viewOf(tx, quoteId);
      await this.audit.record(tx, { module: 'quo', action: 'CANCEL', entityType: 'Quote', entityId: quoteId, branchId: quote.branchId, before: { ...before }, after: { ...view } });
      return { status: 200, body: view };
    });
  }

  /**
   * convertQuote (FR-QUO-011, A-310): an accepted quote's one order through ORD's `Orders.createFromQuoteIn`, each line
   * naming its quote line; an unnamed line of animals takes the animals given, one order line each. The quote's hold on
   * stock passes to the order. Converted once (`uq_quote_converted_order`); asking again is 409.
   */
  async convert(actor: Actor | undefined, quoteId: string, request: QuoteConvertRequest, key: string): Promise<StoredResponse<SalesOrderView>> {
    const branchId = await this.uow.run({ isolation: 'read committed' }, async (tx) => (await this.readable(tx, actor, CONVERT, quoteId)).branchId);
    return this.write(actor, CONVERT, 'convertQuote', quoteId, { ...request, stockUnitIds: request.stockUnitIds ?? null }, key, async (tx, quote, at) => {
      if (quote.status === 'CONVERTED') throw new QuoteAlreadyConvertedError(`quote ${quoteId} converted to order ${quote.convertedOrderId}`);
      if (quote.status !== 'ACCEPTED') throw stateError(quote.status);
      const version = (await this.store.version(tx, quote.acceptedVersionId!))!;
      const lines = await this.store.linesOf(tx, [version.id]);
      const products = await this.refs.productsIn(
        tx,
        lines.flatMap((l) => (l.productId === null ? [] : [l.productId])),
      );
      const animals = [...(request.stockUnitIds ?? [])];
      const broken: QuoteRule[] = [];
      const orderLines: QuoteOrderLine[] = [];
      for (const [i, l] of lines.entries()) {
        const product = l.productId === null ? undefined : products.get(l.productId);
        if (product === undefined) {
          broken.push({ field: lineField(i, 'productId'), rule: 'LINE_WITHOUT_PRODUCT' });
          continue;
        }
        if (product.tracking === 'SERIAL' && l.stockUnitId === null) {
          const head = Number(Quantity.parse(l.qty).toDecimalString().split('.')[0]);
          if (animals.length < head) {
            broken.push({ field: '/stockUnitIds', rule: 'ANIMALS_REQUIRED' });
            continue;
          }
          for (const animal of animals.splice(0, head)) orderLines.push({ quoteLineId: l.id, productId: product.id, stockUnitId: animal, quantity: '1.000', uom: l.uom, priceBasis: l.priceBasis, unitPricePesewas: l.unitPricePesewas });
          continue;
        }
        orderLines.push({ quoteLineId: l.id, productId: product.id, stockUnitId: l.stockUnitId, quantity: l.qty, uom: l.uom, priceBasis: l.priceBasis, unitPricePesewas: l.unitPricePesewas });
      }
      if (animals.length > 0) broken.push({ field: '/stockUnitIds', rule: 'ANIMALS_NOT_ON_QUOTE' });
      // Delivery is B11's (ORD refuses it until then); an address or a slot is refused rather than ignored.
      if (isSet(request.deliveryAddressId)) broken.push({ field: '/deliveryAddressId', rule: 'NOT_FOR_COLLECTION' });
      if (isSet(request.deliverySlotId)) broken.push({ field: '/deliverySlotId', rule: 'NOT_FOR_COLLECTION' });
      if (broken.length > 0) throw new QuoteInvalidError(broken);
      const order = await this.orders.createFromQuoteIn(tx, actor!, {
        quoteId,
        branchId: quote.branchId,
        customerId: quote.customerId,
        contactName: quote.contactName,
        contactPhone: quote.contactPhone,
        salespersonId: quote.salespersonId,
        fulfilmentMode: request.fulfilmentMode,
        paymentTerms: request.paymentTerms,
        deliveryFeePesewas: version.deliveryFeePesewas,
        taxInclusive: version.taxInclusive,
        lines: orderLines,
      });
      const moved = await this.reservations.transferHeldByIn(tx, actor!.principalId, quoteId, order.id, `Quote ${quote.quoteNo} converted: its hold passes to order ${order.orderNo ?? order.id}`);
      for (const line of order.lines) {
        const held = moved.filter((r) => r.productId === line.product.id);
        const sameProduct = order.lines.filter((o) => o.product.id === line.product.id);
        if (held.length === 1 && sameProduct.length === 1) await this.orders.holdLineIn(tx, line.id, held[0]!.id);
      }
      await this.store.updateQuote(tx, quoteId, { status: 'CONVERTED', convertedOrderId: order.id }, actor!.principalId, at);
      const converted: QuoteConverted = { quoteId, quoteNo: quote.quoteNo, versionId: version.id, orderId: order.id, orderNo: order.orderNo, branchId: quote.branchId, salespersonId: quote.salespersonId, convertedAt: at.toISOString() };
      await this.events.publish(tx, { type: QUOTE_CONVERTED, subjectType: 'Quote', subjectId: quoteId, branchId: quote.branchId, payload: converted, occurredAt: at });
      await this.audit.record(tx, { module: 'quo', action: 'CONVERT', entityType: 'Quote', entityId: quoteId, branchId: quote.branchId, before: { status: 'ACCEPTED' }, after: { status: 'CONVERTED', convertedOrderId: order.id } });
      return { status: 201, body: await this.orders.viewOf(tx, order.id) };
    }, [...this.orders.locksFor(branchId)]);
  }

  // ------------------------------------------------------------------------------------------------ the public link

  /** viewQuoteByLink (CR-047): the live version by its token; a closed link opens only its state; anything else 404. */
  viewByLink(token: string): Promise<PublicQuoteView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const { quote, version, state } = await this.byLinkIn(tx, token);
      if (state !== 'OPEN' && state !== 'ACCEPTED' && state !== 'DECLINED') throw new QuoteLinkClosedError(state);
      return this.publicViewIn(tx, quote, version, state === 'OPEN' ? 'ISSUED' : state);
    });
  }

  /** acceptQuoteByLink (FR-QUO-008): once, by the live version's token, recording the name, time and address. */
  acceptByLink(token: string, request: { readonly acceptedName: string }, key: string): Promise<StoredResponse<QuoteDecisionView>> {
    return this.linkWrite(token, 'acceptQuoteByLink', { acceptedName: request.acceptedName }, key, async (tx, quote, version, at) => {
      const context = currentRequestContext();
      await this.acceptIn(tx, quote, version, { method: 'SIGNED_LINK', acceptedName: request.acceptedName, note: null, ip: context?.ip ?? null, userAgent: context?.userAgent?.slice(0, 500) ?? null }, STOREFRONT_PRINCIPAL, at);
      return { quoteNo: quote.quoteNo, versionNo: version.versionNo, status: 'ACCEPTED', message: 'Thank you. We will call you to arrange the deposit and delivery.' };
    });
  }

  /** declineQuoteByLink (FR-QUO-009): the buyer declines by the live version's token, with a reason or none. */
  declineByLink(token: string, request: { readonly reason?: string | undefined }, key: string): Promise<StoredResponse<QuoteDecisionView>> {
    return this.linkWrite(token, 'declineQuoteByLink', { reason: request.reason ?? null }, key, async (tx, quote, version, at) => {
      await this.declineIn(tx, quote, version, request.reason ?? 'Declined by the customer through the quote link', 'SIGNED_LINK', STOREFRONT_PRINCIPAL, at);
      return { quoteNo: quote.quoteNo, versionNo: version.versionNo, status: 'DECLINED', message: 'Thank you for letting us know.' };
    });
  }

  // ----------------------------------------------------------------------------------------- approval and expiry

  readonly approvalHandler: ApprovalHandler = {
    currentPayloadHash: async (tx, subjectDocumentId) => {
      const pending = (await this.store.versionsOf(tx, [subjectDocumentId])).find((v) => v.status === 'PENDING_APPROVAL');
      if (pending === undefined) throw new NotFoundError('no quote version waiting for its margin approval');
      return marginHash(pending, await this.store.linesOf(tx, [pending.id]));
    },
    onApproved: async (tx: Transaction, request: ApprovalRecord) => {
      const at = this.clock.now();
      const quote = (await this.store.lockQuote(tx, request.subjectDocumentId))!;
      const version = (await this.store.versionsOf(tx, [quote.id])).find((v) => v.approvalRequestId === request.id && v.status === 'PENDING_APPROVAL');
      if (version === undefined) throw stateError(quote.status);
      // ADR-0017: the checker is neither the maker who asked (IAM refuses that) nor the version's author.
      if (request.decidedBy === version.createdBy) throw new QuoteAuthorCannotApproveError('the author of a quote version cannot approve its margin');
      if (!['DRAFT', 'PENDING_APPROVAL', 'ISSUED'].includes(quote.status)) throw stateError(quote.status);
      await this.issueIn(tx, quote, version, { issuerId: request.requestedBy, approvedBy: request.decidedBy, channels: ['SMS'], at, actorId: request.decidedBy! });
    },
    onRejected: async (tx: Transaction, request: ApprovalRecord) => {
      const at = this.clock.now();
      const quote = (await this.store.lockQuote(tx, request.subjectDocumentId))!;
      const version = (await this.store.versionsOf(tx, [quote.id])).find((v) => v.approvalRequestId === request.id && v.status === 'PENDING_APPROVAL');
      if (version === undefined) return;
      await this.store.setVersionStatus(tx, version.id, { status: 'DRAFT' }, request.decidedBy ?? request.requestedBy, at);
      if (quote.status === 'PENDING_APPROVAL') await this.store.updateQuote(tx, quote.id, { status: 'DRAFT' }, request.decidedBy ?? request.requestedBy, at);
    },
  };

  /** The daily expiry (FR-QUO-009): issued quotes past their validity become EXPIRED and their hold is released. */
  async expireLapsed(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<string[]> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const at = this.clock.now();
      const expired: string[] = [];
      for (const quote of await this.store.lockLapsed(tx, at, EXPIRY_BATCH)) {
        const live = await this.liveVersionIn(tx, quote);
        await this.reservations.releaseHeldByIn(tx, system.principalId, quote.id, `Quote ${quote.quoteNo} expired at ${live.validUntil.toISOString()}`);
        await this.store.updateQuote(tx, quote.id, { status: 'EXPIRED' }, system.principalId, at);
        await this.publishDecision(tx, QUOTE_EXPIRED, quote, live, 'EXPIRY', at);
        await this.audit.record(tx, { module: 'quo', action: 'EXPIRE', entityType: 'Quote', entityId: quote.id, branchId: quote.branchId, before: { status: 'ISSUED' }, after: { status: 'EXPIRED' } });
        expired.push(quote.id);
      }
      return expired;
    });
  }

  // ------------------------------------------------------------------------------------------------------ inside

  /** Issues a version in the caller's serializable transaction: reserve, supersede, issue, queue the message once. */
  private async issueIn(
    tx: Transaction,
    quote: QuoteRecord,
    version: VersionRecord,
    o: { readonly issuerId: string; readonly approvedBy: string | null; readonly channels: readonly string[]; readonly at: Date; readonly actorId: string },
  ): Promise<void> {
    const superseded = (await this.store.versionsOf(tx, [quote.id])).find((v) => v.status === 'ISSUED') ?? null;
    if (superseded !== null) {
      await this.store.setVersionStatus(tx, superseded.id, { status: 'SUPERSEDED' }, o.actorId, o.at);
      await this.reservations.releaseHeldByIn(tx, o.actorId, quote.id, `Quote ${quote.quoteNo} version ${superseded.versionNo} replaced by version ${version.versionNo}`);
    }
    await this.reserveLinesIn(tx, quote, version, o.actorId);
    await this.store.setVersionStatus(
      tx,
      version.id,
      { status: 'ISSUED', issuedAt: o.at, issuedBy: o.issuerId, ...(o.approvedBy === null ? {} : { approvedBy: o.approvedBy, approvedAt: o.at }) },
      o.actorId,
      o.at,
    );
    if (quote.status !== 'ISSUED') await this.store.updateQuote(tx, quote.id, { status: 'ISSUED' }, o.actorId, o.at);
    const issued: QuoteIssued = {
      quoteId: quote.id,
      quoteNo: quote.quoteNo,
      versionId: version.id,
      versionNo: version.versionNo,
      branchId: quote.branchId,
      customerId: quote.customerId,
      salespersonId: quote.salespersonId,
      grossPesewas: json(version.grossPesewas),
      validUntil: version.validUntil.toISOString(),
      channels: [...o.channels],
      supersededVersionId: superseded?.id ?? null,
      approvalRequestId: version.approvalRequestId,
      issuedAt: o.at.toISOString(),
    };
    // One message per issued version (FR-QUO-007): a revision is announced by the same event, naming what it replaced.
    await this.events.publish(tx, { type: QUOTE_ISSUED, subjectType: 'Quote', subjectId: quote.id, branchId: quote.branchId, payload: issued, occurredAt: o.at });
    await this.audit.record(tx, {
      module: 'quo',
      action: 'ISSUE',
      entityType: 'QuoteVersion',
      entityId: version.id,
      branchId: quote.branchId,
      before: { status: version.status },
      after: { status: 'ISSUED', issuedBy: o.issuerId, approvedBy: o.approvedBy, supersededVersionId: superseded?.id ?? null },
    });
  }

  /** Every product line held for the validity in the base unit (CR-045): a named unit, or lots oldest first. */
  private async reserveLinesIn(tx: Transaction, quote: QuoteRecord, version: VersionRecord, actorId: string): Promise<void> {
    const lines = await this.store.linesOf(tx, [version.id]);
    const products = await this.refs.productsIn(
      tx,
      lines.flatMap((l) => (l.productId === null ? [] : [l.productId])),
    );
    const units = await this.units.factsIn(
      tx,
      lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])),
      this.clock.now(),
    );
    const balances = await this.stock.promisableIn(tx, quote.branchId, [...products.keys()]);
    const left = balances.map((b) => b.availableQty);
    const short: QuoteRule[] = [];
    for (const [i, line] of lines.entries()) {
      const product = line.productId === null ? undefined : products.get(line.productId);
      if (product === undefined || line.baseQty === null) continue;
      const pieces: { productId: string; stockUnitId: string | null; locationId: string; qty: Quantity }[] = [];
      if (line.stockUnitId !== null) {
        const unit = units.get(line.stockUnitId);
        if (unit === undefined || unit.currentLocationId === null || unit.status !== 'ACTIVE' || unit.reserved || unit.holds.length > 0) {
          short.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_SHORT' });
          continue;
        }
        pieces.push({ productId: product.id, stockUnitId: unit.id, locationId: unit.currentLocationId, qty: Quantity.parse(line.baseQty) });
      } else if (product.tracking === 'SERIAL') {
        continue;
      } else {
        const offered = balances.map((b, index) => ({ b, index })).filter(({ b }) => b.productId === product.id);
        const plan = planReservation(
          Quantity.parse(line.baseQty),
          offered.map(({ index }) => left[index]!),
        );
        if (plan.kind === 'SHORT') {
          short.push({ field: lineField(i, 'quantity'), rule: 'STOCK_SHORT' });
          continue;
        }
        for (const p of plan.pieces) {
          const { b, index } = offered[p.index]!;
          left[index] = left[index]!.minus(p.qty);
          pieces.push({ productId: b.productId, stockUnitId: b.stockUnitId, locationId: b.locationId, qty: p.qty });
        }
      }
      const held: string[] = [];
      for (const piece of pieces) {
        try {
          held.push(await this.reservations.reserveIn(tx, actorId, { ...piece, holderDocumentId: quote.id, expiresAt: version.validUntil }));
        } catch (error) {
          if (error instanceof InsufficientStockError || error instanceof StockUnitNotAvailableError || error instanceof StockUnitReservedError || error instanceof StockUnitOnHoldError) {
            throw new QuoteInvalidError([{ field: lineField(i, line.stockUnitId === null ? 'quantity' : 'stockUnitId'), rule: 'STOCK_SHORT' }]);
          }
          throw error;
        }
      }
      if (held.length === 1) await this.store.holdLine(tx, line.id, held[0]!);
    }
    if (short.length > 0) throw new QuoteInvalidError(short);
  }

  /** The balance locks an issue takes before BEGIN, so two quotes for the last crate queue (ADR-0005, A-060). */
  private async reservationLocksIn(tx: Transaction, branchId: string, lines: readonly LineRecord[]): Promise<string[]> {
    const productIds = [...new Set(lines.flatMap((l) => (l.productId === null ? [] : [l.productId])))];
    const balances = await this.stock.promisableIn(tx, branchId, productIds);
    const units = await this.units.factsIn(
      tx,
      lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])),
      this.clock.now(),
    );
    const keys = balances.map((b) => reservationLockKey(b.productId, b.stockUnitId, b.locationId));
    for (const u of units.values()) if (u.currentLocationId !== null) keys.push(reservationLockKey(u.productId, u.id, u.currentLocationId));
    return [...new Set(keys)];
  }

  private async acceptIn(
    tx: Transaction,
    quote: QuoteRecord,
    version: VersionRecord,
    a: { readonly method: AcceptanceRecord['method']; readonly acceptedName: string; readonly note: string | null; readonly ip: string | null; readonly userAgent: string | null },
    actorId: string,
    at: Date,
  ): Promise<void> {
    await this.store.insertAcceptance(tx, { id: this.nextId(), quoteVersionId: version.id, ...a, acceptedAt: at }, actorId, at);
    await this.store.setVersionStatus(tx, version.id, { status: 'ACCEPTED' }, actorId, at);
    await this.store.updateQuote(tx, quote.id, { status: 'ACCEPTED', acceptedVersionId: version.id }, actorId, at);
    // Accepted, the stock is held until the order takes it or the quote is withdrawn, no longer to the validity (A-310).
    await this.reservations.transferHeldByIn(tx, actorId, quote.id, quote.id, `Quote ${quote.quoteNo} accepted: held until it is converted`);
    await this.publishDecision(tx, QUOTE_ACCEPTED, quote, version, a.method, at);
    await this.audit.record(tx, { module: 'quo', action: 'ACCEPT', entityType: 'Quote', entityId: quote.id, branchId: quote.branchId, before: { status: quote.status }, after: { status: 'ACCEPTED', versionId: version.id, method: a.method, acceptedName: a.acceptedName } });
  }

  private async declineIn(tx: Transaction, quote: QuoteRecord, version: VersionRecord, reason: string, method: 'SIGNED_LINK' | 'STAFF', actorId: string, at: Date): Promise<void> {
    await this.reservations.releaseHeldByIn(tx, actorId, quote.id, `Quote ${quote.quoteNo} declined`);
    await this.store.updateQuote(tx, quote.id, { status: 'DECLINED', declineReason: reason }, actorId, at);
    await this.publishDecision(tx, QUOTE_DECLINED, quote, version, method, at);
    await this.audit.record(tx, { module: 'quo', action: 'DECLINE', entityType: 'Quote', entityId: quote.id, branchId: quote.branchId, before: { status: quote.status }, after: { status: 'DECLINED', reason, method } });
  }

  private async publishDecision(tx: Transaction, type: string, quote: QuoteRecord, version: VersionRecord, method: QuoteDecided['method'], at: Date): Promise<void> {
    const decided: QuoteDecided = { quoteId: quote.id, quoteNo: quote.quoteNo, versionId: version.id, versionNo: version.versionNo, branchId: quote.branchId, salespersonId: quote.salespersonId, grossPesewas: json(version.grossPesewas), method, at: at.toISOString() };
    await this.events.publish(tx, { type, subjectType: 'Quote', subjectId: quote.id, branchId: quote.branchId, payload: decided, occurredAt: at });
  }

  /** The live version: the issued one, or the accepted one. */
  private async liveVersionIn(tx: Transaction, quote: QuoteRecord): Promise<VersionRecord> {
    const live = (await this.store.versionsOf(tx, [quote.id])).find((v) => v.status === 'ISSUED' || v.status === 'ACCEPTED');
    if (live === undefined) throw stateError(quote.status);
    return live;
  }

  private openOrRefuse(quote: QuoteRecord, version: VersionRecord, tokenExpiresAt: Date, at: Date): void {
    const state = linkState({ versionStatus: version.status, quoteStatus: quote.status, isCurrent: version.status !== 'SUPERSEDED', validUntil: version.validUntil, tokenExpiresAt, now: at });
    if (state === 'ACCEPTED' || state === 'DECLINED') throw new QuoteAlreadyDecidedError(`quote ${quote.id} is ${state}`);
    if (state !== 'OPEN') throw new QuoteLinkClosedError(state);
  }

  private async byLinkIn(tx: Transaction, token: string): Promise<{ quote: QuoteRecord; version: VersionRecord; state: LinkState; expiresAt: Date }> {
    const hash = linkTokenHash(TOKEN_PREFIX, token);
    const found = hash === null ? null : await this.store.linkToken(tx, hash);
    if (hash === null || found === null || !sameLinkTokenHash(found.tokenHash, hash)) throw new NotFoundError('no such quote link');
    const version = (await this.store.version(tx, found.quoteVersionId))!;
    const [quote] = await this.store.quotes(tx, [version.quoteId]);
    const state = linkState({ versionStatus: version.status, quoteStatus: quote!.status, isCurrent: version.status !== 'SUPERSEDED', validUntil: version.validUntil, tokenExpiresAt: found.expiresAt, now: this.clock.now() });
    return { quote: quote!, version, state, expiresAt: found.expiresAt };
  }

  private async linkWrite(
    token: string,
    operationId: string,
    body: object,
    key: string,
    work: (tx: Transaction, quote: QuoteRecord, version: VersionRecord, at: Date) => Promise<QuoteDecisionView>,
  ): Promise<StoredResponse<QuoteDecisionView>> {
    const hash = linkTokenHash(TOKEN_PREFIX, token);
    // The idempotency key is scoped to the token's hash, never to the token, so a stored answer holds no token.
    const scope = hash === null ? 'invalid' : hash.toString('hex');
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const scopedKey = createHash('sha256').update(`${scope}:${key}`, 'utf8').digest('hex');
      const claim = await this.idempotency.claim(tx, { operationId, principalId: STOREFRONT_PRINCIPAL, key: scopedKey, request: { ...body, link: scope } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<QuoteDecisionView>;
      const { quote, version, expiresAt } = await this.byLinkIn(tx, token);
      const locked = (await this.store.lockQuote(tx, quote.id))!;
      const at = this.clock.now();
      this.openOrRefuse(locked, version, expiresAt, at);
      const response = { status: 200, body: await work(tx, locked, version, at) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** One serializable write on a quote: authorised at its branch, replayed by its key, the quote locked. */
  private write<T>(
    actor: Actor | undefined,
    permission: string,
    operationId: string,
    quoteId: string,
    body: object,
    key: string,
    work: (tx: Transaction, quote: QuoteRecord, at: Date) => Promise<StoredResponse<T>>,
    seriesLocks: readonly string[] = [],
  ): Promise<StoredResponse<T>> {
    return this.uow.run({ isolation: 'serializable', seriesLocks: [...seriesLocks] }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key, request: { quoteId, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<T>;
      const quote = await this.store.lockQuote(tx, quoteId);
      if (quote === null) throw new NotFoundError('no such quote');
      await this.authoriser.authorise(tx, actor, permission, { branchId: quote.branchId });
      const response = await work(tx, quote, this.clock.now());
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async readable(tx: Transaction, actor: Actor | undefined, permission: string, id: string): Promise<QuoteRecord> {
    await this.authoriser.authorise(tx, actor, permission);
    const [quote] = await this.store.quotes(tx, [id]);
    if (quote === undefined) throw new NotFoundError('no such quote');
    await this.authoriser.authorise(tx, actor, permission, { branchId: quote.branchId });
    return quote;
  }

  /** The quote a version belongs to, asked only once the caller holds the permission at all (deny by default). */
  private quoteOfVersion(actor: Actor | undefined, permission: string, versionId: string): Promise<string> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, permission);
      const version = await this.store.version(tx, versionId);
      if (version === null) throw new NotFoundError('no such quote version');
      return version.quoteId;
    });
  }

  private async pendingOf(tx: Transaction, quote: QuoteRecord, version: VersionRecord): Promise<ApprovalPendingView> {
    const listing = (await this.approvals.ofSubjectIn(tx, quote.id, QUOTE_BELOW_MARGIN_KIND)).find((a) => a.id === version.approvalRequestId)!;
    return {
      status: 'PENDING_APPROVAL',
      approvalRequestId: listing.id,
      kind: QUOTE_BELOW_MARGIN_KIND,
      subject: { id: quote.id, docType: QUOTE, number: quote.quoteNo },
      summary: listing.summary,
      requestedAt: listing.requestedAt.toISOString(),
    };
  }

  /**
   * Each line checked and priced (FR-QUO-003, CR-045): a product line in its own unit, converted to the base unit
   * exactly (B06u); the engine's price for that unit kept for the record with its floor; the cost estimated from the
   * pools of the named animal, or of the stock it may be promised from. A free-text line has no product, no base
   * quantity and no cost.
   */
  private async priceLines(
    tx: Transaction,
    versionId: string,
    branchId: string,
    customerId: string | null,
    inputs: readonly QuoteLineInput[],
    at: Date,
  ): Promise<{ readonly lines: LineRecord[]; readonly products: ReadonlyMap<string, ProductFacts> }> {
    const products = await this.refs.productsIn(
      tx,
      inputs.flatMap((l) => (isSet(l.productId) ? [l.productId] : [])),
    );
    const units = await this.units.factsIn(
      tx,
      inputs.flatMap((l) => (isSet(l.stockUnitId) ? [l.stockUnitId] : [])),
      at,
    );
    const broken: QuoteRule[] = [];
    if (inputs.length === 0) broken.push({ field: '/lines', rule: 'NO_LINES' });
    const checked: { i: number; input: QuoteLineInput; product: ProductFacts | null; uom: string; baseQty: Quantity | null }[] = [];
    for (const [i, l] of inputs.entries()) {
      const qty = Quantity.parse(l.quantity);
      if (!isSet(l.productId)) {
        if (isSet(l.stockUnitId)) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_OTHER_PRODUCT' });
        checked.push({ i, input: l, product: null, uom: l.uom ?? DEFAULT_UOM[l.priceBasis], baseQty: null });
        continue;
      }
      const product = products.get(l.productId);
      if (product === undefined || !product.isLive) {
        broken.push({ field: lineField(i, 'productId'), rule: 'PRODUCT_NOT_ACTIVE' });
        continue;
      }
      const uom = l.uom ?? product.baseUom;
      const base = await this.refs.toBaseIn(tx, product.id, uom, qty);
      if (!base.ok) {
        broken.push({ field: lineField(i, 'uom'), rule: base.error === 'INEXACT_QUANTITY' ? 'INEXACT_QUANTITY' : 'NO_CONVERSION' });
        continue;
      }
      if (isSet(l.stockUnitId)) {
        const unit = units.get(l.stockUnitId);
        if (unit === undefined || unit.productId !== product.id) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_OTHER_PRODUCT' });
        else if (unit.status !== 'ACTIVE' || unit.branchId !== branchId) broken.push({ field: lineField(i, 'stockUnitId'), rule: 'STOCK_UNIT_NOT_AVAILABLE' });
        if (product.tracking === 'SERIAL' && !base.value.equals(Quantity.ofUnits(1n))) broken.push({ field: lineField(i, 'quantity'), rule: 'ONE_ANIMAL_PER_LINE' });
      }
      if (product.tracking === 'SERIAL' && base.value.thousandths % 1_000n !== 0n) broken.push({ field: lineField(i, 'quantity'), rule: 'INEXACT_QUANTITY' });
      checked.push({ i, input: l, product, uom, baseQty: base.value });
    }
    if (broken.length > 0) throw new QuoteInvalidError(broken);

    const priced = checked.filter((c) => c.product !== null);
    const resolved =
      priced.length === 0
        ? []
        : (
            await this.pricing.resolveIn(tx, {
              channel: 'QUOTE',
              branchId,
              ...(customerId === null ? {} : { customerId }),
              at,
              lines: priced.map((c) => {
                const unit = isSet(c.input.stockUnitId) ? units.get(c.input.stockUnitId) : undefined;
                const gradeId = c.input.gradeId ?? unit?.gradeId ?? undefined;
                const weightKg = unit?.lastWeightKg ?? undefined;
                return {
                  lineRef: String(c.i),
                  productId: c.product!.id,
                  quantity: Quantity.parse(c.input.quantity).toDecimalString(),
                  ...(c.uom === c.product!.baseUom ? {} : { uom: c.uom }),
                  ...(gradeId === undefined || gradeId === null ? {} : { gradeId }),
                  ...(weightKg === undefined || weightKg === null ? {} : { weightKg }),
                };
              }),
            })
          ).lines;

    // The pools each product line is costed from: the named animal's, or every live pool of the product at the branch.
    const pools = await this.stock.costPoolsIn(
      tx,
      branchId,
      priced.map((c) => c.product!.id),
    );

    const lines: LineRecord[] = [];
    for (const c of checked) {
      const qty = Quantity.parse(c.input.quantity);
      const band = resolved.find((r) => r.lineRef === String(c.i))?.resolved ?? null;
      if (band !== null && band.basis !== c.input.priceBasis) broken.push({ field: lineField(c.i, 'priceBasis'), rule: 'PRICE_BASIS_MISMATCH' });
      let cost: bigint | null = null;
      if (c.product !== null && c.baseQty !== null) {
        const mine = pools.filter((p) => p.productId === c.product!.id && (!isSet(c.input.stockUnitId) || p.stockUnitId === c.input.stockUnitId));
        cost = unitCost(
          mine.map((p) => ({ valuePesewas: p.valuePesewas, qty: Quantity.parse(p.qty) })),
          c.baseQty,
          qty,
        );
      }
      lines.push({
        id: this.nextId(),
        quoteVersionId: versionId,
        lineNo: lineNumber(c.i),
        productId: c.product?.id ?? null,
        description: c.input.description,
        gradeId: c.input.gradeId ?? null,
        weightBandId: c.input.weightBandId ?? band?.weightBand?.id ?? null,
        stockUnitId: c.input.stockUnitId ?? null,
        reservationId: null,
        qty: qty.toDecimalString(),
        uom: c.uom,
        baseQty: c.baseQty?.toDecimalString() ?? null,
        priceBasis: c.input.priceBasis,
        resolvedUnitPricePesewas: band === null ? null : BigInt(band.listPricePesewas),
        resolvedFloorUnitPricePesewas: band === null ? null : BigInt(band.floorPricePesewas),
        unitPricePesewas: c.input.unitPricePesewas,
        lineNetPesewas: lineNet(c.input.unitPricePesewas, qty),
        estimatedUnitCostPesewas: cost,
      });
    }
    if (broken.length > 0) throw new QuoteInvalidError(broken);
    return { lines, products };
  }

  /** The version's figures: the calculator's tax on the product lines, the margin floor from its setting. */
  private async figuresIn(
    tx: Transaction,
    branchId: string,
    priced: { readonly lines: readonly LineRecord[]; readonly products: ReadonlyMap<string, ProductFacts> },
    o: { readonly taxInclusive: boolean; readonly deliveryFeePesewas: bigint; readonly at: Date },
  ) {
    const taxed = priced.lines.filter((l) => l.productId !== null);
    const tax =
      taxed.length === 0
        ? 0n
        : (
            await this.tax.calculateIn(tx, {
              taxInclusive: o.taxInclusive,
              taxDate: toBusinessDate(o.at),
              lines: taxed.map((l) => ({ lineRef: l.id, taxCategoryId: priced.products.get(l.productId!)!.taxCategoryId, amountPesewas: l.lineNetPesewas })),
            })
          ).totals.tax.pesewas;
    const floor = await this.settings.integer(MARGIN_FLOOR_SETTING, DEFAULT_MARGIN_FLOOR_BASIS_POINTS, branchId);
    const f = versionFigures(
      priced.lines.map((l) => ({
        qty: Quantity.parse(l.qty),
        unitPricePesewas: l.unitPricePesewas,
        unitCostPesewas: l.estimatedUnitCostPesewas,
        belowEngineFloor: l.resolvedFloorUnitPricePesewas !== null && l.unitPricePesewas < l.resolvedFloorUnitPricePesewas,
      })),
      { deliveryFeePesewas: o.deliveryFeePesewas, taxPesewas: tax, floorBasisPoints: floor, taxInclusive: o.taxInclusive },
    );
    return { netPesewas: f.netPesewas, taxPesewas: f.taxPesewas, grossPesewas: f.grossPesewas, estimatedCostPesewas: f.estimatedCostPesewas, marginPercent: f.marginPercent, belowMarginFloor: f.belowMarginFloor };
  }

  /** The product line the quote is reported under (FR-QUO-013): its first product's category, by its code. */
  private async productLineOf(tx: Transaction, lines: readonly LineRecord[]): Promise<string | null> {
    const first = lines.find((l) => l.productId !== null);
    if (first === undefined) return null;
    const product = (await this.refs.productsIn(tx, [first.productId!])).get(first.productId!);
    return product?.glGroup ?? null;
  }

  private async wholeBranches(tx: Transaction, actor: Actor, permission: string): Promise<string[]> {
    return [...new Set((await this.authoriser.scopes(tx, actor, permission)).filter((s) => s.locationId === null).map((s) => s.branchId))].sort();
  }

  async viewOf(tx: Transaction, id: string): Promise<QuoteView> {
    return (await this.viewsIn(tx, await this.store.quotes(tx, [id])))[0]!;
  }

  private async viewsIn(tx: Transaction, quotes: readonly QuoteRecord[]): Promise<QuoteView[]> {
    const versions = await this.store.versionsOf(
      tx,
      quotes.map((q) => q.id),
    );
    const current = new Map<string, VersionRecord>();
    const counts = countOf(versions.map((v) => v.quoteId));
    for (const v of versions) if (!current.has(v.quoteId)) current.set(v.quoteId, v);
    const versionViews = new Map((await this.versionViewsIn(tx, [...current.values()])).map((v) => [v.id, v] as const));
    const customers = await this.refs.customersIn(
      tx,
      quotes.flatMap((q) => (q.customerId === null ? [] : [q.customerId])),
    );
    const people = await this.principals.refs(
      tx,
      quotes.map((q) => q.salespersonId),
    );
    const orders = await this.registry.numberedRefs(
      tx,
      quotes.flatMap((q) => (q.convertedOrderId === null ? [] : [q.convertedOrderId])),
    );
    return quotes.map((q) => {
      const customer = q.customerId === null ? undefined : customers.get(q.customerId);
      return {
        id: q.id,
        quoteNo: q.quoteNo,
        status: q.status,
        rfqId: q.rfqId,
        customer: customer === undefined ? null : { id: customer.id, publicId: customer.publicId, name: customer.name },
        contactName: q.contactName,
        contactPhone: q.contactPhone,
        salesperson: people.get(q.salespersonId) ?? { id: q.salespersonId, displayName: q.salespersonId },
        productLine: q.productLine,
        currentVersion: versionViews.get(current.get(q.id)!.id)!,
        versionCount: counts.get(q.id) ?? 0,
        acceptedVersionId: q.acceptedVersionId,
        convertedOrder: q.convertedOrderId === null ? null : (orders.get(q.convertedOrderId) ?? null),
        declineReason: q.declineReason,
        branchId: q.branchId,
        version: q.version,
        createdAt: q.createdAt.toISOString(),
      };
    });
  }

  private async versionViewsIn(tx: Transaction, versions: readonly VersionRecord[]): Promise<QuoteVersionView[]> {
    const ids = versions.map((v) => v.id);
    const lines = await this.store.linesOf(tx, ids);
    const acceptances = await this.store.acceptancesOf(tx, ids);
    const people = await this.principals.refs(
      tx,
      versions.flatMap((v) => [v.createdBy, ...(v.issuedBy === null ? [] : [v.issuedBy])]),
    );
    const products = await this.refs.productsIn(
      tx,
      lines.flatMap((l) => (l.productId === null ? [] : [l.productId])),
    );
    const grades = await this.refs.gradesIn(
      tx,
      lines.flatMap((l) => (l.gradeId === null ? [] : [l.gradeId])),
    );
    const bands = await this.refs.weightBandsIn(
      tx,
      lines.flatMap((l) => (l.weightBandId === null ? [] : [l.weightBandId])),
    );
    const units = await this.units.factsIn(
      tx,
      lines.flatMap((l) => (l.stockUnitId === null ? [] : [l.stockUnitId])),
      this.clock.now(),
    );
    const name = (id: string): Ref => people.get(id) ?? { id, displayName: id };
    return versions.map((v) => {
      const acceptance = acceptances.find((a) => a.quoteVersionId === v.id);
      return {
        id: v.id,
        versionNo: v.versionNo,
        status: v.status,
        validUntil: v.validUntil.toISOString(),
        terms: v.terms,
        deliveryEstimate: v.deliveryEstimate,
        deliveryFeePesewas: json(v.deliveryFeePesewas),
        taxInclusive: v.taxInclusive,
        netPesewas: json(v.netPesewas),
        taxPesewas: json(v.taxPesewas),
        grossPesewas: json(v.grossPesewas),
        estimatedCostPesewas: jsonOrNull(v.estimatedCostPesewas),
        marginPercent: v.marginPercent,
        belowMarginFloor: v.belowMarginFloor,
        approvalRequestId: v.approvalRequestId,
        changeNote: v.changeNote,
        issuedAt: v.issuedAt?.toISOString() ?? null,
        issuedBy: v.issuedBy === null ? null : name(v.issuedBy),
        lines: lines
          .filter((l) => l.quoteVersionId === v.id)
          .map((l) => {
            const product = l.productId === null ? undefined : products.get(l.productId);
            const grade = l.gradeId === null ? undefined : grades.get(l.gradeId);
            const band = l.weightBandId === null ? undefined : bands.get(l.weightBandId);
            const unit = l.stockUnitId === null ? undefined : units.get(l.stockUnitId);
            return {
              id: l.id,
              lineNo: l.lineNo,
              product: product === undefined ? null : { id: product.id, sku: product.sku, name: product.name },
              description: l.description,
              grade: grade === undefined ? null : { id: grade.id, code: grade.code, name: grade.name },
              weightBand: band === undefined ? null : { id: band.id, code: band.code, minKg: band.minKg, maxKg: band.maxKg },
              stockUnit: unit === undefined ? null : { id: unit.id, identifier: unit.identifier, tracking: unit.tracking },
              reservationId: l.reservationId,
              quantity: l.qty,
              uom: l.uom,
              baseQuantity: l.baseQty,
              priceBasis: l.priceBasis,
              resolvedUnitPricePesewas: jsonOrNull(l.resolvedUnitPricePesewas),
              unitPricePesewas: json(l.unitPricePesewas),
              lineNetPesewas: json(l.lineNetPesewas),
              estimatedUnitCostPesewas: jsonOrNull(l.estimatedUnitCostPesewas),
            };
          }),
        acceptance: acceptance === undefined ? null : { method: acceptance.method, acceptedName: acceptance.acceptedName, acceptedAt: acceptance.acceptedAt.toISOString() },
        documentId: v.archivedDocumentId,
        currency: 'GHS',
        createdBy: name(v.createdBy),
        createdAt: v.createdAt.toISOString(),
        version: v.version,
        acceptanceLinkToken: null,
      };
    });
  }

  private async publicViewIn(tx: Transaction, quote: QuoteRecord, version: VersionRecord, status: PublicQuoteView['status']): Promise<PublicQuoteView> {
    const lines = await this.store.linesOf(tx, [version.id]);
    const customer = quote.customerId === null ? undefined : (await this.refs.customersIn(tx, [quote.customerId])).get(quote.customerId);
    return {
      quoteNo: quote.quoteNo,
      versionNo: version.versionNo,
      status,
      validUntil: version.validUntil.toISOString(),
      customerName: customer?.name ?? quote.contactName,
      lines: lines.map((l) => ({ description: l.description, quantity: l.qty, uom: l.uom, priceBasis: l.priceBasis, unitPricePesewas: json(l.unitPricePesewas), lineNetPesewas: json(l.lineNetPesewas) })),
      deliveryFeePesewas: json(version.deliveryFeePesewas),
      netPesewas: json(version.netPesewas),
      taxPesewas: json(version.taxPesewas),
      grossPesewas: json(version.grossPesewas),
      currency: 'GHS',
      terms: version.terms,
      deliveryEstimate: version.deliveryEstimate,
      documentUrl: null,
    };
  }
}

/** A stored line as the input it was priced from, to price again (a revision, an issue). */
function inputOf(l: LineRecord): QuoteLineInput {
  return {
    ...(l.productId === null ? {} : { productId: l.productId }),
    description: l.description,
    ...(l.gradeId === null ? {} : { gradeId: l.gradeId }),
    ...(l.weightBandId === null ? {} : { weightBandId: l.weightBandId }),
    ...(l.stockUnitId === null ? {} : { stockUnitId: l.stockUnitId }),
    quantity: l.qty,
    uom: l.uom,
    priceBasis: l.priceBasis,
    unitPricePesewas: l.unitPricePesewas,
  };
}

/** A request with its bigints and dates as text, for the idempotency hash. */
function wire(request: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(request, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Record<string, unknown>;
}

/**
 * The `quote-expiry` scheduled job (FR-QUO-009, ADR-0049): issued quotes past their validity become EXPIRED and their
 * hold on stock is released. Run by the worker as the Scheduler.
 */
export class QuoteExpiry {
  constructor(private readonly quotes: Quotes) {}

  run(system: { readonly kind: 'SYSTEM'; readonly principalId: string }): Promise<string[]> {
    if (system.kind !== 'SYSTEM') throw new Error('the quote expiry runs as a SYSTEM principal only');
    return this.quotes.expireLapsed(system);
  }
}
