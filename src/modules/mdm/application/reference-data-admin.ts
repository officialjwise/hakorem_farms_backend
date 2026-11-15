import { createHmac } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { openWithSubjectKey, sealWithSubjectKey, type SubjectKeys } from '../../../platform/crypto/subject-keys';
import { sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Settings } from '../../../platform/settings/settings';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { SupplierRegistered } from '../events';
import type { Authoriser } from '../../iam';
import { normaliseGhanaPhone, planAddress } from '../domain/parties';
import type { Channel } from '../domain/pricing/pricing-engine';
import { areaConflicts, defineZoneAreas, matchDeliveryZone, planPaymentMethodChange, quoteForZone } from '../domain/reference-data';
import { jsonPesewas } from './json-money';
import { AdminKit, requireLiveVersion, sentColumns } from './admin-kit';
import { DeliveryZoneInvalidError, DuplicateRecordError, invalidFormat, PaymentMethodInvalidError, referencesNotFound } from './errors';
import type { Page } from './product-catalogue';
import type { PaymentMethodView, ReasonCodeView, ReferenceDataStore, SupplierRecord, SupplierStatus, ZoneRecord } from './reference-data-store';

/** The contract's `Supplier`. `hasProfile` is answered by procurement once `pur.supplier_profile` exists (B7); until then false. */
export interface SupplierView {
  readonly id: string;
  readonly supplierNo: string;
  readonly name: string;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly tinMasked: string | null;
  readonly status: SupplierStatus;
  readonly categories: SupplierRecord['categories'];
  readonly hasProfile: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `DeliveryZone`, money as JSON integers of pesewas. */
export interface DeliveryZoneView {
  readonly id: string;
  readonly branch: ZoneRecord['branch'];
  readonly code: string;
  readonly name: string;
  readonly areas: readonly string[];
  readonly feePesewas: number;
  readonly freeOverPesewas: number | null;
  readonly cutoffTime: string;
  readonly isActive: boolean;
  readonly currency: 'GHS';
  readonly version: number;
}

/** The contract's `DeliveryQuote`. Slots arrive with delivery scheduling (B11): until then none are offered. */
export interface DeliveryQuoteView {
  readonly deliverable: boolean;
  readonly zone: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly feePesewas: number | null;
  readonly freeOverPesewas: number | null;
  readonly cutoffTime: string | null;
  readonly slots: readonly never[];
  readonly currency: 'GHS';
}

export interface SupplierCreateRequest {
  readonly name: string;
  readonly contactName?: string | undefined;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly address?: string | undefined;
  readonly tin?: string | undefined;
  readonly categoryIds?: readonly string[] | undefined;
}

export interface SupplierUpdateRequest extends Omit<SupplierCreateRequest, 'name'> {
  readonly version: number;
  readonly name?: string | undefined;
  readonly status?: SupplierStatus | undefined;
}

export interface PaymentMethodUpdateRequest {
  readonly version: number;
  readonly isEnabled?: boolean | undefined;
  readonly allowedOffline?: boolean | undefined;
  readonly requiresProviderVerification?: boolean | undefined;
  readonly channels?: readonly Channel[] | undefined;
}

export interface ZoneCreateRequest {
  readonly branchId: string;
  readonly code: string;
  readonly name: string;
  readonly areas: readonly string[];
  readonly feePesewas: bigint;
  readonly freeOverPesewas?: bigint | undefined;
  readonly cutoffTime: string;
}

export interface ZoneUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly areas?: readonly string[] | undefined;
  readonly feePesewas?: bigint | undefined;
  readonly freeOverPesewas?: bigint | undefined;
  readonly cutoffTime?: string | undefined;
  readonly isActive?: boolean | undefined;
}

export interface DeliveryQuoteRequest {
  readonly address: { readonly area: string; readonly city: string; readonly region: string; readonly line1: string; readonly recipientPhone: string; readonly digitalAddress?: string | undefined };
  readonly cartId?: string | undefined;
}

