import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import { parsePercent } from '../domain/yield';
import { pageProbe } from './counting';
import { PrcReferenceNotFoundError, YieldStandardInvalidError } from './errors';
import type { Page } from './processing';
import type { ProcessingStore, YieldStandardRecord } from './processing-store';

export interface YieldStandardView {
  readonly id: string;
  readonly inputProduct: { readonly id: string; readonly sku: string; readonly name: string };
  readonly outputProduct: { readonly id: string; readonly sku: string; readonly name: string };
  readonly expectedPercent: string;
  readonly tolerancePercent: string;
  readonly version: number;
}

export interface YieldStandardCreateRequest {
  readonly inputProductId: string;
  readonly outputProductId: string;
  readonly expectedPercent: string;
  readonly tolerancePercent?: string | undefined;
}

/** The tolerance a standard takes when none is given (FR-PRC-005, SA-07). */
export const DEFAULT_TOLERANCE_PERCENT = '5';

/** Percent columns come back from `numeric(7,4)` padded ("50.0000"); a view shows the shortest exact decimal. */
function shortPercent(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/**
 * Yield standards (FR-PRC-004): the expected output weight of a product as a percentage of an input product's live
 * weight, and the tolerance outside which a completed order is flagged. Master data of PRC, readable by everyone who
 * processes, managed by the Owner and the Manager; every write is idempotent and audited.
 */
export class YieldStandards {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: ProcessingStore,
    private readonly refs: MasterDataRefs,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  list(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<YieldStandardView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'prc.yield_standard.read');
      const binding = { operationId: 'listYieldStandards', principalId: actor!.principalId, filters: {} };
      const after = cursor === undefined ? null : ((this.cursors.decode(cursor, binding)['id'] as string | undefined) ?? null);
      const found = await this.store.standards(tx, after, pageProbe(limit));
      const data = found.slice(0, limit);
      const last = data.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.views(tx, data), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit, hasMore } };
    });
  }

  create(actor: Actor | undefined, body: YieldStandardCreateRequest, idempotencyKey: string): Promise<StoredResponse<YieldStandardView>> {
    return this.write(actor, 'createYieldStandard', body, idempotencyKey, async (tx) => ({ status: 201, body: await this.createIn(tx, actor!, body) }));
  }

  /** Creates a standard in the caller's transaction, every rule applied and audited; the caller authorised it. */
  async createIn(tx: Transaction, actor: Actor, body: YieldStandardCreateRequest): Promise<YieldStandardView> {
    const products = await this.refs.productsIn(tx, [body.inputProductId, body.outputProductId]);
    const missing = [...(products.has(body.inputProductId) ? [] : ['/inputProductId']), ...(products.has(body.outputProductId) ? [] : ['/outputProductId'])];
    if (missing.length > 0) throw new PrcReferenceNotFoundError(missing);
    if (body.inputProductId === body.outputProductId) throw new YieldStandardInvalidError([{ field: '/outputProductId', rule: 'SAME_PRODUCT' }]);
    this.checkPercents(body.expectedPercent);
    const id = this.nextId();
    const created = await this.store.insertStandard(
      tx,
      { id, inputProductId: body.inputProductId, outputProductId: body.outputProductId, expectedPercent: body.expectedPercent, tolerancePercent: body.tolerancePercent ?? DEFAULT_TOLERANCE_PERCENT },
      actor.principalId,
    );
    if (!created) throw new YieldStandardInvalidError([{ field: '/outputProductId', rule: 'STANDARD_EXISTS' }]);
    const view = (await this.views(tx, [(await this.store.standard(tx, id))!]))[0]!;
    await this.audit.record(tx, { module: 'prc', action: 'CREATE', entityType: 'YieldStandard', entityId: id, branchId: null, before: null, after: { ...view } });
    return view;
  }

  update(
    actor: Actor | undefined,
    id: string,
    body: { readonly version: number; readonly expectedPercent?: string | undefined; readonly tolerancePercent?: string | undefined },
    idempotencyKey: string,
  ): Promise<StoredResponse<YieldStandardView>> {
    return this.write(actor, 'updateYieldStandard', { id, ...body }, idempotencyKey, async (tx) => {
      const before = await this.store.standard(tx, id);
      if (before === null) throw new NotFoundError(`no yield standard ${id}`);
      if (body.expectedPercent !== undefined) this.checkPercents(body.expectedPercent);
      const set: { expectedPercent?: string; tolerancePercent?: string } = {};
      if (body.expectedPercent !== undefined) set.expectedPercent = body.expectedPercent;
      if (body.tolerancePercent !== undefined) set.tolerancePercent = body.tolerancePercent;
      if (!(await this.store.updateStandard(tx, id, body.version, set, actor!.principalId))) {
        throw new VersionConflictError(`yield standard ${id} is not at version ${body.version}`);
      }
      const [beforeView, view] = await this.views(tx, [before, (await this.store.standard(tx, id))!]);
      await this.audit.record(tx, { module: 'prc', action: 'UPDATE', entityType: 'YieldStandard', entityId: id, branchId: null, before: { ...beforeView! }, after: { ...view! } });
      return { status: 200, body: view! };
    });
  }

  private checkPercents(expected: string): void {
    if (parsePercent(expected) === 0n) throw new YieldStandardInvalidError([{ field: '/expectedPercent', rule: 'EXPECTED_ZERO' }]);
  }

  private write<T>(actor: Actor | undefined, operationId: string, request: object, idempotencyKey: string, work: (tx: Transaction) => Promise<StoredResponse<T>>): Promise<StoredResponse<T>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'prc.yield_standard.manage');
      const claim = await this.idempotency.claim(tx, { operationId, principalId: actor!.principalId, key: idempotencyKey, request });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<T>;
      const response = await work(tx);
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  private async views(tx: Transaction, records: readonly YieldStandardRecord[]): Promise<YieldStandardView[]> {
    const products = await this.refs.productsIn(tx, records.flatMap((r) => [r.inputProductId, r.outputProductId]));
    const ref = (id: string) => {
      const p = products.get(id)!;
      return { id: p.id, sku: p.sku, name: p.name };
    };
    return records.map((r) => ({
      id: r.id,
      inputProduct: ref(r.inputProductId),
      outputProduct: ref(r.outputProductId),
      expectedPercent: shortPercent(r.expectedPercent),
      tolerancePercent: shortPercent(r.tolerancePercent),
      version: r.version,
    }));
  }
}
