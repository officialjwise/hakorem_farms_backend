import { createUuidV7Generator, type Clock } from '@hakorem/kernel';
import type { AuditTrail } from '../../../platform/audit/audit-trail';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError, UnauthenticatedError } from '../../../platform/errors/api-error';
import type { Idempotency, StoredResponse } from '../../../platform/idempotency/idempotency';
import type { MasterDataRefs } from '../../mdm';
import { judgePreferences, type PreferenceInput } from '../domain/routing';
import type { Category, Channel } from '../domain/templates';
import { PreferencesInvalidError } from './errors';
import type { NtfStore, PreferenceOwner, PreferenceRecord } from './ntf-store';

export const REPLACE_PREFERENCES = 'replaceMyNotificationPreferences';

/** The contract's `NotificationPreference`. */
export interface NotificationPreferenceView {
  readonly category: Category;
  readonly channel: Channel;
  readonly isEnabled: boolean;
  readonly quietFrom: string | null;
  readonly quietTo: string | null;
}

export interface PreferencesView {
  readonly preferences: readonly NotificationPreferenceView[];
}

/**
 * The signed-in recipient's own message preferences (FR-NTF-004, FR-NTF-006; B11 continued 11): which channels each
 * category may use, in order, and the recipient's own quiet hours for reminders and marketing. A customer's are kept on
 * the customer record its sign-in belongs to (MDM), a member of staff's and an investor's on their principal; nobody
 * reads or sets anyone else's (no identifier is taken). None set means every channel is accepted, with quiet hours
 * 21:00 to 07:00 (SA-09). The replacement is whole, keyed, audited.
 */
export class Preferences {
  private readonly nextId: () => string;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: NtfStore,
    private readonly refs: MasterDataRefs,
    private readonly idempotency: Idempotency,
    private readonly audit: AuditTrail,
    private readonly clock: Clock,
  ) {
    this.nextId = createUuidV7Generator(clock);
  }

  get(actor: Actor | undefined): Promise<PreferencesView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => ({ preferences: (await this.store.preferencesOf(tx, await this.ownerOf(tx, actor))).map(view) }));
  }

  replace(actor: Actor | undefined, input: readonly PreferenceInput[], idempotencyKey: string): Promise<StoredResponse<PreferencesView>> {
    return this.uow.run({ isolation: 'serializable' }, async (tx) => {
      const owner = await this.ownerOf(tx, actor);
      const claim = await this.idempotency.claim(tx, { operationId: REPLACE_PREFERENCES, principalId: actor!.principalId, key: idempotencyKey, request: { preferences: input } });
      if (claim.kind === 'REPLAY') return claim.response as StoredResponse<PreferencesView>;
      const judged = judgePreferences(input);
      if (!judged.ok) throw new PreferencesInvalidError(judged.error);
      const before = await this.store.preferencesOf(tx, owner);
      await this.store.replacePreferences(tx, owner, input.map((p) => ({ ...p, id: this.nextId() })), this.clock.now(), actor!.principalId);
      const after = await this.store.preferencesOf(tx, owner);
      await this.audit.record(tx, { module: 'ntf', action: 'PREFERENCES_REPLACED', entityType: 'NotificationPreferences', entityId: 'customerId' in owner ? owner.customerId : owner.principalId, branchId: null, before: { preferences: before.map(view) }, after: { preferences: after.map(view) } });
      const response = { status: 200, body: { preferences: after.map(view) } };
      await this.idempotency.complete(tx, claim.id, response);
      return response;
    });
  }

  /** Whose preferences these are: a customer sign-in's customer record, else the principal itself. */
  private async ownerOf(tx: Transaction, actor: Actor | undefined): Promise<PreferenceOwner> {
    if (actor === undefined) throw new UnauthenticatedError('sign in to see your message preferences');
    if (actor.realm !== 'CUSTOMER') return { principalId: actor.principalId };
    const customer = await this.refs.customerOfPrincipalIn(tx, actor.principalId);
    if (customer === null) throw new NotFoundError('no customer account is linked to this sign-in');
    return { customerId: customer.id };
  }
}

function view(p: PreferenceRecord): NotificationPreferenceView {
  return { category: p.category, channel: p.channel, isEnabled: p.isEnabled, quietFrom: p.quietFrom, quietTo: p.quietTo };
}
