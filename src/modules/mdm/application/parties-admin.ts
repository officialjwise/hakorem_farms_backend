import { createHmac } from 'node:crypto';
import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { openWithSubjectKey, sealWithSubjectKey, type SubjectKeys } from '../../../platform/crypto/subject-keys';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { InvalidStateTransitionError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { normaliseGhanaPhone, planAddress, planPriceListAssignment } from '../domain/parties';
import { readPublicId } from '../domain/public-id';
import { matchDeliveryZone } from '../domain/reference-data';
import { AdminKit, requireLiveVersion, sentColumns } from './admin-kit';
import { DuplicateRecordError, invalidFormat, PriceListAssignmentInvalidError, referencesNotFound } from './errors';
import type { AddressView, CustomerFilters, CustomerKind, CustomerRecord, CustomerStatus, PartiesStore, TierView } from './parties-store';
import type { Page } from './product-catalogue';
import type { PublicIds } from './public-ids';

/** The contract's `Customer`. `hasBusinessAccount` is answered by wholesale once it exists (B10); until then false. */
export interface CustomerView {
  readonly id: string;
  /** The customer's public ID (B09q, ADR-0073), in place of the sequential number from contract 2.0.0. */
  readonly publicId: string;
  readonly kind: CustomerKind;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly tier: TierView;
  readonly hasLogin: boolean;
  readonly tinMasked: string | null;
  readonly marketingConsentAt: string | null;
  readonly status: CustomerStatus;
  readonly priceList: { readonly id: string; readonly code: string; readonly name: string } | null;
  readonly hasBusinessAccount: boolean;
  readonly defaultArea: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The contract's `PriceListAssignment`. */
export interface AssignmentView {
  readonly customerId: string;
  readonly priceList: { readonly id: string; readonly code: string; readonly name: string };
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface CustomerCreateRequest {
  readonly kind: CustomerKind;
  readonly name: string;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly tierId?: string | undefined;
  readonly tin?: string | undefined;
  readonly marketingConsent?: boolean | undefined;
}

export interface CustomerUpdateRequest {
  readonly version: number;
  readonly name?: string | undefined;
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly tierId?: string | undefined;
  readonly tin?: string | undefined;
  readonly status?: 'ACTIVE' | 'BLOCKED' | undefined;
}

export interface AddressRequest {
  readonly label?: string | undefined;
  readonly recipientName?: string | undefined;
  readonly recipientPhone?: string | undefined;
  readonly line1?: string | undefined;
  readonly area?: string | undefined;
  readonly city?: string | undefined;
  readonly region?: string | undefined;
  readonly digitalAddress?: string | undefined;
  readonly directions?: string | undefined;
  readonly latitude?: string | undefined;
  readonly longitude?: string | undefined;
  readonly isDefault?: boolean | undefined;
}

export type AddressCreateRequest = AddressRequest & { readonly label: string; readonly recipientName: string; readonly recipientPhone: string; readonly line1: string; readonly area: string; readonly city: string; readonly region: string };

/** The tier a customer created without one joins (seeded by migration 0011). */
const DEFAULT_TIER = 'RETAIL';
/**
 * The advisory lock createCustomer takes before its transaction begins (`seriesLocks`, ADR-0005): every create reads
 * what every other create writes (the phone check over live customers, the new row's index pages), so overlapping
 * serializable creates aborted one another and one could lose all its attempts, a 500. They queue on it instead.
 */
export const CUSTOMER_CREATE_LOCK = 'mdm.customer.create';
/** How many characters of a tax identification number a screen shows. */
const TIN_VISIBLE = 4;
/** Personal data in a customer's or an address's audit `before` and `after` (FR-AUD-011), encrypted with the subject key. */
const CUSTOMER_PERSONAL = ['name', 'phone', 'email', 'tinMasked'] as const;
const ADDRESS_PERSONAL = ['recipientName', 'recipientPhone', 'line1', 'directions', 'digitalAddress', 'latitude', 'longitude'] as const;

const UNIQUE_POINTER: Readonly<Record<string, string>> = { uq_customer_phone_hash: '/phone', uq_customer_tier_code: '/code' };

function translateConstraint(error: unknown): never {
  const constraint = databaseErrorOf(error)?.constraint ?? '';
  const state = sqlStateOf(error);
  if (state === '23505' && UNIQUE_POINTER[constraint] !== undefined) {
    throw new DuplicateRecordError([UNIQUE_POINTER[constraint]]);
  }
  if (state === '23P01' && constraint === 'ex_customer_price_list_one_at_a_time') {
    throw new VersionConflictError('another assignment for this customer was saved at the same time; read it and try again');
  }
  throw error;
}

function phoneOf(input: string | undefined, field: string): string | undefined {
  if (input === undefined) return undefined;
  const phone = normaliseGhanaPhone(input);
  if (!phone.ok) throw invalidFormat([{ field, rule: phone.error }]);
  return phone.value;
}

const tinPlace = (customerId: string) => `mdm.customer.tin_enc:${customerId}`;

/**
 * Customers, their tiers and addresses, and the price list assigned to a customer (FR-MDM-008, FR-MDM-021).
 * A phone number is stored in E.164, a Ghanaian number typed locally normalised first, and is unique among live
 * customers through a keyed hash, so the number itself is never indexed. A tax identification number is encrypted
 * with the customer's own key (ADR-0022) and only its last four characters are shown. Customer data is personal
 * data (FR-AUD-011): audit events carry it encrypted with the customer's key. Customers are not branch-scoped.
 */
export class PartiesAdmin {
  private readonly nextId: () => string;
  private readonly kit: AdminKit;
  private readonly phoneKey: Buffer;

  constructor(
    uow: UnitOfWork,
    private readonly store: PartiesStore,
    authoriser: Authoriser,
    idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly subjectKeys: SubjectKeys,
    cursors: Cursors,
    private readonly clock: Clock,
    lookupKey: Buffer,
    private readonly publicIds: PublicIds,
  ) {
    this.nextId = createUuidV7Generator(clock);
    this.kit = new AdminKit(uow, authoriser, idempotency, cursors, translateConstraint);
    this.phoneKey = createHmac('sha256', lookupKey).update('hk-customer-phone-v1').digest();
  }

  // Tiers.

  listTiers(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<TierView>> {
    return this.kit.page(actor, 'mdm.customer.read', 'listCustomerTiers', {}, cursor, limit, (tx, after) => this.store.tiers(tx, after, limit + 1));
  }

  createTier(actor: Actor | undefined, body: { readonly code: string; readonly name: string }, idempotencyKey: string): Promise<StoredResponse<TierView>> {
    return this.kit.write(actor, 'mdm.customer.create', 'createCustomerTier', body, idempotencyKey, async (tx) => {
      if ((await this.store.tierByCode(tx, body.code)) !== null) throw new DuplicateRecordError(['/code']);
      const id = this.nextId();
      await this.store.insertTier(tx, id, body, actor!.principalId);
      const view = (await this.store.tier(tx, id))!;
      await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'CustomerTier', entityId: id, before: null, after: { ...view } });
      return { status: 201, body: view };
    });
  }

  // Customers.

  listCustomers(
    actor: Actor | undefined,
    query: { readonly q?: string | undefined; readonly kind?: CustomerKind | undefined; readonly tierId?: string | undefined; readonly status?: CustomerStatus | undefined },
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<CustomerView>> {
    // `q` finds a customer by public ID (typed any way, ADR-0073), by phone (typed any way) or by part of the name.
    const publicId = query.q === undefined ? null : readPublicId('CUSTOMER', query.q);
    const phone = query.q === undefined || publicId !== null ? null : normaliseGhanaPhone(query.q);
    const filters: CustomerFilters = {
      ...(query.q === undefined ? {} : publicId !== null ? { publicId } : phone !== null && phone.ok ? { phoneHash: this.phoneHash(phone.value) } : { name: query.q }),
      kind: query.kind,
      tierId: query.tierId,
      status: query.status,
    };
    return this.kit.page(
      actor,
      'mdm.customer.read',
      'listCustomers',
      { q: query.q ?? null, kind: query.kind ?? null, tierId: query.tierId ?? null, status: query.status ?? null },
      cursor,
      limit,
      async (tx, after) => {
        const views: CustomerView[] = [];
        // One query at a time on the transaction's client.
        for (const record of await this.store.customers(tx, filters, this.clock.now(), after, limit + 1)) views.push(await this.view(tx, record, actor!));
        return views;
      },
    );
  }

  getCustomer(actor: Actor | undefined, id: string): Promise<CustomerView> {
    return this.kit.read(
      actor,
      'mdm.customer.read',
      async (tx) => {
        const record = await this.store.customer(tx, id, this.clock.now());
        return record === null ? null : this.view(tx, record, actor!);
      },
      'no such customer',
    );
  }

  createCustomer(actor: Actor | undefined, body: CustomerCreateRequest, idempotencyKey: string): Promise<StoredResponse<CustomerView>> {
    return this.kit.write(
      actor,
      'mdm.customer.create',
      'createCustomer',
      body,
      idempotencyKey,
      async (tx) => ({ status: 201, body: await this.createCustomerIn(tx, actor!, body) }),
      undefined,
      [CUSTOMER_CREATE_LOCK],
    );
  }

  /**
   * Creates a customer in the caller's transaction, every rule of createCustomer applied and audited. The caller has
   * authorised `mdm.customer.create`: createCustomer, or an import being applied (FR-MDM-019).
   */
  async createCustomerIn(tx: Transaction, actor: Actor, body: CustomerCreateRequest): Promise<CustomerView> {
    const phone = phoneOf(body.phone, '/phone') ?? null;
    const tier = body.tierId === undefined ? await this.store.tierByCode(tx, DEFAULT_TIER) : await this.store.tier(tx, body.tierId);
    if (tier === null) throw referencesNotFound(['/tierId']);
    const phoneHash = phone === null ? null : this.phoneHash(phone);
    if (phoneHash !== null && (await this.store.phoneTaken(tx, phoneHash, null))) throw new DuplicateRecordError(['/phone']);
    const id = this.nextId();
    const tinEnc = body.tin === undefined ? null : await this.sealTin(tx, id, body.tin, actor);
    const customerNo = await this.store.nextCustomerNo(tx);
    // A fresh public ID, tried again on the one-in-2^80 collision with another customer's (ADR-0073).
    await this.publicIds.insertWithFresh(tx, 'CUSTOMER', (publicId) => this.store.insertCustomer(
      tx,
      id,
      {
        customerNo,
        publicId,
        kind: body.kind,
        name: body.name,
        phone,
        phoneHash,
        email: body.email?.trim().toLowerCase() ?? null,
        tierId: tier.id,
        tinEnc,
        marketingConsentAt: body.marketingConsent === true ? this.clock.now() : null,
      },
      actor.principalId,
    ));
    const view = await this.viewOf(tx, id, actor);
    await this.auditCustomer(tx, 'CREATE', id, null, view);
    return view;
  }

  updateCustomer(actor: Actor | undefined, id: string, body: CustomerUpdateRequest, idempotencyKey: string): Promise<StoredResponse<CustomerView>> {
    return this.kit.write(actor, 'mdm.customer.update', 'updateCustomer', { id, ...body }, idempotencyKey, async (tx) => ({ status: 200, body: await this.updateCustomerIn(tx, actor!, id, body) }));
  }

  /**
   * Changes a customer in the caller's transaction, every rule of updateCustomer applied and audited. The caller has
   * authorised `mdm.customer.update`: updateCustomer, or an import being applied (FR-MDM-019).
   */
  async updateCustomerIn(tx: Transaction, actor: Actor, id: string, body: CustomerUpdateRequest): Promise<CustomerView> {
    requireLiveVersion(await this.store.lockCustomer(tx, id), 'customer', id, body.version);
    const before = await this.viewOf(tx, id, actor);
    if (before.status === 'ANONYMISED') throw new InvalidStateTransitionError(`customer ${id} is anonymised`);
    const phone = phoneOf(body.phone, '/phone');
    const phoneHash = phone === undefined ? undefined : this.phoneHash(phone);
    if (phoneHash !== undefined && (await this.store.phoneTaken(tx, phoneHash, id))) throw new DuplicateRecordError(['/phone']);
    if (body.tierId !== undefined && (await this.store.tier(tx, body.tierId)) === null) throw referencesNotFound(['/tierId']);
    const set = sentColumns({
      name: body.name,
      phone_e164: phone,
      phone_hash: phoneHash,
      email: body.email?.trim().toLowerCase(),
      tier_id: body.tierId,
      tin_enc: body.tin === undefined ? undefined : await this.sealTin(tx, id, body.tin, actor),
      status: body.status,
    });
    if (Object.keys(set).length > 0 && !(await this.store.updateCustomer(tx, id, body.version, set, actor.principalId))) {
      throw new VersionConflictError(`customer ${id} changed while it was updated`);
    }
    const view = await this.viewOf(tx, id, actor);
    await this.auditCustomer(tx, 'UPDATE', id, before, view);
    return view;
  }

  /**
   * What an import row needs to know about a phone number (FR-MDM-019): the number of the live customer who holds
   * it, or null. The number is matched by its keyed hash, never by the number itself.
   */
  phoneHolder(tx: Transaction, phoneE164: string): Promise<{ readonly id: string; readonly publicId: string } | null> {
    return this.store.customerByPhoneHash(tx, this.phoneHash(phoneE164));
  }

  archiveCustomer(actor: Actor | undefined, id: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<CustomerView>> {
    return this.kit.write(actor, 'mdm.customer.archive', 'archiveCustomer', { id, ...body }, idempotencyKey, async (tx) => {
      requireLiveVersion(await this.store.lockCustomer(tx, id), 'customer', id, body.version);
      const before = await this.viewOf(tx, id, actor!);
      if (!(await this.store.archiveCustomer(tx, id, body.version, body.reason, actor!.principalId, this.clock.now()))) {
        throw new VersionConflictError(`customer ${id} changed while it was archived`);
      }
      const view = await this.viewOf(tx, id, actor!);
      await this.auditCustomer(tx, 'ARCHIVE', id, before, view, body.reason);
      return { status: 200, body: view };
    });
  }

  // Addresses.

  listAddresses(actor: Actor | undefined, customerId: string, cursor: string | undefined, limit: number): Promise<Page<AddressView>> {
    return this.kit.page(
      actor,
      'mdm.customer.read',
      'listCustomerAddresses',
      { customerId },
      cursor,
      limit,
      (tx, after) => this.store.addresses(tx, customerId, after, limit + 1),
      async (tx) => {
        if ((await this.store.customer(tx, customerId, this.clock.now())) === null) throw new NotFoundError('no such customer');
      },
    );
  }

  createAddress(actor: Actor | undefined, customerId: string, body: AddressCreateRequest, idempotencyKey: string): Promise<StoredResponse<AddressView>> {
    return this.kit.write(actor, 'mdm.customer.update', 'createCustomerAddress', { customerId, ...body }, idempotencyKey, async (tx) => {
      const state = await this.store.lockCustomer(tx, customerId);
      if (state === null || state.archived) throw new NotFoundError(`no live customer ${customerId}`);
      const facts = this.addressFacts(body);
      const id = this.nextId();
      if (body.isDefault === true) await this.store.clearDefaultAddress(tx, customerId, null, actor!.principalId);
      await this.store.insertAddress(
        tx,
        id,
        {
          customerId,
          label: body.label,
          recipientName: body.recipientName,
          recipientPhone: facts.recipientPhone,
          line1: body.line1,
          area: body.area,
          city: body.city,
          region: facts.region,
          digitalAddress: facts.digitalAddress,
          directions: body.directions ?? null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          isDefault: body.isDefault ?? false,
          deliveryZoneId: await this.zoneFor(tx, body.area, body.city),
        },
        actor!.principalId,
      );
      const view = (await this.store.address(tx, id))!;
      await this.auditAddress(tx, 'CREATE', customerId, id, null, view);
      return { status: 201, body: view };
    });
  }

  updateAddress(actor: Actor | undefined, id: string, body: AddressRequest & { readonly version: number }, idempotencyKey: string): Promise<StoredResponse<AddressView>> {
    return this.kit.write(actor, 'mdm.customer.update', 'updateCustomerAddress', { id, ...body }, idempotencyKey, async (tx) => {
      requireLiveVersion(await this.store.lockAddress(tx, id), 'address', id, body.version);
      const before = (await this.store.address(tx, id))!;
      const facts = this.addressFacts({
        region: body.region ?? before.region,
        line1: body.line1 ?? before.line1,
        digitalAddress: body.digitalAddress ?? before.digitalAddress ?? undefined,
        recipientPhone: body.recipientPhone ?? before.recipientPhone,
      });
      if (body.isDefault === true) await this.store.clearDefaultAddress(tx, before.customerId, id, actor!.principalId);
      const zoneId = await this.zoneFor(tx, body.area ?? before.area, body.city ?? before.city);
      const set = sentColumns({
        label: body.label,
        recipient_name: body.recipientName,
        recipient_phone_e164: body.recipientPhone === undefined ? undefined : facts.recipientPhone,
        line1: body.line1,
        area: body.area,
        city: body.city,
        region: body.region === undefined ? undefined : facts.region,
        digital_address: body.digitalAddress === undefined ? undefined : facts.digitalAddress,
        directions: body.directions,
        latitude: body.latitude,
        longitude: body.longitude,
        is_default: body.isDefault,
        delivery_zone_id: zoneId === (before.deliveryZone?.id ?? null) ? undefined : zoneId,
      });
      if (Object.keys(set).length > 0 && !(await this.store.updateAddress(tx, id, body.version, set, actor!.principalId))) {
        throw new VersionConflictError(`address ${id} changed while it was updated`);
      }
      const view = (await this.store.address(tx, id))!;
      await this.auditAddress(tx, 'UPDATE', before.customerId, id, before, view);
      return { status: 200, body: view };
    });
  }

  archiveAddress(actor: Actor | undefined, id: string, body: { readonly version: number; readonly reason: string }, idempotencyKey: string): Promise<StoredResponse<AddressView>> {
    return this.kit.write(actor, 'mdm.customer.update', 'archiveCustomerAddress', { id, ...body }, idempotencyKey, async (tx) => {
      requireLiveVersion(await this.store.lockAddress(tx, id), 'address', id, body.version);
      const before = (await this.store.address(tx, id))!;
      if (!(await this.store.archiveAddress(tx, id, body.version, body.reason, actor!.principalId, this.clock.now()))) {
        throw new VersionConflictError(`address ${id} changed while it was archived`);
      }
      const view = (await this.store.address(tx, id))!;
      await this.auditAddress(tx, 'ARCHIVE', before.customerId, id, before, view, body.reason);
      return { status: 200, body: view };
    });
  }

  // The assigned price list.

  /**
   * Assigns a CUSTOMER price list to a customer for `[validFrom, validTo)` (FR-MDM-021). The pricing engine reads it
   * first (ADR-0004). What the new window meets is replaced: an assignment that started earlier ends where the new
   * one starts, one that starts inside it is archived.
   */
  assignPriceList(
    actor: Actor | undefined,
    customerId: string,
    body: { readonly priceListId: string; readonly validFrom: Date; readonly validTo?: Date | undefined },
    idempotencyKey: string,
  ): Promise<StoredResponse<AssignmentView>> {
    const request = { customerId, priceListId: body.priceListId, validFrom: body.validFrom.toISOString(), validTo: body.validTo?.toISOString() ?? null };
    return this.kit.write(actor, 'mdm.price_list.assign', 'assignCustomerPriceList', request, idempotencyKey, async (tx) => {
      const state = await this.store.lockCustomer(tx, customerId);
      if (state === null || state.archived) throw new NotFoundError(`no live customer ${customerId}`);
      const list = await this.store.livePriceList(tx, body.priceListId);
      if (list === null) throw referencesNotFound(['/priceListId']);
      if (list.kind !== 'CUSTOMER') throw new PriceListAssignmentInvalidError([{ field: '/priceListId', rule: 'NOT_A_CUSTOMER_LIST' }]);
      const live = await this.store.liveAssignments(tx, customerId);
      const plan = planPriceListAssignment(live, body.validFrom, body.validTo ?? null);
      if (!plan.ok) throw new PriceListAssignmentInvalidError(plan.error);
      const now = this.clock.now();
      for (const ended of plan.value.end) await this.store.endAssignment(tx, ended.id, ended.validTo, actor!.principalId);
      for (const replaced of plan.value.replace) await this.store.archiveAssignment(tx, replaced, `Replaced by the assignment of ${list.code}`, actor!.principalId, now);
      const id = this.nextId();
      await this.store.insertAssignment(tx, id, { customerId, priceListId: list.id, validFrom: body.validFrom, validTo: body.validTo ?? null }, actor!.principalId);
      const view: AssignmentView = { customerId, priceList: { id: list.id, code: list.code, name: list.name }, validFrom: request.validFrom, validTo: request.validTo };
      await this.audit.record(tx, {
        module: 'mdm',
        action: 'ASSIGN_PRICE_LIST',
        entityType: 'Customer',
        entityId: customerId,
        before: { assignments: live.map((window) => ({ id: window.id, validFrom: window.validFrom.toISOString(), validTo: window.validTo?.toISOString() ?? null })) },
        after: { ...view, assignmentId: id, ended: plan.value.end.map((ended) => ended.id), replaced: [...plan.value.replace] },
      });
      return { status: 200, body: view };
    });
  }

  // Shared steps.

  /** The zone an address is in as it is saved, or null (A-112): the same match `quoteDelivery` makes. */
  private async zoneFor(tx: Transaction, area: string, city: string): Promise<string | null> {
    return matchDeliveryZone({ area, city }, await this.store.deliverableZones(tx))?.id ?? null;
  }

  private phoneHash(phone: string): Buffer {
    return createHmac('sha256', this.phoneKey).update(phone).digest();
  }

  private addressFacts(input: { readonly region: string; readonly line1: string; readonly digitalAddress?: string | undefined; readonly recipientPhone: string }) {
    const plan = planAddress({ region: input.region, line1: input.line1, digitalAddress: input.digitalAddress, recipientPhone: input.recipientPhone });
    if (!plan.ok) throw invalidFormat(plan.error);
    return plan.value;
  }

  private async sealTin(tx: Transaction, customerId: string, tin: string, actor: Actor): Promise<Buffer> {
    const key = await this.subjectKeys.keyFor(tx, { type: 'CUSTOMER', id: customerId }, actor.principalId);
    return sealWithSubjectKey(key, tin.trim(), tinPlace(customerId));
  }

  private async viewOf(tx: Transaction, id: string, actor: Actor): Promise<CustomerView> {
    return this.view(tx, (await this.store.customer(tx, id, this.clock.now()))!, actor);
  }

  private async view(tx: Transaction, record: CustomerRecord, actor: Actor): Promise<CustomerView> {
    let tinMasked: string | null = null;
    if (record.tinEnc !== null) {
      const key = await this.subjectKeys.keyFor(tx, { type: 'CUSTOMER', id: record.id }, actor.principalId);
      const tin = openWithSubjectKey(key.key, record.tinEnc, tinPlace(record.id));
      tinMasked = `${'*'.repeat(Math.max(tin.length - TIN_VISIBLE, 0))}${tin.slice(-TIN_VISIBLE)}`;
    }
    return {
      id: record.id,
      publicId: record.publicId,
      kind: record.kind,
      name: record.name,
      phone: record.phone,
      email: record.email,
      tier: record.tier,
      hasLogin: record.hasLogin,
      tinMasked,
      marketingConsentAt: record.marketingConsentAt,
      status: record.status,
      priceList: record.priceList,
      hasBusinessAccount: false,
      defaultArea: record.defaultArea,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private auditCustomer(tx: Transaction, action: string, id: string, before: CustomerView | null, after: CustomerView, reason?: string): Promise<unknown> {
    return this.audit.record(tx, {
      module: 'mdm',
      action,
      entityType: 'Customer',
      entityId: id,
      before: before === null ? null : { ...before },
      after: reason === undefined ? { ...after } : { ...after, reason },
      subject: { type: 'CUSTOMER', id },
      personalFields: CUSTOMER_PERSONAL,
    });
  }

  private auditAddress(tx: Transaction, action: string, customerId: string, id: string, before: AddressView | null, after: AddressView, reason?: string): Promise<unknown> {
    return this.audit.record(tx, {
      module: 'mdm',
      action,
      entityType: 'CustomerAddress',
      entityId: id,
      before: before === null ? null : { ...before },
      after: reason === undefined ? { ...after } : { ...after, reason },
      subject: { type: 'CUSTOMER', id: customerId },
      personalFields: ADDRESS_PERSONAL,
    });
  }
}
