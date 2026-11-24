import type { Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import { decodePosition, encodePosition, resolveSort, type SortSpec } from '../../../platform/http/keyset-sort';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import type { MasterDataRefs } from '../../mdm';
import type { Orders } from '../../ord';
import { judgeRetry, type AttemptOutcome, type MessageStatus } from '../domain/messages';
import type { Channel } from '../domain/templates';
import { MessageNotRetryableError } from './errors';
import type { MessageFilters, MessageRecord, NtfStore } from './ntf-store';
import type { Page } from './templates';

const READ = 'ntf.message.read';
const RETRY = 'ntf.message.retry';
export const RETRY_MESSAGE = 'retryNotificationMessage';

/** The contract's `NotificationMessage`. */
export interface NotificationMessageView {
  readonly id: string;
  readonly sourceEventId: string;
  readonly templateCode: string;
  readonly channel: Channel;
  readonly category: string;
  readonly recipient: { readonly kind: 'CUSTOMER' | 'STAFF' | 'INVESTOR' | 'CONTACT'; readonly id: string | null; readonly displayName: string | null };
  readonly addressMasked: string;
  readonly status: MessageStatus;
  readonly suppressedReason: string | null;
  readonly attempts: readonly { readonly attemptNo: number; readonly outcome: AttemptOutcome; readonly providerResponse: string | null; readonly attemptedAt: string }[];
  readonly sendAfter: string | null;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly createdAt: string;
}

export interface MessageQuery {
  readonly status?: string | undefined;
  readonly channel?: string | undefined;
  readonly customerId?: string | undefined;
  readonly templateCode?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

/** The log runs newest first, then by id (index ix_message_created). */
const MESSAGE_ORDER: SortSpec<'createdAt'> = {
  fields: { createdAt: { expression: 'm.created_at', type: 'timestamptz' } },
  tieBreaker: { expression: 'm.id', type: 'uuid' },
  defaultOrder: { field: 'createdAt', direction: 'desc' },
};

/**
 * The message log (FR-NTF-007, the owner 2026-11-23: each message's delivery per channel, so a failed one shows as
 * failed): what was sent to whom, masked, and when, with every attempt, read only at the message's branch; and a
 * manager's retry of a failed message, which queues it again without a new message (a suppressed one never). Each
 * handler authorises first through IAM's policy engine at the message's branch, deny by default; the retry is audited.
 */
export class MessageLog {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly refs: MasterDataRefs,
    private readonly orders: Orders,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  list(actor: Actor | undefined, query: MessageQuery, cursor: string | undefined, limit: number): Promise<Page<NotificationMessageView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const branchIds = [...new Set((await this.authoriser.scopes(tx, actor!, READ)).map((scope) => scope.branchId))];
      const filters: MessageFilters = {
        branchIds,
        status: query.status ?? null,
        channel: query.channel ?? null,
        customerId: query.customerId ?? null,
        templateCode: query.templateCode ?? null,
        from: query.from === undefined ? null : new Date(query.from),
        to: query.to === undefined ? null : new Date(query.to),
      };
      const order = resolveSort(MESSAGE_ORDER, undefined, undefined);
      const binding = { operationId: 'listNotificationMessages', principalId: actor!.principalId, filters: { ...query } };
      const position = cursor === undefined ? null : decodePosition(order, this.cursors.decode(cursor, binding));
      const found = await this.store.messagePage(tx, filters, order, position, limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return { data: await this.viewsIn(tx, rows), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, encodePosition(last.position)) : null, limit, hasMore } };
    });
  }

  get(actor: Actor | undefined, id: string): Promise<NotificationMessageView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const message = await this.found(tx, actor, READ, id, false);
      return (await this.viewsIn(tx, [message]))[0]!;
    });
  }

  retry(actor: Actor | undefined, id: string, idempotencyKey: string): Promise<StoredResponse<NotificationMessageView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, RETRY);
      const message = await this.found(tx, actor, RETRY, id, true);
      const claim = await this.idempotency.claim(tx, { operationId: RETRY_MESSAGE, principalId: actor!.principalId, key: idempotencyKey, request: { id } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<NotificationMessageView>;
      const verdict = judgeRetry(message.status);
      if (verdict !== 'OK') throw new MessageNotRetryableError(verdict);
      await this.store.requeue(tx, id, this.clock.now(), actor!.principalId);
      const after = (await this.store.message(tx, id, false))!;
      await this.audit.record(tx, { module: 'ntf', action: 'RETRY', entityType: 'NotificationMessage', entityId: id, branchId: message.branchId, before: { status: message.status, attempts: message.attempts }, after: { status: after.status, attempts: after.attempts } });
      const [view] = await this.viewsIn(tx, [after]);
      const response = { status: 200, body: view! };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** A message the actor may reach at its branch; 404 for one that does not exist, refused at another branch. */
  private async found(tx: Transaction, actor: Actor | undefined, permission: string, id: string, lock: boolean): Promise<MessageRecord> {
    const message = await this.store.message(tx, id, lock);
    if (message === null) throw new NotFoundError(`no notification message ${id}`);
    await this.authoriser.authorise(tx, actor, permission, { branchId: message.branchId });
    return message;
  }

  private async viewsIn(tx: Transaction, rows: readonly MessageRecord[]): Promise<NotificationMessageView[]> {
    // One query at a time on the transaction's connection.
    const attempts = await this.store.attemptsOf(tx, rows.map((r) => r.id));
    const customers = await this.refs.customersIn(tx, rows.flatMap((r) => (r.customerId === null ? [] : [r.customerId])));
    const contacts = await this.orders.messageContactsIn(tx, rows.flatMap((r) => (r.recipientKind === 'CONTACT' && r.salesOrderId !== null ? [r.salesOrderId] : [])));
    return rows.map((r) => ({
      id: r.id,
      sourceEventId: r.sourceEventRef,
      templateCode: r.templateCode,
      channel: r.channel,
      category: r.category,
      recipient: {
        kind: r.recipientKind,
        id: r.customerId ?? r.principalId,
        displayName: r.customerId !== null ? (customers.get(r.customerId)?.name ?? null) : r.salesOrderId === null ? null : (contacts.get(r.salesOrderId)?.contactName ?? null),
      },
      addressMasked: r.addressMasked,
      status: r.status,
      suppressedReason: r.suppressedReason,
      attempts: attempts.filter((a) => a.messageId === r.id).map((a) => ({ attemptNo: a.attemptNo, outcome: a.outcome, providerResponse: a.providerResponse, attemptedAt: a.attemptedAt.toISOString() })),
      sendAfter: r.sendAfter?.toISOString() ?? null,
      sentAt: r.sentAt?.toISOString() ?? null,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
