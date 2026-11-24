import type { Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { InAppRecord, NtfStore } from './ntf-store';

/** The contract's `InAppNotification`. */
export interface InAppNotificationView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly readAt: string | null;
  readonly createdAt: string;
}

export interface InAppPage {
  readonly data: readonly InAppNotificationView[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
  /** How many of the caller's own notifications are unread, whatever the page shows (FR-NTF-008). */
  readonly unreadCount: number;
}

/**
 * The signed-in principal's own in-app notifications (FR-NTF-008, B11 continued 11): the newest first, with the unread
 * count; marking one read is once (`ntf.in_app_notification_guard`), and another principal's notification is not found
 * (404), never told apart from one that does not exist. No identifier but the notification's own is taken.
 */
export class InAppNotifications {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  list(actor: Actor | undefined, unreadOnly: boolean, cursor: string | undefined, limit: number): Promise<InAppPage> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const principalId = own(actor);
      const binding = { operationId: 'listMyNotifications', principalId, filters: { unreadOnly } };
      const at = cursor === undefined ? null : this.cursors.decode(cursor, binding);
      const found = await this.store.inAppPage(tx, principalId, unreadOnly, at === null ? null : [new Date(at['createdAt']!), at['id']!], limit + 1);
      const rows = found.slice(0, limit);
      const last = rows.at(-1);
      const hasMore = found.length > limit;
      return {
        data: rows.map(view),
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { createdAt: last.createdAt.toISOString(), id: last.id }) : null, limit, hasMore },
        unreadCount: await this.store.unreadCount(tx, principalId),
      };
    });
  }

  markRead(actor: Actor | undefined, id: string): Promise<InAppNotificationView> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const principalId = own(actor);
      const found = await this.store.inApp(tx, principalId, id, true);
      if (found === null) throw new NotFoundError(`no notification ${id}`);
      if (found.readAt === null) await this.store.markInAppRead(tx, id, this.clock.now());
      return view((await this.store.inApp(tx, principalId, id, false))!);
    });
  }
}

function own(actor: Actor | undefined): string {
  if (actor === undefined) throw new UnauthenticatedError('sign in to see your notifications');
  return actor.principalId;
}

function view(n: InAppRecord): InAppNotificationView {
  return { id: n.id, title: n.title, body: n.body, link: n.link, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() };
}
