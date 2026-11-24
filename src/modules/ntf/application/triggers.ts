import type { Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, VersionConflictError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from '../../iam';
import { judgeTriggerUpdate, type RecipientKind } from '../domain/routing';
import type { Channel } from '../domain/templates';
import { TriggerInvalidError } from './errors';
import type { NtfStore, TriggerRecord } from './ntf-store';
import type { Page } from './templates';

const READ = 'ntf.template.read';
const MANAGE = 'ntf.template.manage';
export const UPDATE_TRIGGER = 'updateNotificationTrigger';

/** The contract's `TriggerRule`. */
export interface TriggerRuleView {
  readonly id: string;
  readonly eventType: string;
  readonly templateCode: string;
  readonly recipientKind: RecipientKind;
  readonly recipientRoleCode: string | null;
  readonly channels: readonly Channel[];
  readonly isActive: boolean;
  readonly version: number;
}

export interface TriggerUpdate {
  readonly version: number;
  readonly channels?: readonly Channel[] | undefined;
  readonly isActive?: boolean | undefined;
  readonly templateCode?: string | undefined;
}

/**
 * Triggers (FR-NTF-002, B11 continued 11): which event sends which template, to whom, by which channels in order. Every
 * message NTF sends has one, seeded by migration 0338. A manager changes the channels or turns one off; turning it off
 * stops new messages and leaves every message already made as it was. Farm-wide, like the templates: read with
 * `ntf.template.read`, changed with `ntf.template.manage`, at the version read (409 otherwise), keyed and audited.
 */
export class Triggers {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  list(actor: Actor | undefined, cursor: string | undefined, limit: number): Promise<Page<TriggerRuleView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, READ);
      const binding = { operationId: 'listNotificationTriggers', principalId: actor!.principalId, filters: {} };
      const at = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const found = await this.store.triggerPage(tx, at === null ? null : [at['eventType']!, at['templateCode']!], limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return { data: rows.map(view), page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { eventType: last.eventType, templateCode: last.templateCode }) : null, limit, hasMore } };
    });
  }

  update(actor: Actor | undefined, id: string, change: TriggerUpdate, idempotencyKey: string): Promise<StoredResponse<TriggerRuleView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, MANAGE);
      const claim = await this.idempotency.claim(tx, { operationId: UPDATE_TRIGGER, principalId: actor!.principalId, key: idempotencyKey, request: { id, ...change } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<TriggerRuleView>;
      const before = await this.store.trigger(tx, id, true);
      if (before === null) throw new NotFoundError(`no notification trigger ${id}`);
      if (before.version !== change.version) throw new VersionConflictError(`trigger ${id} is at version ${String(before.version)}, not ${String(change.version)}`);
      const rules = judgeTriggerUpdate(before, change);
      if (rules.length > 0) throw new TriggerInvalidError(rules);
      await this.store.updateTrigger(tx, id, { channels: change.channels ?? before.channels, isActive: change.isActive ?? before.isActive }, this.clock.now(), actor!.principalId);
      const after = (await this.store.trigger(tx, id, false))!;
      await this.audit.record(tx, { module: 'ntf', action: 'TRIGGER_UPDATED', entityType: 'NotificationTrigger', entityId: id, branchId: null, before: { channels: before.channels, isActive: before.isActive }, after: { channels: after.channels, isActive: after.isActive } });
      const response = { status: 200, body: view(after) };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }
}

function view(t: TriggerRecord): TriggerRuleView {
  return { id: t.id, eventType: t.eventType, templateCode: t.templateCode, recipientKind: t.recipientKind, recipientRoleCode: t.recipientRoleCode, channels: t.channels, isActive: t.isActive, version: t.version };
}