/** The setting that lets mobile money be taken at an offline counter (A-041); off unless the owner turns it on. */
export const OFFLINE_MOBILE_MONEY_SETTING = 'pos.offline_mobile_money_allowed';
/** How many characters of a tax identification number a screen shows. */
const TIN_VISIBLE = 4;
/** Personal data in a supplier's audit `before` and `after` (FR-AUD-011), encrypted with the supplier's key. */
const SUPPLIER_PERSONAL = ['contactName', 'phone', 'email', 'tinMasked'] as const;

const UNIQUE_POINTER: Readonly<Record<string, string>> = { uq_supplier_phone_hash: '/phone', uq_delivery_zone_code: '/code' };

function translateConstraint(error: unknown): never {
  const constraint = (error as { constraint?: string }).constraint ?? '';
  if (sqlStateOf(error) === '23505' && UNIQUE_POINTER[constraint] !== undefined) {
    throw new DuplicateRecordError([UNIQUE_POINTER[constraint]]);
  }
  throw error;
}

function phoneOf(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const phone = normaliseGhanaPhone(input);
  if (!phone.ok) throw invalidFormat([{ field: '/phone', rule: phone.error }]);
  return phone.value;
}

const tinPlace = (supplierId: string) => `mdm.supplier.tin_enc:${supplierId}`;

/**
 * Suppliers (FR-MDM-007) and the reference data: payment methods (FR-MDM-009), delivery zones and the delivery quote
 * (FR-MDM-010), and the fixed list of reason codes (FR-MDM-011). Every handler authorises in the application layer and
 * denies by default; every write is serializable, claims its idempotency key first and audits before and after. A zone
 * write is scoped to the zone's branch. The quote is public and read-only.
 */
