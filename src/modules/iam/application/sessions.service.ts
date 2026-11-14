import type { Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { Cursors } from '../../../platform/http/cursor';
import type { Idempotency } from '../../../platform/idempotency/idempotency';
import type { Authoriser } from './authoriser';
import type { IamStore, SessionRecord } from './ports';
import type { SessionRecordView } from './session-view';

export const LIST_SESSIONS = 'listSessions';
export const REVOKE_SESSION = 'revokeSession';

export interface SessionListQuery {
  readonly principalId?: string | undefined;
  readonly active?: boolean | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number; readonly hasMore: boolean };
}

function view(session: SessionRecord, currentSessionId: string | null): SessionRecordView {
  return {
    id: session.id,
    principal: { id: session.principalId, displayName: session.displayName },
    realm: session.realm,
    deviceLabel: session.deviceLabel,
    userAgent: session.userAgent,
    ipAddress: session.ipCreated,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    current: session.id === currentSessionId,
    revokedAt: session.revokedAt === null ? null : session.revokedAt.toISOString(),
  };
}

/**
 * The device list and forced logout (FR-IAM-016, ADR-0016). A user sees and revokes their own sessions with
 * `iam.session.read` and `iam.session.revoke`; anyone's needs the `.any` permission (a manager or the owner).
 * Revocation deletes nothing and takes effect on the next request made with that session.
 */
export class SessionsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: IamStore,
    private readonly authoriser: Authoriser,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly cursors: Cursors,
    private readonly clock: Clock,
  ) {}

  async list(actor: Actor | undefined, query: SessionListQuery): Promise<Page<SessionRecordView>> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      const owner = query.principalId ?? actor?.principalId ?? '';
      await this.authoriser.authorise(tx, actor, 'iam.session.read', { owner: { principalId: owner, anyPermission: 'iam.session.read.any' } });
      const filters = { principalId: owner, active: query.active ?? null };
      const binding = { operationId: LIST_SESSIONS, principalId: actor!.principalId, filters };
      const position = query.cursor === undefined ? null : this.cursors.decode(query.cursor, binding);
      const rows = await this.store.listSessions(tx, {
        principalId: owner,
        activeOnly: query.active ?? null,
        beforeId: position?.['id'] ?? null,
        limit: query.limit + 1,
      });
      const hasMore = rows.length > query.limit;
      const data = rows.slice(0, query.limit).map((row) => view(row, actor!.sessionId));
      const last = data.at(-1);
      return {
        data,
        page: { nextCursor: hasMore && last !== undefined ? this.cursors.encode(binding, { id: last.id }) : null, limit: query.limit, hasMore },
      };
    });
  }

  async revoke(actor: Actor | undefined, sessionId: string, reason: string, idempotencyKey: string): Promise<void> {
    await this.uow.run({ isolation: 'serializable' }, async (tx) => {
      await this.authoriser.authorise(tx, actor, 'iam.session.revoke');
      const session = await this.store.sessionById(tx, sessionId);
      if (session === null) {
        throw new NotFoundError('no such session');
      }
      await this.authoriser.authorise(tx, actor, 'iam.session.revoke', { owner: { principalId: session.principalId, anyPermission: 'iam.session.revoke.any' } });
      const claim = await this.idempotency.claim(tx, { operationId: REVOKE_SESSION, principalId: actor!.principalId, key: idempotencyKey, request: { sessionId, reason } });
      if (claim.kind === 'REPLAY') {
        return;
      }
      const revoked = await this.store.revokeSession(tx, session.id, actor!.principalId, reason, this.clock.now());
      if (revoked) {
        await this.audit.record(tx, {
          module: 'iam',
          action: 'SESSION_REVOKED',
          entityType: 'Session',
          entityId: session.id,
          before: { revokedAt: null },
          after: { revokedAt: this.clock.now().toISOString(), reason },
          metadata: { ownerPrincipalId: session.principalId, forced: session.principalId !== actor!.principalId },
        });
      }
      await this.idempotency.complete(tx, claim.id, { status: 204, body: null });
    });
  }
}
