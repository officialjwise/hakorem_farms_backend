import type { Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction } from '../../../platform/database/unit-of-work';
import { ForbiddenError, UnauthenticatedError } from '../../../platform/errors/api-error';
import { decideAccess } from '../domain/authorisation-policy';
import { StepUpRequiredError, TotpEnrolmentRequiredError } from './errors';
import type { IamStore } from './ports';

/** What the action reaches, for scope and ownership (ADR-0017). Leave out what does not apply. */
export interface AuthoriseScope {
  readonly branchId?: string | null;
  readonly locationId?: string | null;
  /** Whose record it is, and the permission that lets the actor reach anyone's. */
  readonly owner?: { readonly principalId: string; readonly anyPermission: string };
}

const MILLISECONDS_PER_SECOND = 1_000;

/**
 * The policy engine every command and query handler calls before doing work (ADR-0017): deny by default, branch
 * and location scope, object ownership, and step-up for permissions that need a fresh TOTP. Grants are read from
 * the database on every check, so a revoked grant takes effect on the next request. A refusal is written to the
 * audit trail on its own connection, so it survives the rollback of the refused command, and is logged as a
 * warning (an investor's refusal as an error: security architecture section 10).
 */
export class Authoriser {
  constructor(
    private readonly store: IamStore,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly stepUpTtlSeconds: number,
  ) {}

  async authorise(tx: Transaction, actor: Actor | undefined, permission: string, scope: AuthoriseScope = {}): Promise<void> {
    if (actor === undefined) {
      throw new UnauthenticatedError(`no actor for ${permission}`);
    }
    const now = this.clock.now();
    const grants = await this.store.grantsWithPermission(tx, actor.principalId, permission, now);
    let holdsAny = false;
    if (scope.owner !== undefined && scope.owner.principalId !== actor.principalId) {
      holdsAny = (await this.store.grantsWithPermission(tx, actor.principalId, scope.owner.anyPermission, now)).length > 0;
    }
    const decision = decideAccess({
      grantsWithPermission: grants,
      scope: {
        branchId: scope.branchId ?? null,
        locationId: scope.locationId ?? null,
        ...(scope.owner === undefined
          ? {}
          : { owner: { principalId: scope.owner.principalId, actorPrincipalId: actor.principalId, holdsAnyPermission: holdsAny } }),
      },
    });
    if (!decision.allowed) {
      await this.refuse(actor, permission, decision.reason, scope);
      throw new ForbiddenError(`${permission} refused: ${decision.reason}`);
    }
    if ((await this.store.permissionRequiresStepUp(tx, permission)) === true) {
      const totp = await this.store.totp(tx, actor.principalId);
      if (totp === null || totp.confirmedAt === null) {
        throw new TotpEnrolmentRequiredError(`${permission} needs a second factor`);
      }
      const fresh = actor.steppedUpAt !== null && now.getTime() - actor.steppedUpAt.getTime() <= this.stepUpTtlSeconds * MILLISECONDS_PER_SECOND;
      if (!fresh) {
        throw new StepUpRequiredError(`${permission} needs a step-up within ${this.stepUpTtlSeconds} s`);
      }
    }
  }

  /** Whether the actor holds the permission anywhere, without auditing a refusal: for what a screen may offer. */
  async holds(tx: Transaction, actor: Actor, permission: string): Promise<boolean> {
    return (await this.store.grantsWithPermission(tx, actor.principalId, permission, this.clock.now())).length > 0;
  }

  private async refuse(actor: Actor, permission: string, reason: string, scope: AuthoriseScope): Promise<void> {
    const fields = { principalId: actor.principalId, realm: actor.realm, permission, reason };
    if (actor.realm === 'INVESTOR') {
      this.logger.error(fields, 'authorisation refused to an investor');
    } else {
      this.logger.warn(fields, 'authorisation refused');
    }
    try {
      await this.audit.recordDetached({
        module: 'iam',
        action: 'AUTHORISATION_FAILURE',
        entityType: 'Permission',
        branchId: scope.branchId ?? null,
        metadata: { permission, reason, locationId: scope.locationId ?? null, ownerPrincipalId: scope.owner?.principalId ?? null },
      });
    } catch (error) {
      this.logger.error({ ...fields, err: error }, 'could not audit an authorisation refusal');
    }
  }
}
