import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import { databaseErrorOf, sqlStateOf, type Transaction, type UnitOfWork } from '../../../platform/database/unit-of-work';
import { BusinessRuleError, NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { DomainEvents } from '../../../platform/events/domain-events';
import type { Cursors } from '../../../platform/http/cursor';
import { registerMessages, translate } from '../../../platform/i18n/messages';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { FieldRule, UomKind } from '../domain/product';
import { exactFactor, factorText, judgeConversion, type UomFactor } from '../domain/unit-conversion';
import type { ProductChanged } from '../events';
import { DuplicateRecordError, referencesNotFound } from './errors';
import type { Page } from './product-catalogue';
import type { ProductStore } from './product-store';

registerMessages({
  'mdm.uom_conversion_invalid': 'This conversion is not allowed.',
  'mdm.uom_conversion_rule': 'This value breaks a unit conversion rule.',
});

export const LIST_UOM_CONVERSIONS = 'listUomConversions';
export const CREATE_UOM_CONVERSION = 'createUomConversion';
export const ARCHIVE_UOM_CONVERSION = 'archiveUomConversion';

const READ = 'mdm.product.read';
const CREATE = 'mdm.uom_conversion.create';
const ARCHIVE = 'mdm.uom_conversion.archive';
/** The partial unique index of migration 0090: one live conversion per product and alternative unit. */
const LIVE_UNIQUE = 'uq_uom_conversion_live';

/** 422: a conversion breaks a rule of FR-MDM-003 or A-163 (an inexact factor, a catch-weight product, the base unit). */
export class UomConversionInvalidError extends BusinessRuleError {
  readonly code = 'UOM_CONVERSION_INVALID';
  readonly messageKey = 'mdm.uom_conversion_invalid';

  constructor(rules: readonly FieldRule[]) {
    super('the unit conversion breaks a rule', rules.map((rule) => ({ field: rule.field, code: rule.rule, message: translate('mdm.uom_conversion_rule') })));
  }
}

/** The contract's `UomConversion`. */
export interface UomConversionView {
  readonly id: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly fromUom: string;
  readonly toUom: string;
  readonly numerator: number;
  readonly denominator: number;
  /** One `fromUom` in `toUom`, three decimal places, exact. */
  readonly factor: string;
  readonly version: number;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly archiveReason: string | null;
}

/** A conversion row as the store reads it. */
export interface UomConversionRow {
  readonly id: string;
  readonly product: { readonly id: string; readonly sku: string; readonly name: string };
  readonly fromUom: string;
  readonly toUom: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly version: number;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
  readonly archiveReason: string | null;
}

export interface UomConversionFilter {
  readonly productId?: string | undefined;
  readonly includeArchived: boolean;
}

export const UOM_CONVERSION_STORE = Symbol('UOM_CONVERSION_STORE');

export interface UomConversionStore {
  /** The unit's kind, or null when there is no such unit. */
  unitKind(tx: Transaction, code: string): Promise<UomKind | null>;
  find(tx: Transaction, id: string): Promise<UomConversionRow | null>;
  /** The live row, locked for its archive, or null when there is none. */
  lockLive(tx: Transaction, id: string): Promise<UomConversionRow | null>;
  list(tx: Transaction, filter: UomConversionFilter, afterId: string | null, limit: number): Promise<UomConversionRow[]>;
  liveFromUnitTaken(tx: Transaction, productId: string, fromUom: string): Promise<boolean>;
  insert(tx: Transaction, row: { readonly id: string; readonly productId: string; readonly fromUom: string; readonly toUom: string } & UomFactor, actorId: string, now: Date): Promise<void>;
  archive(tx: Transaction, id: string, expectedVersion: number, reason: string, actorId: string, now: Date): Promise<boolean>;
}

/** The contract's `UomConversionCreate`, parsed at the boundary. */
export interface UomConversionCreate {
  readonly productId: string;
  readonly fromUom: string;
  readonly numerator: number;
  readonly denominator: number;
}

export interface UomConversionArchive {
  readonly version: number;
  readonly reason: string;
}

function view(row: UomConversionRow): UomConversionView {
  return {
    id: row.id,
    product: row.product,
    fromUom: row.fromUom,
    toUom: row.toUom,
    numerator: Number(row.numerator),
    denominator: Number(row.denominator),
    factor: factorText(row),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    archiveReason: row.archiveReason,
  };
}

/** Where a refused factor points in the request: an inexact one is its denominator's fault. */
const FACTOR_FIELD = { NOT_POSITIVE: '/numerator', TOO_LARGE: '/numerator', INEXACT_FACTOR: '/denominator' } as const;

/**
 * A product's alternative units (FR-MDM-003, A-157, A-163): listUomConversions, createUomConversion and
 * archiveUomConversion. Each authorises first through IAM's policy engine, deny by default: reading needs
 * `mdm.product.read`, making one `mdm.uom_conversion.create` and archiving one `mdm.uom_conversion.archive` (the Owner
 * and the Manager). A factor is exact or refused, here and by the database; a conversion never changes, so a new factor
 * for a unit is a new conversion after the old one is archived. Each change is audited and publishes
 * `mdm.ProductChanged` with `uomConversions` as the changed field, in its transaction.
 */
export class UomConversions {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: UomConversionStore,
    private readonly products: ProductStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly events: DomainEvents,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, filter: UomConversionFilter, cursor: string | undefined, limit: number): Promise<Page<UomConversionView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: LIST_UOM_CONVERSIONS, principalId: actor!.principalId, filters: { productId: filter.productId ?? null, includeArchived: filter.includeArchived } };
      const after = cursor === undefined ? null : (this.cursors.decode(cursor, binding)['id'] ?? null);
      const rows = await this.store.list(tx, filter, after, limit + 1);
      const hasMore = rows.length > limit;
      const data = rows.slice(0, limit).map(view);
      const last = data.at(-1);
      return { data, page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  async create(actor: Actor | undefined, body: UomConversionCreate, idempotencyKey: string): Promise<StoredResponse<UomConversionView>> {
    try {
      return await this.uow.run({ isolation: 'serializable' }, async (tx) => {
        await this.authoriser.authorise(tx, actor, CREATE);
        const claim = await this.idempotency.claim(tx, { operationId: CREATE_UOM_CONVERSION, principalId: actor!.principalId, key: idempotencyKey, request: body });
        if (claim.kind === 'REPLAY') return claim.response as StoredResponse<UomConversionView>;
        if (!(await this.products.lock(tx, body.productId))) throw referencesNotFound(['/productId']);
        const product = (await this.products.view(tx, body.productId))!;
        const fromKind = await this.store.unitKind(tx, body.fromUom);
        if (fromKind === null) throw referencesNotFound(['/fromUom']);
        const factor = exactFactor(BigInt(body.numerator), BigInt(body.denominator));
        const rules = judgeConversion({ stockPolicy: product.stockPolicy, baseUom: product.baseUom, fromUom: body.fromUom, fromKind });
        if (!factor.ok) rules.push({ field: FACTOR_FIELD[factor.error], rule: factor.error });
        if (rules.length > 0 || !factor.ok) throw new UomConversionInvalidError(rules);
        if (await this.store.liveFromUnitTaken(tx, product.id, body.fromUom)) throw new DuplicateRecordError(['/fromUom']);
        const id = this.nextId();
        await this.store.insert(tx, { id, productId: product.id, fromUom: body.fromUom, toUom: product.baseUom, ...factor.value }, actor!.principalId, this.clock.now());
        const made = view((await this.store.find(tx, id))!);
        await this.audit.record(tx, { module: 'mdm', action: 'CREATE', entityType: 'UomConversion', entityId: id, before: null, after: this.audited(made) });
        await this.publish(tx, product.id);
        const response = { status: 201, body: made };
        await this.idempotency.complete(tx, claim.id, response);
        return response;
      });
    } catch (error) {
      // Two makers of one unit racing past the check meet the partial unique index of migration 0090.
      if (sqlStateOf(error) === '23505' && databaseErrorOf(error)?.constraint === LIVE_UNIQUE) throw new DuplicateRecordError(['/fromUom']);
      throw error;
    }
  }

  archive(actor: Actor | undefined, id: string, body: UomConversionArchive, idempotencyKey: string): Promise<StoredResponse<UomConversionView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, ARCHIVE);
      const claim = await this.idempotency.claim(tx, { operationId: ARCHIVE_UOM_CONVERSION, principalId: actor!.principalId, key: idempotencyKey, request: { id, ...body } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<UomConversionView>;
      const before = await this.store.lockLive(tx, id);
      if (before === null) throw new NotFoundError('no such live unit conversion');
      if (before.version !== body.version) throw new VersionConflictError(`unit conversion ${id} is at version ${before.version}`);
      await this.store.archive(tx, id, body.version, body.reason, actor!.principalId, this.clock.now());
      const after = view((await this.store.find(tx, id))!);
      await this.audit.record(tx, { module: 'mdm', action: 'ARCHIVE', entityType: 'UomConversion', entityId: id, before: this.audited(view(before)), after: this.audited(after) });
      await this.publish(tx, before.product.id);
      const response = { status: 200, body: after };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private audited(conversion: UomConversionView): Record<string, unknown> {
    const { product, ...rest } = conversion;
    return { productId: product.id, ...rest };
  }

  private async publish(tx: Transaction, productId: string): Promise<void> {
    const product = (await this.products.viewAny(tx, productId))!;
    const payload: ProductChanged = {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      categoryId: product.category.id,
      onlineMode: product.onlineMode,
      status: product.status,
      isSellable: product.isSellable,
      changedFields: ['uomConversions'],
      version: product.version,
    };
    await this.events.publish(tx, { type: 'mdm.ProductChanged', subjectType: 'Product', subjectId: product.id, payload });
  }
}