export class ReferenceDataAdmin {
  private readonly nextId: () => string;
  private readonly kit: AdminKit;
  private readonly phoneKey: Buffer;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ReferenceDataStore,
    authoriser: Authoriser,
    idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly subjectKeys: SubjectKeys,
    cursors: Cursors,
    private readonly clock: Clock,
    private readonly settings: Settings,
    lookupKey: Buffer,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.kit = new AdminKit(uow, authoriser, idempotency, cursors, translateConstraint);
    this.phoneKey = createHmac('sha256', lookupKey).update('hk-supplier-phone-v1').digest();
  }

  // Suppliers.

  listSuppliers(
    actor: Actor | undefined,
    query: { readonly q?: string | undefined; readonly categoryId?: string | undefined; readonly status?: SupplierStatus | undefined },
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<SupplierView>> {
    const phone = query.q === undefined ? null : normaliseGhanaPhone(query.q);
    const filters = {
      ...(query.q === undefined ? {} : phone !== null && phone.ok ? { phoneHash: this.phoneHash(phone.value) } : { name: query.q }),
      categoryId: query.categoryId,
      status: query.status,
    };
    return this.kit.page(
      actor,
      'mdm.supplier.read',
      'listSuppliers',
      { q: query.q ?? null, categoryId: query.categoryId ?? null, status: query.status ?? null },
      cursor,
      limit,
      async (tx, after) => {
        const views: SupplierView[] = [];
        for (const record of await this.store.suppliers(tx, filters, after, limit + 1)) views.push(await this.supplierView(tx, record, actor!));
        return views;
      },
    );
  }

  getSupplier(actor: Actor | undefined, id: string): Promise<SupplierView> {
    return this.kit.read(
      actor,
      'mdm.supplier.read',
      async (tx) => {
        const record = await this.store.supplier(tx, id);
        return record === null ? null : this.supplierView(tx, record, actor!);
      },
      'no such supplier',
    );
  }

  createSupplier(actor: Actor | undefined, body: SupplierCreateRequest, idempotencyKey: string): Promise<StoredResponse<SupplierView>> {
    return this.kit.write(actor, 'mdm.supplier.create', 'createSupplier', body, idempotencyKey, async (tx) => {
      const phone = phoneOf(body.phone) ?? null;
      const phoneHash = phone === null ? null : this.phoneHash(phone);
      if (phoneHash !== null && (await this.store.supplierPhoneTaken(tx, phoneHash, null))) throw new DuplicateRecordError(['/phone']);
      const categoryIds = await this.liveCategories(tx, body.categoryIds ?? []);
      const id = this.nextId();
      await this.store.insertSupplier(
        tx,
        id,
        {
          supplierNo: await this.store.nextSupplierNo(tx),
          name: body.name,
          contactName: body.contactName ?? null,
          phone,
          phoneHash,
          email: body.email?.trim().toLowerCase() ?? null,
          address: body.address ?? null,
          tinEnc: body.tin === undefined ? null : await this.sealTin(tx, id, body.tin, actor!),
        },
        actor!.principalId,
      );
      await this.store.setSupplierCategories(tx, id, categoryIds, actor!.principalId, this.clock.now(), this.nextId);
      const view = await this.supplierViewOf(tx, id, actor!);
      await this.auditSupplier(tx, 'CREATE', id, null, view);
      const payload: SupplierRegistered = { supplierId: id, supplierNo: view.supplierNo, name: view.name, categoryIds };
      await this.events.publish(tx, { type: 'mdm.SupplierRegistered', subjectType: 'Supplier', subjectId: id, payload });
      return { status: 201, body: view };
    });
  }

  updateSupplier(actor: Actor | undefined, id: string, body: SupplierUpdateRequest, idempotencyKey: string): Promise<StoredResponse<SupplierView>> {
    return this.kit.write(actor, 'mdm.supplier.update', 'updateSupplier', { id, ...body }, idempotencyKey, async (tx) => {
      requireLiveVersion(await this.store.lockSupplier(tx, id), 'supplier', id, body.version);
      const before = await this.supplierViewOf(tx, id, actor!);
      const phone = phoneOf(body.phone);
      const phoneHash = phone === undefined ? undefined : this.phoneHash(phone);
      if (phoneHash !== undefined && (await this.store.supplierPhoneTaken(tx, phoneHash, id))) throw new DuplicateRecordError(['/phone']);
      const categoryIds = body.categoryIds === undefined ? undefined : await this.liveCategories(tx, body.categoryIds);
      const set = sentColumns({
        name: body.name,
        contact_name: body.contactName,
        phone_e164: phone,
        phone_hash: phoneHash,
        email: body.email?.trim().toLowerCase(),
        address: body.address,
        tin_enc: body.tin === undefined ? undefined : await this.sealTin(tx, id, body.tin, actor!),
        status: body.status,
      });
      if (Object.keys(set).length > 0 && !(await this.store.updateSupplier(tx, id, body.version, set, actor!.principalId))) {
        throw new VersionConflictError(`supplier ${id} changed while it was updated`);
      }
      if (categoryIds !== undefined) await this.store.setSupplierCategories(tx, id, categoryIds, actor!.principalId, this.clock.now(), this.nextId);
      const view = await this.supplierViewOf(tx, id, actor!);
      await this.auditSupplier(tx, 'UPDATE', id, before, view);
      return { status: 200, body: view };
    });
  }

  /** Archives a supplier with a reason. Refusing one with open purchase orders arrives with procurement (B7, A-117). */
  archiveSupplier(actor: Actor | undefined, id: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<SupplierView>> {
    return this.kit.write(actor, 'mdm.supplier.archive', 'archiveSupplier', { id, ...body }, idempotencyKey, async (tx) => {
      requireLiveVersion(await this.store.lockSupplier(tx, id), 'supplier', id, body.version);
      const before = await this.supplierViewOf(tx, id, actor!);
      if (!(await this.store.archiveSupplier(tx, id, body.version, body.reason, actor!.principalId, this.clock.now()))) {
        throw new VersionConflictError(`supplier ${id} changed while it was archived`);
      }
      const view = await this.supplierViewOf(tx, id, actor!);
      await this.auditSupplier(tx, 'ARCHIVE', id, before, view, body.reason);
      return { status: 200, body: view };
    });
  }

  // Payment methods.

  /** Enabled methods only, as a tender screen needs them, unless `includeDisabled` (FR-MDM-009). */
  listPaymentMethods(actor: Actor | undefined, includeDisabled: boolean, cursor: string | undefined, limit: number): Promise<Page<PaymentMethodView>> {
    return this.kit.page(actor, 'mdm.payment_method.read', 'listPaymentMethods', { includeDisabled }, cursor, limit, (tx, after) =>
      this.store.paymentMethods(tx, includeDisabled, after, limit + 1),
    );
  }

  updatePaymentMethod(actor: Actor | undefined, id: string, body: PaymentMethodUpdateRequest, idempotencyKey: string): Promise<StoredResponse<PaymentMethodView>> {
    return this.kit.write(actor, 'mdm.payment_method.manage', 'updatePaymentMethod', { id, ...body }, idempotencyKey, async (tx) => {
      requireLiveVersion(await this.store.lockPaymentMethod(tx, id), 'payment method', id, body.version);
      const before = (await this.store.paymentMethod(tx, id))!;
      const plan = planPaymentMethodChange(before, body, { offlineMobileMoneyAllowed: await this.settings.boolean(OFFLINE_MOBILE_MONEY_SETTING, false) });
      if (!plan.ok) throw new PaymentMethodInvalidError(plan.error);
      const set = sentColumns({
        is_enabled: body.isEnabled,
        allowed_offline: body.allowedOffline,
        requires_provider_verification: body.requiresProviderVerification,
        channels: body.channels === undefined ? undefined : [...new Set(body.channels)],
      });
      if (Object.keys(set).length > 0 && !(await this.store.updatePaymentMethod(tx, id, body.version, set, actor!.principalId))) {
        throw new VersionConflictError(`payment method ${id} changed while it was updated`);
      }
      const view = (await this.store.paymentMethod(tx, id))!;
      await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'PaymentMethod', entityId: id, before: { ...before }, after: { ...view } });
      return { status: 200, body: view };
    });
  }

  // Delivery zones.

  listZones(actor: Actor | undefined, branchId: string | undefined, cursor: string | undefined, limit: number): Promise<Page<DeliveryZoneView>> {
    return this.kit.page(actor, 'mdm.delivery_zone.read', 'listDeliveryZones', { branchId: branchId ?? null }, cursor, limit, async (tx, after) =>
      (await this.store.zones(tx, branchId ?? null, after, limit + 1)).map(zoneView),
    );
  }

  getZone(actor: Actor | undefined, id: string): Promise<DeliveryZoneView> {
    return this.kit.read(actor, 'mdm.delivery_zone.read', async (tx) => {
      const zone = await this.store.zone(tx, id);
      return zone === null ? null : zoneView(zone);
    }, 'no such delivery zone');
  }

  createZone(actor: Actor | undefined, body: ZoneCreateRequest, idempotencyKey: string): Promise<StoredResponse<DeliveryZoneView>> {
    return this.kit.write(
      actor,
      'mdm.delivery_zone.create',
      'createDeliveryZone',
      { ...body, feePesewas: body.feePesewas.toString(), freeOverPesewas: body.freeOverPesewas?.toString() ?? null },
      idempotencyKey,
      async (tx) => {
        if (!(await this.store.branchExists(tx, body.branchId))) throw referencesNotFound(['/branchId']);
        const areas = await this.checkedAreas(tx, body.areas, null);
        if (await this.store.zoneCodeTaken(tx, body.branchId, body.code)) throw new DuplicateRecordError(['/code']);
        const id = this.nextId();
        await this.store.insertZone(
          tx,
          id,
          { branchId: body.branchId, code: body.code, name: body.name, areas, feePesewas: body.feePesewas, freeOverPesewas: body.freeOverPesewas ?? null, cutoffTime: body.cutoffTime },
          actor!.principalId,
        );
        const view = zoneView((await this.store.zone(tx, id))!);
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'DeliveryZone', entityId: id, branchId: body.branchId, before: null, after: { ...view } });
        return { status: 201, body: view };
      },
      async (tx) => ((await this.store.branchExists(tx, body.branchId)) ? { branchId: body.branchId } : {}),
    );
  }

  updateZone(actor: Actor | undefined, id: string, body: ZoneUpdateRequest, idempotencyKey: string): Promise<StoredResponse<DeliveryZoneView>> {
    return this.kit.write(
      actor,
      'mdm.delivery_zone.update',
      'updateDeliveryZone',
      { id, ...body, feePesewas: body.feePesewas?.toString() ?? null, freeOverPesewas: body.freeOverPesewas?.toString() ?? null },
      idempotencyKey,
      async (tx) => {
        requireLiveVersion(await this.store.lockZone(tx, id), 'delivery zone', id, body.version);
        const before = (await this.store.zone(tx, id))!;
        const willBeActive = body.isActive ?? before.isActive;
        const areas = body.areas === undefined ? undefined : await this.checkedAreas(tx, body.areas, willBeActive ? id : undefined);
        if (body.areas === undefined && body.isActive === true && !before.isActive) await this.checkedAreas(tx, before.areas, id);
        const set = sentColumns({
          name: body.name,
          areas,
          fee_pesewas: body.feePesewas,
          free_over_pesewas: body.freeOverPesewas,
          cutoff_time: body.cutoffTime,
          is_active: body.isActive,
        });
        if (Object.keys(set).length > 0 && !(await this.store.updateZone(tx, id, body.version, set, actor!.principalId))) {
          throw new VersionConflictError(`delivery zone ${id} changed while it was updated`);
        }
        const view = zoneView((await this.store.zone(tx, id))!);
        await this.audit.record(tx, { module: 'mdm', action: 'UPDATE', entityType: 'DeliveryZone', entityId: id, branchId: before.branch.id, before: { ...zoneView(before) }, after: { ...view } });
        return { status: 200, body: view };
      },
      async (tx) => {
        const zone = await this.store.zone(tx, id);
        return zone === null ? {} : { branchId: zone.branch.id };
      },
    );
  }

  /**
   * quoteDelivery (FR-MDM-010): public and read-only. The zone whose areas name the address's area, else its city,
   * among the live, active zones of open branches; its exact fee, or "delivery unavailable" with no fee, never zero.
   * No cart exists before B7, so a cart id names nothing; slots arrive with delivery scheduling (B11).
   */
  quoteDelivery(request: DeliveryQuoteRequest): Promise<DeliveryQuoteView> {
    const plan = planAddress({ region: request.address.region, line1: request.address.line1, digitalAddress: request.address.digitalAddress, recipientPhone: request.address.recipientPhone });
    if (!plan.ok) throw invalidFormat(plan.error.map((rule) => ({ ...rule, field: rule.field === null ? null : `/address${rule.field}` })));
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      if (request.cartId !== undefined) throw referencesNotFound(['/cartId']);
      const quote = quoteForZone(matchDeliveryZone(request.address, await this.store.deliverableZones(tx)));
      return { ...quote, feePesewas: jsonPesewas(quote.feePesewas), freeOverPesewas: jsonPesewas(quote.freeOverPesewas), slots: [], currency: 'GHS' };
    });
  }

  // Reason codes.

  /** The fixed list (FR-MDM-011); there is no write operation. */
  async listReasonCodes(actor: Actor | undefined, domain: string | undefined, cursor: string | undefined, limit: number): Promise<Page<ReasonCodeView>> {
    const page = await this.kit.page(actor, 'mdm.reason_code.read', 'listReasonCodes', { domain: domain ?? null }, cursor, limit, async (tx, after) =>
      (await this.store.reasonCodes(tx, domain ?? null, after, limit + 1)).map((row) => ({ id: row.code, row })),
    );
    return { data: page.data.map((entry) => entry.row), page: page.page };
  }

  // Shared steps.

  private async checkedAreas(tx: Transaction, input: readonly string[], exceptId: string | null | undefined): Promise<string[]> {
    const areas = defineZoneAreas(input);
    if (!areas.ok) throw new DeliveryZoneInvalidError(areas.error);
    // An inactive zone may share an area; it is checked again when it is made active.
    if (exceptId !== undefined) {
      const conflicts = areaConflicts(areas.value, await this.store.otherActiveZones(tx, exceptId));
      if (conflicts.length > 0) throw new DeliveryZoneInvalidError(conflicts);
    }
    return areas.value;
  }

  private async liveCategories(tx: Transaction, ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const unknown = await this.store.unknownCategories(tx, unique);
    if (unknown.length > 0) throw referencesNotFound(unknown.map((id) => `/categoryIds/${ids.indexOf(id)}`));
    return unique;
  }

  private phoneHash(phone: string): Buffer {
    return createHmac('sha256', this.phoneKey).update(phone).digest();
  }

  private async sealTin(tx: Transaction, supplierId: string, tin: string, actor: Actor): Promise<Buffer> {
    const key = await this.subjectKeys.keyFor(tx, { type: 'SUPPLIER', id: supplierId }, actor.principalId);
    return sealWithSubjectKey(key, tin.trim(), tinPlace(supplierId));
  }

  private async supplierViewOf(tx: Transaction, id: string, actor: Actor): Promise<SupplierView> {
    return this.supplierView(tx, (await this.store.supplier(tx, id))!, actor);
  }

  private async supplierView(tx: Transaction, record: SupplierRecord, actor: Actor): Promise<SupplierView> {
    let tinMasked: string | null = null;
    if (record.tinEnc !== null) {
      const key = await this.subjectKeys.keyFor(tx, { type: 'SUPPLIER', id: record.id }, actor.principalId);
      const tin = openWithSubjectKey(key.key, record.tinEnc, tinPlace(record.id));
      tinMasked = `${'*'.repeat(Math.max(tin.length - TIN_VISIBLE, 0))}${tin.slice(-TIN_VISIBLE)}`;
    }
    return {
      id: record.id,
      supplierNo: record.supplierNo,
      name: record.name,
      contactName: record.contactName,
      phone: record.phone,
      email: record.email,
      address: record.address,
      tinMasked,
      status: record.status,
      categories: record.categories,
      hasProfile: false,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private auditSupplier(tx: Transaction, action: string, id: string, before: SupplierView | null, after: SupplierView, reason?: string): Promise<unknown> {
    return this.audit.record(tx, {
      module: 'mdm',
      action,
      entityType: 'Supplier',
      entityId: id,
      before: before === null ? null : { ...before },
      after: reason === undefined ? { ...after } : { ...after, reason },
      subject: { type: 'SUPPLIER', id },
      personalFields: SUPPLIER_PERSONAL,
    });
  }
}

function zoneView(zone: ZoneRecord): DeliveryZoneView {
  return {
    id: zone.id,
    branch: zone.branch,
    code: zone.code,
    name: zone.name,
    areas: zone.areas,
    feePesewas: jsonPesewas(zone.feePesewas),
    freeOverPesewas: jsonPesewas(zone.freeOverPesewas),
    cutoffTime: zone.cutoffTime,
    isActive: zone.isActive,
    currency: 'GHS',
    version: zone.version,
  };
}
